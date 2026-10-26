import { BROWSER, type ClientDefinition, CLIENTS, type Client, WEB, YOUTUBE_ORIGIN } from "./clients.ts";
import { YtdlError } from "./errors.ts";
import { abortable, bodyText, fetchText, ignore, send, statusError } from "./http.ts";
import { at, isRecord, type Json, str, ytcfg } from "./json.ts";

type Identity = Pick<ClientDefinition, "name" | "nameId" | "version" | "userAgent" | "context" | "origin">;
type Endpoint = "player" | "next" | "navigation/resolve_url" | "search" | "browse";

interface InnertubeRequest {
  readonly videoId?: string;
  readonly visitorData: string | undefined;
  readonly hl?: string;
  readonly body?: Json;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly thirdParty?: Json | undefined;
  readonly user?: Json | undefined;
  readonly notFound?: string;
}

export interface EmbedContext {
  readonly visitorData: string | undefined;
  readonly hostFlags: string | undefined;
}

export interface PlayerRequest {
  readonly client: Client;
  readonly videoId: string;
  readonly visitorData: string | undefined;
  readonly signatureTimestamp: number | undefined;
  readonly poToken: string | undefined;
  readonly authHeaders: Readonly<Record<string, string>> | undefined;
  readonly embed: EmbedContext | undefined;
}

interface InnerTubeOptions {
  readonly fetch: typeof fetch;
  readonly lang: string | undefined;
  readonly country: string | undefined;
  readonly utcOffsetMinutes: number | undefined;
}

// An embedded player request plays only with the host flags and visitor data of an embed page on a third-party site.
const EMBED_HOST = "https://www.reddit.com/";

export class InnerTube {
  readonly fetch: typeof fetch;
  readonly lang: string;
  readonly country: string;
  readonly utcOffsetMinutes: number;
  #visitor: Promise<string> | undefined;

  constructor(options: InnerTubeOptions) {
    this.fetch = options.fetch;
    this.lang = options.lang ?? "en";
    this.country = options.country ?? "US";
    this.utcOffsetMinutes = options.utcOffsetMinutes ?? 0;
  }

  text(url: string, init: RequestInit, what: string): Promise<string> {
    return fetchText(this.fetch, url, init, what);
  }

  visitorData(signal: AbortSignal | undefined): Promise<string> {
    return abortable(this.#sharedVisitor(), signal);
  }

  replaceVisitorData(
    stale: string | undefined,
    signal: AbortSignal | undefined,
    { keepOnFailure = false } = {},
  ): Promise<string> {
    const current = this.#visitor;
    const fresh = () => {
      this.#visitor = undefined;
      const pending = this.#sharedVisitor();
      if (keepOnFailure && current) {
        pending.catch(() => {
          this.#visitor ??= current;
        });
      }
      return abortable(pending, signal);
    };
    if (!current || stale === undefined) return fresh();
    const settle = (value: string | undefined) =>
      !signal?.aborted && this.#visitor === current && (value === undefined || value === stale)
        ? fresh()
        : this.visitorData(signal);
    return abortable(
      current.then(settle, () => settle(undefined)),
      signal,
    );
  }

  #sharedVisitor(): Promise<string> {
    if (!this.#visitor) {
      const pending = this.#fetchVisitorData();
      this.#visitor = pending;
      pending.catch(() => {
        if (this.#visitor === pending) this.#visitor = undefined;
      });
    }
    return this.#visitor;
  }

  async embedContext(videoId: string, signal: AbortSignal | undefined): Promise<EmbedContext> {
    const page = await this.text(
      `${YOUTUBE_ORIGIN}/embed/${encodeURIComponent(videoId)}?html5=1`,
      { headers: { ...BROWSER, Referer: EMBED_HOST }, signal },
      "YouTube embed page",
    );
    const config = ytcfg(page);
    return {
      visitorData: str(config.VISITOR_DATA),
      hostFlags: str(
        at(config, "WEB_PLAYER_CONTEXT_CONFIGS", "WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER", "encryptedHostFlags"),
      ),
    };
  }

  player(request: PlayerRequest, signal: AbortSignal | undefined): Promise<Json> {
    return this.#post("player", CLIENTS[request.client], signal, {
      videoId: request.videoId,
      // Playability reasons are localized, and `classifyPlayability` reads them in English.
      hl: "en",
      visitorData: request.visitorData,
      headers: request.authHeaders,
      thirdParty: request.embed && { embedUrl: EMBED_HOST },
      body: {
        playbackContext: {
          contentPlaybackContext: {
            html5Preference: "HTML5_PREF_WANTS",
            signatureTimestamp: request.signatureTimestamp,
            encryptedHostFlags: request.embed?.hostFlags,
          },
        },
        serviceIntegrityDimensions: request.poToken ? { poToken: request.poToken } : undefined,
      },
    });
  }

  // Only `microformat` is read: the WEB formats are SABR-only and the playback clients omit it.
  webMetadata(videoId: string, visitorData: string | undefined, signal: AbortSignal | undefined): Promise<Json> {
    return this.#post("player", WEB, signal, { videoId, visitorData });
  }

  next(videoId: string, visitorData: string | undefined, signal: AbortSignal | undefined): Promise<Json> {
    return this.#post("next", WEB, signal, { videoId, visitorData });
  }

  search(
    page: { readonly query: string; readonly params: string } | { readonly continuation: string },
    safeSearch: boolean,
    visitorData: string,
    signal: AbortSignal | undefined,
  ): Promise<Json> {
    return this.#post("search", WEB, signal, {
      visitorData,
      user: safeSearch ? { enableSafetyMode: true } : undefined,
      body: "query" in page ? { query: page.query, params: page.params } : { continuation: page.continuation },
    });
  }

  browse(
    page: { readonly playlistId: string } | { readonly continuation: string },
    visitorData: string,
    signal: AbortSignal | undefined,
  ): Promise<Json> {
    return this.#post("browse", WEB, signal, {
      visitorData,
      body: "playlistId" in page ? { browseId: `VL${page.playlistId}` } : { continuation: page.continuation },
    });
  }

  async channelId(url: string, signal: AbortSignal | undefined): Promise<string> {
    const id = str(at(await this.#resolveUrl(url, signal), "endpoint", "browseEndpoint", "browseId"));
    if (!id || !/^UC[\w-]{22}$/u.test(id)) throw new YtdlError("NOT_FOUND", `${url} names no channel`);
    return id;
  }

  async channelLiveVideo(url: string, signal: AbortSignal | undefined): Promise<string> {
    const videoId = str(at(await this.#resolveUrl(url, signal), "endpoint", "watchEndpoint", "videoId"));
    if (!videoId || !/^[\w-]{11}$/u.test(videoId)) throw new YtdlError("NOT_FOUND", `${url} has no live stream`);
    return videoId;
  }

  #resolveUrl(url: string, signal: AbortSignal | undefined): Promise<Json> {
    return this.#post("navigation/resolve_url", WEB, signal, {
      visitorData: undefined,
      body: { url },
      notFound: `${url} names no channel`,
    });
  }

  // Without visitor data every client answers "confirm you're not a bot"; `sw.js_data` hands one out.
  async #fetchVisitorData(): Promise<string> {
    const what = "YouTube visitor data";
    const body = await this.text(`${YOUTUBE_ORIGIN}/sw.js_data`, { headers: BROWSER }, what);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.replace(/^\)\]\}'\s*/u, ""));
    } catch (cause) {
      throw new YtdlError("REQUEST_FAILED", `${what} was not JSON`, { cause });
    }
    const visitor = str(at(parsed, 0, 2, 0, 0, 13));
    if (!visitor) throw new YtdlError("REQUEST_FAILED", `${what} had no visitor ID`);
    return visitor;
  }

  async #post(
    endpoint: Endpoint,
    identity: Identity,
    signal: AbortSignal | undefined,
    request: InnertubeRequest,
  ): Promise<Json> {
    const what = `YouTube ${identity.name} ${endpoint}`;
    const response = await send(
      this.fetch,
      `${identity.origin}/youtubei/v1/${endpoint}?prettyPrint=false`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(identity.userAgent ? { "User-Agent": identity.userAgent } : {}),
          "X-YouTube-Client-Name": String(identity.nameId),
          "X-YouTube-Client-Version": identity.version,
          Origin: identity.origin,
          ...(request.visitorData ? { "X-Goog-Visitor-Id": request.visitorData } : {}),
          ...request.headers,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: identity.name,
              clientVersion: identity.version,
              ...identity.context,
              userAgent: identity.userAgent,
              hl: request.hl ?? this.lang,
              gl: this.country,
              utcOffsetMinutes: this.utcOffsetMinutes,
              visitorData: request.visitorData,
            },
            thirdParty: request.thirdParty,
            user: request.user,
          },
          videoId: request.videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          ...request.body,
        }),
        signal,
      },
      what,
    );
    if (response.status === 404 && request.notFound) {
      response.body?.cancel().catch(ignore);
      throw new YtdlError("NOT_FOUND", request.notFound);
    }
    if (!response.ok) throw await answerError(response, signal, what);
    const text = await bodyText(response, signal, what);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new YtdlError("REQUEST_FAILED", `${what} returned invalid JSON`, { cause });
    }
    if (!isRecord(json)) throw new YtdlError("REQUEST_FAILED", `${what} returned no object`);
    return json;
  }
}

async function answerError(response: Response, signal: AbortSignal | undefined, what: string): Promise<YtdlError> {
  const body = await bodyText(response, signal, what).catch(() => "");
  signal?.throwIfAborted();
  let error: unknown;
  try {
    error = at(JSON.parse(body), "error");
  } catch {}
  const detail = [str(at(error, "status")), str(at(error, "message"))].filter(Boolean).join(": ");
  return statusError(response.status, what, detail);
}

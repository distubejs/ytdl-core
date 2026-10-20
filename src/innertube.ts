import { type ClientDefinition, CLIENTS, type Client, userAgentHeader, YOUTUBE_ORIGIN } from "./clients.ts";
import { YtdlError } from "./errors.ts";
import { expectOk, fetchText, ignore, send } from "./http.ts";
import { at, isRecord, type Json, str, ytcfg } from "./json.ts";

export interface RequestContext {
  readonly fetch: typeof fetch;
  readonly lang: string | undefined;
  readonly country: string | undefined;
  readonly signal: AbortSignal | undefined;
}

// Without visitor data every client answers "confirm you're not a bot"; `sw.js_data` hands one out.
export async function fetchVisitorData(context: RequestContext): Promise<string> {
  const what = "YouTube visitor data";
  const body = await fetchText(
    context.fetch,
    `${YOUTUBE_ORIGIN}/sw.js_data`,
    { headers: userAgentHeader("visionos"), signal: context.signal },
    what,
  );
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

type Identity = Pick<ClientDefinition, "name" | "nameId" | "version" | "userAgent" | "context" | "origin">;

interface InnertubeRequest {
  readonly videoId?: string;
  readonly visitorData: string | undefined;
  readonly body?: Json;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly thirdParty?: Json | undefined;
  readonly notFound?: string;
}

async function innertube(
  context: RequestContext,
  endpoint: "player" | "next" | "navigation/resolve_url" | "search" | "browse",
  identity: Identity,
  request: InnertubeRequest,
): Promise<Json> {
  const what = `YouTube ${identity.name} ${endpoint}`;
  const response = await send(
    context.fetch,
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
            hl: context.lang ?? "en",
            gl: context.country ?? "US",
            visitorData: request.visitorData,
          },
          thirdParty: request.thirdParty,
        },
        videoId: request.videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        ...request.body,
      }),
      signal: context.signal,
    },
    what,
  );
  if (response.status === 404 && request.notFound) {
    response.body?.cancel().catch(ignore);
    throw new YtdlError("NOT_FOUND", request.notFound);
  }
  let json: unknown;
  try {
    json = await expectOk(response, what).json();
  } catch (cause) {
    if (YtdlError.is(cause)) throw cause;
    throw new YtdlError("REQUEST_FAILED", `${what} returned invalid JSON`, { cause });
  }
  if (!isRecord(json)) throw new YtdlError("REQUEST_FAILED", `${what} returned no object`);
  return json;
}

interface PlayerRequest {
  readonly client: Client;
  readonly videoId: string;
  readonly visitorData: string | undefined;
  readonly signatureTimestamp: number | undefined;
  readonly poToken: string | undefined;
  readonly authHeaders: Readonly<Record<string, string>> | undefined;
  readonly embed: EmbedContext | undefined;
}

interface EmbedContext {
  readonly visitorData: string | undefined;
  readonly hostFlags: string | undefined;
}

// An embedded player request plays only with the host flags and visitor data of an embed page on a third-party site.
const EMBED_HOST = "https://www.reddit.com/";

export async function fetchEmbedContext(context: RequestContext, videoId: string): Promise<EmbedContext> {
  const page = await fetchText(
    context.fetch,
    `${YOUTUBE_ORIGIN}/embed/${encodeURIComponent(videoId)}?html5=1`,
    { headers: { ...userAgentHeader("web_embedded"), Referer: EMBED_HOST }, signal: context.signal },
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

export function requestPlayer(context: RequestContext, request: PlayerRequest): Promise<Json> {
  return innertube(context, "player", CLIENTS[request.client], {
    videoId: request.videoId,
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

export function requestNext(context: RequestContext, videoId: string, visitorData: string | undefined): Promise<Json> {
  return innertube(context, "next", CLIENTS.web, { videoId, visitorData });
}

// Search params `EgIQAQ==` select the "Videos" type filter.
const VIDEOS_ONLY = "EgIQAQ%3D%3D";

export function requestSearch(
  context: RequestContext,
  page: { readonly query: string } | { readonly continuation: string },
  visitorData: string,
): Promise<Json> {
  return innertube(context, "search", CLIENTS.web, {
    visitorData,
    body: "query" in page ? { query: page.query, params: VIDEOS_ONLY } : { continuation: page.continuation },
  });
}

export function requestBrowse(
  context: RequestContext,
  page: { readonly playlistId: string } | { readonly continuation: string },
  visitorData: string,
): Promise<Json> {
  return innertube(context, "browse", CLIENTS.web, {
    visitorData,
    body: "playlistId" in page ? { browseId: `VL${page.playlistId}` } : { continuation: page.continuation },
  });
}

// Only `microformat` is read: the WEB formats are SABR-only and the playback clients omit it.
export function requestWebMetadata(
  context: RequestContext,
  videoId: string,
  visitorData: string | undefined,
): Promise<Json> {
  return innertube(context, "player", CLIENTS.web, { videoId, visitorData });
}

/** The video a channel's `/live` URL plays now. */
export async function resolveChannelLive(context: RequestContext, url: string): Promise<string> {
  const answer = await innertube(context, "navigation/resolve_url", CLIENTS.web, {
    visitorData: undefined,
    body: { url },
    notFound: `${url} names no channel`,
  });
  const videoId = str(at(answer, "endpoint", "watchEndpoint", "videoId"));
  if (!videoId || !/^[\w-]{11}$/u.test(videoId)) throw new YtdlError("NOT_FOUND", `${url} has no live stream`);
  return videoId;
}

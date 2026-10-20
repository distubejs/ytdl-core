import type { Readable } from "node:stream";
import { CookieAuth } from "./auth.ts";
import { CLIENTS, DEFAULT_CLIENTS, userAgentHeader } from "./clients.ts";
import { YtdlError } from "./errors.ts";
import { createNodeStream, createWebStream, type DeliveryInput, type ResumeRequest } from "./delivery/index.ts";
import { chooseFormat, sameFormat } from "./formats.ts";
import { parseHlsMaster } from "./delivery/hls.ts";
import { captionUrl, checkFormat, chooseTrack } from "./captions.ts";
import { browsePlaylist, checkLimit, checkQuery, fetchSuggestions, relatedVideos, searchVideos } from "./discovery.ts";
import { basicInfo, type InfoBase } from "./info.ts";
import { fetchText } from "./http.ts";
import { requestNext, requestWebMetadata, resolveChannelLive } from "./innertube.ts";
import { at, isRecord, type Json } from "./json.ts";
import {
  planClients,
  replaceVisitorData,
  type Resolution,
  requestContext,
  resolvePlayback,
  type ResolverState,
  visitorData,
} from "./resolve.ts";
import {
  CaptionFormat,
  type CaptionOptions,
  type DownloadOptions,
  type ListOptions,
  type LookupOptions,
  type PlaylistInfo,
  type VideoFormat,
  type VideoInfo,
  type VideoSummary,
  type YtdlOptions,
} from "./types.ts";
import { getVideoTarget, parsePlaylistId, type VideoTarget } from "./url.ts";

/**
 * One YouTube session: visitor data, blocked clients, account and PO tokens belong to the
 * instance. Use one instance per account or network identity.
 */
export class Ytdl {
  readonly #state: ResolverState;
  readonly #lookups = new WeakMap<VideoInfo, Pick<Resolution, "visitorData" | "sabr">>();

  constructor(options: YtdlOptions = {}) {
    if (options.getPoToken !== undefined && typeof options.getPoToken !== "function") {
      throw new YtdlError("INVALID_ARGUMENT", "getPoToken must be a function");
    }
    if (options.fetch !== undefined && typeof options.fetch !== "function") {
      throw new YtdlError("INVALID_ARGUMENT", "fetch must be a function");
    }
    const clients = options.clients ?? DEFAULT_CLIENTS;
    if (
      !Array.isArray(clients) ||
      clients.length === 0 ||
      new Set(clients).size !== clients.length ||
      !clients.every((client) => Object.hasOwn(CLIENTS, client))
    ) {
      throw new YtdlError("INVALID_ARGUMENT", "clients must list distinct Client values");
    }
    const credentials = { cookie: options.cookie !== undefined, poToken: options.getPoToken !== undefined };
    if (planClients({ clients, ...credentials }, new Map(), 0).length === 0) {
      throw new YtdlError("INVALID_ARGUMENT", "every listed client needs a cookie or getPoToken this instance lacks");
    }
    const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#state = {
      fetch: fetcher,
      lang: options.lang,
      country: options.country,
      playerId: options.playerId,
      clients,
      auth: options.cookie === undefined ? undefined : new CookieAuth({ cookie: options.cookie, fetch: fetcher }),
      getPoToken: options.getPoToken,
      blocked: new Map(),
      visitor: undefined,
    };
  }

  /**
   * Video details, related videos and formats whose URLs are ready to request. A channel's live URL,
   * such as `https://www.youtube.com/@NASA/live`, looks up the stream it plays now.
   */
  async getInfo(video: string, options: LookupOptions = {}): Promise<VideoInfo> {
    const id = await this.#videoId(getVideoTarget(video), options.signal);
    const resolution = await resolvePlayback(this.#state, id, { signal: options.signal });
    const [basic, formats] = await Promise.all([
      this.#basic(id, resolution, options.signal),
      this.#playableFormats(resolution, options.signal),
    ]);
    return this.#toInfo(basic, resolution, formats);
  }

  /** Streams one format as a Node `Readable`. */
  download(video: string | VideoInfo, options: DownloadOptions = {}): Readable {
    const target = typeof video === "string" ? getVideoTarget(video) : { id: video.videoDetails.id };
    return createNodeStream((signal) => this.#prepare(target, video, options, signal), options);
  }

  /** The same delivery as {@link download}, as a web `ReadableStream`. */
  downloadReadableStream(video: string | VideoInfo, options: DownloadOptions = {}): ReadableStream<Uint8Array> {
    const target = typeof video === "string" ? getVideoTarget(video) : { id: video.videoDetails.id };
    return createWebStream((signal) => this.#prepare(target, video, options, signal), options);
  }

  /**
   * YouTube's own text for one caption track, not parsed into cues. The format is `CaptionFormat.Vtt` unless
   * `format` says otherwise. `lang` must equal a track's `languageCode`, so `de` does not match `de-DE`.
   * YouTube's timedtext endpoint answers HTTP 429 after a few quick requests from one IP, which rejects with
   * `RATE_LIMITED` and is not retried, so cache the text.
   */
  async getCaptions(video: string | VideoInfo, options: CaptionOptions = {}): Promise<string> {
    const { signal } = options;
    checkFormat(options.format);
    const info =
      this.#unexpired(video) ??
      (await this.getInfo(typeof video === "string" ? video : video.videoDetails.id, { signal }));
    signal?.throwIfAborted();
    const track = chooseTrack(info.captionTracks, options.lang);
    const url = captionUrl(track, options.format ?? CaptionFormat.Vtt);
    return fetchText(this.#state.fetch, url, { headers: userAgentHeader(info.client), signal }, "YouTube captions");
  }

  /**
   * Videos matching `query` in YouTube's rank order, at most `limit` (20 unless set), across as many result
   * pages as that takes. Channels, playlists and shelves are left out. Discovery requests share the instance's
   * visitor data and never send the `cookie`.
   */
  async search(query: string, options: ListOptions = {}): Promise<readonly VideoSummary[]> {
    checkQuery(query);
    const limit = checkLimit(options.limit) ?? 20;
    const context = requestContext(this.#state, options.signal);
    return searchVideos(context, await visitorData(this.#state, context), query, limit);
  }

  /**
   * A playlist by ID or by a YouTube URL with a `list` parameter, with its entries in playlist order across
   * pages: all of them, or the first `limit`. Entries YouTube marks unplayable are left out.
   */
  async getPlaylist(playlist: string, options: ListOptions = {}): Promise<PlaylistInfo> {
    const id = parsePlaylistId(playlist);
    if (id === undefined) {
      throw new YtdlError("INVALID_URL", `Not a YouTube playlist URL or ID: ${String(playlist).slice(0, 200)}`);
    }
    const limit = checkLimit(options.limit) ?? Number.POSITIVE_INFINITY;
    const context = requestContext(this.#state, options.signal);
    return browsePlaylist(context, await visitorData(this.#state, context), id, limit);
  }

  /**
   * The related videos `getInfo` returns as `relatedVideos`, from one `next` request and no player lookup.
   * Takes the same input as {@link getInfo}.
   */
  async getRelated(video: string, options: LookupOptions = {}): Promise<readonly VideoSummary[]> {
    const target = getVideoTarget(video);
    const context = requestContext(this.#state, options.signal);
    const id = await this.#videoId(target, options.signal);
    return relatedVideos(await requestNext(context, id, await visitorData(this.#state, context)));
  }

  /** YouTube's autocomplete completions for `query` in provider order, asked in the instance's `lang` and `country`. */
  async getSuggestions(query: string, options: LookupOptions = {}): Promise<readonly string[]> {
    checkQuery(query);
    return fetchSuggestions(requestContext(this.#state, options.signal), query);
  }

  #unexpired(video: string | VideoInfo): VideoInfo | undefined {
    return typeof video !== "string" && video.expiresAt > Date.now() + 60_000 ? video : undefined;
  }

  #videoId(target: VideoTarget, signal: AbortSignal | undefined): Promise<string> | string {
    return "id" in target ? target.id : resolveChannelLive(requestContext(this.#state, signal), target.channelLive);
  }

  async #prepare(
    target: VideoTarget,
    video: string | VideoInfo,
    options: DownloadOptions,
    signal: AbortSignal,
  ): Promise<DeliveryInput> {
    const id = await this.#videoId(target, signal);
    let info = this.#unexpired(video) ?? (await this.getInfo(id, { signal }));
    let format = chooseFormat(info.formats, options);
    if (format.url === undefined && !this.#lookups.get(info)?.sabr) {
      info = await this.getInfo(id, { signal });
      format = chooseFormat(info.formats, { ...options, format });
    }
    options.onInfo?.(info, format);
    const { getPoToken, auth } = this.#state;
    return {
      info,
      format,
      fetch: this.#state.fetch,
      options,
      resume: (request) => this.#resume(info, request),
      sabr: (current) => this.#lookups.get(current)?.sabr,
      mintPoToken:
        getPoToken &&
        (async (current, tokenSignal) => {
          const visitor = this.#lookups.get(current)?.visitorData;
          const dataSyncId = visitor ? undefined : await auth?.dataSyncId(tokenSignal);
          return getPoToken({
            videoId: "",
            client: current.client,
            visitorData: visitor,
            dataSyncId,
            signal: tokenSignal,
          });
        }),
    };
  }

  async #resume(previous: VideoInfo, request: ResumeRequest): Promise<{ info: VideoInfo; format: VideoFormat }> {
    const { format: failed, attempt, reason, signal } = request;
    const visitor = this.#lookups.get(previous)?.visitorData;
    if (attempt <= 1) {
      if (visitor) await replaceVisitorData(this.#state, requestContext(this.#state, signal), visitor);
    } else if (reason === "HTTP 403") {
      this.#state.blocked.set(failed.client, Date.now());
    }
    const resolution = await resolvePlayback(this.#state, previous.videoDetails.id, {
      signal,
      format: failed,
      prefer: attempt <= 1 ? [failed.client] : undefined,
    });
    const formats = await this.#playableFormats(resolution, signal);
    const format = formats.find(
      (candidate) => sameFormat(candidate, failed) && candidate.contentLength === failed.contentLength,
    );
    if (!format) throw new YtdlError("NO_FORMAT", `No client offers the same itag ${failed.itag} file after ${reason}`);
    return { info: this.#toInfo(previous, resolution, formats), format };
  }

  #toInfo(basic: InfoBase, resolution: Resolution, formats: readonly VideoFormat[]): VideoInfo {
    const info: VideoInfo = {
      videoDetails: basic.videoDetails,
      relatedVideos: basic.relatedVideos,
      playerResponse: basic.playerResponse,
      captionTracks: basic.captionTracks,
      formats,
      client: resolution.client,
      hlsManifestUrl: resolution.hlsManifestUrl,
      expiresAt: resolution.expiresAt,
      playableAt: resolution.playableAt,
    };
    this.#lookups.set(info, { visitorData: resolution.visitorData, sabr: resolution.sabr });
    return info;
  }

  async #basic(id: string, resolution: Resolution, signal: AbortSignal | undefined): Promise<InfoBase> {
    const context = requestContext(this.#state, signal);
    const visitor = resolution.visitorData;
    const [next, web] = await Promise.all([
      requestNext(context, id, visitor).catch(() => ({}) as Json),
      at(resolution.player, "microformat") === undefined
        ? requestWebMetadata(context, id, visitor).catch(() => ({}) as Json)
        : Promise.resolve({} as Json),
    ]);
    signal?.throwIfAborted();
    const microformat = at(resolution.player, "microformat") ?? at(web, "microformat");
    const player: Json = isRecord(microformat) ? { ...resolution.player, microformat } : resolution.player;
    return basicInfo(player, next, {
      ageRestricted: resolution.attempts.some((attempt) => attempt.code === "AGE_RESTRICTED"),
    });
  }

  async #playableFormats(resolution: Resolution, signal: AbortSignal | undefined): Promise<readonly VideoFormat[]> {
    if (at(resolution.player, "videoDetails", "isLive") !== true || !resolution.hlsManifestUrl) {
      return resolution.formats;
    }
    const playlist = await fetchText(
      this.#state.fetch,
      resolution.hlsManifestUrl,
      { headers: userAgentHeader(resolution.client), signal },
      "YouTube HLS manifest",
    );
    return [...parseHlsMaster(playlist, resolution.hlsManifestUrl, resolution.client), ...resolution.formats];
  }
}

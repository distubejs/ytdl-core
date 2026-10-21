import type { Readable } from "node:stream";
import { CookieAuth } from "./auth.ts";
import { CLIENTS, DEFAULT_CLIENTS, userAgentHeader } from "./clients.ts";
import { YtdlError } from "./errors.ts";
import { timed } from "./http.ts";
import { deliver, type Delivery, Media, type Playback, type ResumeRequest } from "./delivery/index.ts";
import { checkPlayable, chooseFormat, sameFormat } from "./formats.ts";
import { parseHlsMaster } from "./delivery/hls.ts";
import { captionUrl, checkFormat, chooseTrack } from "./captions.ts";
import { browsePlaylist, checkLimit, checkQuery, fetchSuggestions, relatedVideos, searchVideos } from "./discovery.ts";
import { basicInfo, type InfoBase } from "./info.ts";
import { InnerTube } from "./innertube.ts";
import { at, isRecord, type Json } from "./json.ts";
import { planClients, type Resolution, Resolver } from "./resolve.ts";
import { CaptionFormat, type CaptionOptions } from "./captions.ts";
import type { DownloadOptions } from "./delivery/index.ts";
import type { VideoFormat } from "./formats.ts";
import type { VideoInfo } from "./info.ts";
import type { PlaylistInfo, VideoSummary } from "./discovery.ts";
import { getVideoTarget, parsePlaylistId, type VideoTarget } from "./url.ts";
import type { GetPoToken } from "./po-token/index.ts";
import type { Client } from "./clients.ts";

export interface YtdlOptions {
  /** `Cookie` header or Netscape cookie export of a signed-in YouTube session. */
  readonly cookie?: string;
  /** Mints PO tokens; clients that need one are skipped without it. */
  readonly getPoToken?: GetPoToken;
  /**
   * Clients to ask, most preferred first.
   * @defaultValue `DEFAULT_CLIENTS`
   */
  readonly clients?: readonly Client[];
  /**
   * Every request goes through this; pass one bound to a proxy or local address.
   * @defaultValue `globalThis.fetch`
   */
  readonly fetch?: typeof fetch;
  /**
   * InnerTube `hl`, the language of titles and messages.
   * @defaultValue `"en"`
   */
  readonly lang?: string;
  /**
   * InnerTube `gl`, the content region.
   * @defaultValue `"US"`
   */
  readonly country?: string;
  /** Pins the player.js version used for solving. */
  readonly playerId?: string;
  /**
   * Milliseconds a request may wait for its response headers or its next body chunk before it fails with
   * `REQUEST_FAILED`.
   * @defaultValue `30000`
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export interface LookupOptions {
  /** Aborting it cancels the lookup or download. */
  readonly signal?: AbortSignal;
}

export interface ListOptions extends LookupOptions {
  /** Stops collecting at this many videos; a positive integer. */
  readonly limit?: number;
}

/**
 * One YouTube session: visitor data, blocked clients, account and PO tokens belong to the
 * instance. Use one instance per account or network identity.
 */
export class Ytdl {
  readonly #innertube: InnerTube;
  readonly #resolver: Resolver;
  readonly #delivery: Delivery;

  constructor(options: YtdlOptions = {}) {
    if (options.getPoToken !== undefined && typeof options.getPoToken !== "function") {
      throw new YtdlError("INVALID_ARGUMENT", "getPoToken must be a function");
    }
    if (options.fetch !== undefined && typeof options.fetch !== "function") {
      throw new YtdlError("INVALID_ARGUMENT", "fetch must be a function");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new YtdlError("INVALID_ARGUMENT", "timeoutMs must be a finite number above 0");
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
    const fetcher = timed(options.fetch ?? globalThis.fetch.bind(globalThis), timeoutMs);
    this.#innertube = new InnerTube({ fetch: fetcher, lang: options.lang, country: options.country });
    const auth = options.cookie === undefined ? undefined : new CookieAuth({ cookie: options.cookie, fetch: fetcher });
    const { getPoToken } = options;
    this.#resolver = new Resolver({
      innertube: this.#innertube,
      clients,
      auth,
      getPoToken,
      playerId: options.playerId,
    });
    this.#delivery = {
      fetch: fetcher,
      resume: (request) => this.#resume(request),
      mintPoToken:
        getPoToken &&
        ((info, signal) => getPoToken({ contentBinding: info.videoDetails.id, client: info.client, signal })),
    };
  }

  /**
   * Video details, related videos and formats whose URLs are ready to request. A channel's live URL,
   * such as `https://www.youtube.com/@NASA/live`, looks up the stream it plays now.
   */
  async getInfo(video: string, options: LookupOptions = {}): Promise<VideoInfo> {
    const id = await this.#videoId(getVideoTarget(video), options.signal);
    const resolution = await this.#resolver.resolve(id, { signal: options.signal });
    const [basic, formats] = await Promise.all([
      this.#basic(id, resolution, options.signal),
      this.#playableFormats(resolution, options.signal),
    ]);
    return this.#toInfo(basic, resolution, formats);
  }

  /**
   * Streams the format `chooseFormat` picks as a Node `Readable`. An unexpired info is used as is; `Readable.toWeb`
   * turns the stream into a web `ReadableStream`.
   */
  download(video: string | VideoInfo, options: DownloadOptions = {}): Readable {
    const target = typeof video === "string" ? getVideoTarget(video) : { id: video.videoDetails.id };
    return deliver(this.#delivery, (signal) => this.#prepare(target, video, options, signal), options);
  }

  /**
   * One format of `info`, read as often as needed without another lookup. A read that re-resolves after a 403 or
   * an expired URL refreshes `Media#info`, and later reads start from it.
   */
  open(info: VideoInfo, format: VideoFormat): Media {
    const own = info.formats.find((candidate) => sameFormat(candidate, format));
    if (!own) throw new YtdlError("NO_FORMAT", `itag ${format.itag} is not a format of ${info.videoDetails.id}`);
    checkPlayable(own);
    return new Media(this.#delivery, info, own);
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
    return this.#innertube.text(url, { headers: userAgentHeader(info.client), signal }, "YouTube captions");
  }

  /**
   * Videos matching `query` in YouTube's rank order, at most `limit` (20 unless set), across as many result
   * pages as that takes. Channels, playlists and shelves are left out. Discovery requests share the instance's
   * visitor data and never send the `cookie`.
   */
  async search(query: string, options: ListOptions = {}): Promise<readonly VideoSummary[]> {
    checkQuery(query);
    const limit = checkLimit(options.limit) ?? 20;
    return searchVideos(this.#innertube, query, limit, options.signal);
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
    return browsePlaylist(this.#innertube, id, limit, options.signal);
  }

  /**
   * The related videos `getInfo` returns as `relatedVideos`, from one `next` request and no player lookup.
   * Takes the same input as {@link getInfo}.
   */
  async getRelated(video: string, options: LookupOptions = {}): Promise<readonly VideoSummary[]> {
    const target = getVideoTarget(video);
    const id = await this.#videoId(target, options.signal);
    const visitor = await this.#innertube.visitorData(options.signal);
    return relatedVideos(await this.#innertube.next(id, visitor, options.signal));
  }

  /** YouTube's autocomplete completions for `query` in provider order, asked in the instance's `lang` and `country`. */
  async getSuggestions(query: string, options: LookupOptions = {}): Promise<readonly string[]> {
    checkQuery(query);
    return fetchSuggestions(this.#innertube, query, options.signal);
  }

  #unexpired(video: string | VideoInfo): VideoInfo | undefined {
    return typeof video !== "string" && video.expiresAt > Date.now() + 60_000 ? video : undefined;
  }

  #videoId(target: VideoTarget, signal: AbortSignal | undefined): Promise<string> | string {
    return "id" in target ? target.id : this.#innertube.channelLiveVideo(target.channelLive, signal);
  }

  async #prepare(
    target: VideoTarget,
    video: string | VideoInfo,
    options: DownloadOptions,
    signal: AbortSignal,
  ): Promise<Playback> {
    const info = this.#unexpired(video) ?? (await this.getInfo(await this.#videoId(target, signal), { signal }));
    return { info, format: chooseFormat(info.formats, options) };
  }

  async #resume(request: ResumeRequest): Promise<Playback> {
    const { info: previous, format: failed, attempt, reason, signal } = request;
    if (attempt <= 1) {
      if (previous.visitorData) await this.#innertube.replaceVisitorData(previous.visitorData, signal);
    } else if (reason === "HTTP 403") {
      this.#resolver.block(failed.client);
    }
    const resolution = await this.#resolver.resolve(previous.videoDetails.id, {
      signal,
      format: failed,
      prefer: attempt <= 1 ? [failed.client] : undefined,
    });
    const formats = await this.#playableFormats(resolution, signal);
    const format = formats.find(
      (candidate) => sameFormat(candidate, failed) && candidate.contentLength === failed.contentLength,
    );
    if (!format) throw new YtdlError("NO_FORMAT", `No client offers the same itag ${failed.itag} file after ${reason}`);
    return { info: this.#toInfo({ ...previous, playerResponse: resolution.player }, resolution, formats), format };
  }

  #toInfo(basic: InfoBase, resolution: Resolution, formats: readonly VideoFormat[]): VideoInfo {
    return {
      videoDetails: basic.videoDetails,
      relatedVideos: basic.relatedVideos,
      playerResponse: basic.playerResponse,
      captionTracks: basic.captionTracks,
      formats,
      client: resolution.client,
      hlsManifestUrl: resolution.hlsManifestUrl,
      sabr: resolution.sabr,
      visitorData: resolution.visitorData,
      expiresAt: resolution.expiresAt,
      playableAt: resolution.playableAt,
    };
  }

  async #basic(id: string, resolution: Resolution, signal: AbortSignal | undefined): Promise<InfoBase> {
    const visitor = resolution.visitorData;
    const [next, web] = await Promise.all([
      this.#innertube.next(id, visitor, signal).catch(() => ({}) as Json),
      at(resolution.player, "microformat") === undefined
        ? this.#innertube.webMetadata(id, visitor, signal).catch(() => ({}) as Json)
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
    const playlist = await this.#innertube.text(
      resolution.hlsManifestUrl,
      { headers: userAgentHeader(resolution.client), signal },
      "YouTube HLS manifest",
    );
    return [...parseHlsMaster(playlist, resolution.hlsManifestUrl, resolution.client), ...resolution.formats];
  }
}

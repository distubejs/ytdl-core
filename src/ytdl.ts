import type { Readable } from "node:stream";
import { CookieAuth } from "./auth.ts";
import { CLIENTS, DEFAULT_CLIENTS, userAgentHeader } from "./clients.ts";
import { YtdlError } from "./errors.ts";
import { consented, timed } from "./http.ts";
import { deliver, type Delivery, Media, type Playback } from "./delivery/index.ts";
import { checkPlayable, chooseFormat, sameFormat } from "./formats.ts";
import { captionUrl, checkFormat, chooseTrack } from "./captions.ts";
import {
  browsePlaylist,
  checkLimit,
  checkQuery,
  checkSafeSearch,
  checkSearchType,
  fetchSuggestions,
  relatedVideos,
  SearchType,
  searchPlaylists,
  searchVideos,
} from "./discovery.ts";
import { lookupInfo, resumeInfo } from "./info.ts";
import { InnerTube } from "./innertube.ts";
import { planClients, Resolver } from "./resolve.ts";
import { CaptionFormat, type CaptionOptions } from "./captions.ts";
import type { DownloadOptions } from "./delivery/index.ts";
import type { VideoFormat } from "./formats.ts";
import type { VideoInfo } from "./info.ts";
import type { PlaylistInfo, PlaylistSummary, VideoSummary } from "./discovery.ts";
import { getPlaylistTarget, getVideoTarget, uploads, type VideoTarget } from "./url.ts";
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
   * Every request goes through this; pass one bound to a proxy or local address. The player script and the lookup
   * of its version are shared by every instance in the process, so whichever instance needs them first fetches them
   * through its own `fetch`.
   * @defaultValue `globalThis.fetch`
   */
  readonly fetch?: typeof fetch;
  /**
   * InnerTube `hl` for titles, search, related videos and suggestions. Player answers are always English, so
   * playability is classified the same in every language and caption track names come back in English.
   * @defaultValue `"en"`
   */
  readonly lang?: string;
  /**
   * InnerTube `gl`, the content region.
   * @defaultValue `"US"`
   */
  readonly country?: string;
  /**
   * InnerTube `utcOffsetMinutes`, which YouTube uses for relative times such as "Updated 2 days ago".
   * @defaultValue `0`
   */
  readonly utcOffsetMinutes?: number;
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

export interface SearchOptions extends ListOptions {
  /**
   * Videos or playlists.
   * @defaultValue `SearchType.Video`
   */
  readonly type?: SearchType;
  /** Asks YouTube for restricted-mode results. */
  readonly safeSearch?: boolean;
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
    if (options.utcOffsetMinutes !== undefined && !Number.isInteger(options.utcOffsetMinutes)) {
      throw new YtdlError("INVALID_ARGUMENT", "utcOffsetMinutes must be an integer");
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
    const fetcher = timed(consented(options.fetch ?? globalThis.fetch.bind(globalThis)), timeoutMs);
    this.#innertube = new InnerTube({
      fetch: fetcher,
      lang: options.lang,
      country: options.country,
      utcOffsetMinutes: options.utcOffsetMinutes,
    });
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
      resume: (request) => resumeInfo(this.#innertube, this.#resolver, request),
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
    return lookupInfo(this.#innertube, this.#resolver, id, options.signal);
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
   * Videos, or playlists with `type: SearchType.Playlist`, matching `query` in YouTube's rank order, at most `limit`
   * (20 unless set), across as many result pages as that takes. Channels, shelves and mixes are left out.
   * Discovery requests share the instance's visitor data and never send the `cookie`.
   */
  search(
    query: string,
    options?: SearchOptions & { readonly type?: typeof SearchType.Video },
  ): Promise<readonly VideoSummary[]>;
  search(
    query: string,
    options: SearchOptions & { readonly type: typeof SearchType.Playlist },
  ): Promise<readonly PlaylistSummary[]>;
  search(query: string, options?: SearchOptions): Promise<readonly VideoSummary[] | readonly PlaylistSummary[]>;
  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<readonly VideoSummary[] | readonly PlaylistSummary[]> {
    checkQuery(query);
    const request = {
      limit: checkLimit(options.limit) ?? 20,
      safeSearch: checkSafeSearch(options.safeSearch),
      signal: options.signal,
    };
    return checkSearchType(options.type) === SearchType.Playlist
      ? searchPlaylists(this.#innertube, query, request)
      : searchVideos(this.#innertube, query, request);
  }

  /**
   * A playlist by ID or by a YouTube URL with a `list` parameter, or a channel's uploads by channel ID or channel URL,
   * with its entries in playlist order across pages: all of them, or the first `limit`. Entries YouTube marks
   * unplayable are left out.
   */
  async getPlaylist(playlist: string, options: ListOptions = {}): Promise<PlaylistInfo> {
    const target = getPlaylistTarget(playlist);
    const limit = checkLimit(options.limit) ?? Number.POSITIVE_INFINITY;
    const id = "id" in target ? target.id : uploads(await this.#innertube.channelId(target.channel, options.signal));
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
}

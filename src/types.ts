import type { Client } from "./clients.ts";

export interface PoTokenRequest {
  readonly videoId: string;
  readonly client: Client;
  /** The logged-out visitor the token binds to. */
  readonly visitorData: string | undefined;
  /** The signed-in account the token binds to. */
  readonly dataSyncId: string | undefined;
  readonly signal: AbortSignal | undefined;
}

/** Mints a GVS PO token; plug in `createPoTokenProvider()` or your own minter. */
export type GetPoToken = (request: PoTokenRequest) => Promise<string>;

export interface YtdlOptions {
  /** `Cookie` header of a signed-in YouTube session; `ytdl-core cookies` converts an export. */
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
}

export interface LookupOptions {
  /** Aborting it cancels the lookup or download. */
  readonly signal?: AbortSignal;
}

/**
 * Named format qualities for `chooseFormat` and `download`.
 * @enum
 */
export const Quality = {
  /** The top format when ranked by known size, then audio and video together, then resolution and bitrate. */
  Highest: "highest",
  /** The bottom format of the `Highest` ranking. */
  Lowest: "lowest",
  /** The format with the best audio; among equals, the smallest video. */
  HighestAudio: "highestaudio",
  /** The format with the smallest audio. */
  LowestAudio: "lowestaudio",
  /** The format with the best video; among equals, the smallest audio. */
  HighestVideo: "highestvideo",
  /** The format with the smallest video. */
  LowestVideo: "lowestvideo",
} as const;

/** A `Quality` value, an itag, or itags tried in order. */
export type Quality = (typeof Quality)[keyof typeof Quality] | number | readonly number[];

/**
 * Named format filters for `chooseFormat` and `download`.
 * @enum
 */
export const Filter = {
  /** Formats with both audio and video. */
  AudioAndVideo: "audioandvideo",
  /** Formats with video, with or without audio. */
  Video: "video",
  /** Formats with video and no audio. */
  VideoOnly: "videoonly",
  /** Formats with audio, with or without video. */
  Audio: "audio",
  /** Formats with audio and no video. */
  AudioOnly: "audioonly",
} as const;

/** A `Filter` value or a predicate. */
export type Filter = (typeof Filter)[keyof typeof Filter] | ((format: FormatMetadata) => boolean);

export interface ChooseFormatOptions {
  /**
   * A `Quality` value, an itag, or itags tried in order.
   * @defaultValue `Quality.Highest`
   */
  readonly quality?: Quality;
  /** A `Filter` value or `(format) => boolean`. */
  readonly filter?: Filter;
  /** Wins over `quality` and `filter`. */
  readonly format?: VideoFormat;
}

export interface DownloadOptions extends ChooseFormatOptions, LookupOptions {
  /** Inclusive byte range of the format. */
  readonly range?: { readonly start?: number; readonly end?: number };
  /**
   * Bytes per ranged request.
   * @defaultValue 10 MiB
   */
  readonly chunkSize?: number;
  /** Stream buffer limit in bytes. */
  readonly highWaterMark?: number;
  /**
   * Live only: milliseconds of segments kept buffered behind the edge.
   * @defaultValue `20000`
   */
  readonly liveBuffer?: number;
  /** Called once with the info and format before the first byte. */
  readonly onInfo?: (info: VideoInfo, format: VideoFormat) => void;
  /** Called after each chunk with the bytes received so far and the total, when known. */
  readonly onProgress?: (event: ProgressEvent) => void;
  /** Called before each re-resolution after a 403, an expired URL or a failed SABR session. */
  readonly onRetry?: (event: RetryEvent) => void;
}

export interface Thumbnail {
  readonly url: string;
  readonly width: number | undefined;
  readonly height: number | undefined;
}

export interface Author {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly thumbnails: readonly Thumbnail[];
  readonly verified: boolean | undefined;
  readonly subscriberCount: number | undefined;
}

export interface Chapter {
  readonly title: string;
  /** Seconds from the start. */
  readonly startTime: number;
}

export interface Storyboard {
  /** Contains `$M` for the sheet index. */
  readonly templateUrl: string;
  readonly thumbnailWidth: number;
  readonly thumbnailHeight: number;
  readonly thumbnailCount: number;
  /** Milliseconds between thumbnails. */
  readonly interval: number;
  readonly columns: number;
  readonly rows: number;
  readonly storyboardCount: number;
}

export interface RelatedVideo {
  readonly id: string;
  readonly title: string;
  readonly author: { readonly id: string | undefined; readonly name: string | undefined };
  readonly lengthSeconds: number | undefined;
  readonly viewCount: number | undefined;
  readonly thumbnails: readonly Thumbnail[];
  readonly isLive: boolean;
}

export interface VideoDetails {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly description: string | undefined;
  readonly lengthSeconds: number;
  readonly viewCount: number | undefined;
  readonly likes: number | undefined;
  readonly publishDate: string | undefined;
  readonly uploadDate: string | undefined;
  readonly keywords: readonly string[];
  readonly category: string | undefined;
  readonly thumbnails: readonly Thumbnail[];
  readonly author: Author;
  readonly isLive: boolean;
  readonly isUpcoming: boolean;
  readonly isUnlisted: boolean | undefined;
  readonly isFamilySafe: boolean | undefined;
  readonly isAgeRestricted: boolean;
  readonly availableCountries: readonly string[] | undefined;
  readonly chapters: readonly Chapter[];
  readonly storyboards: readonly Storyboard[];
}

export interface FormatMetadata {
  readonly itag: number;
  readonly mimeType: string;
  /** `mp4`, `webm`, `ts` and so on. */
  readonly container: string;
  readonly codecs: string;
  readonly videoCodec: string | undefined;
  readonly audioCodec: string | undefined;
  readonly bitrate: number | undefined;
  /** Kbps, for formats with audio. */
  readonly audioBitrate: number | undefined;
  readonly audioSampleRate: number | undefined;
  readonly audioChannels: number | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly fps: number | undefined;
  readonly qualityLabel: string | undefined;
  readonly contentLength: number | undefined;
  readonly approxDurationMs: number | undefined;
  readonly audioTrack: { readonly id: string; readonly name: string; readonly isDefault: boolean } | undefined;
  /** Stable-volume (DRC) audio. It shares its itag with the original, so match formats with all three of itag, `isDrc` and `audioTrack`. */
  readonly isDrc: boolean;
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
  readonly isLive: boolean;
  readonly isHLS: boolean;
  /** The client that served this format; resume asks it first. */
  readonly client: Client;
}

export interface VideoFormat extends FormatMetadata {
  /** Ready to request: solved, with any PO token attached. `undefined` for a format YouTube serves only through SABR; `download` streams it. */
  readonly url: string | undefined;
}

export interface CaptionTrack {
  /** BCP 47 code such as `en` or `pt-BR`; `getCaptions` matches `lang` against it exactly. */
  readonly languageCode: string;
  readonly name: string;
  readonly isAutoGenerated: boolean;
  /** The track YouTube turns on first. */
  readonly isDefault: boolean;
  /** Signed by YouTube and expiring with the info; `getCaptions` requests it. */
  readonly url: string;
}

/**
 * Caption text formats YouTube renders.
 * @enum
 */
export const CaptionFormat = {
  /** WebVTT, which players, `ffmpeg` and `<track>` read directly. */
  Vtt: "vtt",
  /** YouTube's XML timed text with per-word timing and styling. */
  Srv3: "srv3",
  /** JSON events. */
  Json3: "json3",
} as const;

export type CaptionFormat = (typeof CaptionFormat)[keyof typeof CaptionFormat];

export interface CaptionOptions extends LookupOptions {
  /** Exact `languageCode` of a track. Without it: the default track, else the first manual track, else the first. */
  readonly lang?: string;
  /**
   * @defaultValue `CaptionFormat.Vtt`
   */
  readonly format?: CaptionFormat;
}

export interface VideoInfo {
  readonly videoDetails: VideoDetails;
  readonly relatedVideos: readonly RelatedVideo[];
  /** The raw InnerTube player response, for fields ytdl-core does not model. */
  readonly playerResponse: unknown;
  readonly formats: readonly VideoFormat[];
  /** Empty when the video has no captions. */
  readonly captionTracks: readonly CaptionTrack[];
  readonly client: Client;
  readonly hlsManifestUrl: string | undefined;
  /** Epoch ms after which the format URLs stop working. */
  readonly expiresAt: number;
  /** Epoch ms before which an enforced preroll keeps media requests at 403. */
  readonly playableAt: number;
}

export interface ProgressEvent {
  readonly chunkBytes: number;
  readonly downloaded: number;
  readonly total: number | undefined;
}

export interface RetryEvent {
  readonly attempt: number;
  readonly client: Client;
  readonly reason: string;
}

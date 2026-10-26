import { relatedVideos } from "./discovery.ts";
import { userAgentHeader } from "./clients.ts";
import { YtdlError } from "./errors.ts";
import { parseHlsMaster, sameFormat } from "./formats.ts";
import {
  at,
  collect,
  isRecord,
  type Json,
  list,
  num,
  parseAbbreviated,
  parseClock,
  str,
  text,
  thumbnails,
} from "./json.ts";
import type { CaptionTrack } from "./captions.ts";
import type { Client } from "./clients.ts";
import type { Playback, ResumeRequest } from "./delivery/index.ts";
import type { VideoFormat } from "./formats.ts";
import type { VideoSummary } from "./discovery.ts";
import type { InnerTube } from "./innertube.ts";
import type { Resolution, Resolver } from "./resolve.ts";

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

export interface VideoInfo {
  readonly videoDetails: VideoDetails;
  readonly relatedVideos: readonly VideoSummary[];
  /** The raw InnerTube player response, for fields ytdl-core does not model. */
  readonly playerResponse: unknown;
  readonly formats: readonly VideoFormat[];
  /** Empty when the video has no captions. */
  readonly captionTracks: readonly CaptionTrack[];
  readonly client: Client;
  readonly hlsManifestUrl: string | undefined;
  /** The SABR session that streams formats without a `url`. */
  readonly sabr: { readonly url: string; readonly config: string } | undefined;
  /** The visitor ID the formats were resolved with; `undefined` when signed in. */
  readonly visitorData: string | undefined;
  /** Epoch ms after which the format URLs stop working. */
  readonly expiresAt: number;
  /** Epoch ms before which an enforced preroll keeps media requests at 403. */
  readonly playableAt: number;
}

function author(player: Json, next: Json): Author {
  const details = at(player, "videoDetails");
  const micro = at(player, "microformat", "playerMicroformatRenderer");
  const owner = collect(next, "videoOwnerRenderer")[0];
  const id = str(at(details, "channelId")) ?? str(at(micro, "externalChannelId")) ?? "";
  const badges = collect(owner, "metadataBadgeRenderer");
  return {
    id,
    name: str(at(details, "author")) ?? str(at(micro, "ownerChannelName")) ?? text(at(owner, "title")) ?? "",
    url: str(at(micro, "ownerProfileUrl")) ?? (id ? `https://www.youtube.com/channel/${id}` : ""),
    thumbnails: thumbnails(at(owner, "thumbnail", "thumbnails")),
    verified: owner ? badges.some((badge) => /VERIFIED/u.test(String(at(badge, "style")))) : undefined,
    subscriberCount: parseAbbreviated(text(at(owner, "subscriberCountText"))),
  };
}

// The spec is one string of `|`-separated levels.
function storyboards(player: Json): Storyboard[] {
  const spec = str(at(player, "storyboards", "playerStoryboardSpecRenderer", "spec"));
  if (!spec) return [];
  const [base, ...levels] = spec.split("|");
  if (!base) return [];
  return levels.flatMap((level, index) => {
    const [width, height, count, columns, rows, interval, name, sigh] = level.split("#");
    const values = [width, height, count, columns, rows, interval].map(Number);
    if (values.some((value) => !Number.isFinite(value)) || !name || !sigh) return [];
    const [thumbnailWidth = 0, thumbnailHeight = 0, thumbnailCount = 0, cols = 1, rowCount = 1, ms = 0] = values;
    const url = new URL(base.replace("$L", String(index)).replace("$N", name));
    url.searchParams.set("sigh", sigh);
    return [
      {
        templateUrl: url.href.replaceAll("%24M", "$M"),
        thumbnailWidth,
        thumbnailHeight,
        thumbnailCount,
        interval: ms,
        columns: cols,
        rows: rowCount,
        storyboardCount: Math.ceil(thumbnailCount / (cols * rowCount)),
      },
    ];
  });
}

function chapters(next: Json): Chapter[] {
  const fromMarkers = collect(next, "chapterRenderer").flatMap((chapter) => {
    const title = text(at(chapter, "title"));
    const start = num(at(chapter, "timeRangeStartMillis"));
    return title !== undefined && start !== undefined ? [{ title, startTime: start / 1000 }] : [];
  });
  if (fromMarkers.length > 0) return fromMarkers;
  return collect(next, "macroMarkersListItemRenderer").flatMap((item) => {
    const title = text(at(item, "title"));
    const start =
      num(at(item, "onTap", "watchEndpoint", "startTimeSeconds")) ?? parseClock(text(at(item, "timeDescription")));
    return title !== undefined && start !== undefined ? [{ title, startTime: start }] : [];
  });
}

function likes(next: Json): number | undefined {
  for (const button of collect(next, "likeButtonViewModel")) {
    for (const label of collect(button, "buttonViewModel")) {
      const accessibility = str(at(label, "accessibilityText"));
      if (accessibility && /along with/iu.test(accessibility))
        return parseAbbreviated(accessibility.split(/along with/iu)[1]);
    }
  }
  return undefined;
}

interface DetailsContext {
  readonly ageRestricted: boolean;
}

function videoDetails(player: Json, next: Json, context: DetailsContext): VideoDetails {
  const details = at(player, "videoDetails");
  const micro = at(player, "microformat", "playerMicroformatRenderer");
  const id = str(at(details, "videoId")) ?? "";
  const countries = at(micro, "availableCountries");
  const keywords = at(details, "keywords");
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: str(at(details, "title")) ?? text(at(micro, "title")) ?? "",
    description: str(at(details, "shortDescription")) ?? text(at(micro, "description")),
    lengthSeconds: num(at(details, "lengthSeconds")) ?? 0,
    viewCount: num(at(details, "viewCount")),
    likes: likes(next),
    publishDate: str(at(micro, "publishDate")),
    uploadDate: str(at(micro, "uploadDate")),
    keywords: Array.isArray(keywords) ? keywords.filter((word): word is string => typeof word === "string") : [],
    category: str(at(micro, "category")),
    thumbnails: thumbnails(at(details, "thumbnail", "thumbnails")),
    author: author(player, next),
    isLive: at(details, "isLive") === true,
    isUpcoming: at(details, "isUpcoming") === true,
    isUnlisted: typeof at(micro, "isUnlisted") === "boolean" ? (at(micro, "isUnlisted") as boolean) : undefined,
    isFamilySafe: typeof at(micro, "isFamilySafe") === "boolean" ? (at(micro, "isFamilySafe") as boolean) : undefined,
    isAgeRestricted: context.ageRestricted,
    availableCountries: Array.isArray(countries)
      ? countries.filter((c): c is string => typeof c === "string")
      : undefined,
    chapters: chapters(next),
    storyboards: storyboards(player),
  };
}

function captionTracks(player: Json): CaptionTrack[] {
  const renderer = at(player, "captions", "playerCaptionsTracklistRenderer");
  const audioTrack = at(renderer, "audioTracks", num(at(renderer, "defaultAudioTrackIndex")) ?? 0);
  const defaultIndex = num(at(audioTrack, "defaultCaptionTrackIndex"));
  return list(at(renderer, "captionTracks")).flatMap((track, index) => {
    const url = str(at(track, "baseUrl"));
    const languageCode = str(at(track, "languageCode"));
    if (!url || !languageCode) return [];
    return [
      {
        languageCode,
        name: text(at(track, "name")) ?? languageCode,
        isAutoGenerated: at(track, "kind") === "asr",
        isDefault: index === defaultIndex,
        url,
      },
    ];
  });
}

type InfoBase = Pick<VideoInfo, "videoDetails" | "relatedVideos" | "playerResponse" | "captionTracks">;

function toInfo(base: InfoBase, resolution: Resolution, formats: readonly VideoFormat[]): VideoInfo {
  return {
    videoDetails: base.videoDetails,
    relatedVideos: base.relatedVideos,
    playerResponse: base.playerResponse,
    captionTracks: base.captionTracks,
    formats,
    client: resolution.client,
    hlsManifestUrl: resolution.hlsManifestUrl,
    sabr: resolution.sabr,
    visitorData: resolution.visitorData,
    expiresAt: resolution.expiresAt,
    playableAt: resolution.playableAt,
  };
}

async function basicInfo(
  innertube: InnerTube,
  id: string,
  resolution: Resolution,
  signal: AbortSignal | undefined,
): Promise<InfoBase> {
  const visitor = resolution.visitorData;
  const [next, web] = await Promise.all([
    innertube.next(id, visitor, signal).catch(() => ({}) as Json),
    at(resolution.player, "microformat") === undefined
      ? innertube.webMetadata(id, visitor, signal).catch(() => ({}) as Json)
      : Promise.resolve({} as Json),
  ]);
  signal?.throwIfAborted();
  const microformat = at(resolution.player, "microformat") ?? at(web, "microformat");
  const player: Json = isRecord(microformat) ? { ...resolution.player, microformat } : resolution.player;
  const ageRestricted = resolution.attempts.some((attempt) => attempt.code === "AGE_RESTRICTED");
  return {
    videoDetails: videoDetails(player, next, { ageRestricted }),
    relatedVideos: relatedVideos(next),
    playerResponse: player,
    captionTracks: captionTracks(player),
  };
}

async function playableFormats(
  innertube: InnerTube,
  resolution: Resolution,
  signal: AbortSignal | undefined,
): Promise<readonly VideoFormat[]> {
  if (at(resolution.player, "videoDetails", "isLive") !== true || !resolution.hlsManifestUrl) {
    return resolution.formats;
  }
  let playlist: string;
  try {
    playlist = await innertube.text(
      resolution.hlsManifestUrl,
      { headers: userAgentHeader(resolution.client), signal },
      "YouTube HLS manifest",
    );
  } catch (error) {
    const failed = YtdlError.is(error, "REQUEST_FAILED") || YtdlError.is(error, "RATE_LIMITED");
    if (signal?.aborted || !failed || !resolution.formats.some((format) => format.isLive)) throw error;
    return resolution.formats;
  }
  return [...parseHlsMaster(playlist, resolution.hlsManifestUrl, resolution.client), ...resolution.formats];
}

export async function lookupInfo(
  innertube: InnerTube,
  resolver: Resolver,
  id: string,
  signal: AbortSignal | undefined,
): Promise<VideoInfo> {
  const resolution = await resolver.resolve(id, { signal });
  const [base, formats] = await Promise.all([
    basicInfo(innertube, id, resolution, signal),
    playableFormats(innertube, resolution, signal),
  ]);
  return toInfo(base, resolution, formats);
}

export async function resumeInfo(innertube: InnerTube, resolver: Resolver, request: ResumeRequest): Promise<Playback> {
  const { info: previous, format: failed, attempt, reason, signal } = request;
  if (attempt <= 1) {
    if (previous.visitorData) await innertube.replaceVisitorData(previous.visitorData, signal);
  } else if (reason === "HTTP 403") {
    resolver.block(failed.client);
  }
  const resolution = await resolver.resolve(previous.videoDetails.id, {
    signal,
    format: failed,
    prefer: attempt <= 1 ? [failed.client] : undefined,
  });
  const formats = await playableFormats(innertube, resolution, signal);
  const format = formats.find(
    (candidate) => sameFormat(candidate, failed) && candidate.contentLength === failed.contentLength,
  );
  if (!format) throw new YtdlError("NO_FORMAT", `No client offers the same itag ${failed.itag} file after ${reason}`);
  const base = { ...previous, playerResponse: resolution.player };
  return { info: toInfo(base, resolution, formats), format };
}

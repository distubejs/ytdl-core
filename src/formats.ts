import type { Client } from "./clients.ts";
import { YtdlError } from "./errors.ts";
import { at, isRecord, type Json, num, str } from "./json.ts";
import type { ChooseFormatOptions, Filter, FormatCriteria, FormatMetadata, Quality, VideoFormat } from "./types.ts";

export interface SabrSource {
  /** `serverAbrStreamingUrl` with `n` solved. */
  readonly url: string;
  /** `videoPlaybackUstreamerConfig`. */
  readonly config: string;
  readonly formats: readonly Json[];
}

export interface RawFormat {
  readonly metadata: FormatMetadata;
  readonly url: string | undefined;
  readonly signatureCipher: string | undefined;
}

// Muxed itags carry no audio bitrate field; these are YouTube's fixed values.
export const MUXED_AUDIO_KBPS: Readonly<Record<number, number>> = {
  18: 96,
  22: 192,
  91: 48,
  92: 48,
  93: 128,
  94: 128,
  95: 256,
  96: 256,
};

function splitCodecs(mimeType: string): { container: string; codecs: string; list: string[] } {
  const [type = "", params = ""] = mimeType.split(";");
  const container = type.split("/")[1]?.trim() ?? "";
  const codecs = /codecs="([^"]*)"/u.exec(params)?.[1] ?? "";
  return {
    container,
    codecs,
    list: codecs
      .split(",")
      .map((codec) => codec.trim())
      .filter(Boolean),
  };
}

export const AUDIO_CODEC = /^(?:mp4a|opus|vorbis|ac-3|ec-3|flac|mp3)/u;

export function parseFormat(entry: Json, client: Client, isLive = false): RawFormat | undefined {
  const itag = num(entry.itag);
  const mimeType = str(entry.mimeType);
  if (itag === undefined || mimeType === undefined) return undefined;
  const { container, codecs, list } = splitCodecs(mimeType);
  const isVideoType = mimeType.startsWith("video/");
  const audioCodec = list.find((codec) => AUDIO_CODEC.test(codec));
  const videoCodec = isVideoType ? list.find((codec) => !AUDIO_CODEC.test(codec)) : undefined;
  const hasAudio = mimeType.startsWith("audio/") || audioCodec !== undefined;
  const bitrate = num(entry.averageBitrate) ?? num(entry.bitrate);
  const track = at(entry, "audioTrack");
  return {
    url: str(entry.url),
    signatureCipher: str(entry.signatureCipher),
    metadata: {
      itag,
      mimeType,
      container,
      codecs,
      videoCodec,
      audioCodec,
      bitrate: num(entry.bitrate),
      audioBitrate: !hasAudio
        ? undefined
        : isVideoType
          ? MUXED_AUDIO_KBPS[itag]
          : bitrate === undefined
            ? undefined
            : Math.round(bitrate / 1000),
      audioSampleRate: num(entry.audioSampleRate),
      audioChannels: num(entry.audioChannels),
      width: num(entry.width),
      height: num(entry.height),
      fps: num(entry.fps),
      qualityLabel: str(entry.qualityLabel),
      contentLength: num(entry.contentLength),
      approxDurationMs: num(entry.approxDurationMs),
      audioTrack: isRecord(track)
        ? { id: str(track.id) ?? "", name: str(track.displayName) ?? "", isDefault: track.audioIsDefault === true }
        : undefined,
      isDrc: entry.isDrc === true,
      hasAudio,
      hasVideo: isVideoType,
      isLive,
      isHLS: false,
      client,
    },
  };
}

export function sabrSession(player: Json): SabrSource | undefined {
  const url = str(at(player, "streamingData", "serverAbrStreamingUrl"));
  const config = str(
    at(player, "playerConfig", "mediaCommonConfig", "mediaUstreamerRequestConfig", "videoPlaybackUstreamerConfig"),
  );
  const adaptive = at(player, "streamingData", "adaptiveFormats");
  if (!url || !config || !Array.isArray(adaptive)) return undefined;
  return { url, config, formats: adaptive.filter(isRecord) };
}

export function parseFormats(player: Json, client: Client): RawFormat[] {
  const streaming = at(player, "streamingData");
  const isLive = at(player, "videoDetails", "isLive") === true;
  const sabr = !isLive && sabrSession(player) !== undefined;
  const muxed = at(streaming, "formats");
  const adaptive = at(streaming, "adaptiveFormats");
  const entries = [
    ...(Array.isArray(muxed) ? muxed.map((entry: unknown) => ({ entry, isAdaptive: false })) : []),
    ...(Array.isArray(adaptive) ? adaptive.map((entry: unknown) => ({ entry, isAdaptive: true })) : []),
  ];
  const out: RawFormat[] = [];
  for (const { entry, isAdaptive } of entries) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry.drmFamilies) && entry.drmFamilies.length > 0) continue;
    if (entry.type === "FORMAT_STREAM_TYPE_OTF") continue;
    const parsed = parseFormat(entry, client, isLive);
    if (parsed && (parsed.url || parsed.signatureCipher || (sabr && isAdaptive))) out.push(parsed);
  }
  return out;
}

// YouTube's live HLS variants are muxed audio and video.
const VIDEO_ENCODINGS = ["mp4v", "avc1", "Sorenson H.283", "MPEG-4 Visual", "VP8", "VP9", "vp09", "av01", "H.264"];
const AUDIO_ENCODINGS = ["mp4a", "mp3", "vorbis", "aac", "opus", "flac"];

type Rank = (format: FormatMetadata) => number;
const qualityHeight: Rank = (format) => Number.parseInt(format.qualityLabel ?? "", 10) || 0;
const videoBitrate: Rank = (format) => (format.hasVideo ? (format.bitrate ?? 0) : 0);
const audioBitrate: Rank = (format) => format.audioBitrate ?? 0;
const videoEncoding: Rank = (format) => VIDEO_ENCODINGS.findIndex((encoding) => format.codecs.includes(encoding));
const audioEncoding: Rank = (format) => AUDIO_ENCODINGS.findIndex((encoding) => format.codecs.includes(encoding));

function compare(ranks: readonly Rank[]) {
  return (a: FormatMetadata, b: FormatMetadata): number => {
    for (const rank of ranks) {
      const difference = rank(b) - rank(a);
      if (difference !== 0) return difference;
    }
    return 0;
  };
}

const byVideo = compare([qualityHeight, videoBitrate, videoEncoding]);
const byAudio = compare([audioBitrate, audioEncoding]);
const sortFormats = compare([
  (format) => Number(format.contentLength !== undefined && format.contentLength > 0),
  (format) => Number(format.hasVideo && format.hasAudio),
  (format) => Number(format.hasVideo),
  qualityHeight,
  videoBitrate,
  audioBitrate,
  videoEncoding,
  audioEncoding,
]);

type NamedFilter = Extract<Filter, string>;
type Matcher = (format: FormatMetadata) => boolean;

const NAMED_FILTERS: Readonly<Record<NamedFilter, FormatCriteria>> = {
  audioandvideo: { hasAudio: true, hasVideo: true },
  video: { hasVideo: true },
  videoonly: { hasVideo: true, hasAudio: false },
  audio: { hasAudio: true },
  audioonly: { hasAudio: true, hasVideo: false },
};

const CRITERIA: Readonly<Record<keyof FormatCriteria, "boolean" | "string">> = {
  hasAudio: "boolean",
  hasVideo: "boolean",
  audioCodec: "string",
  videoCodec: "string",
  container: "string",
  isDrc: "boolean",
  isLive: "boolean",
};

const isCriterion = (key: string): key is keyof FormatCriteria => Object.hasOwn(CRITERIA, key);

function fieldMatches(format: FormatMetadata, key: keyof FormatCriteria, wanted: string | boolean): boolean {
  const value = format[key];
  if (value === wanted) return true;
  return (key === "audioCodec" || key === "videoCodec") && typeof value === "string" && value.split(".")[0] === wanted;
}

function matcher(filter: unknown): Matcher {
  if (typeof filter === "function") return (format) => Boolean(filter(format));
  const criteria =
    typeof filter === "string" && Object.hasOwn(NAMED_FILTERS, filter) ? NAMED_FILTERS[filter as NamedFilter] : filter;
  if (!isRecord(criteria)) throw new YtdlError("INVALID_ARGUMENT", `Unknown filter ${JSON.stringify(filter)}`);
  const fields: [keyof FormatCriteria, string | boolean][] = [];
  for (const [key, wanted] of Object.entries(criteria)) {
    if (wanted === undefined) continue;
    if (!isCriterion(key)) throw new YtdlError("INVALID_ARGUMENT", `Unknown filter criterion ${JSON.stringify(key)}`);
    if (typeof wanted !== CRITERIA[key]) {
      throw new YtdlError("INVALID_ARGUMENT", `Filter criterion ${key} must be a ${CRITERIA[key]}`);
    }
    fields.push([key, wanted as string | boolean]);
  }
  return (format) => fields.every(([key, wanted]) => fieldMatches(format, key, wanted));
}

function matchers(filter: Filter | undefined): Matcher[] {
  if (filter === undefined) return [() => true];
  if (!Array.isArray(filter)) return [matcher(filter)];
  if (filter.length === 0) throw new YtdlError("INVALID_ARGUMENT", "A filter list needs at least one entry");
  return filter.map(matcher);
}

// YouTube gives DRC variants and dubbed tracks the itag of the original.
export function sameFormat(a: FormatMetadata, b: FormatMetadata): boolean {
  return a.itag === b.itag && a.isDrc === b.isDrc && a.audioTrack?.id === b.audioTrack?.id;
}

/**
 * Filters, then picks by quality. A filter list picks with its first entry that yields a format. An
 * explicit `format` is matched in `formats`, so a fresh list's URL replaces a stale one. A DRC variant
 * is picked only when no original matches.
 */
export function chooseFormat(formats: readonly VideoFormat[], options: ChooseFormatOptions = {}): VideoFormat {
  const wanted = options.format;
  if (wanted) return formats.find((format) => sameFormat(format, wanted)) ?? wanted;
  const quality = options.quality ?? "highest";
  for (const matches of matchers(options.filter)) {
    const matching = formats.filter(matches);
    const originals = matching.filter((format) => !format.isDrc);
    const chosen = pick(originals.length > 0 ? originals : matching, quality);
    if (chosen) return chosen;
  }
  throw new YtdlError("NO_FORMAT", `No format matches quality ${JSON.stringify(quality)}`);
}

function pick(candidates: readonly VideoFormat[], quality: Quality): VideoFormat | undefined {
  if (typeof quality === "number") return candidates.find((format) => format.itag === quality);
  if (Array.isArray(quality)) {
    for (const itag of quality) {
      const chosen = candidates.find((format) => format.itag === itag);
      if (chosen) return chosen;
    }
    return undefined;
  }
  if (quality === "highest" || quality === "lowest") {
    const sorted = candidates.toSorted(sortFormats);
    return quality === "highest" ? sorted[0] : sorted.at(-1);
  }
  if (quality === "highestaudio" || quality === "lowestaudio") {
    const sorted = candidates.filter((format) => format.hasAudio).toSorted(byAudio);
    if (quality === "lowestaudio") return sorted.at(-1);
    const best = sorted[0];
    return (
      best &&
      sorted.filter((format) => byAudio(best, format) === 0).toSorted((a, b) => qualityHeight(a) - qualityHeight(b))[0]
    );
  }
  if (quality === "highestvideo" || quality === "lowestvideo") {
    const sorted = candidates.filter((format) => format.hasVideo).toSorted(byVideo);
    if (quality === "lowestvideo") return sorted.at(-1);
    const best = sorted[0];
    return (
      best &&
      sorted.filter((format) => byVideo(best, format) === 0).toSorted((a, b) => audioBitrate(a) - audioBitrate(b))[0]
    );
  }
  return undefined;
}

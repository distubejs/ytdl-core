import { inspect } from "node:util";
import type { Client } from "./clients.ts";
import { YtdlError } from "./errors.ts";
import { at, isRecord, type Json, num, str } from "./json.ts";

/**
 * Named format qualities for `chooseFormat` and `download`.
 * @enum
 */
export const Quality = {
  /** The top format when ranked by known size, then audio and video together, then resolution and bitrate. */
  Highest: "highest",
  /** The bottom format of the `Highest` ranking that has a known bitrate; the bottom one when none has. */
  Lowest: "lowest",
  /** The format with the best audio; among equals, the smallest video. */
  HighestAudio: "highestaudio",
  /** The format with the smallest audio and a known bitrate; the smallest when none has. */
  LowestAudio: "lowestaudio",
  /** The format with the best video; among equals, the smallest audio. */
  HighestVideo: "highestvideo",
  /** The format with the smallest video and a known bitrate; the smallest when none has. */
  LowestVideo: "lowestvideo",
} as const;

/** A `Quality` value, an itag, or itags tried in order. */
export type Quality = (typeof Quality)[keyof typeof Quality] | number | readonly number[];

/** Format fields that must all match. A codec matches exactly or by its family before the first `.`. */
export interface FormatCriteria {
  readonly hasAudio?: boolean;
  readonly hasVideo?: boolean;
  readonly audioCodec?: string;
  readonly videoCodec?: string;
  readonly container?: string;
  readonly isDrc?: boolean;
  readonly isLive?: boolean;
}

type SingleFilter = FormatCriteria | ((format: FormatMetadata) => boolean);

/** Criteria, a predicate, or a list of those tried in order. */
export type Filter = SingleFilter | readonly SingleFilter[];

export interface ChooseFormatOptions {
  /**
   * A `Quality` value, an itag, or itags tried in order.
   * @defaultValue `Quality.Highest`
   */
  readonly quality?: Quality;
  /**
   * `FormatCriteria`, `(format) => boolean`, or a list of those. A list picks with the first entry that
   * yields a format under `quality`.
   */
  readonly filter?: Filter;
  /** Wins over `quality` and `filter`. */
  readonly format?: VideoFormat;
}

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export interface AudioTrack {
  readonly id: string;
  readonly displayName: string;
  readonly audioIsDefault: boolean;
}

/** The caption track a timed-text format carries, such as a live stream's auto-generated captions. */
export interface FormatCaptionTrack {
  readonly id: string;
  readonly displayName: string;
  readonly vssId: string;
  readonly languageCode: string;
  /** `asr` for auto-generated captions. */
  readonly kind?: string;
}

export interface ColorInfo {
  readonly primaries?: string;
  readonly transferCharacteristics?: string;
  readonly matrixCoefficients?: string;
}

/**
 * One format as YouTube lists it, under YouTube's field names, plus fields ytdl-core derives. A field YouTube
 * omits is absent; numeric strings are numbers.
 */
export interface FormatMetadata {
  readonly itag: number;
  readonly mimeType: string;
  /** `mp4`, `webm`, `ts` and so on. */
  readonly container: string;
  readonly codecs: string;
  readonly videoCodec: string | undefined;
  readonly audioCodec: string | undefined;
  /** Kbps, for formats with audio. */
  readonly audioBitrate: number | undefined;
  /** Stable-volume (DRC) audio. It shares its itag with the original, so match formats with all three of itag, `isDrc` and `audioTrack.id`. */
  readonly isDrc: boolean;
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
  readonly isLive: boolean;
  readonly isHLS: boolean;
  /** Encrypted; listed, but never chosen or opened. */
  readonly isDrm: boolean;
  /** Served as OTF segments, which ytdl-core cannot read; listed, but never chosen or opened. */
  readonly isOtf: boolean;
  /** The client that served this format; resume asks it first. */
  readonly client: Client;
  readonly bitrate?: number;
  readonly averageBitrate?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly quality?: string;
  readonly qualityLabel?: string;
  readonly qualityOrdinal?: string;
  readonly audioQuality?: string;
  readonly audioSampleRate?: number;
  readonly audioChannels?: number;
  readonly contentLength?: number;
  readonly approxDurationMs?: number;
  /** Microseconds since the epoch. */
  readonly lastModified?: number;
  /** Bytes of the container header. */
  readonly initRange?: ByteRange;
  /** Bytes of the container's seek index. */
  readonly indexRange?: ByteRange;
  /** Live segment length. */
  readonly targetDurationSec?: number;
  /** How far behind the live edge the stream can be read. */
  readonly maxDvrDurationSec?: number;
  readonly audioTrack?: AudioTrack;
  readonly captionTrack?: FormatCaptionTrack;
  readonly loudnessDb?: number;
  readonly trackAbsoluteLoudnessLkfs?: number;
  readonly isVb?: boolean;
  readonly appliedDrcTargetCenterForBackgroundDb?: number;
  readonly appliedVocalsGainFactor?: number;
  readonly vocalsBackgroundLoudnessDifferenceDb?: number;
  readonly colorInfo?: ColorInfo;
  readonly projectionType?: string;
  readonly xtags?: string;
  readonly highReplication?: boolean;
  readonly drmFamilies?: readonly string[];
  /** `FORMAT_STREAM_TYPE_OTF` for an OTF format. */
  readonly type?: string;
}

export interface VideoFormat extends FormatMetadata {
  /** Ready to request: solved, with any PO token attached. `undefined` for a format YouTube serves only through SABR; `download` streams it. */
  readonly url: string | undefined;
}

export interface SabrSource {
  /** `serverAbrStreamingUrl` with `n` solved. */
  readonly url: string;
  /** `videoPlaybackUstreamerConfig`. */
  readonly config: string;
}

export interface RawFormat {
  readonly metadata: FormatMetadata;
  readonly url: string | undefined;
  readonly signatureCipher: string | undefined;
}

// Muxed itags and live HLS audio renditions carry no audio bitrate field; these are YouTube's fixed values.
export const FIXED_AUDIO_KBPS: Readonly<Record<number, number>> = {
  18: 96,
  22: 192,
  91: 48,
  92: 48,
  93: 128,
  94: 128,
  95: 256,
  96: 256,
  233: 48,
  234: 128,
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

const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

function range(value: unknown): ByteRange | undefined {
  const start = num(at(value, "start"));
  const end = num(at(value, "end"));
  return start === undefined || end === undefined ? undefined : { start, end };
}

function audioTrack(value: unknown): AudioTrack | undefined {
  if (!isRecord(value)) return undefined;
  return {
    id: str(value.id) ?? "",
    displayName: str(value.displayName) ?? "",
    audioIsDefault: value.audioIsDefault === true,
  };
}

function captionTrack(value: unknown): FormatCaptionTrack | undefined {
  if (!isRecord(value)) return undefined;
  return defined({
    id: str(value.id) ?? "",
    displayName: str(value.displayName) ?? "",
    vssId: str(value.vssId) ?? "",
    languageCode: str(value.languageCode) ?? "",
    kind: str(value.kind),
  });
}

function colorInfo(value: unknown): ColorInfo | undefined {
  if (!isRecord(value)) return undefined;
  return defined({
    primaries: str(value.primaries),
    transferCharacteristics: str(value.transferCharacteristics),
    matrixCoefficients: str(value.matrixCoefficients),
  });
}

function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

// Optional fields YouTube omits stay absent instead of holding `undefined`.
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

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
  const drmFamilies = strings(entry.drmFamilies);
  const type = str(entry.type);
  return {
    url: str(entry.url),
    signatureCipher: str(entry.signatureCipher),
    metadata: defined<FormatMetadata>({
      itag,
      mimeType,
      container,
      codecs,
      videoCodec,
      audioCodec,
      audioBitrate: !hasAudio
        ? undefined
        : isVideoType
          ? FIXED_AUDIO_KBPS[itag]
          : bitrate === undefined
            ? undefined
            : Math.round(bitrate / 1000),
      isDrc: entry.isDrc === true,
      hasAudio,
      hasVideo: isVideoType,
      isLive,
      isHLS: false,
      isDrm: drmFamilies !== undefined && drmFamilies.length > 0,
      isOtf: type === "FORMAT_STREAM_TYPE_OTF",
      client,
      bitrate: num(entry.bitrate),
      averageBitrate: num(entry.averageBitrate),
      width: num(entry.width),
      height: num(entry.height),
      fps: num(entry.fps),
      quality: str(entry.quality),
      qualityLabel: str(entry.qualityLabel),
      qualityOrdinal: str(entry.qualityOrdinal),
      audioQuality: str(entry.audioQuality),
      audioSampleRate: num(entry.audioSampleRate),
      audioChannels: num(entry.audioChannels),
      contentLength: num(entry.contentLength),
      approxDurationMs: num(entry.approxDurationMs),
      lastModified: num(entry.lastModified),
      initRange: range(entry.initRange),
      indexRange: range(entry.indexRange),
      targetDurationSec: num(entry.targetDurationSec),
      maxDvrDurationSec: num(entry.maxDvrDurationSec),
      audioTrack: audioTrack(entry.audioTrack),
      captionTrack: captionTrack(entry.captionTrack),
      loudnessDb: num(entry.loudnessDb),
      trackAbsoluteLoudnessLkfs: num(entry.trackAbsoluteLoudnessLkfs),
      isVb: bool(entry.isVb),
      appliedDrcTargetCenterForBackgroundDb: num(entry.appliedDrcTargetCenterForBackgroundDb),
      appliedVocalsGainFactor: num(entry.appliedVocalsGainFactor),
      vocalsBackgroundLoudnessDifferenceDb: num(entry.vocalsBackgroundLoudnessDifferenceDb),
      colorInfo: colorInfo(entry.colorInfo),
      projectionType: str(entry.projectionType),
      xtags: str(entry.xtags),
      highReplication: bool(entry.highReplication),
      drmFamilies,
      type,
    }),
  };
}

export function sabrSession(player: Json): SabrSource | undefined {
  const url = str(at(player, "streamingData", "serverAbrStreamingUrl"));
  const config = str(
    at(player, "playerConfig", "mediaCommonConfig", "mediaUstreamerRequestConfig", "videoPlaybackUstreamerConfig"),
  );
  const adaptive = at(player, "streamingData", "adaptiveFormats");
  if (!url || !config || !Array.isArray(adaptive)) return undefined;
  return { url, config };
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
    const parsed = parseFormat(entry, client, isLive);
    if (parsed && (parsed.url || parsed.signatureCipher || (sabr && isAdaptive))) out.push(parsed);
  }
  return out;
}

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

type Matcher = (format: FormatMetadata) => boolean;

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
  if (!isRecord(filter)) {
    throw new YtdlError(
      "INVALID_ARGUMENT",
      `Unknown filter ${inspect(filter)}; pass criteria such as { hasAudio: true, hasVideo: false } or a predicate`,
    );
  }
  const criteria = filter;
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

export function isPlayable(format: FormatMetadata): boolean {
  return !format.isDrm && !format.isOtf;
}

export function checkPlayable(format: FormatMetadata): void {
  if (!isPlayable(format)) {
    throw new YtdlError("NO_FORMAT", `itag ${format.itag} is ${format.isDrm ? "DRM-protected" : "OTF"}`);
  }
}

// YouTube gives DRC variants and dubbed tracks the itag of the original.
export function sameFormat(a: FormatMetadata, b: FormatMetadata): boolean {
  return a.itag === b.itag && a.isDrc === b.isDrc && a.audioTrack?.id === b.audioTrack?.id;
}

function lengthDelimitedFields(bytes: Uint8Array): [number, Uint8Array][] {
  const fields: [number, Uint8Array][] = [];
  let offset = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = bytes[offset++] ?? 0;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (tag % 8 === 0) varint();
    else if (tag % 8 === 2) {
      const length = varint();
      fields.push([Math.floor(tag / 8), bytes.subarray(offset, (offset += length))]);
    } else break;
  }
  return fields;
}

// The player answer's `xtags` is base64url protobuf: repeated field 1 holding { 1: key, 2: value }.
function xtag(format: FormatMetadata, key: string): string | undefined {
  if (!format.xtags) return undefined;
  const text = new TextDecoder();
  for (const [field, pair] of lengthDelimitedFields(Buffer.from(format.xtags, "base64url"))) {
    if (field !== 1) continue;
    const entry = new Map(lengthDelimitedFields(pair));
    if (text.decode(entry.get(1)) === key) return text.decode(entry.get(2));
  }
  return undefined;
}

function isDubbed(format: FormatMetadata): boolean {
  const content = xtag(format, "acont");
  return content !== undefined && content !== "original";
}

const PREFERENCE: readonly ((format: VideoFormat) => boolean)[] = [
  (format) => !format.isDrc && !isDubbed(format),
  (format) => !isDubbed(format),
  (format) => !format.isDrc,
  () => true,
];

/**
 * Filters, then picks by quality. A filter list picks with its first entry that yields a format. An
 * explicit `format` is matched in `formats`, so a fresh list's URL replaces a stale one, and one `formats` lacks
 * throws `NO_FORMAT`. A DRC variant is picked only when no original matches, and a dubbed audio track only when no
 * original-language track does.
 */
export function chooseFormat(formats: readonly VideoFormat[], options: ChooseFormatOptions = {}): VideoFormat {
  const quality = options.quality ?? Quality.Highest;
  if (!isQuality(quality)) throw new YtdlError("INVALID_ARGUMENT", `Unknown quality ${inspect(quality)}`);
  const wanted = options.format;
  if (wanted) {
    const own = formats.find((format) => sameFormat(format, wanted));
    if (!own) throw new YtdlError("NO_FORMAT", `itag ${wanted.itag} is not one of the given formats`);
    checkPlayable(own);
    return own;
  }
  const playable = formats.filter(isPlayable);
  for (const matches of matchers(options.filter)) {
    const matching = playable.filter(matches);
    for (const preferred of PREFERENCE) {
      const chosen = pick(matching.filter(preferred), quality);
      if (chosen) return chosen;
    }
  }
  throw new YtdlError("NO_FORMAT", `No format matches quality ${JSON.stringify(quality)}`);
}

const QUALITIES: readonly unknown[] = Object.values(Quality);

const isItag = (value: unknown) => typeof value === "number";

function isQuality(value: unknown): value is Quality {
  return QUALITIES.includes(value) || isItag(value) || (Array.isArray(value) && value.every(isItag));
}

function lowest(sorted: readonly VideoFormat[], bitrate: (format: VideoFormat) => number | undefined) {
  return sorted.findLast((format) => bitrate(format) !== undefined) ?? sorted.at(-1);
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
    return quality === "highest"
      ? sorted[0]
      : lowest(sorted, (format) => (format.hasVideo ? format.bitrate : format.audioBitrate));
  }
  if (quality === "highestaudio" || quality === "lowestaudio") {
    const sorted = candidates.filter((format) => format.hasAudio).toSorted(byAudio);
    if (quality === "lowestaudio") return lowest(sorted, (format) => format.audioBitrate);
    const best = sorted[0];
    return (
      best &&
      sorted.filter((format) => byAudio(best, format) === 0).toSorted((a, b) => qualityHeight(a) - qualityHeight(b))[0]
    );
  }
  if (quality === "highestvideo" || quality === "lowestvideo") {
    const sorted = candidates.filter((format) => format.hasVideo).toSorted(byVideo);
    if (quality === "lowestvideo") return lowest(sorted, (format) => format.bitrate);
    const best = sorted[0];
    return (
      best &&
      sorted.filter((format) => byVideo(best, format) === 0).toSorted((a, b) => audioBitrate(a) - audioBitrate(b))[0]
    );
  }
  return undefined;
}

interface MasterEntry {
  readonly variant: boolean;
  readonly url: string;
  readonly attributes: ReadonlyMap<string, string>;
}

function attributeList(text: string): ReadonlyMap<string, string> {
  return new Map(
    Array.from(text.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gu), ([, name = "", value = ""]) => [
      name,
      value.replace(/"/gu, ""),
    ]),
  );
}

function codecList(codecs: string | undefined): string[] {
  return (codecs ?? "")
    .split(",")
    .map((codec) => codec.trim())
    .filter(Boolean);
}

export function parseHlsMaster(playlist: string, base: string, client: Client): VideoFormat[] {
  const lines = playlist.split(/\r?\n/u);
  const entries = lines.flatMap((line, index): MasterEntry[] => {
    const tag = /^#EXT-X-(STREAM-INF|MEDIA):/u.exec(line);
    if (!tag) return [];
    const variant = tag[1] === "STREAM-INF";
    const attributes = attributeList(line.slice(tag[0].length));
    if (!variant && attributes.get("TYPE") !== "AUDIO") return [];
    const uri = variant
      ? lines.slice(index + 1).find((next) => next.trim() && !next.startsWith("#"))
      : attributes.get("URI");
    return uri ? [{ variant, url: new URL(uri.trim(), base).href, attributes }] : [];
  });
  const separateAudio = new Set(
    entries.filter((entry) => !entry.variant).map((entry) => entry.attributes.get("GROUP-ID")),
  );
  const variants = entries.filter((entry) => entry.variant);
  return entries.flatMap(({ variant, url, attributes }): VideoFormat[] => {
    const itag = num(/\/itag\/(\d+)\//u.exec(url)?.[1]);
    if (itag === undefined) return [];
    const group = attributes.get(variant ? "AUDIO" : "GROUP-ID");
    const usedBy = variant ? undefined : variants.find((entry) => group && entry.attributes.get("AUDIO") === group);
    const list = variant
      ? codecList(attributes.get("CODECS"))
      : codecList(usedBy?.attributes.get("CODECS")).filter((codec) => AUDIO_CODEC.test(codec));
    const codecs = list.join(",");
    const audioCodec = list.find((codec) => AUDIO_CODEC.test(codec));
    const hasAudio = variant ? audioCodec !== undefined && !(group && separateAudio.has(group)) : true;
    const [width, height] = (attributes.get("RESOLUTION") ?? "").split("x").map(Number);
    const hasVideo = width !== undefined && height !== undefined && Number.isFinite(height) && height > 0;
    return [
      {
        itag,
        url,
        mimeType: `${hasVideo ? "video" : "audio"}/ts; codecs="${codecs}"`,
        container: "ts",
        codecs,
        videoCodec: list.find((codec) => !AUDIO_CODEC.test(codec)),
        audioCodec: hasAudio ? audioCodec : undefined,
        bitrate: num(attributes.get("BANDWIDTH")),
        audioBitrate: hasAudio ? FIXED_AUDIO_KBPS[itag] : undefined,
        ...(hasVideo ? { width, height, qualityLabel: `${height}p` } : {}),
        fps: num(attributes.get("FRAME-RATE")),
        isDrc: false,
        isDrm: false,
        isOtf: false,
        hasAudio,
        hasVideo,
        isLive: true,
        isHLS: true,
        client,
      },
    ];
  });
}

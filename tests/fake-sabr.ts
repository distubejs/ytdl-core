import {
  FormatInitializationMetadata,
  MediaHeader,
  NextRequestPolicy,
  StreamProtectionStatus,
  UMPPartId,
  VideoPlaybackAbrRequest,
} from "googlevideo/protos";
import { CompositeBuffer, UmpWriter } from "googlevideo/ump";
import { EnabledTrackTypes } from "googlevideo/utils";
import { playable } from "./fake-youtube.ts";

export const SABR_URL = "https://rr2---sn-test.googlevideo.com/videoplayback?sabr=1&expire=4102444800&n=xyz";
// YouTube's ustreamer config identifies the video; MEDIA_HEADER and FORMAT_INITIALIZATION_METADATA echo its id.
const USTREAMER_PREFIX = "fake-sabr:";
const DURATION_MS = 100_000;
const LAST_MODIFIED = "1700000000000000";
const SEGMENTS_PER_RESPONSE = 2;
const ATTESTATION_BACKOFF_MS = 10;

export interface SabrFormatSpec {
  readonly itag: number;
  /** `audio/...` or `video/...`; googlevideo derives the track type from it. */
  readonly mimeType: string;
  /** The whole file; the server splits it into an init segment plus `segments` media segments. */
  readonly bytes: Uint8Array;
  /** Media segment count, default 4. */
  readonly segments?: number;
  readonly isDrc?: boolean;
  readonly audioTrackId?: string;
  readonly bitrate?: number;
  /** Video only, default 1280x720. */
  readonly width?: number;
  readonly height?: number;
}

const isAudio = (format: SabrFormatSpec) => format.mimeType.startsWith("audio/");
const trackKey = (id: { readonly itag?: number | undefined; readonly xtags?: string | undefined }) =>
  `${id.itag ?? ""}:${id.xtags ?? ""}`;

// YouTube tells DRC and dubbed variants of one itag apart by an opaque `xtags`.
function xtags(format: SabrFormatSpec): string | undefined {
  if (!format.isDrc && format.audioTrackId === undefined) return undefined;
  return `${format.audioTrackId ?? ""}${format.isDrc ? ":drc" : ""}`;
}

function adaptiveFormat(format: SabrFormatSpec): Record<string, unknown> {
  const common = {
    itag: format.itag,
    mimeType: format.mimeType,
    bitrate: format.bitrate ?? (isAudio(format) ? 130_000 : 2_000_000),
    lastModified: LAST_MODIFIED,
    contentLength: String(format.bytes.length),
    approxDurationMs: String(DURATION_MS),
    xtags: xtags(format),
  };
  if (!isAudio(format)) {
    const height = format.height ?? 720;
    return { ...common, width: format.width ?? 1280, height, qualityLabel: `${height}p`, fps: 30 };
  }
  return {
    ...common,
    audioQuality: "AUDIO_QUALITY_MEDIUM",
    audioChannels: 2,
    isDrc: format.isDrc,
    audioTrack: format.audioTrackId === undefined ? undefined : { id: format.audioTrackId, audioIsDefault: true },
  };
}

/** A playable `/player` answer whose adaptive formats have no URL and stream through `SABR_URL`. */
export function sabrPlayable(
  videoId: string,
  formats: readonly SabrFormatSpec[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const adaptiveFormats = formats.map(adaptiveFormat);
  return playable(videoId, adaptiveFormats, {
    streamingData: { adaptiveFormats, serverAbrStreamingUrl: SABR_URL },
    playerConfig: {
      mediaCommonConfig: {
        mediaUstreamerRequestConfig: { videoPlaybackUstreamerConfig: btoa(USTREAMER_PREFIX + videoId) },
      },
    },
    ...extra,
  });
}

export interface SabrServerOptions {
  readonly formats: readonly SabrFormatSpec[];
  /** Answers HTTP 500 to each POST (0-based index) it returns true for. */
  readonly failOn?: (index: number) => boolean;
  /** Answer STREAM_PROTECTION_STATUS 2 (pending) and withhold media until a POST carries a PO token. */
  readonly requireAttestation?: boolean;
}

export interface SabrRequest {
  readonly playerTimeMs: number;
  readonly itags: readonly number[];
  readonly poToken: boolean;
  /** The `n` query value; the synthetic player solves `xyz` to `xyz3`. */
  readonly n: string | null;
}

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly bytes: Uint8Array;
}

function splitIntoSegments(format: SabrFormatSpec): { init: Uint8Array; media: Segment[] } {
  const count = format.segments ?? 4;
  const cut = (i: number) => Math.round((i * format.bytes.length) / (count + 1));
  const time = (i: number) => Math.round((i * DURATION_MS) / count);
  const media = Array.from({ length: count }, (_, i) => ({
    start: time(i),
    end: time(i + 1),
    bytes: format.bytes.subarray(cut(i + 1), cut(i + 2)),
  }));
  return { init: format.bytes.subarray(0, cut(1)), media };
}

/** Answers POSTs to `SABR_URL`; `fetch(inner)` sends every other request to `inner`, `requests` has one entry per POST. */
export function sabrServer(options: SabrServerOptions) {
  const requests: SabrRequest[] = [];
  const sabrUrl = new URL(SABR_URL);
  const formats = options.formats.map((format) => ({
    format,
    key: trackKey({ itag: format.itag, xtags: xtags(format) }),
    ...splitIntoSegments(format),
  }));

  async function answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = VideoPlaybackAbrRequest.decode(new Uint8Array(await request.arrayBuffer()));
    const selected = [...body.selectedAudioFormatIds, ...body.selectedVideoFormatIds];
    const playerTimeMs = Number(body.clientAbrState?.playerTimeMs ?? 0);
    const poToken = (body.streamerContext?.poToken?.length ?? 0) > 0;
    requests.push({ playerTimeMs, itags: selected.map((id) => id.itag ?? 0), poToken, n: url.searchParams.get("n") });
    if (options.failOn?.(requests.length - 1)) {
      return new Response("fake failure", { status: 500, statusText: "Internal Server Error" });
    }
    const ustreamer = new TextDecoder().decode(body.videoPlaybackUstreamerConfig);
    if (!ustreamer.startsWith(USTREAMER_PREFIX)) {
      return new Response("missing videoPlaybackUstreamerConfig", { status: 400, statusText: "Bad Request" });
    }
    const videoId = ustreamer.slice(USTREAMER_PREFIX.length);

    const pending = options.requireAttestation === true && !poToken;
    const tracks = body.clientAbrState?.enabledTrackTypesBitfield ?? EnabledTrackTypes.VIDEO_AND_AUDIO;
    const wanted = pending
      ? []
      : formats.filter(
          ({ format, key }) =>
            (tracks === EnabledTrackTypes.VIDEO_AND_AUDIO ||
              (tracks === EnabledTrackTypes.AUDIO_ONLY) === isAudio(format)) &&
            selected.some((id) => trackKey(id) === key),
        );
    // SabrStream lists a format here once it has seen its FORMAT_INITIALIZATION_METADATA,
    // whether or not the init segment arrived, so both travel in one response.
    const initialized = new Set(body.initializationFormatIds.map(trackKey));

    const out = new CompositeBuffer();
    const ump = new UmpWriter(out);
    if (pending) ump.write(UMPPartId.STREAM_PROTECTION_STATUS, StreamProtectionStatus.encode({ status: 2 }).finish());
    const backoffTimeMs = pending ? ATTESTATION_BACKOFF_MS : 0;
    ump.write(UMPPartId.NEXT_REQUEST_POLICY, NextRequestPolicy.encode({ backoffTimeMs }).finish());
    let headerId = 0;
    for (const { format, key, init, media } of wanted) {
      const formatId = { itag: format.itag, lastModified: LAST_MODIFIED, xtags: xtags(format) };
      const writeSegment = (header: MediaHeader, bytes: Uint8Array) => {
        const id = headerId++;
        const segmentLengthBytes = String(bytes.length);
        ump.write(UMPPartId.MEDIA_HEADER, MediaHeader.encode({ ...header, headerId: id, segmentLengthBytes }).finish());
        const part = new Uint8Array(bytes.length + 1);
        part[0] = id;
        part.set(bytes, 1);
        ump.write(UMPPartId.MEDIA, part);
        ump.write(UMPPartId.MEDIA_END, new Uint8Array([id]));
      };
      const common = { videoId, itag: format.itag, formatId, lmt: LAST_MODIFIED, xtags: formatId.xtags };
      if (!initialized.has(key)) {
        ump.write(
          UMPPartId.FORMAT_INITIALIZATION_METADATA,
          FormatInitializationMetadata.encode({
            videoId,
            formatId,
            mimeType: format.mimeType,
            endTimeMs: String(DURATION_MS),
            endTimeTicks: String(DURATION_MS),
            endTimeTimescale: "1000",
            endSegmentNum: String(media.length),
          }).finish(),
        );
        writeSegment({ ...common, isInitializationSegment: true, segmentNum: 0 }, init);
      }
      const first = media.findIndex((segment) => segment.end > playerTimeMs);
      if (first === -1) continue;
      for (const [offset, segment] of media.slice(first, first + SEGMENTS_PER_RESPONSE).entries()) {
        const timeRange = {
          startTicks: String(segment.start),
          durationTicks: String(segment.end - segment.start),
          timescale: 1000,
        };
        const segmentNum = first + offset + 1;
        writeSegment(
          { ...common, segmentNum, startMs: String(segment.start), durationMs: "0", timeRange },
          segment.bytes,
        );
      }
    }
    return new Response(Buffer.concat(out.chunks), { headers: { "content-type": "application/vnd.yt-ump" } });
  }

  return {
    fetch: (inner: typeof fetch) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.origin !== sabrUrl.origin || url.pathname !== sabrUrl.pathname) return inner(input, init);
        init?.signal?.throwIfAborted();
        return answer(new Request(input, init));
      }) as typeof fetch,
    requests: requests as readonly SabrRequest[],
  };
}

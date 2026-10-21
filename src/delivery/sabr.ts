import { ignore } from "../http.ts";
import { CLIENTS, type Client, userAgentHeader } from "../clients.ts";
import { redact, YtdlError } from "../errors.ts";
import { type FormatMetadata, parseFormat, sameFormat } from "../formats.ts";
import type { VideoInfo } from "../info.ts";
import { at, isRecord, list } from "../json.ts";
import type { CompletedSegment } from "googlevideo/sabr-stream";
import type { Track as SabrTrack } from "googlevideo/utils";
import type { Session } from "./session.ts";

const SABR_REQUEST_RETRIES = 2;

type BuildSabrFormat = typeof import("googlevideo/utils").buildSabrFormat;
type SabrFormat = ReturnType<BuildSabrFormat>;

interface Track {
  readonly metadata: FormatMetadata;
  readonly sabr: SabrFormat;
}

function tracks(info: VideoInfo, client: Client, build: BuildSabrFormat): Track[] {
  return list(at(info.playerResponse, "streamingData", "adaptiveFormats"))
    .filter(isRecord)
    .flatMap((entry) => {
      const metadata = parseFormat(entry, client)?.metadata;
      if (!metadata) return [];
      // `buildSabrFormat` reads YouTube.js's snake_case `is_drc` and `audio_track`, not InnerTube's fields.
      const built = build(entry as unknown as Parameters<BuildSabrFormat>[0]);
      return [{ metadata, sabr: { ...built, isDrc: metadata.isDrc, audioTrackId: metadata.audioTrack?.id } }];
    });
}

function cheapestAudio(available: readonly Track[]): Track | undefined {
  return available
    .filter(({ metadata }) => metadata.hasAudio && !metadata.hasVideo && !metadata.isDrc)
    .toSorted((a, b) => (a.metadata.bitrate ?? 0) - (b.metadata.bitrate ?? 0))[0];
}

async function drain(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  for (;;) if ((await reader.read()).done) return;
}

function lastBoundaryAtOrBefore(
  timeAtByte: ReadonlyMap<number, number>,
  position: number,
): { byte: number; timeMs: number } | undefined {
  let found: { byte: number; timeMs: number } | undefined;
  for (const [byte, timeMs] of timeAtByte) {
    if (byte <= position && byte > (found?.byte ?? -1)) found = { byte, timeMs };
  }
  return found;
}

function tokenBytes(token: string): Uint8Array {
  return Uint8Array.from(atob(token.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
}

export async function* readSabr(
  session: Session,
  start: number,
  last: number,
  total: number | undefined,
  startTimeMs: number | undefined,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array, void, undefined> {
  const [{ SabrStream }, { buildSabrFormat, EnabledTrackTypes }] = await Promise.all([
    import("googlevideo/sabr-stream"),
    import("googlevideo/utils"),
  ]);
  let position = start;
  const timeAtByte = new Map<number, number>();
  const switched = (cause: YtdlError): void => {
    if (startTimeMs === undefined) return;
    const { itag } = session.format;
    throw new YtdlError("NO_FORMAT", `itag ${itag}: the resumed format has a URL and cannot start at a time`, {
      cause,
    });
  };
  for (;;) {
    if (!(await session.ensureFresh())) {
      if (session.format.url !== undefined) {
        return switched(new YtdlError("REQUEST_FAILED", `itag ${session.format.itag}: URL expired`));
      }
      continue;
    }
    const { info, format, delivery } = session;
    const source = info.sabr;
    if (!source) throw new YtdlError("NO_FORMAT", `itag ${format.itag}: the info has no SABR session`);
    const available = tracks(info, format.client, buildSabrFormat);
    const wanted = available.find((track) => sameFormat(track.metadata, format))?.sabr;
    // SABR has no video-only session, and cancelling either track aborts both.
    const audio = format.hasVideo ? cheapestAudio(available)?.sabr : wanted;
    if (!wanted || !audio) throw new YtdlError("NO_FORMAT", `itag ${format.itag}: missing from the SABR session`);
    const client = CLIENTS[format.client];
    const mint = delivery.mintPoToken;
    let mintFailure: unknown;
    const stream = new SabrStream({
      videoId: info.videoDetails.id,
      fetchFunction: ((url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(userAgentHeader(format.client))) headers.set(name, value);
        return delivery.fetch(url, { ...init, headers });
      }) as typeof fetch,
      serverAbrStreamingUrl: source.url,
      videoPlaybackUstreamerConfig: source.config,
      clientInfo: { clientName: client.nameId, clientVersion: client.version },
      formats: available.map((track) => track.sabr),
      callbacks: mint && {
        // googlevideo logs a failed mint and carries on without a token.
        onMintPoToken: () =>
          mint(info, signal).then(tokenBytes, (error: unknown) => {
            mintFailure ??= error;
            throw error;
          }),
      },
    });
    let wantedTrack: SabrTrack | undefined;
    const unread: CompletedSegment[] = [];
    const queued = new WeakSet<CompletedSegment>();
    const queueRecorded = () => {
      for (const segment of wantedTrack?.trackedSegments.values() ?? []) {
        if (queued.has(segment)) continue;
        queued.add(segment);
        unread.push(segment);
      }
    };
    if (startTimeMs === undefined) {
      stream.on("formatInitialization", (track) => {
        if (track.type === (format.hasVideo ? "video" : "audio")) wantedTrack = track;
      });
      stream.on("trackStateUpdate", queueRecorded);
    }
    // Known ceiling: a deep first `range.start` starts at time 0 because no offsets are known yet; parsing the format's `indexRange` (sidx) would map bytes to time up front.
    const resumeAt = lastBoundaryAtOrBefore(timeAtByte, position);
    const { audioStream, videoStream } = stream.start({
      audioFormat: audio,
      videoFormat: format.hasVideo ? wanted : undefined,
      enabledTrackTypes: format.hasVideo ? EnabledTrackTypes.VIDEO_AND_AUDIO : EnabledTrackTypes.AUDIO_ONLY,
      isPostLiveDvr: false,
      maxRetries: SABR_REQUEST_RETRIES,
      startTimeMs: resumeAt?.timeMs ?? startTimeMs,
    });
    const abort = () => void stream.abort().catch(ignore);
    signal.addEventListener("abort", abort, { once: true });
    if (format.hasVideo) drain(audioStream).catch(ignore);
    const reader = (format.hasVideo ? videoStream : audioStream).getReader();
    let offset = 0;
    let failure: unknown;
    try {
      for (;;) {
        const read = await reader.read().catch((error: unknown) => {
          signal.throwIfAborted();
          failure = error;
          return undefined;
        });
        if (!read) break;
        const { done, value } = read;
        if (done) {
          if (last === Infinity) return;
          failure = new Error(`session ended at byte ${offset}`);
          break;
        }
        const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        queueRecorded();
        const segment = unread.shift();
        const byteStart = Number(segment?.mediaHeader.segmentByteRangeStart);
        if (segment && !segment.mediaHeader.isInitializationSegment && byteStart > 0) {
          if (byteStart > position) {
            failure = new Error(`segment at byte ${byteStart} skips byte ${position}`);
            break;
          }
          offset = byteStart;
          timeAtByte.set(byteStart, segment.startTimeMs);
          const byteEnd = byteStart + chunk.length;
          if (!timeAtByte.has(byteEnd)) timeAtByte.set(byteEnd, segment.endTimeMs);
        }
        const from = Math.max(position - offset, 0);
        const to = Math.min(chunk.length, last - offset + 1);
        offset += chunk.length;
        if (to > from) {
          position += to - from;
          session.progress(to - from, total);
          yield chunk.subarray(from, to);
        }
        if (position > last) return;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      abort();
      reader.cancel().catch(ignore);
    }
    if (mintFailure !== undefined) {
      throw new YtdlError("REQUEST_FAILED", `itag ${format.itag}: getPoToken failed`, { cause: mintFailure });
    }
    const reason = redact(failure instanceof Error ? failure.message : String(failure));
    const failed = new YtdlError("REQUEST_FAILED", `itag ${format.itag}: SABR session failed: ${reason}`, {
      cause: failure,
    });
    await session.resume("SABR session failed", failed);
    if (session.format.url !== undefined) return switched(failed);
  }
}

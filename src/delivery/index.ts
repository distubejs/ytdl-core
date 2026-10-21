import { ignore } from "../http.ts";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { YtdlError } from "../errors.ts";
import type { SabrSource } from "../formats.ts";
import type { DownloadOptions, VideoFormat, VideoInfo } from "../types.ts";
import { readDashLive } from "./dash.ts";
import { readLive } from "./hls.ts";
import { readSabr } from "./sabr.ts";
import { readBody, type ReadEnd, Session } from "./session.ts";

export interface ResumeRequest {
  readonly format: VideoFormat;
  readonly attempt: number;
  readonly reason: string;
  readonly signal: AbortSignal;
}

export interface DeliveryInput {
  readonly info: VideoInfo;
  readonly format: VideoFormat;
  readonly fetch: typeof fetch;
  readonly options: DownloadOptions;
  readonly resume: (request: ResumeRequest) => Promise<{ readonly info: VideoInfo; readonly format: VideoFormat }>;
  readonly sabr: (info: VideoInfo) => SabrSource | undefined;
  readonly mintPoToken: ((info: VideoInfo, signal: AbortSignal) => Promise<string>) | undefined;
}

// YouTube throttles an unranged GET to about 0.03 MB/s; 10 MiB ranges read at full speed.
const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024;
const DEFAULT_LIVE_BUFFER_MS = 20_000;

type PrepareDelivery = (signal: AbortSignal) => Promise<DeliveryInput>;

interface StreamOptions {
  readonly highWaterMark?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

async function* deliver(prepare: PrepareDelivery, signal: AbortSignal): AsyncGenerator<Uint8Array, void, undefined> {
  try {
    const input = await prepare(signal);
    checkStartTime(input.options, input.format);
    const session = new Session(input, signal);
    const liveBuffer = input.options.liveBuffer ?? DEFAULT_LIVE_BUFFER_MS;
    if (input.format.isHLS) yield* readLive(session, liveBuffer, signal);
    else if (input.format.isLive) yield* readDashLive(session, liveBuffer, signal);
    else yield* readFile(session, input.options, signal);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}

function checkStartTime({ startTimeMs, range }: DownloadOptions, { itag, url }: VideoFormat): void {
  if (startTimeMs === undefined) return;
  if (!Number.isFinite(startTimeMs) || startTimeMs < 0) {
    throw new YtdlError("INVALID_ARGUMENT", `startTimeMs must be a finite number from 0, got ${startTimeMs}`);
  }
  if (range !== undefined) throw new YtdlError("INVALID_ARGUMENT", "startTimeMs cannot be combined with range");
  if (url !== undefined) throw new YtdlError("INVALID_ARGUMENT", `itag ${itag}: startTimeMs needs a SABR format`);
}

async function* readFile(
  session: Session,
  options: DownloadOptions,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array, void, undefined> {
  const { itag, contentLength } = session.format;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const { startTimeMs } = options;
  const start = options.range?.start ?? 0;
  const last =
    startTimeMs === undefined
      ? Math.min(options.range?.end ?? Infinity, contentLength === undefined ? Infinity : contentLength - 1)
      : Infinity;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new YtdlError("INVALID_ARGUMENT", `chunkSize must be a positive integer, got ${chunkSize}`);
  }
  if (!Number.isSafeInteger(start) || start < 0 || !(start <= last)) {
    throw new YtdlError("INVALID_ARGUMENT", `Range start ${start} is outside itag ${itag}`);
  }
  const total = Number.isFinite(last) ? last - start + 1 : undefined;
  let position = start;
  for (;;) {
    const reader =
      session.format.url === undefined
        ? readSabr(session, position, last, startTimeMs, signal)
        : readRanged(session, position, last, chunkSize);
    try {
      for (;;) {
        const result = await reader.next();
        if (result.done) {
          if (result.value === "complete") return;
          break;
        }
        position += result.value.length;
        session.progress(result.value.length, total);
        yield result.value;
      }
    } finally {
      await reader.return("complete");
    }
  }
}

async function* readRanged(
  session: Session,
  start: number,
  last: number,
  chunkSize: number,
): AsyncGenerator<Uint8Array, ReadEnd, undefined> {
  const { itag } = session.format;
  let position = start;
  while (position <= last) {
    const windowEnd = Math.min(position + chunkSize - 1, last);
    const url = session.format.url;
    if (url === undefined) return "switched";
    const response = await session.request(`${url}${url.includes("?") ? "&" : "?"}range=${position}-${windowEnd}`);
    if (!response) continue;
    const windowStart = position;
    for await (const piece of readBody(response, itag)) {
      // A server may answer past the requested range.
      const bytes = piece.subarray(0, windowEnd - position + 1);
      if (bytes.length === 0) break;
      position += bytes.length;
      yield bytes;
    }
    if (position > windowEnd) continue;
    // YouTube ends a format of unknown length with a short window.
    if (last === Infinity) return "complete";
    if (position === windowStart) {
      throw new YtdlError("REQUEST_FAILED", `itag ${itag}: empty media response at byte ${position}`);
    }
  }
  return "complete";
}

export function createNodeStream(prepare: PrepareDelivery, options: StreamOptions = {}): Readable {
  const web = createWebStream(prepare, { signal: options.signal }) as unknown as NodeReadableStream<Uint8Array>;
  return Readable.fromWeb(web, { highWaterMark: options.highWaterMark, signal: options.signal });
}

export function createWebStream(prepare: PrepareDelivery, options: StreamOptions = {}): ReadableStream<Uint8Array> {
  const controller = new AbortController();
  const caller = options.signal;
  const chunks = deliver(prepare, caller ? AbortSignal.any([controller.signal, caller]) : controller.signal);
  const strategy = new ByteLengthQueuingStrategy({ highWaterMark: options.highWaterMark ?? 0 });
  return new ReadableStream<Uint8Array>(
    {
      async pull(stream) {
        const result = await chunks.next();
        if (result.done) stream.close();
        else stream.enqueue(result.value);
      },
      cancel(reason: unknown) {
        controller.abort(reason);
        chunks.return(undefined).catch(ignore);
      },
    },
    strategy,
  );
}

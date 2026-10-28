import { addAbortSignal, Readable } from "node:stream";
import type { Client } from "../clients.ts";
import { YtdlError } from "../errors.ts";
import { ignore } from "../http.ts";
import type { ChooseFormatOptions, VideoFormat } from "../formats.ts";
import type { VideoInfo } from "../info.ts";
import type { LookupOptions } from "../ytdl.ts";
import { readDash } from "./dash.ts";
import { readLive } from "./hls.ts";
import { readSabr } from "./sabr.ts";
import { readBody, Session } from "./session.ts";

export interface ReadOptions extends LookupOptions {
  /** Inclusive byte range of the format. */
  readonly range?: { readonly start?: number; readonly end?: number };
  /**
   * Milliseconds to start at, for a format without a `url` and without `range`. The stream sends the
   * initialization segment, then media from the segment containing this time, and reports no total.
   */
  readonly startTimeMs?: number;
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
  /** Called after each chunk with the bytes received so far and the total, when known. */
  readonly onProgress?: (event: ProgressEvent) => void;
  /** Called before each re-resolution after a 403, a failed or stalled request or body, an expired URL or a failed SABR session. */
  readonly onRetry?: (event: RetryEvent) => void;
}

export interface DownloadOptions extends ChooseFormatOptions, ReadOptions {}

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

export interface Playback {
  info: VideoInfo;
  format: VideoFormat;
}

export interface ResumeRequest {
  readonly info: VideoInfo;
  readonly format: VideoFormat;
  readonly attempt: number;
  readonly reason: string;
  readonly signal: AbortSignal;
}

export interface Delivery {
  readonly fetch: typeof fetch;
  readonly resume: (request: ResumeRequest) => Promise<Playback>;
  readonly mintPoToken: (info: VideoInfo, signal: AbortSignal) => Promise<string>;
}

/** One format of one `getInfo` result, ready to read; each read starts from the latest refreshed info. */
export class Media {
  readonly #delivery: Delivery;
  readonly #playback: Playback;

  constructor(delivery: Delivery, info: VideoInfo, format: VideoFormat) {
    this.#delivery = delivery;
    this.#playback = { info, format };
  }

  /** The info the next read starts from; a read that re-resolves replaces it. */
  get info(): VideoInfo {
    return this.#playback.info;
  }

  get format(): VideoFormat {
    return this.#playback.format;
  }

  /** Streams the format's bytes as a Node `Readable`. */
  read(options: ReadOptions = {}): Readable {
    return deliver(this.#delivery, async () => this.#playback, options);
  }
}

// YouTube throttles an unranged GET to about 0.03 MB/s; 10 MiB ranges read at full speed.
const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024;
const DEFAULT_LIVE_BUFFER_MS = 20_000;

export function deliver(
  delivery: Delivery,
  prepare: (signal: AbortSignal) => Promise<Playback>,
  options: ReadOptions = {},
): Readable {
  const controller = new AbortController();
  const chunks = generate(delivery, prepare, options, controller.signal);
  // `Readable.from` aborts only after `return()` settles, which waits out the generator's pending request.
  const stream = new Readable({
    highWaterMark: options.highWaterMark,
    read() {
      chunks.next().then(
        (result) => this.push(result.done ? null : result.value),
        (error: unknown) => this.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    },
    destroy(error, callback) {
      controller.abort(error ?? undefined);
      chunks.return(undefined).catch(ignore);
      callback(error);
    },
  });
  return options.signal ? addAbortSignal(options.signal, stream) : stream;
}

async function* generate(
  delivery: Delivery,
  prepare: (signal: AbortSignal) => Promise<Playback>,
  options: ReadOptions,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array, void, undefined> {
  try {
    const playback = await prepare(signal);
    checkStartTime(options, playback.format);
    const session = new Session(delivery, playback, options, signal);
    const liveBuffer = options.liveBuffer ?? DEFAULT_LIVE_BUFFER_MS;
    if (playback.format.isHLS) yield* readLive(session, liveBuffer, signal);
    else if (playback.format.isLive || playback.format.targetDurationSec !== undefined) {
      yield* readDash(session, liveBuffer, signal);
    } else yield* readFile(session, options, signal);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}

function checkStartTime({ startTimeMs, range }: ReadOptions, { itag, url }: VideoFormat): void {
  if (startTimeMs === undefined) return;
  if (!Number.isFinite(startTimeMs) || startTimeMs < 0) {
    throw new YtdlError("INVALID_ARGUMENT", `startTimeMs must be a finite number from 0, got ${startTimeMs}`);
  }
  if (range !== undefined) throw new YtdlError("INVALID_ARGUMENT", "startTimeMs cannot be combined with range");
  if (url !== undefined) throw new YtdlError("INVALID_ARGUMENT", `itag ${itag}: startTimeMs needs a SABR format`);
}

async function* readFile(
  session: Session,
  options: ReadOptions,
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
  const total = contentLength !== undefined && Number.isFinite(last) ? last - start + 1 : undefined;
  // A resume can move the format between URL and SABR delivery; the other reader then continues.
  for (;;) {
    const sabr = session.format.url === undefined;
    const position = start + session.downloaded;
    if (sabr) yield* readSabr(session, position, last, total, startTimeMs, signal);
    else yield* readRanged(session, position, last, total, chunkSize);
    if ((session.format.url === undefined) === sabr) return;
  }
}

async function* readRanged(
  session: Session,
  start: number,
  last: number,
  total: number | undefined,
  chunkSize: number,
): AsyncGenerator<Uint8Array, void, undefined> {
  const { itag } = session.format;
  let position = start;
  while (position <= last) {
    const windowEnd = Math.min(position + chunkSize - 1, last);
    const url = session.format.url;
    if (url === undefined) return;
    // YouTube answers a range that starts past the last byte with HTTP 400.
    const response = await session.request(`${url}${url.includes("?") ? "&" : "?"}range=${position}-${windowEnd}`, {
      allowBadRequest: session.format.contentLength === undefined && session.downloaded > 0,
    });
    if (!response) continue;
    if (response.status === 400) {
      response.body?.cancel().catch(ignore);
      return;
    }
    const windowStart = position;
    try {
      for await (const piece of readBody(response, itag)) {
        // A server may answer past the requested range.
        const bytes = piece.subarray(0, windowEnd - position + 1);
        if (bytes.length === 0) continue;
        position += bytes.length;
        session.progress(bytes.length, total);
        yield bytes;
        if (position > windowEnd) break;
      }
    } catch (error) {
      if (!YtdlError.is(error, "REQUEST_FAILED")) throw error;
      await session.resume("response broke off", error);
      continue;
    }
    if (position > windowEnd) continue;
    if (position === windowStart) {
      throw new YtdlError("REQUEST_FAILED", `itag ${itag}: empty media response at byte ${position}`);
    }
  }
}

import { setTimeout as sleep } from "node:timers/promises";
import { userAgentHeader } from "../clients.ts";
import { YtdlError } from "../errors.ts";
import { expectOk, ignore, send } from "../http.ts";
import type { Delivery, Playback, ReadOptions } from "./index.ts";
import type { VideoFormat } from "../formats.ts";
import type { VideoInfo } from "../info.ts";

const MAX_RESUMES_WITHOUT_PROGRESS = 3;
export const LIVE_IDLE_MS = 30_000;

export async function waitUntil(time: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const delay = time - Date.now();
  if (delay > 0) await sleep(delay, undefined, { signal });
}

export class Session {
  readonly delivery: Delivery;
  readonly #playback: Playback;
  readonly #options: ReadOptions;
  readonly #signal: AbortSignal;
  #downloaded = 0;
  #attempt = 0;

  constructor(delivery: Delivery, playback: Playback, options: ReadOptions, signal: AbortSignal) {
    this.delivery = delivery;
    this.#playback = playback;
    this.#options = options;
    this.#signal = signal;
  }

  get info(): VideoInfo {
    return this.#playback.info;
  }

  get format(): VideoFormat {
    return this.#playback.format;
  }

  get downloaded(): number {
    return this.#downloaded;
  }

  async ensureFresh(): Promise<boolean> {
    await waitUntil(this.info.playableAt, this.#signal);
    if (Date.now() < this.info.expiresAt) return true;
    await this.resume("URL expired", new YtdlError("REQUEST_FAILED", `itag ${this.format.itag}: URL expired`));
    return false;
  }

  async request(url: string, { allowNotFound = false, allowBadRequest = false } = {}): Promise<Response | undefined> {
    if (!(await this.ensureFresh())) return undefined;
    const { itag } = this.format;
    const what = `itag ${itag}: media`;
    // YouTube requires the client that signed the URL to fetch it.
    const init = { headers: userAgentHeader(this.format.client), signal: this.#signal };
    let response: Response;
    try {
      response = await send(this.delivery.fetch, url, init, what);
    } catch (error) {
      if (!YtdlError.is(error, "REQUEST_FAILED")) throw error;
      await this.resume("request failed", error);
      return undefined;
    }
    if ((allowNotFound && response.status === 404) || (allowBadRequest && response.status === 400)) return response;
    if (response.status !== 403) return expectOk(response, what);
    response.body?.cancel().catch(ignore);
    await this.resume("HTTP 403", new YtdlError("REQUEST_FAILED", `${what} answered HTTP 403`));
    return undefined;
  }

  /** Reads a whole body; one that breaks off or stalls resumes and gives `undefined`. */
  async read<T>(response: Response, parse: (body: Response) => Promise<T>): Promise<T | undefined> {
    try {
      return await parse(response);
    } catch (cause) {
      const what = `itag ${this.format.itag}: media response broke off`;
      await this.resume("response broke off", new YtdlError("REQUEST_FAILED", what, { cause }));
      return undefined;
    }
  }

  progress(bytes: number, total: number | undefined): void {
    this.#attempt = 0;
    this.#downloaded += bytes;
    this.#options.onProgress?.({ chunkBytes: bytes, downloaded: this.#downloaded, total });
  }

  async resume(reason: string, cause: YtdlError): Promise<void> {
    this.#signal.throwIfAborted();
    const { itag, client } = this.format;
    const attempt = ++this.#attempt;
    if (attempt > MAX_RESUMES_WITHOUT_PROGRESS) {
      throw new YtdlError(
        "REQUEST_FAILED",
        `itag ${itag}: gave up after ${MAX_RESUMES_WITHOUT_PROGRESS} resumes without progress`,
        {
          cause,
        },
      );
    }
    this.#options.onRetry?.({ attempt, client, reason });
    let next: Playback;
    try {
      next = await this.delivery.resume({ ...this.#playback, attempt, reason, signal: this.#signal });
    } catch (error) {
      this.#signal.throwIfAborted();
      if (YtdlError.is(error) && error.cause === undefined) {
        throw new YtdlError(error.code, error.message, {
          attempts: error.attempts,
          startTime: error.startTime,
          availableCountries: error.availableCountries,
          cause,
        });
      }
      throw error;
    }
    this.#playback.info = next.info;
    this.#playback.format = next.format;
  }
}

export async function* readBody(response: Response, itag: number): AsyncGenerator<Uint8Array, void, undefined> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const result = await reader.read().catch((error: unknown) => {
        throw new YtdlError("REQUEST_FAILED", `itag ${itag}: media response broke off`, { cause: error });
      });
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.cancel().catch(ignore);
  }
}

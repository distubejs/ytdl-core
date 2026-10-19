import { setTimeout as sleep } from "node:timers/promises";
import { userAgentHeader } from "../clients.ts";
import { YtdlError } from "../errors.ts";
import { expectOk, ignore, send } from "../http.ts";
import type { DeliveryInput } from "./index.ts";
import type { VideoFormat, VideoInfo } from "../types.ts";

const MAX_RESUMES_WITHOUT_PROGRESS = 3;

export type ReadEnd = "complete" | "switched";

export async function waitUntil(time: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const delay = time - Date.now();
  if (delay > 0) await sleep(delay, undefined, { signal });
}

export class Session {
  info: VideoInfo;
  format: VideoFormat;
  readonly #signal: AbortSignal;
  #downloaded = 0;
  #attempt = 0;
  readonly input: DeliveryInput;

  constructor(input: DeliveryInput, signal: AbortSignal) {
    this.info = input.info;
    this.format = input.format;
    this.input = input;
    this.#signal = signal;
  }

  async ensureFresh(): Promise<boolean> {
    await waitUntil(this.info.playableAt, this.#signal);
    if (Date.now() < this.info.expiresAt) return true;
    await this.resume("URL expired", new YtdlError("REQUEST_FAILED", `itag ${this.format.itag}: URL expired`));
    return false;
  }

  async request(url: string, { allowNotFound = false } = {}): Promise<Response | undefined> {
    if (!(await this.ensureFresh())) return undefined;
    const { itag } = this.format;
    const what = `itag ${itag}: media`;
    // YouTube requires the client that signed the URL to fetch it.
    const init = { headers: userAgentHeader(this.format.client), signal: this.#signal };
    const response = await send(this.input.fetch, url, init, what);
    if (allowNotFound && response.status === 404) return response;
    if (response.status !== 403) return expectOk(response, what);
    response.body?.cancel().catch(ignore);
    await this.resume("HTTP 403", new YtdlError("REQUEST_FAILED", `${what} answered HTTP 403`));
    return undefined;
  }

  progress(bytes: number, total: number | undefined): void {
    this.#attempt = 0;
    this.#downloaded += bytes;
    this.input.options.onProgress?.({ chunkBytes: bytes, downloaded: this.#downloaded, total });
  }

  async resume(reason: string, cause: YtdlError): Promise<void> {
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
    this.input.options.onRetry?.({ attempt, client, reason });
    let next: { readonly info: VideoInfo; readonly format: VideoFormat };
    try {
      next = await this.input.resume({ format: this.format, attempt, reason, signal: this.#signal });
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
    this.info = next.info;
    this.format = next.format;
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

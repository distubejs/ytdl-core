import { YtdlError, type YtdlErrorCode } from "./errors.ts";

export const ignore = (): void => {};

export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(ignore);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const timeoutError = (ms: number) => new DOMException(`No response within ${ms} ms`, "TimeoutError");

/** Fails a request whose headers, or whose next body chunk, take longer than `ms`. */
export function timed(fetchFn: typeof fetch, ms: number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const controller = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    let timer = setTimeout(() => controller.abort(timeoutError(ms)), ms);
    let response: Response;
    try {
      response = await fetchFn(input, { ...init, signal });
    } finally {
      clearTimeout(timer);
    }
    const source = response.body;
    if (!source) return response;
    const reader = source.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        const stalled = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeoutError(ms)), ms);
        });
        try {
          const result = await Promise.race([abortable(reader.read(), signal), stalled]);
          if (result.done) stream.close();
          else stream.enqueue(result.value);
        } catch (error) {
          controller.abort(error);
          reader.cancel(error).catch(ignore);
          throw error;
        } finally {
          clearTimeout(timer);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}

export async function send(fetchFn: typeof fetch, url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (cause) {
    init.signal?.throwIfAborted();
    throw new YtdlError("REQUEST_FAILED", `${what} request failed`, { cause });
  }
}

export function statusError(status: number, what: string, detail = ""): YtdlError {
  const code: YtdlErrorCode = status === 429 ? "RATE_LIMITED" : "REQUEST_FAILED";
  return new YtdlError(code, `${what} answered HTTP ${status}${detail ? ` (${detail})` : ""}`);
}

export function expectOk(response: Response, what: string): Response {
  if (response.ok) return response;
  response.body?.cancel().catch(ignore);
  throw statusError(response.status, what);
}

export async function bodyText(
  response: Response,
  signal: AbortSignal | null | undefined,
  what: string,
): Promise<string> {
  try {
    return await response.text();
  } catch (cause) {
    signal?.throwIfAborted();
    throw new YtdlError("REQUEST_FAILED", `${what} response broke off`, { cause });
  }
}

export async function fetchText(fetchFn: typeof fetch, url: string, init: RequestInit, what: string): Promise<string> {
  return bodyText(expectOk(await send(fetchFn, url, init, what), what), init.signal, what);
}

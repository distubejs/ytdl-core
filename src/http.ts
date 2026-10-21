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

export async function send(fetchFn: typeof fetch, url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (cause) {
    init.signal?.throwIfAborted();
    throw new YtdlError("REQUEST_FAILED", `${what} request failed`, { cause });
  }
}

export function expectOk(response: Response, what: string): Response {
  if (response.ok) return response;
  response.body?.cancel().catch(ignore);
  const code: YtdlErrorCode = response.status === 429 ? "RATE_LIMITED" : "REQUEST_FAILED";
  throw new YtdlError(code, `${what} answered HTTP ${response.status}`);
}

export async function fetchText(fetchFn: typeof fetch, url: string, init: RequestInit, what: string): Promise<string> {
  return expectOk(await send(fetchFn, url, init, what), what).text();
}

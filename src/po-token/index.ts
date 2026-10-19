import { Worker } from "node:worker_threads";
import { YtdlError } from "../errors.ts";
import { abortable } from "../http.ts";
import type { GetPoToken, PoTokenRequest } from "../types.ts";
import type { FetchRequest, HostMessage, WorkerMessage } from "./worker.ts";

export interface PoTokenProviderOptions {
  /** Runs the BotGuard challenge and integrity token requests; pass the `fetch` given to `new Ytdl()`. */
  readonly fetch?: typeof fetch;
  /** Aborting it disposes the provider. */
  readonly signal?: AbortSignal;
}

/** Mints one token per identifier: the video ID, or for a session token (empty `videoId`) the Data Sync ID or visitor data. */
export type PoTokenProvider = GetPoToken & {
  /** Terminates the worker. Later calls reject with `INVALID_STATE`. */
  dispose(): Promise<void>;
};

const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);

/** Starts a BotGuard worker thread and resolves once it can mint; rejects if BotGuard refuses the environment. */
export async function createPoTokenProvider(options: PoTokenProviderOptions = {}): Promise<PoTokenProvider> {
  options.signal?.throwIfAborted();
  const fetchFn = options.fetch ?? globalThis.fetch;
  const pending = new Map<number, { resolve(token: string | undefined): void; reject(error: unknown): void }>();
  let worker: Worker | undefined;
  let disposed = false;
  let nextId = 0;

  const updateRef = () => (pending.size === 0 ? worker?.unref() : worker?.ref());

  const rejectAll = (error: YtdlError) => {
    const calls = [...pending.values()];
    pending.clear();
    for (const call of calls) call.reject(error);
  };

  const proxy = async (w: Worker, request: FetchRequest) => {
    let reply: HostMessage;
    try {
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: options.signal,
      });
      reply = { type: "fetched", id: request.id, status: response.status, body: await response.arrayBuffer() };
    } catch (error) {
      reply = { type: "fetched", id: request.id, error: error instanceof Error ? error.message : String(error) };
    }
    if (worker === w) w.postMessage(reply, "body" in reply ? [reply.body] : []);
  };

  const start = (): Worker => {
    const w = new Worker(WORKER_URL);
    const crash = (cause: unknown) => {
      if (worker !== w) return;
      worker = undefined;
      void w.terminate();
      rejectAll(new YtdlError("REQUEST_FAILED", "PO token worker stopped", { cause }));
    };
    w.on("message", (message: WorkerMessage) => {
      if (message.type === "fetch") {
        void proxy(w, message);
        return;
      }
      const call = pending.get(message.id);
      pending.delete(message.id);
      updateRef();
      if (message.type === "minted") {
        call?.resolve(message.token);
      } else {
        call?.reject(new YtdlError("REQUEST_FAILED", "PO token minting failed", { cause: new Error(message.error) }));
      }
    });
    w.on("error", crash);
    w.on("exit", (code) => crash(new Error(`PO token worker exited with code ${code}`)));
    return w;
  };

  const call = (identifier: string | undefined, signal?: AbortSignal) => {
    if (disposed) return Promise.reject(new YtdlError("INVALID_STATE", "The PO token provider is disposed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    worker ??= start();
    const id = nextId++;
    const minted = new Promise<string | undefined>((resolve, reject) => pending.set(id, { resolve, reject }));
    updateRef();
    worker.postMessage({ type: "mint", id, identifier } satisfies HostMessage);
    return abortable(minted, signal);
  };

  const dispose = async () => {
    disposed = true;
    options.signal?.removeEventListener("abort", disposeOnAbort);
    rejectAll(new YtdlError("INVALID_STATE", "The PO token provider is disposed"));
    const w = worker;
    worker = undefined;
    await w?.terminate();
  };
  const disposeOnAbort = () => void dispose();

  const getPoToken = async (request: PoTokenRequest): Promise<string> => {
    const identifier = request.videoId || request.dataSyncId || request.visitorData;
    if (!identifier)
      throw new YtdlError("INVALID_ARGUMENT", "A PO token needs a video ID, Data Sync ID or visitor data");
    const token = await call(identifier, request.signal);
    if (token === undefined) throw new YtdlError("REQUEST_FAILED", "The PO token worker returned no token");
    return token;
  };

  try {
    await call(undefined, options.signal);
    options.signal?.throwIfAborted();
  } catch (error) {
    await dispose();
    throw error;
  }
  options.signal?.addEventListener("abort", disposeOnAbort, { once: true });
  return Object.assign(getPoToken, { dispose });
}

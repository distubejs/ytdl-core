import type { Client } from "../clients.ts";
import { YtdlError } from "../errors.ts";
import { abortable } from "../http.ts";
import { startWorker, type WorkerRpc } from "../worker-rpc.ts";
import type { FetchReply, FetchRequest } from "./worker.ts";

export interface PoTokenRequest {
  /** What the token binds to: the video ID, for a player request and for SABR attestation alike. */
  readonly contentBinding: string;
  readonly client: Client;
  readonly signal: AbortSignal | undefined;
}

/** Mints a PO token; plug in `createPoTokenProvider()` or your own minter. */
export type GetPoToken = (request: PoTokenRequest) => Promise<string>;

export interface PoTokenProviderOptions {
  /** Runs the BotGuard challenge and integrity token requests; pass the `fetch` given to `new Ytdl()`. */
  readonly fetch?: typeof fetch;
  /** Aborting it disposes the provider. */
  readonly signal?: AbortSignal;
}

/** Mints one token per `contentBinding`. */
export type PoTokenProvider = GetPoToken & {
  /** Terminates the worker. Later calls reject with `INVALID_STATE`. */
  dispose(): Promise<void>;
};

const disposedError = () => new YtdlError("INVALID_STATE", "The PO token provider is disposed");

const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);

/** Starts a BotGuard worker thread and resolves once it can mint; rejects if BotGuard refuses the environment. */
export async function createPoTokenProvider(options: PoTokenProviderOptions = {}): Promise<PoTokenProvider> {
  options.signal?.throwIfAborted();
  const fetchFn = options.fetch ?? globalThis.fetch;
  let worker: WorkerRpc | undefined;
  let disposed = false;

  const proxy = async (target: WorkerRpc, request: FetchRequest) => {
    let reply: FetchReply;
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
    target.post(reply, "body" in reply ? [reply.body] : []);
  };

  const start = (): WorkerRpc => {
    const started = startWorker(WORKER_URL, {
      onMessage: (message) => void proxy(started, message as FetchRequest),
      onStop: () => {
        if (worker === started) worker = undefined;
      },
    });
    return started;
  };

  const mint = (contentBinding: string | undefined, signal: AbortSignal | undefined): Promise<unknown> => {
    if (disposed) return Promise.reject(disposedError());
    if (signal?.aborted) return Promise.reject(signal.reason);
    worker ??= start();
    const minted = worker.call(contentBinding).catch((cause: unknown) => {
      throw disposed ? disposedError() : new YtdlError("REQUEST_FAILED", "PO token minting failed", { cause });
    });
    return abortable(minted, signal);
  };

  const dispose = async () => {
    disposed = true;
    options.signal?.removeEventListener("abort", disposeOnAbort);
    const stopping = worker;
    worker = undefined;
    await stopping?.terminate();
  };
  const disposeOnAbort = () => void dispose();

  const getPoToken = async ({ contentBinding, signal }: PoTokenRequest): Promise<string> => {
    if (typeof contentBinding !== "string" || contentBinding === "") {
      throw new YtdlError("INVALID_ARGUMENT", "A PO token needs a non-empty contentBinding");
    }
    const token = await mint(contentBinding, signal);
    if (typeof token !== "string") throw new YtdlError("REQUEST_FAILED", "The PO token worker returned no token");
    return token;
  };

  try {
    await mint(undefined, options.signal);
    options.signal?.throwIfAborted();
  } catch (error) {
    await dispose();
    throw error;
  }
  options.signal?.addEventListener("abort", disposeOnAbort, { once: true });
  return Object.assign(getPoToken, { dispose });
}

import { parentPort, type Transferable, Worker } from "node:worker_threads";

interface Call {
  readonly call: number;
  readonly request: unknown;
}

type Reply =
  | { readonly reply: number; readonly result: unknown }
  | { readonly reply: number; readonly error: string; readonly name: string };

const isCall = (message: unknown): message is Call =>
  typeof message === "object" && message !== null && "call" in message;
const isReply = (message: unknown): message is Reply =>
  typeof message === "object" && message !== null && "reply" in message;

export interface WorkerRpc {
  call(request: unknown): Promise<unknown>;
  post(message: unknown, transfer?: readonly Transferable[]): void;
  terminate(): Promise<void>;
}

interface WorkerEvents {
  readonly onMessage?: (message: unknown) => void;
  readonly onStop?: () => void;
}

export function startWorker(file: URL, events: WorkerEvents = {}): WorkerRpc {
  const worker = new Worker(file);
  const pending = new Map<number, { resolve(result: unknown): void; reject(error: unknown): void }>();
  let nextCall = 0;
  let stopped = false;
  worker.unref();

  const stop = (cause: unknown) => {
    if (stopped) return;
    stopped = true;
    const waiters = [...pending.values()];
    pending.clear();
    for (const waiter of waiters) waiter.reject(cause);
    events.onStop?.();
  };
  worker.on("message", (message: unknown) => {
    if (!isReply(message)) {
      events.onMessage?.(message);
      return;
    }
    const waiter = pending.get(message.reply);
    pending.delete(message.reply);
    if (pending.size === 0) worker.unref();
    if ("error" in message) waiter?.reject(Object.assign(new Error(message.error), { name: message.name }));
    else waiter?.resolve(message.result);
  });
  worker.on("error", stop);
  worker.on("exit", (code) => stop(new Error(`Worker exited with code ${code}`)));

  return {
    call(request) {
      if (stopped) return Promise.reject(new Error("Worker stopped"));
      const call = nextCall++;
      worker.ref();
      return new Promise((resolve, reject) => {
        pending.set(call, { resolve, reject });
        worker.postMessage({ call, request } satisfies Call);
      });
    },
    post(message, transfer) {
      if (!stopped) worker.postMessage(message, transfer);
    },
    async terminate() {
      stop(new Error("Worker terminated"));
      await worker.terminate();
    },
  };
}

export function serve(handle: (request: unknown) => unknown, onMessage?: (message: unknown) => void): void {
  const port = parentPort;
  if (!port) throw new Error("serve runs only inside a worker thread");
  port.on("message", (message: unknown) => {
    if (!isCall(message)) {
      onMessage?.(message);
      return;
    }
    Promise.resolve()
      .then(() => handle(message.request))
      .then(
        (result: unknown) => port.postMessage({ reply: message.call, result } satisfies Reply),
        (error: unknown) =>
          port.postMessage({
            reply: message.call,
            error: error instanceof Error ? error.message : String(error),
            name: error instanceof Error ? String(error.name) : "Error",
          } satisfies Reply),
      );
  });
}

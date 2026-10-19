import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from "node:worker_threads";
import { YOUTUBE_ORIGIN } from "../clients.ts";
import { YtdlError } from "../errors.ts";
import { abortable, fetchText } from "../http.ts";
import type { DropRequest, LoadReply, LoadRequest, SolveReply, SolveRequest } from "./worker.ts";

export interface PreparedPlayer {
  readonly id: string;
  readonly signatureTimestamp: number;
  solveUrl(format: { readonly url?: string; readonly signatureCipher?: string }): string;
}

const CACHE_LIMIT = 4;
const SOLVE_WAIT_MS = 5000;

const cache = new Map<string, Promise<PreparedPlayer>>();
const handles = new WeakMap<PreparedPlayer, number>();
let nextHandle = 0;

interface LoadPlayerOptions {
  readonly fetch: typeof fetch;
  readonly playerId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function loadPlayer({ fetch, playerId, signal }: LoadPlayerOptions): Promise<PreparedPlayer> {
  signal?.throwIfAborted();
  const id = playerId ?? (await discoverPlayerId(fetch, signal));
  let entry = cache.get(id);
  cache.delete(id);
  if (!entry) {
    const created = prepare(id, fetch);
    created.catch(() => cache.get(id) === created && cache.delete(id));
    entry = created;
  }
  cache.set(id, entry);
  for (const [oldId, old] of cache) {
    if (cache.size <= CACHE_LIMIT) break;
    cache.delete(oldId);
    old.then(
      (player) => current?.drop(handles.get(player)),
      () => {},
    );
  }
  return abortable(entry, signal);
}

// YouTube rolls the player a few times a week.
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
let discovery: { readonly id: Promise<string>; readonly at: number } | undefined;

function discoverPlayerId(fetchFn: typeof fetch, signal: AbortSignal | undefined): Promise<string> {
  if (!discovery || Date.now() - discovery.at >= DISCOVERY_TTL_MS) {
    const id = fetchText(fetchFn, `${YOUTUBE_ORIGIN}/iframe_api`, {}, "YouTube iframe API").then((text) => {
      const found = /player\\?\/([\da-f]{8})\\?\//u.exec(text)?.[1];
      if (!found) throw new YtdlError("PLAYER_SOLVE_FAILED", "No player ID in the iframe API script");
      return found;
    });
    const entry = { id, at: Date.now() };
    discovery = entry;
    id.catch(() => {
      if (discovery === entry) discovery = undefined;
    });
  }
  return abortable(discovery.id, signal);
}

// The main player, as yt-dlp uses.
const playerUrl = (id: string): string =>
  `${YOUTUBE_ORIGIN}/s/player/${encodeURIComponent(id)}/player_ias.vflset/en_US/base.js`;

async function prepare(id: string, fetchFn: typeof fetch): Promise<PreparedPlayer> {
  const source = await fetchText(fetchFn, playerUrl(id), {}, `YouTube player ${id}`);
  const timestamp = /signatureTimestamp:(\d+)/u.exec(source)?.[1];
  if (!timestamp) throw new YtdlError("PLAYER_SOLVE_FAILED", `No signature timestamp in player ${id}`);
  const handle = await host().load(source);
  const player: PreparedPlayer = {
    id,
    signatureTimestamp: Number(timestamp),
    solveUrl: (format) => solveUrl(id, handle, format),
  };
  handles.set(player, handle);
  return player;
}

function solveUrl(
  id: string,
  handle: number,
  format: { readonly url?: string; readonly signatureCipher?: string },
): string {
  const cipher = format.signatureCipher;
  const params = cipher === undefined ? undefined : new URLSearchParams(cipher);
  const raw = params ? params.get("url") : format.url;
  if (!raw || !URL.canParse(raw)) throw new YtdlError("PLAYER_SOLVE_FAILED", "Format has no valid URL");
  const url = new URL(raw);
  const sig = params?.get("s") ?? undefined;
  // Manifest URLs carry their parameters as `/key/value` path segments.
  const segments = url.pathname.split("/");
  const pathN = url.searchParams.has("n") ? -1 : segments.indexOf("n") + 1;
  const n = url.searchParams.get("n") ?? (pathN > 0 ? segments[pathN] : undefined);
  if (sig === undefined && n === undefined) return url.toString();
  const solved = host().solve(handle, sig, n, id);
  if (sig !== undefined && solved.sig !== undefined) url.searchParams.set(params?.get("sp") ?? "signature", solved.sig);
  if (n !== undefined && solved.n !== undefined) {
    if (pathN > 0) {
      segments[pathN] = solved.n;
      url.pathname = segments.join("/");
    } else url.searchParams.set("n", solved.n);
  }
  return url.toString();
}

interface Host {
  load(source: string): Promise<number>;
  solve(handle: number, sig: string | undefined, n: string | undefined, id: string): { sig?: string; n?: string };
  drop(handle: number | undefined): void;
}

let current: Host | undefined;

function host(): Host {
  current ??= startHost();
  return current;
}

function startHost(): Host {
  const { port1: solvePort, port2 } = new MessageChannel();
  const file = import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js";
  const worker = new Worker(new URL(file, import.meta.url), {
    workerData: { solvePort: port2 },
    transferList: [port2],
  });
  const pending = new Map<number, { resolve: (handle: number) => void; reject: (error: unknown) => void }>();
  let seq = 0;
  worker.unref();
  solvePort.unref();

  const fail = (error: unknown): void => {
    if (current !== self) return;
    current = undefined;
    cache.clear();
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error(`Solver worker exited with code ${code}`)));
  worker.on("message", (reply: LoadReply) => {
    const waiter = pending.get(reply.handle);
    if (!waiter) return;
    pending.delete(reply.handle);
    if (pending.size === 0) worker.unref();
    if (reply.error === undefined) waiter.resolve(reply.handle);
    else
      waiter.reject(
        new YtdlError("PLAYER_SOLVE_FAILED", "Could not prepare the player", { cause: new Error(reply.error) }),
      );
  });

  const self: Host = {
    load(source) {
      const handle = ++nextHandle;
      worker.ref();
      worker.postMessage({ kind: "load", handle, source } satisfies LoadRequest);
      return new Promise((resolve, reject) => pending.set(handle, { resolve, reject }));
    },
    solve(handle, sig, n, id) {
      const flag = new Int32Array(new SharedArrayBuffer(4));
      const request = { seq: ++seq, handle, sig, n, flag } satisfies SolveRequest;
      solvePort.postMessage(request);
      if (Atomics.wait(flag, 0, 0, SOLVE_WAIT_MS) === "timed-out") {
        throw new YtdlError("PLAYER_SOLVE_FAILED", `Player ${id} did not answer in ${SOLVE_WAIT_MS} ms`);
      }
      const reply = receive(solvePort, request.seq);
      if (!reply || reply.error !== undefined) {
        const cause = new Error(reply?.error ?? "No reply from the solver worker");
        throw new YtdlError("PLAYER_SOLVE_FAILED", `Could not solve a URL with player ${id}`, { cause });
      }
      return reply;
    },
    drop(handle) {
      if (handle !== undefined) worker.postMessage({ kind: "drop", handle } satisfies DropRequest);
    },
  };
  return self;
}

function receive(port: MessagePort, seq: number): SolveReply | undefined {
  for (let entry = receiveMessageOnPort(port); entry; entry = receiveMessageOnPort(port)) {
    const reply = entry.message as SolveReply;
    if (reply.seq === seq) return reply;
  }
  return undefined;
}

import { parentPort } from "node:worker_threads";
import { BotGuardClient } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import { buildURL, getHeaders, parseLooseJSON } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";
import { JSDOM } from "jsdom";
import { at, str, ytcfg } from "../json.ts";

type MintRequest = { readonly type: "mint"; readonly id: number; readonly identifier?: string };
type FetchReply =
  | { readonly type: "fetched"; readonly id: number; readonly status: number; readonly body: ArrayBuffer }
  | { readonly type: "fetched"; readonly id: number; readonly error: string };
export type HostMessage = MintRequest | FetchReply;

export type FetchRequest = {
  readonly type: "fetch";
  readonly id: number;
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
};
export type WorkerMessage =
  | { readonly type: "minted"; readonly id: number; readonly token: string | undefined }
  | { readonly type: "failed"; readonly id: number; readonly error: string }
  | FetchRequest;

// YouTube web player's WAA request key.
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const HOMEPAGE = "https://www.youtube.com/";

if (!parentPort) throw new Error("po-token/worker runs only as a worker thread");
const port = parentPort;

// BgUtils and the BotGuard VM read these from globalThis; this thread exists so the host's stay untouched.
const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
  url: "https://www.youtube.com/",
  referrer: "https://www.youtube.com/",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  origin: dom.window.origin,
});
if (!Reflect.has(globalThis, "navigator"))
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });

const fetches = new Map<number, { resolve(response: Response): void; reject(error: unknown): void }>();
let nextFetchId = 0;

// Functions cannot cross the thread boundary, so the host runs every request with its `fetch`.
const proxiedFetch = ((url: string | URL, init?: RequestInit): Promise<Response> => {
  const id = nextFetchId++;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const request: FetchRequest = {
    type: "fetch",
    id,
    url: String(url),
    method: init?.method ?? "GET",
    headers,
    body: typeof init?.body === "string" ? init.body : undefined,
  };
  port.postMessage(request);
  return new Promise((resolve, reject) => fetches.set(id, { resolve, reject }));
}) as typeof fetch;

async function fetchText(url: string, name: string): Promise<string> {
  const response = await proxiedFetch(url);
  if (!response.ok) throw new Error(`${name} answered ${response.status}`);
  return response.text();
}

async function createMinter(): Promise<{ minter: WebPoMinter; refreshAt: number }> {
  const page = await fetchText(HOMEPAGE, "The YouTube home page");
  const config = ytcfg(page);
  const atN = /window\.ytAtN\((\{.*?\})\)/su.exec(page)?.[1];
  const challenge: unknown = atN === undefined ? undefined : at(parseLooseJSON(atN), "R", "bgChallenge");
  const interpreterUrl = str(at(challenge, "interpreterUrl", "privateDoNotAccessOrElseTrustedResourceUrlWrappedValue"));
  const program = str(at(challenge, "program"));
  const globalName = str(at(challenge, "globalName"));
  if (Object.keys(config).length === 0 || !interpreterUrl || !program || !globalName) {
    throw new Error("The YouTube home page carries no BotGuard challenge");
  }
  // YouTube accepts WEB and MWEB tokens only from a VM that read the `yt.config_` of the page serving its challenge.
  const yt = { config_: config };
  Object.assign(globalThis, { yt });
  Object.assign(dom.window, { yt });
  new Function(await fetchText(new URL(interpreterUrl, HOMEPAGE).href, "The BotGuard interpreter"))();
  const client = await BotGuardClient.create({
    program,
    globalName,
    globalObject: globalThis,
  });
  const webPoSignalOutput: WebPoSignalOutput = [];
  const botguardResponse = await client.snapshot({ webPoSignalOutput });

  const response = await proxiedFetch(buildURL("GenerateIT", true), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  if (!response.ok) throw new Error(`GenerateIT answered ${response.status}`);
  const json: unknown = await response.json();
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold]: unknown[] = Array.isArray(json) ? json : [];
  if (typeof integrityToken !== "string" || typeof estimatedTtlSecs !== "number") {
    throw new Error("GenerateIT returned no integrity token");
  }
  const threshold = typeof mintRefreshThreshold === "number" ? mintRefreshThreshold : 0;
  const minter = await WebPoMinter.create({ integrityToken, estimatedTtlSecs }, webPoSignalOutput);
  // YouTube's player replaces the integrity token once less than `mintRefreshThreshold` seconds remain.
  return { minter, refreshAt: Date.now() + (estimatedTtlSecs - threshold) * 1000 };
}

let current: Promise<WebPoMinter> | undefined;
let refreshAt = 0;

function getMinter(): Promise<WebPoMinter> {
  if (!current || Date.now() >= refreshAt) {
    refreshAt = Number.POSITIVE_INFINITY;
    const next = createMinter().then((created) => {
      refreshAt = created.refreshAt;
      return created.minter;
    });
    next.catch(() => {
      if (current === next) current = undefined;
    });
    current = next;
  }
  return current;
}

async function mint(identifier: string | undefined): Promise<string | undefined> {
  const minter = await getMinter();
  return identifier === undefined ? undefined : minter.mintAsWebsafeString(identifier);
}

port.on("message", (message: HostMessage) => {
  if (message.type === "fetched") {
    const pending = fetches.get(message.id);
    fetches.delete(message.id);
    if ("error" in message) pending?.reject(new Error(message.error));
    else pending?.resolve(new Response(message.body, { status: message.status }));
    return;
  }
  const { id } = message;
  mint(message.identifier).then(
    (token) => port.postMessage({ type: "minted", id, token } satisfies WorkerMessage),
    // Messages, not errors: an error whose cause holds a function cannot be cloned across threads.
    (error: unknown) => port.postMessage({ type: "failed", id, error: describe(error) } satisfies WorkerMessage),
  );
});

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

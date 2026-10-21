import { afterEach, describe, expect, mock, test } from "bun:test";
import * as workerThreads from "node:worker_threads";
import { YtdlError } from "../src/errors.ts";
import type { PoTokenProviderOptions, PoTokenRequest } from "../src/po-token/index.ts";

let workersStarted = 0;
class CountingWorker extends workerThreads.Worker {
  constructor(...args: ConstructorParameters<typeof workerThreads.Worker>) {
    super(...args);
    workersStarted++;
  }
}
mock.module("node:worker_threads", () => ({ ...workerThreads, Worker: CountingWorker }));
const { createPoTokenProvider } = await import("../src/po-token/index.ts");
type PoTokenProvider = Awaited<ReturnType<typeof createPoTokenProvider>>;

const interpreter = (minted: string) => `
globalThis.fakeBotGuard = {
  a(program, setup) {
    if (typeof document === "undefined" || location.origin !== "https://www.youtube.com") throw new Error("no DOM");
    if (window.yt?.config_?.EVENT_ID !== "home-event") throw new Error("no home page ytcfg");
    document.createElement("canvas").getContext("2d");
    const text = (bytes) => new TextDecoder().decode(bytes);
    setup((done, [, , output]) => {
      output.push(async (integrity) => async (binding) => new TextEncoder().encode(${minted}));
      done("bg-response");
    }, () => {}, () => {}, () => {});
    return [() => "sync"];
  },
};`;
const INTERPRETER = interpreter('text(integrity) + "|" + text(binding)');
const USER_AGENT_INTERPRETER = interpreter('text(integrity) + "|" + navigator.userAgent');
const CRASHING_INTERPRETER = `
setTimeout(() => { throw new Error("boom"); });
globalThis.fakeBotGuard = { a() { return []; } };`;

const escapeForScript = (json: string) => json.replace(/[{}"]/g, (char) => `\\x${char.charCodeAt(0).toString(16)}`);
const homePage = (interpreterUrl: string) => {
  const atN = {
    responseContext: {},
    bgChallenge: {
      interpreterUrl: { privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: interpreterUrl },
      interpreterHash: "hash",
      program: "program",
      globalName: "fakeBotGuard",
    },
  };
  return `<script>ytcfg.set({"EVENT_ID":"home-event","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB"}}});</script>
<script>if (window.ytAtN) {window.ytAtN({'R': '${escapeForScript(JSON.stringify(atN))}','T': 'trust',})}</script>`;
};
const HOME_PAGE_URL = "https://www.youtube.com/";
const GENERATE_IT_URL = "https://www.youtube.com/api/jnn/v1/GenerateIT";

function fakeYouTube({
  ttl,
  threshold,
  interpreters = [],
  page = homePage("//www.google.com/js/th/fake.js"),
}: {
  ttl: number;
  threshold: number;
  interpreters?: string[];
  page?: string;
}) {
  const requests: string[] = [];
  const homePageHeaders: Headers[] = [];
  const stalled = Promise.withResolvers<AbortSignal | null | undefined>();
  let challenges = 0;
  let integrityTokens = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === fake.stall) {
      stalled.resolve(init?.signal);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    if (url === HOME_PAGE_URL) {
      homePageHeaders.push(new Headers(init?.headers));
      return new Response(page);
    }
    if (url === "https://www.google.com/js/th/fake.js") return new Response(interpreters[challenges++] ?? INTERPRETER);
    if (url === GENERATE_IT_URL && init?.body === '["O43z0dpjhgX20SCx4KAo","bg-response"]') {
      return Response.json([btoa(`it-${++integrityTokens}`), ttl, threshold, "fallback"]);
    }
    return new Response(null, { status: 400 });
  }) as typeof globalThis.fetch;
  const fake = { fetch, requests, homePageHeaders, stall: undefined as string | undefined, stalled: stalled.promise };
  return fake;
}

const providers: PoTokenProvider[] = [];
async function provide(
  fake: ReturnType<typeof fakeYouTube>,
  options: Omit<PoTokenProviderOptions, "fetch"> = {},
): Promise<PoTokenProvider> {
  const provider = await createPoTokenProvider({ ...options, fetch: fake.fetch });
  providers.push(provider);
  return provider;
}
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.dispose()));
});

const request = (overrides: Partial<PoTokenRequest> = {}): PoTokenRequest => ({
  contentBinding: "aqz-KE-bpKQ",
  client: "mweb",
  signal: undefined,
  ...overrides,
});
const decode = (token: string) => Buffer.from(token, "base64url").toString();
const causeNames = (error: unknown): string[] =>
  error instanceof Error ? [error.name, ...causeNames(error.cause)] : [];

describe("createPoTokenProvider", () => {
  test("mints in a worker without touching host globals or loading jsdom on the main thread", async () => {
    const provider = await provide(fakeYouTube({ ttl: 3600, threshold: 300 }));
    const token = await provider(request());

    expect(decode(token)).toBe("it-1|aqz-KE-bpKQ");
    expect(Reflect.get(globalThis, "window")).toBeUndefined();
    expect(Reflect.get(globalThis, "document")).toBeUndefined();
    expect(Reflect.get(globalThis, "location")).toBeUndefined();
    expect(Reflect.get(globalThis, "yt")).toBeUndefined();
    expect(Object.keys(require.cache).filter((path) => path.includes("/node_modules/jsdom/"))).toEqual([]);
    expect(new YtdlError("REQUEST_FAILED", `GET https://media.test/v?itag=251&pot=${token}`).message).not.toContain(
      token,
    );
  });

  test("binds each token to its contentBinding", async () => {
    const provider = await provide(fakeYouTube({ ttl: 3600, threshold: 300 }));
    expect(decode(await provider(request()))).toBe("it-1|aqz-KE-bpKQ");
    expect(decode(await provider(request({ contentBinding: "visitor-data" })))).toBe("it-1|visitor-data");
  });

  test("fetches the home page as a consenting browser whose user agent BotGuard also sees", async () => {
    const fake = fakeYouTube({ ttl: 3600, threshold: 300, interpreters: [USER_AGENT_INTERPRETER] });
    const provider = await provide(fake);
    const [headers] = fake.homePageHeaders;
    const userAgent = headers?.get("user-agent") ?? "";

    expect(userAgent).toStartWith("Mozilla/5.0 (");
    expect(headers?.get("cookie")).toContain("SOCS=CAI");
    expect(decode(await provider(request()))).toBe(`it-1|${userAgent}`);
  });

  test("minting writes nothing to standard output or standard error", async () => {
    const written: string[] = [];
    const capture = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    const { stdout, stderr } = process;
    const writes = [stdout.write, stderr.write];
    stdout.write = capture as typeof stdout.write;
    stderr.write = capture as typeof stderr.write;
    try {
      const provider = await provide(fakeYouTube({ ttl: 3600, threshold: 300 }));
      await provider(request());
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      [stdout.write, stderr.write] = writes as [typeof stdout.write, typeof stderr.write];
    }
    expect(written).toEqual([]);
  });

  test.each([
    ["keeps the integrity token while it is fresh", 3600, 300, "it-1"],
    ["refreshes the integrity token once the refresh threshold is reached", 60, 60, "it-2"],
  ])("%s", async (_, ttl, threshold, expected) => {
    const provider = await provide(fakeYouTube({ ttl, threshold }));
    expect(decode(await provider(request()))).toBe(`${expected}|aqz-KE-bpKQ`);
  });

  test("a disposed provider rejects with INVALID_STATE and starts no worker", async () => {
    const fake = fakeYouTube({ ttl: 3600, threshold: 300 });
    const provider = await provide(fake);
    await provider.dispose();
    const started = workersStarted;
    const requests = fake.requests.length;

    const error = await provider(request()).catch((caught: unknown) => caught);
    expect(YtdlError.is(error, "INVALID_STATE")).toBe(true);
    expect(workersStarted).toBe(started);
    expect(fake.requests).toHaveLength(requests);
  });

  test("a worker crash rejects the pending mint with its cause and the next call starts a fresh worker", async () => {
    const fake = fakeYouTube({ ttl: 60, threshold: 60, interpreters: [INTERPRETER, CRASHING_INTERPRETER] });
    const provider = await provide(fake);
    const started = workersStarted;

    const error = await provider(request()).catch((caught: unknown) => caught);
    expect(YtdlError.is(error, "REQUEST_FAILED")).toBe(true);
    expect(error instanceof YtdlError && error.cause instanceof Error && error.cause.message).toBe("boom");

    expect(decode(await provider(request()))).toBe("it-2|aqz-KE-bpKQ");
    expect(workersStarted).toBe(started + 1);
  });

  test("a stalled refresh fails after timeoutMs and the next mint sets BotGuard up again", async () => {
    const fake = fakeYouTube({ ttl: 60, threshold: 60 });
    const provider = await provide(fake, { timeoutMs: 50 });
    fake.stall = GENERATE_IT_URL;

    const error = await provider(request()).catch((caught: unknown) => caught);
    expect(YtdlError.is(error, "REQUEST_FAILED")).toBe(true);
    expect(causeNames(error)).toContain("TimeoutError");

    fake.stall = undefined;
    expect(decode(await provider(request()))).toBe("it-2|aqz-KE-bpKQ");
  });

  test("dispose aborts the in-flight request and rejects the pending call with INVALID_STATE", async () => {
    const fake = fakeYouTube({ ttl: 60, threshold: 60 });
    const provider = await provide(fake);
    fake.stall = HOME_PAGE_URL;

    const pending = provider(request()).catch((caught: unknown) => caught);
    const signal = await fake.stalled;
    await provider.dispose();

    expect(signal?.aborted).toBe(true);
    expect(YtdlError.is(await pending, "INVALID_STATE")).toBe(true);
  });

  test.each([
    "https://example.com/vm.js",
    "https://www.google.com.example.com/vm.js",
    "https://notyoutube.com/vm.js",
    "http://www.google.com/js/th/fake.js",
  ])("refuses the BotGuard interpreter %s without requesting it", async (interpreterUrl) => {
    const fake = fakeYouTube({ ttl: 3600, threshold: 300, page: homePage(interpreterUrl) });

    const error = await createPoTokenProvider({ fetch: fake.fetch }).catch((caught: unknown) => caught);
    expect(YtdlError.is(error, "REQUEST_FAILED")).toBe(true);
    expect(fake.requests).toEqual([HOME_PAGE_URL]);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects timeoutMs %p with INVALID_ARGUMENT before starting a worker",
    async (timeoutMs) => {
      const fake = fakeYouTube({ ttl: 3600, threshold: 300 });
      const started = workersStarted;

      const error = await createPoTokenProvider({ fetch: fake.fetch, timeoutMs }).catch((caught: unknown) => caught);
      expect(YtdlError.is(error, "INVALID_ARGUMENT")).toBe(true);
      expect(workersStarted).toBe(started);
      expect(fake.requests).toEqual([]);
    },
  );
});

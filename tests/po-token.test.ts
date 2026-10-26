import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as workerThreads from "node:worker_threads";
import { YtdlError } from "../src/errors.ts";
import type { PoTokenProviderOptions, PoTokenRequest } from "../src/po-token/index.ts";
import {
  CRASHING_INTERPRETER,
  fakeBotGuard,
  GENERATE_IT_URL,
  HOME_PAGE_URL,
  homePage,
  INTERPRETER,
  USER_AGENT_INTERPRETER,
  youTubeWithBotGuard,
} from "./fake-botguard.ts";
import {
  fakeYouTube,
  MWEB,
  type PlayerHandler,
  playable,
  TV,
  unplayable,
  VISIONOS,
  WEB_EMBEDDED,
} from "./fake-youtube.ts";
import { sabrPlayable, sabrServer } from "./fake-sabr.ts";

let workersStarted = 0;
class CountingWorker extends workerThreads.Worker {
  constructor(...args: ConstructorParameters<typeof workerThreads.Worker>) {
    super(...args);
    if (String(args[0]).includes("/po-token/")) workersStarted++;
  }
}
mock.module("node:worker_threads", () => ({ ...workerThreads, Worker: CountingWorker }));
const { createPoTokenProvider } = await import("../src/po-token/index.ts");
const { Ytdl } = await import("../src/index.ts");
type PoTokenProvider = Awaited<ReturnType<typeof createPoTokenProvider>>;

const providers: PoTokenProvider[] = [];
async function provide(
  fake: ReturnType<typeof fakeBotGuard>,
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
    const provider = await provide(fakeBotGuard({ ttl: 3600, threshold: 300 }));
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
    const provider = await provide(fakeBotGuard({ ttl: 3600, threshold: 300 }));
    expect(decode(await provider(request()))).toBe("it-1|aqz-KE-bpKQ");
    expect(decode(await provider(request({ contentBinding: "visitor-data" })))).toBe("it-1|visitor-data");
  });

  test("fetches the home page as a consenting browser whose user agent BotGuard also sees", async () => {
    const fake = fakeBotGuard({ ttl: 3600, threshold: 300, interpreters: [USER_AGENT_INTERPRETER] });
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
      const provider = await provide(fakeBotGuard({ ttl: 3600, threshold: 300 }));
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
    const provider = await provide(fakeBotGuard({ ttl, threshold }));
    expect(decode(await provider(request()))).toBe(`${expected}|aqz-KE-bpKQ`);
  });

  test("a disposed provider rejects with INVALID_STATE and starts no worker", async () => {
    const fake = fakeBotGuard({ ttl: 3600, threshold: 300 });
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
    const fake = fakeBotGuard({ ttl: 60, threshold: 60, interpreters: [INTERPRETER, CRASHING_INTERPRETER] });
    const provider = await provide(fake);
    const started = workersStarted;

    const error = await provider(request()).catch((caught: unknown) => caught);
    expect(YtdlError.is(error, "REQUEST_FAILED")).toBe(true);
    expect(error instanceof YtdlError && error.cause instanceof Error && error.cause.message).toBe("boom");

    expect(decode(await provider(request()))).toBe("it-2|aqz-KE-bpKQ");
    expect(workersStarted).toBe(started + 1);
  });

  test("a stalled refresh fails after timeoutMs and the next mint sets BotGuard up again", async () => {
    const fake = fakeBotGuard({ ttl: 60, threshold: 60 });
    const provider = await provide(fake, { timeoutMs: 50 });
    fake.stall = GENERATE_IT_URL;

    const error = await provider(request()).catch((caught: unknown) => caught);
    expect(YtdlError.is(error, "REQUEST_FAILED")).toBe(true);
    expect(causeNames(error)).toContain("TimeoutError");

    fake.stall = undefined;
    expect(decode(await provider(request()))).toBe("it-2|aqz-KE-bpKQ");
  });

  test("dispose aborts the in-flight request and rejects the pending call with INVALID_STATE", async () => {
    const fake = fakeBotGuard({ ttl: 60, threshold: 60 });
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
    const fake = fakeBotGuard({ ttl: 3600, threshold: 300, page: homePage(interpreterUrl) });

    const error = await createPoTokenProvider({ fetch: fake.fetch }).catch((caught: unknown) => caught);
    expect(YtdlError.is(error, "REQUEST_FAILED")).toBe(true);
    expect(fake.requests).toEqual([HOME_PAGE_URL]);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects timeoutMs %p with INVALID_ARGUMENT before starting a worker",
    async (timeoutMs) => {
      const fake = fakeBotGuard({ ttl: 3600, threshold: 300 });
      const started = workersStarted;

      const error = await createPoTokenProvider({ fetch: fake.fetch, timeoutMs }).catch((caught: unknown) => caught);
      expect(YtdlError.is(error, "INVALID_ARGUMENT")).toBe(true);
      expect(workersStarted).toBe(started);
      expect(fake.requests).toEqual([]);
    },
  );
});

const ID = "aqz-KE-bpKQ";
const PLAYER_ID = "aaaa0001";
const onlyMweb: PlayerHandler = ({ client }) => (client === MWEB ? playable(ID) : unplayable("UNPLAYABLE", ""));

const mintedToken = (yt: ReturnType<typeof fakeYouTube>) => {
  const call = yt.playerCalls.find((candidate) => candidate.client === MWEB);
  return (call?.body.serviceIntegrityDimensions as { poToken?: string } | undefined)?.poToken ?? "";
};

describe("the built-in provider of a Ytdl without getPoToken", () => {
  test("PO token rungs follow the earlier rungs with a token the worker minted through the instance's fetch", async () => {
    const { fetch, botGuard, yt } = youTubeWithBotGuard(onlyMweb);
    const started = workersStarted;
    const info = await new Ytdl({ fetch, playerId: PLAYER_ID }).getInfo(ID);

    expect(yt.clients()).toEqual([VISIONOS, WEB_EMBEDDED, TV, MWEB]);
    expect(decode(mintedToken(yt))).toBe(`it-1|${ID}`);
    expect(new URL(info.formats[0]?.url ?? "").searchParams.get("pot")).toBe(mintedToken(yt));
    expect(botGuard.requests).toContain(HOME_PAGE_URL);
    expect(workersStarted).toBe(started + 1);
  });

  test("no worker starts at construction or when an earlier rung plays", async () => {
    const { fetch, botGuard, yt } = youTubeWithBotGuard(() => playable(ID));
    const started = workersStarted;
    expect(() => new Ytdl({ fetch, clients: ["mweb"] })).not.toThrow();
    const info = await new Ytdl({ fetch, playerId: PLAYER_ID }).getInfo(ID);

    expect(info.client).toBe("visionos");
    expect(yt.clients()).toEqual([VISIONOS]);
    expect(botGuard.requests).toEqual([]);
    expect(workersStarted).toBe(started);
  });

  test("a hook replaces the provider", async () => {
    const { fetch, botGuard } = youTubeWithBotGuard(onlyMweb);
    const started = workersStarted;
    const calls: unknown[] = [];
    await new Ytdl({
      fetch,
      playerId: PLAYER_ID,
      clients: ["mweb"],
      getPoToken: async ({ contentBinding, client }) => {
        calls.push({ contentBinding, client });
        return "POTOKEN-for-test";
      },
    }).getInfo(ID);

    expect(calls).toEqual([{ contentBinding: ID, client: "mweb" }]);
    expect(botGuard.requests).toEqual([]);
    expect(workersStarted).toBe(started);
  });

  test("a failed startup fails the rung with its cause, and the next lookup starts a new provider", async () => {
    let homePages = 0;
    const { fetch } = youTubeWithBotGuard(onlyMweb, (pass) =>
      ++homePages === 1 ? Promise.resolve(new Response("", { status: 500 })) : pass(),
    );
    const ytdl = new Ytdl({ fetch, playerId: PLAYER_ID, clients: ["mweb"] });
    const started = workersStarted;

    const error = await ytdl.getInfo(ID).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "REQUEST_FAILED",
      attempts: [{ client: "mweb", step: "po-token", code: "REQUEST_FAILED", cause: expect.any(YtdlError) }],
    });

    expect((await ytdl.getInfo(ID)).client).toBe("mweb");
    expect(workersStarted).toBe(started + 2);
  });

  test("concurrent first lookups share one startup", async () => {
    const { fetch } = youTubeWithBotGuard(onlyMweb);
    const ytdl = new Ytdl({ fetch, playerId: PLAYER_ID, clients: ["mweb"] });
    const started = workersStarted;
    const infos = await Promise.all([ytdl.getInfo(ID), ytdl.getInfo(ID)]);

    expect(infos.map((info) => info.client)).toEqual(["mweb", "mweb"]);
    expect(workersStarted).toBe(started + 1);
  });

  test("a cancelled first lookup leaves the startup to the other", async () => {
    const homePageAsked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { fetch, yt } = youTubeWithBotGuard(onlyMweb, async (pass) => {
      homePageAsked.resolve();
      await release.promise;
      return pass();
    });
    const ytdl = new Ytdl({ fetch, playerId: PLAYER_ID, clients: ["mweb"] });
    const started = workersStarted;
    const controller = new AbortController();
    const reason = new Error("caller gave up");

    const first = ytdl.getInfo(ID, { signal: controller.signal }).catch((caught: unknown) => caught);
    const second = ytdl.getInfo(ID);
    await homePageAsked.promise;
    controller.abort(reason);
    expect(await first).toBe(reason);
    release.resolve();

    expect((await second).client).toBe("mweb");
    expect(decode(mintedToken(yt))).toBe(`it-1|${ID}`);
    expect(workersStarted).toBe(started + 1);
  });

  test("SABR attestation mints through the provider", async () => {
    const audio = {
      itag: 251,
      mimeType: 'audio/webm; codecs="opus"',
      bytes: Uint8Array.from({ length: 5000 }, (_, i) => i % 251),
    };
    const { fetch, botGuard } = youTubeWithBotGuard(() => sabrPlayable(ID, [audio]));
    const sabr = sabrServer({ formats: [audio], requireAttestation: true });
    const ytdl = new Ytdl({ fetch: sabr.fetch(fetch), playerId: PLAYER_ID });
    const body = Buffer.concat(await ytdl.download(ID, { quality: 251 }).toArray());

    expect(body).toEqual(Buffer.from(audio.bytes));
    expect(sabr.requests.some((post) => post.poToken === `it-1|${ID}`)).toBe(true);
    expect(botGuard.requests).toContain(HOME_PAGE_URL);
  });

  test("an idle provider lets the process exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ytdl-idle-"));
    try {
      const script = join(dir, "idle.ts");
      writeFileSync(
        script,
        `import { Ytdl } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).pathname)};
import { youTubeWithBotGuard } from ${JSON.stringify(new URL("./fake-botguard.ts", import.meta.url).pathname)};
import { playable } from ${JSON.stringify(new URL("./fake-youtube.ts", import.meta.url).pathname)};
const { fetch } = youTubeWithBotGuard(() => playable(${JSON.stringify(ID)}));
const info = await new Ytdl({ fetch, playerId: ${JSON.stringify(PLAYER_ID)}, clients: ["mweb"] }).getInfo(${JSON.stringify(ID)});
if (info.client !== "mweb") process.exit(2);
`,
      );
      const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
      const timer = setTimeout(() => child.kill(), 20_000);
      const code = await child.exited;
      clearTimeout(timer);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

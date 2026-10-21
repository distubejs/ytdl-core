import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { Client, Ytdl, YtdlError } from "../src/index.ts";
import type { RetryEvent } from "../src/index.ts";
import { ciphered, fakeYouTube, MEDIA_HOST, TV, unplayable, VISIONOS } from "./fake-youtube.ts";

const ID = "aqz-KE-bpKQ";
const SOLVED = ["edcba", "xyz3"];

function surfaces(error: unknown): string[] {
  const out: string[] = [];
  for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
    out.push(JSON.stringify(current) ?? "", inspect(current, { depth: 5 }));
    if (current instanceof Error) out.push(current.message, current.stack ?? "");
  }
  return out;
}

const refused = (url: string) =>
  Object.assign(new TypeError(`Unable to connect to ${url}`), { code: "ECONNREFUSED", path: url });

describe("redaction", () => {
  test("a failed media request names the itag and status, never the signed parameters", async () => {
    const solvedMedia = `${MEDIA_HOST}?itag=251&expire=4102444800&n=xyz3&sig=edcba`;
    const yt = fakeYouTube({
      player: ({ client }) => (client === VISIONOS ? unplayable("UNPLAYABLE", "") : ciphered(ID)),
      routes: { [solvedMedia]: () => new Response("boom", { status: 500 }) },
    });
    const ytdl = new Ytdl({ fetch: yt.fetch, playerId: "aaaa0002", clients: [Client.VisionOS, Client.Tv] });
    const retries: RetryEvent[] = [];
    const stream = ytdl.download(ID, {
      filter: { hasAudio: true, hasVideo: false },
      onRetry: (event) => retries.push(event),
    });
    const error = await new Promise<unknown>((resolve) => {
      stream.on("error", resolve);
      stream.resume();
    });

    expect(yt.requests.some((request) => request.url.startsWith(`${solvedMedia}&range=`))).toBe(true);
    expect(YtdlError.is(error, "REQUEST_FAILED")).toBe(true);
    expect((error as Error).message).toContain("251");
    expect((error as Error).message).toContain("500");
    const visible = [...surfaces(error), JSON.stringify(retries)].join("\n");
    for (const secret of SOLVED) expect(visible).not.toContain(secret);
    expect(yt.clients()).toEqual([VISIONOS, TV]);
  });

  test("signed URL parameters are stripped from library messages", () => {
    const error = new YtdlError("REQUEST_FAILED", `GET ${MEDIA_HOST}?itag=18&sig=AAA&n=BBB&pot=CCC&lsig=DDD failed`);
    expect(error.message).toBe(
      `GET ${MEDIA_HOST}?itag=18&sig=[redacted]&n=[redacted]&pot=[redacted]&lsig=[redacted] failed`,
    );
  });

  test.each([
    ["the runtime error itself", refused],
    ["a wrapper whose cause is the runtime error", (url: string) => new Error("proxy failed", { cause: refused(url) })],
    ["an AggregateError of runtime errors", (url: string) => new AggregateError([refused(url)], "proxies failed")],
    ["an error holding the request", (url: string) => Object.assign(new Error("proxy failed"), { request: { url } })],
    ["a plain object holding the URL", (url: string) => ({ url })],
    ["the URL past inspect's array limit", (url: string) => ({ attempts: [...Array(100).fill("timeout"), url] })],
    ["the URL past inspect's string limit", (url: string) => ({ detail: "x".repeat(10_000) + url })],
  ])("a fetch rejection with %s leaves the signed URL out of every cause", async (_, rejection) => {
    const yt = fakeYouTube({
      player: ({ client }) => (client === VISIONOS ? unplayable("UNPLAYABLE", "") : ciphered(ID)),
    });
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      return url.startsWith(MEDIA_HOST) ? Promise.reject(rejection(url)) : yt.fetch(input, init);
    }) as typeof globalThis.fetch;
    const stream = new Ytdl({ fetch, playerId: "aaaa0002", clients: [Client.VisionOS, Client.Tv] }).download(ID, {
      filter: { hasAudio: true, hasVideo: false },
    });
    const error = await new Promise<unknown>((resolve) => {
      stream.on("error", resolve);
      stream.resume();
    });

    expect(YtdlError.is(error, "REQUEST_FAILED")).toBe(true);
    const visible = [Bun.inspect(error, { depth: Infinity }), ...surfaces(error)].join("\n");
    for (const secret of SOLVED) expect(visible).not.toContain(secret);
  });

  test("signed path segments of a manifest URL are stripped from library messages", () => {
    const manifest = "https://manifest.googlevideo.com/api/manifest/hls_variant/n/abcd/sig/efgh/file/index.m3u8";
    const player = "https://www.youtube.com/s/player/aaaa0002/player_ias.vflset/en_US/base.js";
    expect(new YtdlError("REQUEST_FAILED", `GET ${manifest} and ${player} failed`).message).toBe(
      "GET https://manifest.googlevideo.com/api/manifest/hls_variant/n/[redacted]/sig/[redacted]/file/index.m3u8" +
        ` and ${player} failed`,
    );
  });

  test("a getPoToken rejection without secrets stays the cause as is", async () => {
    const rejection = new Error("minting is down");
    const yt = fakeYouTube({ player: () => unplayable("UNPLAYABLE", "") });
    const error = await new Ytdl({
      fetch: yt.fetch,
      playerId: "aaaa0004",
      clients: [Client.Mweb],
      getPoToken: () => Promise.reject(rejection),
    })
      .getInfo(ID)
      .catch((caught: unknown) => caught);

    expect(YtdlError.is(error)).toBe(true);
    expect((error as Error).cause).toBe(rejection);
  });

  test("a getPoToken rejection that names a signed URL is scrubbed in attempt reasons and causes", async () => {
    const yt = fakeYouTube({ player: () => unplayable("UNPLAYABLE", "") });
    const error = await new Ytdl({
      fetch: yt.fetch,
      playerId: "aaaa0004",
      clients: [Client.Mweb],
      getPoToken: () => Promise.reject(new Error(`mint failed for ${MEDIA_HOST}?pot=SECRETPOT&sig=SECRETSIG`)),
    })
      .getInfo(ID)
      .catch((caught: unknown) => caught);
    expect(YtdlError.is(error)).toBe(true);
    const visible = [JSON.stringify((error as YtdlError).attempts), ...surfaces(error)].join("\n");
    expect(visible).toContain("mint failed");
    expect(visible).not.toContain("SECRETPOT");
    expect(visible).not.toContain("SECRETSIG");
  });

  test("account credentials stay out of instances and errors", async () => {
    const cookie = "SAPISID=sapisid-secret-value; LOGIN_INFO=login-secret-value";
    const yt = fakeYouTube({ player: () => unplayable("UNPLAYABLE", "") });
    const signedOut = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === "https://www.youtube.com/"
        ? new Response(`ytcfg.set({"LOGGED_IN":false,"echo":"${cookie}"});`)
        : yt.fetch(input, init)) as typeof fetch;
    const withCookie = new Ytdl({ cookie, fetch: signedOut, playerId: "aaaa0003" });

    const forms = [JSON.stringify(withCookie), String(withCookie), inspect(withCookie, { depth: 5 })];
    const error = await withCookie.getInfo(ID).catch((caught: unknown) => caught);
    expect(YtdlError.is(error)).toBe(true);
    const visible = [...forms, ...surfaces(error), JSON.stringify((error as YtdlError).attempts)].join("\n");
    for (const secret of ["sapisid-secret-value", "login-secret-value"]) {
      expect(visible).not.toContain(secret);
    }
  });

  test("a provider reason that echoes the cookie keeps its values out of errors", async () => {
    const cookie = "SAPISID=sapisid-secret-value; LOGIN_INFO=login-secret-value";
    const yt = fakeYouTube({ player: () => unplayable("UNPLAYABLE", `Blocked for ${cookie}`) });
    const signedIn = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === "https://www.youtube.com/"
        ? new Response('ytcfg.set({"LOGGED_IN":true});')
        : yt.fetch(input, init)) as typeof fetch;
    const error = await new Ytdl({ cookie, fetch: signedIn, playerId: "aaaa0005" })
      .getInfo(ID)
      .catch((caught: unknown) => caught);

    expect(YtdlError.is(error)).toBe(true);
    const visible = [...surfaces(error), JSON.stringify((error as YtdlError).attempts)].join("\n");
    expect(visible).toContain("Blocked for");
    for (const secret of ["sapisid-secret-value", "login-secret-value"]) expect(visible).not.toContain(secret);
  });
});

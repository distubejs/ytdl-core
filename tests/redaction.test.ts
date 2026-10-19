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
    if (!(current instanceof Error)) break;
    out.push(current.message, current.stack ?? "", inspect(current, { depth: 5 }));
  }
  return out;
}

describe("redaction", () => {
  test("a failed media request names the itag and status, never the signed parameters", async () => {
    const solvedMedia = `${MEDIA_HOST}?itag=251&expire=4102444800&n=xyz3&sig=edcba`;
    const yt = fakeYouTube({
      player: ({ client }) => (client === VISIONOS ? unplayable("UNPLAYABLE", "") : ciphered(ID)),
      routes: { [solvedMedia]: () => new Response("boom", { status: 500 }) },
    });
    const ytdl = new Ytdl({ fetch: yt.fetch, playerId: "aaaa0002", clients: [Client.VisionOS, Client.Tv] });
    const retries: RetryEvent[] = [];
    const stream = ytdl.download(ID, { filter: "audioonly", onRetry: (event) => retries.push(event) });
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

  test("attempt reasons are scrubbed like messages", async () => {
    const yt = fakeYouTube({ player: () => unplayable("UNPLAYABLE", "") });
    const error = await new Ytdl({
      fetch: yt.fetch,
      playerId: "aaaa0004",
      getPoToken: () => Promise.reject(new Error(`mint failed for ${MEDIA_HOST}?pot=SECRETPOT&sig=SECRETSIG`)),
    })
      .getInfo(ID)
      .catch((caught: unknown) => caught);
    expect(YtdlError.is(error)).toBe(true);
    const reasons = JSON.stringify((error as YtdlError).attempts);
    expect(reasons).toContain("mint failed");
    expect(reasons).not.toContain("SECRETPOT");
    expect(reasons).not.toContain("SECRETSIG");
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
});

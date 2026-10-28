import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Ytdl } from "../src/index.ts";
import { YtdlError } from "../src/errors.ts";
import { loadPlayer } from "../src/solver/index.ts";
import { ciphered, fakeYouTube, playable, TV, VISIONOS } from "./fake-youtube.ts";
import hostile from "./fixtures/solver/hostile-players.json" with { type: "json" };

const PLAYER = readFileSync(new URL("./fixtures/solver/player.js", import.meta.url), "utf8");
const HOOK = "var hook=function(){};";
const MEDIA = "https://rr1---sn-abc.googlevideo.com/videoplayback?itag=251&mime=audio%2Fwebm&n=xyz";

function youtube(players: Record<string, string>, current?: string) {
  const requests: string[] = [];
  const fetchFake = async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (url === "https://www.youtube.com/iframe_api") {
      return new Response(
        `var scriptUrl = 'https:\\/\\/www.youtube.com\\/s\\/player\\/${current}\\/www-widgetapi.js';`,
      );
    }
    const id = /^https:\/\/www\.youtube\.com\/s\/player\/(\w+)\/player_ias\.vflset\/en_US\/base\.js$/u.exec(url)?.[1];
    const body = id === undefined ? undefined : players[id];
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  };
  const fetch = fetchFake as typeof globalThis.fetch;
  const scripts = (id: string) => requests.filter((url) => url.includes(`/s/player/${id}/`)).length;
  return { fetch, requests, scripts };
}

async function solveError(solving: Promise<unknown>): Promise<YtdlError> {
  const error = await solving.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (error instanceof YtdlError) return error;
  throw new Error("Expected a YtdlError");
}

describe("loadPlayer", () => {
  test("solves the signature and n with the player's own builder", async () => {
    const { fetch } = youtube({ a0000001: PLAYER });
    const player = await loadPlayer({ fetch, playerId: "a0000001" });
    expect(player.id).toBe("a0000001");
    expect(player.signatureTimestamp).toBe(20123);

    const manifest =
      "https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1/n/xyz/source/yt_live_broadcast";
    const direct = "https://rr1---sn-abc.googlevideo.com/videoplayback?itag=18";
    const [signed, defaultParam, throttled, untouched, manifestUrl] = await player.solve([
      { signatureCipher: new URLSearchParams({ s: "AB=CDE", sp: "sig", url: MEDIA }).toString() },
      { signatureCipher: new URLSearchParams({ s: "abc", url: MEDIA }).toString() },
      { url: MEDIA },
      { url: direct },
      { url: manifest },
    ]);
    const signedUrl = new URL(signed ?? "");
    expect(signedUrl.searchParams.get("sig")).toBe("DC=BA");
    expect(signedUrl.searchParams.get("n")).toBe("xyz3");
    expect(signedUrl.searchParams.get("mime")).toBe("audio/webm");
    expect(new URL(defaultParam ?? "").searchParams.get("signature")).toBe("ba");
    expect(new URL(throttled ?? "").searchParams.get("n")).toBe("xyz3");
    expect(untouched).toBe(direct);
    expect(manifestUrl).toBe(
      "https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1/n/xyz3/source/yt_live_broadcast",
    );
  });

  test("a slow player leaves the event loop free while it solves a batch", async () => {
    const slow = "var hook=function(){var t=Date.now();while(Date.now()-t<50){}};";
    const { fetch } = youtube({ a0000002: PLAYER.replace(HOOK, slow) });
    const player = await loadPlayer({ fetch, playerId: "a0000002" });
    const urls = Array.from({ length: 10 }, (_, index) => ({ url: `${MEDIA}${index}` }));
    const ticks: number[] = [];
    const interval = setInterval(() => ticks.push(Date.now()), 10);
    const started = Date.now();
    try {
      const solved = await player.solve(urls);
      expect(solved.map((url) => new URL(url).searchParams.get("n"))).toEqual(urls.map((_, index) => `xyz${index}4`));
    } finally {
      clearInterval(interval);
    }
    const gaps = ticks.map((tick, index) => tick - (ticks[index - 1] ?? started));
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(Math.max(...gaps)).toBeLessThan(100);
  });

  test("a callback the player queues after the solve never reaches the host", async () => {
    const late = `var hook=function(){Promise.resolve().then(function(){throw new Error("late")});Promise.reject(new Error("unhandled"))};`;
    const { fetch } = youtube({ b0000001: PLAYER.replace(HOOK, late) });
    const escaped: unknown[] = [];
    const record = (error: unknown) => escaped.push(error);
    process.on("unhandledRejection", record);
    process.on("uncaughtException", record);
    try {
      const player = await loadPlayer({ fetch, playerId: "b0000001" });
      const [solved] = await player.solve([{ url: MEDIA }]);
      expect(new URL(solved ?? "").searchParams.get("n")).toBe("xyz3");
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off("unhandledRejection", record);
      process.off("uncaughtException", record);
    }
    expect(escaped).toEqual([]);
  });

  test("an endless loop in player code fails the solve as PLAYER_SOLVE_FAILED", async () => {
    const { fetch } = youtube({ c0000001: PLAYER.replace(HOOK, "var hook=function(){for(;;){}};"), c0000002: PLAYER });
    const looping = await loadPlayer({ fetch, playerId: "c0000001" });
    const error = await solveError(looping.solve([{ url: MEDIA }]));
    expect(error.code).toBe("PLAYER_SOLVE_FAILED");
    expect(error.cause).toBeInstanceOf(Error);

    const healthy = await loadPlayer({ fetch, playerId: "c0000002" });
    const [solved] = await healthy.solve([{ url: MEDIA }]);
    expect(new URL(solved ?? "").searchParams.get("n")).toBe("xyz3");
  });

  test.each(hostile.cases.map((player, index) => [player.name, player, `h000000${index}`] as const))(
    "a player that %s gets its pinned outcome, never reaches the host and leaves the worker solving",
    async (_, { payload, outcome }, playerId) => {
      const dir = mkdtempSync(join(tmpdir(), "ytdl-solver-"));
      const marker = join(dir, "escaped");
      const prelude = hostile.prelude.replace("MARKER", JSON.stringify(marker));
      const { fetch } = youtube({ [playerId]: PLAYER.replace(HOOK, `${prelude}${payload}`), h0000099: PLAYER });
      try {
        const result = await loadPlayer({ fetch, playerId })
          .then((player) => player.solve([{ url: MEDIA }]))
          .then(
            ([solved]) => new URL(solved ?? "").searchParams.get("n"),
            (reason: unknown) => (YtdlError.is(reason) ? reason.code : reason),
          );
        expect(result).toBe(outcome);
        expect(existsSync(marker)).toBe(false);

        const healthy = await loadPlayer({ fetch, playerId: "h0000099" });
        const [solved] = await healthy.solve([{ url: MEDIA }]);
        expect(new URL(solved ?? "").searchParams.get("n")).toBe("xyz3");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("an n transform that returns its input fails the rung as PLAYER_SOLVE_FAILED and the next client answers", async () => {
    const failing = PLAYER.replace(
      "var nT=function(a){return a+a.length};",
      'var nT=function(a){return "enhanced_except_gZ4B_"+a};',
    );
    const id = "aqz-KE-bpKQ";
    const yt = fakeYouTube({ player: ({ client }) => (client === TV ? ciphered(id) : playable(id)) });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/s/player/") ? new Response(failing) : yt.fetch(input, init)) as typeof globalThis.fetch;

    const info = await new Ytdl({ fetch, playerId: "c0000004", clients: [Client.Tv, Client.VisionOS] }).getInfo(id);
    expect(info.client).toBe("visionos");
    expect(yt.clients()).toEqual([TV, VISIONOS]);
    const error = await solveError(new Ytdl({ fetch, playerId: "c0000004", clients: [Client.Tv] }).getInfo(id));
    expect(error.code).toBe("PLAYER_SOLVE_FAILED");
  });

  test.each([
    ["a script answering 404", "d0000001", undefined, "Could not load player d0000001", "REQUEST_FAILED"],
    [
      "a player without the URL builder",
      "d0000002",
      PLAYER.replace('d.set("alr","yes");', ""),
      "Could not prepare player d0000002",
      undefined,
    ],
  ] as const)("%s fails to load as PLAYER_SOLVE_FAILED naming the player", async (_, id, body, message, causeCode) => {
    const { fetch } = youtube(body === undefined ? {} : { [id]: body });
    const error = await solveError(loadPlayer({ fetch, playerId: id }));
    expect(error.code).toBe("PLAYER_SOLVE_FAILED");
    expect(error.message).toBe(message);
    expect(error.cause).toBeInstanceOf(Error);
    if (causeCode) expect(YtdlError.is(error.cause, causeCode)).toBe(true);
  });

  test("concurrent loads of one version fetch and prepare it once", async () => {
    const first = youtube({ e0000001: PLAYER });
    const second = youtube({ e0000001: PLAYER });
    const [a, b] = await Promise.all([
      loadPlayer({ fetch: first.fetch, playerId: "e0000001" }),
      loadPlayer({ fetch: second.fetch, playerId: "e0000001" }),
    ]);
    expect(a).toBe(b);
    expect(first.scripts("e0000001") + second.scripts("e0000001")).toBe(1);
  });

  test("the playerId pin wins over discovery", async () => {
    const { fetch, requests, scripts } = youtube({ f0000001: PLAYER, f0000002: PLAYER }, "f0000001");
    expect((await loadPlayer({ fetch, playerId: "f0000002" })).id).toBe("f0000002");
    expect(requests).not.toContain("https://www.youtube.com/iframe_api");
    expect(scripts("f0000001")).toBe(0);
  });

  test("the cache keeps the four most recently used versions", async () => {
    const ids = ["90000001", "90000002", "90000003", "90000004", "90000005"];
    const { fetch, scripts } = youtube(Object.fromEntries(ids.map((id) => [id, PLAYER])));
    const load = (playerId: string) => loadPlayer({ fetch, playerId });
    for (const id of ids.slice(0, 4)) await load(id);
    await load("90000001");
    await load("90000005");

    await load("90000001");
    expect(scripts("90000001")).toBe(1);
    await load("90000002");
    expect(scripts("90000002")).toBe(2);
  });
});

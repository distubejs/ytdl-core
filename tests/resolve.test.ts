import { describe, expect, test } from "bun:test";
import { BLOCK_PERIOD_MS, planClients } from "../src/resolve.ts";
import { Client, DEFAULT_CLIENTS, Ytdl, YtdlError } from "../src/index.ts";
import type { RetryEvent } from "../src/index.ts";
import {
  audioFormat,
  ciphered,
  fakeYouTube,
  MEDIA_HOST,
  MWEB,
  playable,
  SIGNATURE_TIMESTAMP,
  TV,
  unplayable,
  VISIONOS,
  WEB_EMBEDDED,
} from "./fake-youtube.ts";

const ID = "aqz-KE-bpKQ";
const PLAYER_ID = "aaaa0001";

const order = (cookie: boolean, poToken: boolean) =>
  planClients({ clients: DEFAULT_CLIENTS, cookie, poToken }, new Map(), 0).map(
    (rung) => `${rung.client}${rung.signedIn ? "+" : ""}`,
  );

async function rejection(promise: Promise<unknown>): Promise<YtdlError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof YtdlError)) throw new Error(`Expected a YtdlError, got ${String(error)}`);
  return error;
}

describe("client order", () => {
  test("a made-for-kids video falls through VISIONOS to the embedded player, solved with the player", async () => {
    const yt = fakeYouTube({
      player: ({ client }) => (client === VISIONOS ? unplayable("UNPLAYABLE", "") : ciphered(ID)),
    });
    const info = await new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID }).getInfo(ID);

    expect(yt.clients()).toEqual([VISIONOS, WEB_EMBEDDED]);
    expect(info.client).toBe("web_embedded");
    const url = new URL(info.formats[0]?.url ?? "");
    expect(url.searchParams.get("sig")).toBe("edcba");
    expect(url.searchParams.get("n")).toBe("xyz3");
    const embedded = yt.playerCalls[1]?.body;
    expect(embedded?.playbackContext).toEqual({
      contentPlaybackContext: {
        html5Preference: "HTML5_PREF_WANTS",
        signatureTimestamp: SIGNATURE_TIMESTAMP,
        encryptedHostFlags: "HOST-FLAGS",
      },
    });
    expect(embedded?.context).toMatchObject({
      client: { visitorData: "EMBED-VISITOR" },
      thirdParty: { embedUrl: "https://www.reddit.com/" },
    });
    for (const call of yt.playerCalls) {
      expect(call.body.contentCheckOk).toBe(true);
      expect(call.body.racyCheckOk).toBe(true);
    }
  });

  test("the PO token rungs need a provider, and their URLs carry its token", async () => {
    const answer = ({ client }: { client: string }) => (client === MWEB ? ciphered(ID) : unplayable("UNPLAYABLE", ""));
    const clients = [Client.VisionOS, Client.Tv, Client.Mweb];
    const without = fakeYouTube({ player: answer });
    await rejection(new Ytdl({ fetch: without.fetch, playerId: PLAYER_ID, clients }).getInfo(ID));
    expect(without.clients()).toEqual([VISIONOS, TV]);

    const requests: unknown[] = [];
    const withHook = fakeYouTube({ player: answer });
    const info = await new Ytdl({
      fetch: withHook.fetch,
      playerId: PLAYER_ID,
      clients,
      getPoToken: async (request) => {
        requests.push({ videoId: request.videoId, client: request.client, visitorData: request.visitorData });
        return "POTOKEN-for-test";
      },
    }).getInfo(ID);

    expect(withHook.clients()).toEqual([VISIONOS, TV, MWEB]);
    expect(requests).toEqual([{ videoId: ID, client: "mweb", visitorData: "VISITOR-1" }]);
    expect(withHook.playerCalls[2]?.body.serviceIntegrityDimensions).toEqual({ poToken: "POTOKEN-for-test" });
    expect(new URL(info.formats[0]?.url ?? "").searchParams.get("pot")).toBe("POTOKEN-for-test");
  });

  test("a session-bound client asks for its token without the video", async () => {
    const yt = fakeYouTube({ player: () => playable(ID) });
    const videoIds: string[] = [];
    await new Ytdl({
      fetch: yt.fetch,
      playerId: PLAYER_ID,
      clients: [Client.TvSimply],
      getPoToken: async (request) => {
        videoIds.push(request.videoId);
        return "POTOKEN-for-test";
      },
    }).getInfo(ID);
    expect(videoIds).toEqual([""]);
  });

  test("a failing hook fails its rung without hiding earlier outcomes", async () => {
    const yt = fakeYouTube({ player: () => unplayable("LOGIN_REQUIRED", "Sign in to confirm your age") });
    const error = await rejection(
      new Ytdl({
        fetch: yt.fetch,
        playerId: PLAYER_ID,
        clients: [Client.VisionOS, Client.Tv, Client.Mweb],
        getPoToken: () => Promise.reject(new Error("minter down")),
      }).getInfo(ID),
    );
    expect(error.code).toBe("AGE_RESTRICTED");
    expect(error.attempts.map((attempt) => [attempt.client, attempt.code])).toEqual([
      ["visionos", "AGE_RESTRICTED"],
      ["tv", "AGE_RESTRICTED"],
      ["mweb", "REQUEST_FAILED"],
    ]);
  });

  test("blocked clients move to the end until the block period passes", () => {
    const config = { clients: DEFAULT_CLIENTS, cookie: false, poToken: false } as const;
    const blocked = new Map([["visionos", 1_000]] as const);
    expect(planClients(config, blocked, 1_000 + BLOCK_PERIOD_MS - 1).map((rung) => rung.client)).toEqual([
      "web_embedded",
      "tv",
      "visionos",
    ]);
    expect(planClients(config, blocked, 1_000 + BLOCK_PERIOD_MS).map((rung) => rung.client)).toEqual([
      "visionos",
      "web_embedded",
      "tv",
    ]);
  });

  test("account rungs exist only with their credential", () => {
    expect(order(false, false)).toEqual(["visionos", "web_embedded", "tv"]);
    expect(order(true, true)).toEqual([
      "visionos",
      "web_embedded",
      "web_embedded+",
      "tv",
      "tv+",
      "mweb",
      "mweb+",
      "web_creator+",
    ]);
    expect(order(false, true)).toEqual(["visionos", "web_embedded", "tv", "mweb"]);
  });

  test("the clients option is the priority order", async () => {
    const yt = fakeYouTube({ player: () => unplayable("UNPLAYABLE", "") });
    const ytdl = new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID, clients: [Client.Tv, Client.VisionOS] });
    await rejection(ytdl.getInfo(ID));
    expect(yt.clients()).toEqual([TV, VISIONOS]);
  });

  test.each([[[]], [["visionos", "visionos"]], [["nope"]], [["mweb"]], [["web_creator"]]])(
    "clients %p fails construction",
    (clients) => {
      expect(() => new Ytdl({ clients: clients as Client[] })).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
    },
  );
});

describe("visitor data", () => {
  test("concurrent first calls fetch it once", async () => {
    const yt = fakeYouTube({ player: () => playable(ID) });
    const ytdl = new Ytdl({ fetch: yt.fetch });
    await Promise.all([ytdl.getInfo(ID), ytdl.getInfo(ID), ytdl.getInfo(ID)]);
    expect(yt.visitorFetches()).toBe(1);
  });

  test("a bot check replaces it once and retries the same client", async () => {
    const yt = fakeYouTube({
      player: ({ headers }) =>
        headers.get("X-Goog-Visitor-Id") === "VISITOR-1"
          ? unplayable("LOGIN_REQUIRED", "Sign in to confirm you're not a bot")
          : playable(ID),
    });
    const info = await new Ytdl({ fetch: yt.fetch }).getInfo(ID);
    expect(info.client).toBe("visionos");
    expect(yt.clients()).toEqual([VISIONOS, VISIONOS]);
    expect(yt.visitorFetches()).toBe(2);
  });
});

describe("shared lookups", () => {
  test("concurrent bot checks on one visitor share one replacement", async () => {
    const yt = fakeYouTube({
      player: ({ headers }) =>
        headers.get("X-Goog-Visitor-Id") === "VISITOR-1"
          ? unplayable("LOGIN_REQUIRED", "Sign in to confirm you're not a bot")
          : playable(ID),
    });
    const ytdl = new Ytdl({ fetch: yt.fetch });
    await Promise.all([ytdl.getInfo(ID), ytdl.getInfo(ID), ytdl.getInfo(ID)]);
    expect(yt.visitorFetches()).toBe(2);
  });

  test("one caller's abort does not fail another lookup of the same video", async () => {
    const controller = new AbortController();
    const yt = fakeYouTube({ player: ({ client }) => (client === MWEB ? ciphered(ID) : unplayable("UNPLAYABLE", "")) });
    const ytdl = new Ytdl({
      fetch: yt.fetch,
      playerId: PLAYER_ID,
      getPoToken: async ({ signal }) => {
        await Bun.sleep(20);
        signal?.throwIfAborted();
        return "POTOKEN-shared";
      },
    });
    const first = ytdl.getInfo(ID, { signal: controller.signal });
    const second = ytdl.getInfo(ID);
    await Bun.sleep(5);
    controller.abort(new Error("first caller gave up"));
    await expect(first).rejects.toThrow("first caller gave up");
    expect((await second).client).toBe("mweb");
  });
});

describe("resume", () => {
  test("a 403 replaces the visitor, asks the same client and continues at the next byte", async () => {
    const content = Uint8Array.from({ length: 3000 }, (_, index) => index % 251);
    const yt = fakeYouTube({
      player: ({ headers }) =>
        playable(ID, [
          audioFormat(251, {
            url: `${MEDIA_HOST}?itag=251&expire=4102444800&v=${headers.get("X-Goog-Visitor-Id")}`,
            contentLength: String(content.length),
          }),
        ]),
      media: (url) => {
        const [start = 0, end = 0] = (url.searchParams.get("range") ?? "").split("-").map(Number);
        if (url.searchParams.get("v") === "VISITOR-1" && start >= 1000) return new Response("", { status: 403 });
        return new Response(content.slice(start, end + 1));
      },
    });
    const retries: RetryEvent[] = [];
    const stream = new Ytdl({ fetch: yt.fetch }).download(ID, {
      chunkSize: 1000,
      onRetry: (event) => retries.push(event),
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk as Uint8Array);

    expect(Buffer.concat(chunks)).toEqual(Buffer.from(content));
    expect(retries).toEqual([{ attempt: 1, client: "visionos", reason: "HTTP 403" }]);
    expect(yt.visitorFetches()).toBe(2);
    expect(yt.clients()).toEqual([VISIONOS, VISIONOS]);
  });

  test("a client still walled after a new visitor is blocked, and the next client finishes the bytes", async () => {
    const content = Uint8Array.from({ length: 4000 }, (_, index) => (index * 7) % 256);
    const yt = fakeYouTube({
      player: ({ client }) =>
        client === VISIONOS
          ? playable(ID, [audioFormat(251, { url: `${MEDIA_HOST}?itag=251&expire=4102444800&c=visionos` })])
          : ciphered(ID),
      media: (url) => {
        const [start = 0, end = 0] = (url.searchParams.get("range") ?? "").split("-").map(Number);
        if (url.searchParams.get("c") === "visionos" && start >= 1000) return new Response("", { status: 403 });
        return new Response(content.slice(start, end + 1));
      },
    });
    const ytdl = new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID, clients: [Client.VisionOS, Client.Tv] });
    const retries: RetryEvent[] = [];
    const stream = ytdl.download(ID, { chunkSize: 1000, onRetry: (event) => retries.push(event) });
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk as Uint8Array);

    expect(Buffer.concat(chunks)).toEqual(Buffer.from(content));
    expect(retries.map(({ attempt, client }) => [attempt, client])).toEqual([
      [1, "visionos"],
      [2, "visionos"],
    ]);
    const before = yt.clients().length;
    expect((await ytdl.getInfo(ID)).client).toBe("tv");
    expect(yt.clients().slice(before)).toEqual([TV]);
  });
});

describe("outcomes", () => {
  test("an answer for another video is discarded", async () => {
    const yt = fakeYouTube({ player: ({ client }) => (client === VISIONOS ? playable("otherVideo1") : ciphered(ID)) });
    const info = await new Ytdl({
      fetch: yt.fetch,
      playerId: PLAYER_ID,
      clients: [Client.VisionOS, Client.Tv],
    }).getInfo(ID);
    expect(info.videoDetails.id).toBe(ID);
    expect(info.client).toBe("tv");
  });

  test("the most specific outcome wins", async () => {
    const yt = fakeYouTube({
      player: ({ client }) =>
        client === VISIONOS ? unplayable("UNPLAYABLE", "") : unplayable("LOGIN_REQUIRED", "This video is private"),
    });
    const error = await rejection(
      new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID, clients: [Client.VisionOS, Client.Tv] }).getInfo(ID),
    );
    expect(error.code).toBe("PRIVATE");
    expect(error.attempts.map((attempt) => attempt.code)).toEqual(["NO_FORMAT", "PRIVATE"]);
  });

  test("an age gate without an account says how to get past it", async () => {
    const yt = fakeYouTube({ player: () => unplayable("AGE_CHECK_REQUIRED", "Sign in to confirm your age") });
    const error = await rejection(new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID }).getInfo(ID));
    expect(error.code).toBe("AGE_RESTRICTED");
    expect(error.message).toContain("cookie");
  });

  test("a premiere carries its start time", async () => {
    const start = 4_102_444_800;
    const offline = unplayable("LIVE_STREAM_OFFLINE", "Premieres soon", {
      liveStreamability: {
        liveStreamabilityRenderer: {
          offlineSlate: { liveStreamOfflineSlateRenderer: { scheduledStartTime: String(start) } },
        },
      },
    });
    const yt = fakeYouTube({ player: () => offline });
    const error = await rejection(new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID }).getInfo(ID));
    expect(error.code).toBe("NOT_STARTED");
    expect(error.startTime).toEqual(new Date(start * 1000));
  });

  test("a region block carries the allowed countries", async () => {
    const yt = fakeYouTube({
      player: () => ({
        ...unplayable("UNPLAYABLE", "The uploader has not made this video available in your country"),
        microformat: { playerMicroformatRenderer: { availableCountries: ["DE", "FR"] } },
      }),
    });
    const error = await rejection(new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID }).getInfo(ID));
    expect(error.code).toBe("REGION_BLOCKED");
    expect(error.availableCountries).toEqual(["DE", "FR"]);
  });
});

describe("input and cancellation", () => {
  test("an invalid video is rejected before any request", async () => {
    const yt = fakeYouTube({ player: () => playable(ID) });
    const ytdl = new Ytdl({ fetch: yt.fetch });
    expect((await rejection(ytdl.getInfo("https://example.com/watch?v=aqz-KE-bpKQ"))).code).toBe("INVALID_URL");
    expect((await rejection(ytdl.getInfo("not a video"))).code).toBe("INVALID_URL");
    expect(() => ytdl.download("not a video")).toThrow(YtdlError);
    expect(yt.requests).toHaveLength(0);
  });

  test("an abort between clients stops the lookup with the caller's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    const yt = fakeYouTube({
      player: () => {
        controller.abort(reason);
        return unplayable("UNPLAYABLE", "");
      },
    });
    const error = await new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID })
      .getInfo(ID, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(error).toBe(reason);
    expect(yt.clients()).toEqual([VISIONOS]);
  });
});

describe("channel live URLs", () => {
  const LIVE_ID = "liveStream1";
  const CHANNEL_LIVE = "https://www.youtube.com/@NASA/live";

  test("getInfo and download look up the stream the channel plays now", async () => {
    const asked: string[] = [];
    const media = `${MEDIA_HOST}?itag=251&expire=4102444800`;
    const yt = fakeYouTube({
      resolveUrl: (url) => {
        asked.push(url);
        return Response.json({ endpoint: { watchEndpoint: { videoId: LIVE_ID } } });
      },
      player: ({ body }) => playable(String(body.videoId), [audioFormat(251, { url: media, contentLength: "3" })]),
      routes: { [media]: () => new Response(new Uint8Array([1, 2, 3])) },
    });
    const ytdl = new Ytdl({ fetch: yt.fetch });

    expect((await ytdl.getInfo("youtube.com/@NASA/live/")).videoDetails.id).toBe(LIVE_ID);
    expect(Buffer.concat(await ytdl.download(CHANNEL_LIVE).toArray())).toEqual(Buffer.from([1, 2, 3]));
    expect(asked).toEqual([CHANNEL_LIVE, CHANNEL_LIVE]);
    expect(new Set(yt.playerCalls.map((call) => call.body.videoId))).toEqual(new Set([LIVE_ID]));
  });

  test.each([
    ["a channel that is not live", () => Response.json({ endpoint: { browseEndpoint: { browseId: "UCchannel" } } })],
    ["an unknown channel", () => new Response("{}", { status: 404 })],
  ])("%s fails with NOT_FOUND before any player request", async (_, answer) => {
    const yt = fakeYouTube({ resolveUrl: answer, player: () => playable(ID) });
    expect((await rejection(new Ytdl({ fetch: yt.fetch }).getInfo(CHANNEL_LIVE))).code).toBe("NOT_FOUND");
    expect(yt.playerCalls).toHaveLength(0);
  });
});

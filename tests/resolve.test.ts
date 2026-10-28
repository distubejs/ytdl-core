import { describe, expect, setSystemTime, test } from "bun:test";
import { planClients } from "../src/resolve.ts";
import { Client, DEFAULT_CLIENTS, Ytdl, YtdlError } from "../src/index.ts";
import type { RetryEvent, YtdlOptions } from "../src/index.ts";
import {
  audioFormat,
  ciphered,
  fakeYouTube,
  MEDIA_HOST,
  MWEB,
  type PlayerHandler,
  PLAYER_JS,
  playable,
  SIGNATURE_TIMESTAMP,
  TV,
  unplayable,
  VISIONOS,
  visitorBody,
  WEB_EMBEDDED,
} from "./fake-youtube.ts";

const ID = "aqz-KE-bpKQ";
const PLAYER_ID = "aaaa0001";
const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1000;
const TOKEN_FREE_CLIENTS = [Client.VisionOS, Client.WebEmbedded, Client.Tv];

const order = (cookie: boolean) =>
  planClients({ clients: DEFAULT_CLIENTS, cookie }, new Map(), 0).map(
    (rung) => `${rung.client}${rung.signedIn ? "+" : ""}`,
  );

const cookies = (yt: ReturnType<typeof fakeYouTube>, pattern: RegExp) =>
  yt.requests
    .filter((request) => pattern.test(request.url))
    .map((request) => new Headers(request.init?.headers).get("Cookie"));

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

  test("a PO token rung's request and URLs carry the hook's token", async () => {
    const answer = ({ client }: { client: string }) => (client === MWEB ? ciphered(ID) : unplayable("UNPLAYABLE", ""));
    const requests: unknown[] = [];
    const withHook = fakeYouTube({ player: answer });
    const info = await new Ytdl({
      fetch: withHook.fetch,
      playerId: PLAYER_ID,
      clients: [Client.VisionOS, Client.Tv, Client.Mweb],
      getPoToken: async (request) => {
        requests.push({ contentBinding: request.contentBinding, client: request.client });
        return "POTOKEN-for-test";
      },
    }).getInfo(ID);

    expect(withHook.clients()).toEqual([VISIONOS, TV, MWEB]);
    expect(requests).toEqual([{ contentBinding: ID, client: "mweb" }]);
    expect(withHook.playerCalls[2]?.body.serviceIntegrityDimensions).toEqual({ poToken: "POTOKEN-for-test" });
    expect(new URL(info.formats[0]?.url ?? "").searchParams.get("pot")).toBe("POTOKEN-for-test");
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

  test("account rungs exist only with a cookie", () => {
    expect(order(false)).toEqual(["visionos", "web_embedded", "tv", "mweb"]);
    expect(order(true)).toEqual([
      "visionos",
      "web_embedded",
      "web_embedded+",
      "tv",
      "tv+",
      "mweb",
      "mweb+",
      "web_creator+",
    ]);
  });

  test("the clients option is the priority order", async () => {
    const yt = fakeYouTube({ player: () => unplayable("UNPLAYABLE", "") });
    const ytdl = new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID, clients: [Client.WebEmbedded, Client.VisionOS] });
    await rejection(ytdl.getInfo(ID));
    expect(yt.clients()).toEqual([WEB_EMBEDDED, VISIONOS]);
  });

  test.each([[[]], [["visionos", "visionos"]], [["nope"]], [["android"]], [["web_creator"]]])(
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

  test("after a failed bot-check replacement the next client fetches fresh visitor data", async () => {
    const answers = [
      () => new Response(visitorBody("VISITOR-A")),
      () => new Response(null, { status: 500 }),
      () => new Response(visitorBody("VISITOR-B")),
    ];
    let fetches = 0;
    const yt = fakeYouTube({
      routes: { "https://www.youtube.com/sw.js_data": () => answers[fetches++]!() },
      player: ({ client }) =>
        client === VISIONOS ? unplayable("LOGIN_REQUIRED", "Sign in to confirm you're not a bot") : playable(ID),
    });
    const info = await new Ytdl({ fetch: yt.fetch, clients: [Client.VisionOS, Client.Tv] }).getInfo(ID);
    expect(info.client).toBe("tv");
    const visitorOf = (client: string) =>
      yt.playerCalls.filter((call) => call.client === client).map((call) => call.headers.get("X-Goog-Visitor-Id"));
    expect(visitorOf(VISIONOS)).toEqual(["VISITOR-A"]);
    expect(visitorOf(TV)).toEqual(["VISITOR-B"]);
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

  test("a client still walled after a new visitor goes last for ten minutes, and the next client finishes the bytes", async () => {
    setSystemTime(new Date(NOW));
    const content = Uint8Array.from({ length: 4000 }, (_, index) => (index * 7) % 256);
    let tvDown = false;
    const yt = fakeYouTube({
      player: ({ client }) =>
        client === VISIONOS
          ? playable(ID, [audioFormat(251, { url: `${MEDIA_HOST}?itag=251&expire=4102444800&c=visionos` })])
          : tvDown
            ? unplayable("UNPLAYABLE", "")
            : ciphered(ID),
      media: (url) => {
        const [start = 0, end = 0] = (url.searchParams.get("range") ?? "").split("-").map(Number);
        if (url.searchParams.get("c") === "visionos" && start >= 1000) return new Response("", { status: 403 });
        return new Response(content.slice(start, end + 1));
      },
    });
    const ytdl = new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID, clients: [Client.VisionOS, Client.Tv] });
    const retries: RetryEvent[] = [];
    const asked = async (at: number) => {
      setSystemTime(new Date(at));
      const before = yt.clients().length;
      await ytdl.getInfo(ID);
      return yt.clients().slice(before);
    };
    try {
      const stream = ytdl.download(ID, { chunkSize: 1000, onRetry: (event) => retries.push(event) });
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk as Uint8Array);

      expect(Buffer.concat(chunks)).toEqual(Buffer.from(content));
      expect(retries.map(({ attempt, client }) => [attempt, client])).toEqual([
        [1, "visionos"],
        [2, "visionos"],
      ]);
      tvDown = true;
      expect(await asked(NOW + 10 * MINUTE - 1)).toEqual([TV, VISIONOS]);
      expect(await asked(NOW + 10 * MINUTE)).toEqual([VISIONOS]);
    } finally {
      setSystemTime();
    }
  });

  test("onRetry destroying the stream leaves no unhandled rejection and starts no request", async () => {
    const content = Uint8Array.from({ length: 3000 }, (_, index) => index % 251);
    const yt = fakeYouTube({
      player: () =>
        playable(ID, [
          audioFormat(251, {
            url: `${MEDIA_HOST}?itag=251&expire=4102444800`,
            contentLength: String(content.length),
          }),
        ]),
      media: (url) => {
        const [start = 0, end = 0] = (url.searchParams.get("range") ?? "").split("-").map(Number);
        return start >= 1000 ? new Response("", { status: 403 }) : new Response(content.slice(start, end + 1));
      },
    });
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      let requestsAtDestroy = -1;
      const stream = new Ytdl({ fetch: yt.fetch }).download(ID, {
        chunkSize: 1000,
        onRetry: () => {
          requestsAtDestroy = yt.requests.length;
          stream.destroy();
        },
      });
      stream.on("error", () => {});
      stream.resume();
      await new Promise((resolve) => stream.once("close", resolve));
      await Bun.sleep(20);

      expect(unhandled).toEqual([]);
      expect(requestsAtDestroy).toBeGreaterThan(0);
      expect(yt.requests).toHaveLength(requestsAtDestroy);
      expect(yt.visitorFetches()).toBe(1);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});

describe("outcomes", () => {
  test("a client that answers only DRM formats falls through to the next", async () => {
    const yt = fakeYouTube({
      player: ({ client }) =>
        client === VISIONOS ? playable(ID, [audioFormat(251, { drmFamilies: ["WIDEVINE"] })]) : ciphered(ID),
    });
    const info = await new Ytdl({
      fetch: yt.fetch,
      playerId: PLAYER_ID,
      clients: [Client.VisionOS, Client.Tv],
    }).getInfo(ID);
    expect(info.client).toBe("tv");
    expect(info.formats.map(({ itag, isDrm }) => ({ itag, isDrm }))).toEqual([{ itag: 251, isDrm: false }]);
  });

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

  test.each([
    ["a private video", "PRIVATE", "This video is private", "Dieses Video ist privat"],
    ["an age gate", "AGE_RESTRICTED", "Sign in to confirm your age", "Melde dich an, um dein Alter zu bestätigen"],
  ] as const)(
    "%s under a German lang rejects with its code and keeps the visitor",
    async (_, code, english, german) => {
      const yt = fakeYouTube({
        player: ({ body }) => {
          const { hl } = (body.context as { client: { hl: string } }).client;
          return unplayable("LOGIN_REQUIRED", hl === "de" ? german : english);
        },
      });
      const error = await rejection(new Ytdl({ fetch: yt.fetch, lang: "de", clients: [Client.VisionOS] }).getInfo(ID));
      expect(error.code).toBe(code);
      expect(yt.clients()).toEqual([VISIONOS]);
      expect(yt.visitorFetches()).toBe(1);
    },
  );

  test("a Music Premium reason rejects as premium-only, not members-only", async () => {
    const yt = fakeYouTube({
      player: () => unplayable("UNPLAYABLE", "This video is only available to Music Premium members"),
    });
    const error = await rejection(new Ytdl({ fetch: yt.fetch, clients: [Client.VisionOS] }).getInfo(ID));
    expect(error.code).toBe("PREMIUM_ONLY");
  });

  test.each([
    ["ERROR", "This video is no longer available due to a copyright claim by Country Music Television", "NOT_FOUND"],
    [
      "ERROR",
      "This video contains content from Premium Media Group, who has blocked it on copyright grounds.",
      "NOT_FOUND",
    ],
    [
      "UNPLAYABLE",
      "This video contains content from Private Island Records, who has blocked it in your country on copyright grounds.",
      "REGION_BLOCKED",
    ],
  ] as const)("a %s answer with the copyright notice %p rejects %s", async (status, subreason, code) => {
    const yt = fakeYouTube({
      player: () =>
        unplayable(status, "Video unavailable", {
          errorScreen: { playerErrorMessageRenderer: { subreason: { simpleText: subreason } } },
        }),
    });
    const error = await rejection(
      new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID, clients: TOKEN_FREE_CLIENTS }).getInfo(ID),
    );
    expect(error.code).toBe(code);
  });

  test("an age gate without an account says how to get past it", async () => {
    const yt = fakeYouTube({ player: () => unplayable("AGE_CHECK_REQUIRED", "Sign in to confirm your age") });
    const error = await rejection(
      new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID, clients: TOKEN_FREE_CLIENTS }).getInfo(ID),
    );
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
    const error = await rejection(
      new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID, clients: TOKEN_FREE_CLIENTS }).getInfo(ID),
    );
    expect(error.code).toBe("NOT_STARTED");
    expect(error.startTime).toEqual(new Date(start * 1000));
  });

  test("a format URL without an expiry stays fresh for five hours", async () => {
    setSystemTime(new Date(NOW));
    try {
      const yt = fakeYouTube({ player: () => playable(ID, [audioFormat(251, { url: `${MEDIA_HOST}?itag=251` })]) });
      const info = await new Ytdl({ fetch: yt.fetch }).getInfo(ID);
      expect(info.expiresAt).toBe(NOW + 5 * 60 * MINUTE);
    } finally {
      setSystemTime();
    }
  });
});

const playerScript = (id: string) => `https://www.youtube.com/s/player/${id}/player_ias.vflset/en_US/base.js`;
const REGION_REASON = "The uploader has not made this video available in your country";
const ACCOUNT = "SID=account-sid-value; SAPISID=sapisid-value-aaaa";
const SIGNED_IN_HOME = { "https://www.youtube.com/": () => new Response('ytcfg.set({"LOGGED_IN":true});') };
const SIGNED_OUT_HOME = { "https://www.youtube.com/": () => new Response('ytcfg.set({"LOGGED_IN":false});') };
const RECORDING_REASON = "This live stream recording is not available.";
const deadCookieAttempts = (anonymous: string) => [
  { client: "visionos", signedIn: false, step: "playability", code: anonymous },
  { client: "web_embedded", signedIn: false, step: "playability", code: anonymous },
  { client: "web_embedded", signedIn: true, step: "visitor", code: "AUTH_FAILED" },
  { client: "tv", signedIn: false, step: "playability", code: anonymous },
  { client: "tv", signedIn: true, step: "visitor", code: "AUTH_FAILED" },
];
const countries = (list: readonly string[]) => ({
  microformat: { playerMicroformatRenderer: { availableCountries: list } },
});

interface AttributionCase {
  readonly clients?: readonly Client[];
  readonly playerId?: string;
  readonly options?: Pick<YtdlOptions, "cookie" | "getPoToken">;
  readonly player: PlayerHandler;
  readonly routes?: Record<string, () => Response>;
  readonly cookieHint?: boolean;
  readonly metadataRequests?: number;
  readonly error: Record<string, unknown>;
}

describe("attempt attribution", () => {
  const cases: Record<string, AttributionCase> = {
    "a broken player is not reported as an age gate": {
      playerId: "bad00001",
      routes: { [playerScript("bad00001")]: () => new Response(PLAYER_JS.replace('d.set("alr","yes");', "")) },
      player: ({ client }) =>
        client === VISIONOS ? unplayable("AGE_CHECK_REQUIRED", "Sign in to confirm your age") : ciphered(ID),
      error: {
        code: "PLAYER_SOLVE_FAILED",
        attempts: [
          { client: "visionos", signedIn: false, step: "playability", code: "AGE_RESTRICTED" },
          {
            client: "web_embedded",
            signedIn: false,
            step: "player",
            code: "PLAYER_SOLVE_FAILED",
            reason: expect.stringContaining("bad00001"),
            cause: expect.any(Error),
          },
          { client: "tv", signedIn: false, step: "player", code: "PLAYER_SOLVE_FAILED", cause: expect.any(Error) },
        ],
      },
    },
    "a failed embed page is not reported as a missing format": {
      routes: { [`https://www.youtube.com/embed/${ID}?html5=1`]: () => new Response("", { status: 500 }) },
      player: () => unplayable("UNPLAYABLE", ""),
      error: {
        code: "REQUEST_FAILED",
        attempts: [
          { client: "visionos", step: "playability", code: "NO_FORMAT" },
          { client: "web_embedded", step: "embed", code: "REQUEST_FAILED", cause: expect.any(YtdlError) },
          { client: "tv", step: "playability", code: "NO_FORMAT" },
        ],
      },
    },
    "InnerTube's error answer reaches the attempt": {
      clients: [Client.Tv],
      routes: {
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false": () =>
          Response.json(
            { error: { code: 400, status: "FAILED_PRECONDITION", message: "Precondition check failed." } },
            { status: 400 },
          ),
      },
      player: () => playable(ID),
      error: {
        code: "REQUEST_FAILED",
        attempts: [
          {
            client: "tv",
            step: "request",
            code: "REQUEST_FAILED",
            reason: expect.stringMatching(/FAILED_PRECONDITION.*Precondition check failed\./u),
          },
        ],
      },
    },
    "a player script answering 404 fails its rung at the player step": {
      clients: [Client.Tv],
      playerId: "f0000404",
      routes: { [playerScript("f0000404")]: () => new Response("not found", { status: 404 }) },
      player: () => ciphered(ID),
      error: {
        code: "PLAYER_SOLVE_FAILED",
        attempts: [
          {
            client: "tv",
            step: "player",
            code: "PLAYER_SOLVE_FAILED",
            reason: expect.stringContaining("f0000404"),
            cause: expect.any(Error),
          },
        ],
      },
    },
    "the TV client's upcoming live event has not started": {
      clients: [Client.Tv],
      player: () => unplayable("UNPLAYABLE", "This live event will begin in 3 hours"),
      error: { code: "NOT_STARTED", attempts: [{ client: "tv", step: "playability", code: "NOT_STARTED" }] },
    },
    "the embedded player's age-restricted wording is an age gate": {
      clients: [Client.WebEmbedded],
      player: () => unplayable("UNPLAYABLE", "Sorry, this content is age-restricted"),
      cookieHint: true,
      error: { code: "AGE_RESTRICTED" },
    },
    "the cookie hint follows a reason ending in a period": {
      clients: [Client.VisionOS],
      player: () => unplayable("AGE_CHECK_REQUIRED", "Sign in to confirm your age."),
      cookieHint: true,
      error: {
        message: `Could not play ${ID}: Sign in to confirm your age. This video needs a signed-in, age-verified account: pass \`cookie\` to new Ytdl().`,
      },
    },
    "only WEB metadata lists the allowed countries": {
      player: ({ client }) =>
        client === "WEB"
          ? { ...unplayable("UNPLAYABLE", REGION_REASON), ...countries(["DE", "FR"]) }
          : unplayable("UNPLAYABLE", REGION_REASON),
      metadataRequests: 1,
      error: { code: "REGION_BLOCKED", availableCountries: ["DE", "FR"] },
    },
    "a generic unavailable answer does not hide a region block": {
      options: { cookie: ACCOUNT },
      routes: SIGNED_IN_HOME,
      player: ({ client, headers }) =>
        client === WEB_EMBEDDED && headers.has("Authorization")
          ? unplayable("ERROR", "This video is unavailable")
          : client === VISIONOS || client === "WEB"
            ? unplayable("UNPLAYABLE", REGION_REASON)
            : unplayable("UNPLAYABLE", ""),
      metadataRequests: 1,
      error: {
        code: "REGION_BLOCKED",
        attempts: [
          { client: "visionos", signedIn: false, code: "REGION_BLOCKED" },
          { client: "web_embedded", signedIn: false, code: "NO_FORMAT" },
          { client: "web_embedded", signedIn: true, step: "playability", code: "NOT_FOUND" },
          { client: "tv", signedIn: false, code: "NO_FORMAT" },
          { client: "tv", signedIn: true, code: "NO_FORMAT" },
        ],
      },
    },
    "a generic unavailable answer does not hide an upcoming live event": {
      clients: [Client.Tv, Client.WebEmbedded],
      player: ({ client }) =>
        client === TV
          ? unplayable("UNPLAYABLE", "This live event will begin in 3 hours")
          : unplayable("ERROR", "This video is unavailable"),
      error: {
        code: "NOT_STARTED",
        attempts: [
          { client: "tv", code: "NOT_STARTED" },
          { client: "web_embedded", code: "NOT_FOUND" },
        ],
      },
    },
    "an unavailable answer outranks a player failure": {
      clients: [Client.VisionOS, Client.Tv],
      player: ({ client }) => (client === VISIONOS ? ciphered(ID) : unplayable("ERROR", "This video is unavailable")),
      error: {
        code: "NOT_FOUND",
        attempts: [
          { client: "visionos", step: "solve", code: "PLAYER_SOLVE_FAILED" },
          { client: "tv", step: "playability", code: "NOT_FOUND" },
        ],
      },
    },
    "a failed visitor lookup fails its rung at the visitor step": {
      clients: [Client.VisionOS],
      routes: { "https://www.youtube.com/sw.js_data": () => new Response("", { status: 500 }) },
      player: () => playable(ID),
      error: { code: "REQUEST_FAILED", attempts: [{ client: "visionos", step: "visitor", code: "REQUEST_FAILED" }] },
    },
    "a failing PO token hook fails its rung at the po-token step": {
      clients: [Client.Mweb],
      options: { getPoToken: () => Promise.reject(new Error("minter down")) },
      player: () => ciphered(ID),
      error: {
        code: "REQUEST_FAILED",
        attempts: [{ client: "mweb", step: "po-token", code: "REQUEST_FAILED", cause: expect.any(Error) }],
      },
    },
    "an answer with only DRM formats fails its rung at the formats step": {
      clients: [Client.VisionOS],
      player: () => playable(ID, [audioFormat(251, { drmFamilies: ["WIDEVINE"] })]),
      error: { code: "NO_FORMAT", attempts: [{ client: "visionos", step: "formats", code: "NO_FORMAT" }] },
    },
    "ciphered formats without a player fail their rung at the solve step": {
      clients: [Client.VisionOS],
      player: () => ciphered(ID),
      error: {
        code: "PLAYER_SOLVE_FAILED",
        attempts: [{ client: "visionos", step: "solve", code: "PLAYER_SOLVE_FAILED" }],
      },
    },
    "a dead cookie does not hide the video's own answer": {
      options: { cookie: ACCOUNT },
      routes: SIGNED_OUT_HOME,
      player: () => unplayable("UNPLAYABLE", ""),
      error: {
        code: "NO_FORMAT",
        message: `Could not play ${ID}: status UNPLAYABLE`,
        attempts: deadCookieAttempts("NO_FORMAT"),
      },
    },
    "a dead cookie still outranks a bot check next to an unplayable answer": {
      options: { cookie: ACCOUNT },
      routes: SIGNED_OUT_HOME,
      player: ({ client }) =>
        client === VISIONOS
          ? unplayable("UNPLAYABLE", "")
          : unplayable("LOGIN_REQUIRED", "Sign in to confirm you're not a bot"),
      error: {
        code: "AUTH_FAILED",
        attempts: [
          { client: "visionos", signedIn: false, code: "NO_FORMAT" },
          { client: "web_embedded", signedIn: false, code: "BOT_CHECK" },
          { client: "web_embedded", signedIn: true, code: "AUTH_FAILED" },
          { client: "tv", signedIn: false, code: "BOT_CHECK" },
          { client: "tv", signedIn: true, code: "AUTH_FAILED" },
        ],
      },
    },
    "a failed PO token does not hide the video's own answer": {
      clients: [Client.VisionOS, Client.Mweb],
      options: { getPoToken: () => Promise.reject(new Error("minter down")) },
      player: () => unplayable("UNPLAYABLE", ""),
      error: {
        code: "NO_FORMAT",
        message: `Could not play ${ID}: status UNPLAYABLE`,
        attempts: [
          { client: "visionos", step: "playability", code: "NO_FORMAT" },
          { client: "mweb", step: "po-token", code: "REQUEST_FAILED" },
        ],
      },
    },
    "an ended stream without a recording is not found, even with a dead cookie": {
      options: { cookie: ACCOUNT },
      routes: SIGNED_OUT_HOME,
      player: () => unplayable("UNPLAYABLE", RECORDING_REASON),
      error: {
        code: "NOT_FOUND",
        message: `Could not play ${ID}: ${RECORDING_REASON}`,
        attempts: deadCookieAttempts("NOT_FOUND"),
      },
    },
    "countries on a later attempt win the tie and need no metadata": {
      player: ({ client }) =>
        client === TV
          ? { ...unplayable("UNPLAYABLE", REGION_REASON), ...countries(["DE", "FR"]) }
          : client === "WEB"
            ? countries(["US"])
            : unplayable("UNPLAYABLE", REGION_REASON),
      error: { code: "REGION_BLOCKED", availableCountries: ["DE", "FR"] },
    },
  };

  test.each(Object.entries(cases))(
    "%s",
    async (_, { clients, playerId, options, player, routes, cookieHint, metadataRequests, error }) => {
      const yt = fakeYouTube({ player, ...(routes ? { routes } : {}) });
      const rejected = await rejection(
        new Ytdl({
          fetch: yt.fetch,
          playerId: playerId ?? PLAYER_ID,
          clients: clients ?? TOKEN_FREE_CLIENTS,
          ...options,
        }).getInfo(ID),
      );

      expect(rejected).toMatchObject(error);
      expect(rejected.message.includes("pass `cookie`")).toBe(cookieHint ?? false);
      expect(yt.playerCalls.filter((call) => call.client === "WEB")).toHaveLength(metadataRequests ?? 0);
    },
  );
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

  test("an abort that fails the last client rejects with the caller's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    const yt = fakeYouTube({
      player: () => {
        controller.abort(reason);
        throw new Error("connection reset");
      },
    });
    const error = await new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID, clients: [Client.Tv] })
      .getInfo(ID, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(error).toBe(reason);
  });

  test("an abort during the region metadata lookup rejects with the caller's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    const yt = fakeYouTube({
      player: ({ client }) => {
        if (client !== "WEB") return unplayable("UNPLAYABLE", REGION_REASON);
        controller.abort(reason);
        return countries(["DE"]);
      },
    });
    const error = await new Ytdl({ fetch: yt.fetch, playerId: PLAYER_ID, clients: TOKEN_FREE_CLIENTS })
      .getInfo(ID, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(error).toBe(reason);
    expect(yt.playerCalls.filter((call) => call.client === "WEB")).toHaveLength(1);
  });
});

describe("consent cookie", () => {
  test("logged-out YouTube requests carry SOCS=CAI and media requests carry no cookie", async () => {
    const content = Uint8Array.from({ length: 4000 }, (_, index) => index % 256);
    const yt = fakeYouTube({
      player: ({ client }) => (client === VISIONOS ? unplayable("UNPLAYABLE", "") : ciphered(ID)),
      media: (url) => {
        const [start = 0, end = 0] = (url.searchParams.get("range") ?? "").split("-").map(Number);
        return new Response(content.slice(start, end + 1));
      },
    });

    const stream = new Ytdl({ fetch: yt.fetch, playerId: "c0de0001" }).download(ID);

    expect(Buffer.concat(await stream.toArray())).toEqual(Buffer.from(content));
    expect(cookies(yt, /\/sw\.js_data$/u)).toEqual(["SOCS=CAI"]);
    expect(cookies(yt, /\/embed\//u)).toEqual(["SOCS=CAI"]);
    expect(cookies(yt, /\/s\/player\/c0de0001\//u)).toEqual(["SOCS=CAI"]);
    expect(new Set(cookies(yt, /\/youtubei\/v1\/player/u))).toEqual(new Set(["SOCS=CAI"]));
    const media = cookies(yt, /^https:\/\/[^/]+\.googlevideo\.com\//u);
    expect(media.length).toBeGreaterThan(0);
    expect(new Set(media)).toEqual(new Set([null]));
  });

  test("player discovery carries SOCS=CAI", async () => {
    const yt = fakeYouTube({
      player: () => ciphered(ID),
      routes: { "https://www.youtube.com/iframe_api": () => new Response("no player here") },
    });
    setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
    try {
      await rejection(new Ytdl({ fetch: yt.fetch, clients: [Client.WebEmbedded] }).getInfo(ID));
    } finally {
      setSystemTime();
    }

    expect(cookies(yt, /\/iframe_api$/u)).toEqual(["SOCS=CAI"]);
  });

  test("a signed-in rung sends the account cookie alone", async () => {
    const account = "SID=account-sid-value; SAPISID=sapisid-value-aaaa";
    const yt = fakeYouTube({
      player: ({ headers }) => (headers.has("Authorization") ? playable(ID) : unplayable("LOGIN_REQUIRED", "")),
      routes: { "https://www.youtube.com/": () => new Response('ytcfg.set({"LOGGED_IN":true});') },
    });

    await new Ytdl({ cookie: account, fetch: yt.fetch, playerId: PLAYER_ID, clients: [Client.WebEmbedded] }).getInfo(
      ID,
    );

    expect(cookies(yt, /^https:\/\/www\.youtube\.com\/$/u)).toEqual([account]);
    expect(
      yt.playerCalls.filter((call) => call.headers.has("Authorization")).map((call) => call.headers.get("Cookie")),
    ).toEqual([account]);
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

const hangingPlayer = (fetch: typeof globalThis.fetch) =>
  (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).includes("/youtubei/v1/player")
      ? new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        })
      : fetch(input, init)) as typeof globalThis.fetch;

const causes = (error: unknown): unknown[] =>
  error instanceof Error ? [error, ...causes(error.cause)] : error === undefined ? [] : [error];

describe("timeouts", () => {
  test("a player request that never answers rejects REQUEST_FAILED after timeoutMs", async () => {
    const yt = fakeYouTube({ player: () => playable(ID) });
    const ytdl = new Ytdl({ fetch: hangingPlayer(yt.fetch), timeoutMs: 50, clients: [Client.VisionOS] });
    const error = await rejection(ytdl.getInfo(ID));

    expect(error.code).toBe("REQUEST_FAILED");
    expect(causes(error).some((cause) => cause instanceof DOMException && cause.name === "TimeoutError")).toBe(true);
  });

  test("a media body that never sends a byte errors once after three resumes with a TimeoutError cause", async () => {
    const yt = fakeYouTube({
      player: () =>
        playable(ID, [audioFormat(251, { url: `${MEDIA_HOST}?itag=251&expire=4102444800`, contentLength: "3000" })]),
      media: () => new Response(new ReadableStream()),
    });
    const retries: RetryEvent[] = [];
    const stream = new Ytdl({ fetch: yt.fetch, timeoutMs: 50 }).download(ID, {
      onRetry: (event) => retries.push(event),
    });
    const errors: unknown[] = [];
    stream.on("error", (error) => errors.push(error));
    stream.resume();
    await new Promise((resolve) => stream.once("close", resolve));

    expect(retries.map((retry) => retry.attempt)).toEqual([1, 2, 3]);
    expect(errors).toHaveLength(1);
    expect(YtdlError.is(errors[0], "REQUEST_FAILED")).toBe(true);
    expect(causes(errors[0]).some((cause) => cause instanceof DOMException && cause.name === "TimeoutError")).toBe(
      true,
    );
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "timeoutMs %p throws INVALID_ARGUMENT before any request",
    (timeoutMs) => {
      const yt = fakeYouTube({ player: () => playable(ID) });
      expect(() => new Ytdl({ fetch: yt.fetch, timeoutMs })).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      expect(yt.requests).toHaveLength(0);
    },
  );
});

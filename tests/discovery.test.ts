import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Ytdl, YtdlError, YtdlErrorCode } from "../src/index.ts";
import { fakeYouTube, fixture, playable } from "./fake-youtube.ts";

// Recorded 2026-10-20 from WEB with visitor data. Search: "blender open movie" with the video filter, first and
// continuation page, Blender uploads only. Mixed: "nasa jpl" without a filter, NASA uploads, channels, a shelf, a
// Shorts shelf and a playlist. Live: the live filter for "NASA", its one result relabelled as NASA's ISS stream.
// Playlist: PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5 (NASA, Perseverance Mars Rover), both pages. Short playlist:
// PL6B3937A5D230E335 (Blender, Official Blender Open Movies), one page with only a section-level continuation. Missing:
// the answer for a well-formed unknown playlist ID. Every answer is trimmed to the parsed fields; tracking and visitor
// data are gone, and the search continuation tokens, which encode third-party IDs, are replaced by labels.
const SEARCH_PAGE = fixture("search-web.json");
const SEARCH_NEXT_PAGE = fixture("search-continuation-web.json");
const MIXED_PAGE = fixture("search-mixed-web.json");
const LIVE_PAGE = fixture("search-live-web.json");
const PLAYLIST_ID = "PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5";
const PLAYLIST_PAGE = fixture("browse-playlist-web.json");
const PLAYLIST_NEXT_PAGE = fixture("browse-continuation-web.json");
const SHORT_PLAYLIST_PAGE = fixture("browse-short-playlist-web.json");
const MISSING_PLAYLIST = fixture("browse-missing-web.json");
const NEXT = fixture("next-web.json");
const SUGGESTIONS = readFileSync(new URL("./fixtures/innertube/suggest-blender.txt", import.meta.url), "utf8");
const VIDEO_ID = "aqz-KE-bpKQ";

const SEARCH = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false";
const BROWSE = "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false";

type Page = Record<string, unknown>;
interface Item {
  readonly videoRenderer?: { readonly videoId: string };
  readonly shelfRenderer?: unknown;
}
interface Section {
  readonly itemSectionRenderer?: { readonly contents: readonly Item[] };
}
interface SearchPage {
  readonly contents?: {
    readonly twoColumnSearchResultsRenderer: {
      readonly primaryContents: { readonly sectionListRenderer: { readonly contents: readonly Section[] } };
    };
  };
  readonly onResponseReceivedCommands?: readonly {
    readonly appendContinuationItemsAction: { readonly continuationItems: readonly Section[] };
  }[];
}

const sections = (page: Page): readonly Section[] => {
  const search = page as SearchPage;
  return (
    search.contents?.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents ??
    search.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction.continuationItems ??
    []
  );
};
const items = (page: Page) => sections(page).flatMap((section) => section.itemSectionRenderer?.contents ?? []);
const videoIds = (page: Page) =>
  items(page).flatMap((item) => (item.videoRenderer ? [item.videoRenderer.videoId] : []));
const searchPage = (entries: readonly unknown[]): Page => ({
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: entries } }] } },
    },
  },
});
const matches = (value: unknown, pattern: RegExp) =>
  [...JSON.stringify(value).matchAll(pattern)].map((m) => m[1] ?? "");
const lockupIds = (page: Page) => matches(page, /"contentId":"([\w-]{11})"/gu);
const firstToken = (page: Page) => /"token":"([^"]+)"/u.exec(JSON.stringify(page))?.[1] ?? "";

const playlistEntry = (videoId: string, extra: Record<string, unknown> = {}) => ({
  playlistVideoRenderer: { videoId, title: { runs: [{ text: `Video ${videoId}` }] }, lengthSeconds: "60", ...extra },
});

const continuationItem = (token: string) => ({
  continuationItemViewModel: { continuationCommand: { innertubeCommand: { continuationCommand: { token } } } },
});
const appendedPage = (continuationItems: readonly unknown[], extra: Page = {}): Page => ({
  ...extra,
  onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems } }],
});
const appendedItems = (page: Page) =>
  (page as { onResponseReceivedActions: { appendContinuationItemsAction: { continuationItems: unknown[] } }[] })
    .onResponseReceivedActions[0]?.appendContinuationItemsAction.continuationItems ?? [];

function pages(...answers: readonly Page[]): () => Response {
  let served = 0;
  return () => {
    const answer = answers[served++];
    return answer ? Response.json(answer) : new Response("unexpected page request", { status: 500 });
  };
}

function setup(routes: Record<string, () => Response>, options: { readonly cookie?: string } = {}) {
  const yt = fakeYouTube({ player: () => playable(VIDEO_ID), next: NEXT, routes });
  const bodies = (url: string) =>
    yt.requests.filter((request) => request.url === url).map((request) => JSON.parse(String(request.init?.body)));
  return { yt, ytdl: new Ytdl({ fetch: yt.fetch, ...options }), bodies };
}

async function rejection(promise: Promise<unknown>): Promise<YtdlError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof YtdlError)) throw new Error(`Expected a YtdlError, got ${String(error)}`);
  return error;
}

describe("search", () => {
  test("a limit past the first page fetches the next page once and repeats no video", async () => {
    const first = videoIds(SEARCH_PAGE);
    const second = videoIds(SEARCH_NEXT_PAGE);
    expect(new Set([...first, ...second]).size).toBe(first.length + second.length);
    expect(second.length).toBeGreaterThan(2);
    // YouTube repeats a result across pages now and then.
    const repeated = {
      onResponseReceivedCommands: [
        {
          appendContinuationItemsAction: {
            continuationItems: [
              { itemSectionRenderer: { contents: [items(SEARCH_PAGE)[0], ...items(SEARCH_NEXT_PAGE)] } },
              ...sections(SEARCH_NEXT_PAGE).slice(1),
            ],
          },
        },
      ],
    };
    const { ytdl, bodies } = setup({ [SEARCH]: pages(SEARCH_PAGE, repeated) });
    const limit = first.length + 2;

    const videos = await ytdl.search("blender open movie", { limit });

    expect(videos.map((video) => video.id)).toEqual([...first, ...second].slice(0, limit));
    expect(bodies(SEARCH).map((body) => body.continuation)).toEqual([undefined, firstToken(SEARCH_PAGE)]);
    expect(bodies(SEARCH)[0]).toMatchObject({ query: "blender open movie", params: "EgIQAQ%3D%3D" });
  });

  test("channels, playlists and shelves are left out", async () => {
    const shelved = items(MIXED_PAGE)
      .filter((item) => item.shelfRenderer)
      .flatMap((shelf) => matches(shelf, /"videoId":"([\w-]{11})"/gu));
    const listed = videoIds(MIXED_PAGE);
    const shelfOnly = shelved.filter((id) => !listed.includes(id));
    expect(shelfOnly.length).toBeGreaterThan(0);
    const { ytdl } = setup({ [SEARCH]: pages(MIXED_PAGE) });

    const ids = (await ytdl.search("nasa jpl", { limit: 100 })).map((video) => video.id);

    expect(ids).toEqual(listed);
  });

  test("a query nothing matches resolves to an empty list", async () => {
    const { ytdl } = setup({ [SEARCH]: pages(searchPage([])) });
    expect(await ytdl.search("zzzzzz")).toEqual([]);
  });

  test("a live result is live with no length", async () => {
    const { ytdl } = setup({ [SEARCH]: pages(LIVE_PAGE) });
    const [video] = await ytdl.search("NASA");
    expect(video).toMatchObject({ isLive: true, lengthSeconds: undefined });
  });

  test("a result without a view count keeps its other fields and one without a title is skipped", async () => {
    const recorded = items(SEARCH_PAGE)[0]?.videoRenderer;
    const { ytdl } = setup({
      [SEARCH]: pages(
        searchPage([
          { videoRenderer: { ...recorded, title: undefined } },
          { videoRenderer: { ...recorded, viewCountText: undefined } },
        ]),
      ),
    });

    const videos = await ytdl.search("blender open movie");
    const [video] = videos;

    expect(videos).toHaveLength(1);

    expect(video?.viewCount).toBeUndefined();
    expect(video?.id).toBe(recorded?.videoId);
    expect(video?.title).toBeString();
    expect(video?.author.name).toBeString();
    expect(video?.lengthSeconds).toBeGreaterThan(0);
    expect(video?.thumbnails.length).toBeGreaterThan(0);
  });

  test("aborting between pages rejects with the reason and requests no further page", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const { ytdl, bodies } = setup({
      [SEARCH]: () => {
        controller.abort(reason);
        return Response.json(SEARCH_PAGE);
      },
    });

    const outcome = ytdl.search("blender open movie", { limit: 100, signal: controller.signal });

    await expect(outcome).rejects.toBe(reason);
    expect(bodies(SEARCH)).toHaveLength(1);
  });
});

describe("discovery arguments", () => {
  test.each([
    ["a blank search query", (ytdl: Ytdl) => ytdl.search("   ")],
    ["a zero search limit", (ytdl: Ytdl) => ytdl.search("nasa", { limit: 0 })],
    ["a fractional search limit", (ytdl: Ytdl) => ytdl.search("nasa", { limit: 1.5 })],
    ["a zero playlist limit", (ytdl: Ytdl) => ytdl.getPlaylist(PLAYLIST_ID, { limit: 0 })],
    ["a blank suggestion query", (ytdl: Ytdl) => ytdl.getSuggestions(" ")],
  ])("%s rejects INVALID_ARGUMENT before any request", async (_, call) => {
    const { yt, ytdl } = setup({});
    expect((await rejection(call(ytdl))).code).toBe("INVALID_ARGUMENT");
    expect(yt.requests).toHaveLength(0);
  });

  test.each([
    `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://example.com/playlist?list=${PLAYLIST_ID}`,
    VIDEO_ID,
  ])("getPlaylist(%s) rejects INVALID_URL before any request", async (input) => {
    const { yt, ytdl } = setup({});
    expect((await rejection(ytdl.getPlaylist(input))).code).toBe("INVALID_URL");
    expect(yt.requests).toHaveLength(0);
  });
});

describe("getPlaylist", () => {
  test("a watch URL with a list expands every page in order", async () => {
    const { ytdl, bodies } = setup({ [BROWSE]: pages(PLAYLIST_PAGE, PLAYLIST_NEXT_PAGE) });

    const playlist = await ytdl.getPlaylist(`https://www.youtube.com/watch?v=${VIDEO_ID}&list=${PLAYLIST_ID}`);

    expect(playlist.videos.map((video) => video.id)).toEqual([
      ...lockupIds(PLAYLIST_PAGE),
      ...lockupIds(PLAYLIST_NEXT_PAGE),
    ]);
    expect(playlist).toMatchObject({
      id: PLAYLIST_ID,
      url: `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`,
      title: (PLAYLIST_PAGE.metadata as { playlistMetadataRenderer: { title: string } }).playlistMetadataRenderer.title,
    });
    expect(playlist.author.name).toBeString();
    expect(playlist.thumbnails.length).toBeGreaterThan(0);
    expect(bodies(BROWSE)).toMatchObject([
      { browseId: `VL${PLAYLIST_ID}` },
      { continuation: firstToken(PLAYLIST_PAGE) },
    ]);
  });

  test("a limit within the first page requests no continuation", async () => {
    const { ytdl, bodies } = setup({ [BROWSE]: pages(PLAYLIST_PAGE, PLAYLIST_NEXT_PAGE) });
    const limit = lockupIds(PLAYLIST_PAGE).length - 1;

    const playlist = await ytdl.getPlaylist(PLAYLIST_ID, { limit });

    expect(playlist.videos.map((video) => video.id)).toEqual(lockupIds(PLAYLIST_PAGE).slice(0, limit));
    expect(bodies(BROWSE)).toHaveLength(1);
  });

  test("an unplayable entry is dropped and its page neighbours stay", async () => {
    const page = {
      metadata: { playlistMetadataRenderer: { title: "Blender open movies" } },
      contents: [
        playlistEntry("aqz-KE-bpKQ"),
        playlistEntry("eRsGyueVLvQ", { isPlayable: false }),
        playlistEntry("R6MlUcmOul8"),
      ],
    };
    const { ytdl } = setup({ [BROWSE]: pages(page) });

    const playlist = await ytdl.getPlaylist(PLAYLIST_ID);

    expect(playlist.videos.map((video) => video.id)).toEqual(["aqz-KE-bpKQ", "R6MlUcmOul8"]);
  });

  test("a playlist YouTube does not know rejects NOT_FOUND", async () => {
    const { ytdl } = setup({ [BROWSE]: pages(MISSING_PLAYLIST) });
    expect((await rejection(ytdl.getPlaylist(PLAYLIST_ID))).code).toBe("NOT_FOUND");
  });

  test("a continuation outside the entry list requests no further page", async () => {
    const { ytdl, bodies } = setup({ [BROWSE]: pages(SHORT_PLAYLIST_PAGE, PLAYLIST_NEXT_PAGE) });

    const playlist = await ytdl.getPlaylist("PL6B3937A5D230E335");

    expect(playlist.videos.map((video) => video.id)).toEqual(lockupIds(SHORT_PLAYLIST_PAGE));
    expect(bodies(BROWSE)).toHaveLength(1);
  });

  test("a playlist that keeps offering new pages rejects REQUEST_FAILED at the page cap", async () => {
    let served = 0;
    const endless = () => {
      served++;
      const next = served < 100 ? [continuationItem(`PAGE-${served + 1}`)] : [];
      return Response.json(
        appendedPage([playlistEntry(`video-${served}`), ...next], {
          metadata: { playlistMetadataRenderer: { title: "Endless" } },
        }),
      );
    };
    const { ytdl, bodies } = setup({ [BROWSE]: endless });

    expect((await rejection(ytdl.getPlaylist(PLAYLIST_ID))).code).toBe("REQUEST_FAILED");
    expect(bodies(BROWSE)).toHaveLength(60);
  });

  test("a continuation that repeats the one that fetched it ends expansion", async () => {
    const looping = appendedPage([...appendedItems(PLAYLIST_NEXT_PAGE), continuationItem(firstToken(PLAYLIST_PAGE))]);
    const { ytdl, bodies } = setup({ [BROWSE]: pages(PLAYLIST_PAGE, looping) });

    const playlist = await ytdl.getPlaylist(PLAYLIST_ID);

    expect(playlist.videos).toHaveLength(lockupIds(PLAYLIST_PAGE).length + lockupIds(PLAYLIST_NEXT_PAGE).length);
    expect(bodies(BROWSE)).toHaveLength(2);
  });
});

describe("getRelated", () => {
  test("one next request with no player request returns the list getInfo calls relatedVideos", async () => {
    const { yt, ytdl } = setup({});

    const related = await ytdl.getRelated(VIDEO_ID);

    expect(yt.playerCalls).toHaveLength(0);
    expect(yt.requests.filter((request) => request.url.includes("/youtubei/v1/next"))).toHaveLength(1);
    expect(related.length).toBeGreaterThan(0);
    const info = await setup({}).ytdl.getInfo(VIDEO_ID);
    expect(related.map((video) => video.id)).toEqual(info.relatedVideos.map((video) => video.id));
  });
});

describe("getSuggestions", () => {
  test("returns the JSONP completions in answer order, asked in the instance's language and region without visitor data", async () => {
    const yt = fakeYouTube({
      player: () => playable(VIDEO_ID),
      media: (url) => (url.hostname === "suggestqueries-clients6.youtube.com" ? new Response(SUGGESTIONS) : undefined),
    });

    const suggestions = await new Ytdl({ fetch: yt.fetch, lang: "de", country: "DE" }).getSuggestions(
      "blender open movie",
    );

    expect(suggestions).toEqual([
      "blender open movie",
      "blender open movie spring",
      "blender open movie charge",
      "spring - blender open movie behind the scenes",
      "blender studio open movie",
      "sprite fright - blender open movie",
      "wing it blender open movie",
    ]);
    const url = new URL(yt.requests.at(-1)?.url ?? "");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: "blender open movie", hl: "de", gl: "DE" });
    expect(yt.visitorFetches()).toBe(0);
  });

  test.each([
    ["HTTP 503", () => new Response("unavailable", { status: 503 }), YtdlErrorCode.REQUEST_FAILED],
    ["HTTP 429", () => new Response("slow down", { status: 429 }), YtdlErrorCode.RATE_LIMITED],
    ["a body that is not JSONP", () => new Response("<html></html>"), YtdlErrorCode.REQUEST_FAILED],
  ] as const)("%s rejects %s", async (_, answer, code) => {
    const yt = fakeYouTube({
      player: () => playable(VIDEO_ID),
      media: (url) => (url.hostname === "suggestqueries-clients6.youtube.com" ? answer() : undefined),
    });
    expect((await rejection(new Ytdl({ fetch: yt.fetch }).getSuggestions("nasa"))).code).toBe(code);
  });
});

describe("discovery session", () => {
  test("search then getInfo on a new instance fetches visitor data once", async () => {
    const { yt, ytdl } = setup({ [SEARCH]: pages(SEARCH_PAGE) });
    await ytdl.search("blender open movie", { limit: 1 });
    await ytdl.getInfo(VIDEO_ID);
    expect(yt.visitorFetches()).toBe(1);
  });

  test.each([
    ["getPlaylist", BROWSE, (ytdl: Ytdl) => ytdl.getPlaylist(PLAYLIST_ID, { limit: 1 })],
    [
      "getRelated",
      "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
      (ytdl: Ytdl) => ytdl.getRelated(VIDEO_ID),
    ],
  ])("%s sends the instance's visitor data", async (_, url, call) => {
    const { yt, ytdl } = setup({ [BROWSE]: pages(PLAYLIST_PAGE) });
    await call(ytdl);
    const headers = new Headers(yt.requests.find((request) => request.url === url)?.init?.headers);
    expect(headers.get("X-Goog-Visitor-Id")).toBe("VISITOR-1");
  });

  test("a signed-in instance searches with its visitor data and the consent cookie, without the account", async () => {
    const { yt, ytdl } = setup(
      { [SEARCH]: pages(SEARCH_PAGE) },
      { cookie: "SID=account-sid-value; SAPISID=sapisid-value-aaaa" },
    );

    await ytdl.search("blender open movie", { limit: 1 });

    const headers = new Headers(yt.requests.find((request) => request.url === SEARCH)?.init?.headers);
    expect(headers.get("X-Goog-Visitor-Id")).toBe("VISITOR-1");
    expect(headers.get("Cookie")).toBe("SOCS=CAI");
    expect(headers.get("Authorization")).toBeNull();
  });
});

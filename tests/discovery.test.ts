import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { SearchType, Ytdl, YtdlError, YtdlErrorCode, type YtdlOptions } from "../src/index.ts";
import { fakeYouTube, fixture, playable } from "./fake-youtube.ts";

// Recorded 2026-10-20 from WEB with visitor data. Search: "blender open movie" with the video filter, first and
// continuation page, Blender uploads only. Mixed: "nasa jpl" without a filter, NASA uploads, channels, a shelf, a
// Shorts shelf and a playlist. Live: the live filter for "NASA", its one result relabelled as NASA's ISS stream.
// Unbadged, recorded 2026-10-21 with the video filter: NASA's ISS stream, live without a badge, from "nasa live", then
// NASA's scheduled "Artemis Acceleration" stream, from its title. Playlist: PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5 (NASA,
// Perseverance Mars Rover), both pages. Short playlist: PL6B3937A5D230E335 (Blender, Official Blender Open Movies), one
// page with only a section-level continuation, and its page header rows and description recorded 2026-10-22. Missing: the
// answer for a well-formed unknown playlist ID. Recorded 2026-10-22: playlists, the playlist filter for "taylor swift"
// and "lofi hip hop" across two pages, its artist-channel list without its count badge and one list relabelled as an
// RDEM mix; badges, "taylor swift" with the video filter, an official-artist result and one without badges; resolve,
// /@TaylorSwift; uploads, that channel's uploads list. Every answer is trimmed to the parsed fields; tracking, visitor
// data and onesie URLs are gone, and the search continuation tokens, which encode third-party IDs, are replaced by labels.
// Recorded 2026-10-28 from YouTube Music's WEB_REMIX without visitor data: song search for "kevin macleod", both pages, its
// one third-party row relabelled; a two-artist explicit row from another song search, relabelled; suggestions for
// "kevin macl"; the radio of 4jTzgLFd5_4 (Kevin MacLeod, CC BY), its third-party entries relabelled.
const SEARCH_PAGE = fixture("search-web.json");
const SEARCH_NEXT_PAGE = fixture("search-continuation-web.json");
const MIXED_PAGE = fixture("search-mixed-web.json");
const LIVE_PAGE = fixture("search-live-web.json");
const UNBADGED_PAGE = fixture("search-unbadged-web.json");
const PLAYLIST_ID = "PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5";
const PLAYLIST_PAGE = fixture("browse-playlist-web.json");
const PLAYLIST_NEXT_PAGE = fixture("browse-continuation-web.json");
const SHORT_PLAYLIST_PAGE = fixture("browse-short-playlist-web.json");
const MISSING_PLAYLIST = fixture("browse-missing-web.json");
const PLAYLISTS_PAGE = fixture("search-playlists-web.json");
const PLAYLISTS_NEXT_PAGE = fixture("search-playlists-continuation-web.json");
const BADGES_PAGE = fixture("search-badges-web.json");
const RESOLVED_CHANNEL = fixture("resolve-channel-web.json");
const UPLOADS_PAGE = fixture("browse-uploads-web.json");
const CHANNEL_ID = "UCqECaJ8Gagnn7YCbPEzWH6g";
const NEXT = fixture("next-web.json");
const SUGGESTIONS = readFileSync(new URL("./fixtures/innertube/suggest-blender.txt", import.meta.url), "utf8");
const VIDEO_ID = "aqz-KE-bpKQ";
const SONGS_PAGE = fixture("search-songs-music.json");
const SONGS_NEXT_PAGE = fixture("search-songs-continuation-music.json");
const SONG_BADGES_PAGE = fixture("search-songs-badges-music.json");
const MUSIC_SUGGESTIONS = fixture("suggest-music.json");
const RADIO = fixture("next-radio-music.json");
const RADIO_SEED = "4jTzgLFd5_4";

const SEARCH = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false";
const BROWSE = "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false";
const RESOLVE = "https://www.youtube.com/youtubei/v1/navigation/resolve_url?prettyPrint=false";
const MUSIC_SEARCH = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false";
const MUSIC_NEXT = "https://music.youtube.com/youtubei/v1/next?prettyPrint=false";
const MUSIC_SUGGEST = "https://music.youtube.com/youtubei/v1/music/get_search_suggestions?prettyPrint=false";
const SONGS_PARAMS = "EgWKAQIIAWoKEAoQAxAEEAkQBQ%3D%3D";

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
const songIds = (page: Page) => matches(page, /"playlistItemData":\{"videoId":"([\w-]{11})"/gu);
const radioIds = (page: Page) => matches(page, /"playlistPanelVideoRenderer":\{"videoId":"([\w-]{11})"/gu);
const NO_SONGS: Page = {
  contents: {
    tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [] } } } }] },
  },
};
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

function numberedPages(last: number): () => Response {
  let served = 0;
  return () => {
    served++;
    const next = served < last ? [continuationItem(`PAGE-${served + 1}`)] : [];
    return Response.json(
      appendedPage([playlistEntry(`video-${served}`), ...next], {
        metadata: { playlistMetadataRenderer: { title: "Numbered" } },
      }),
    );
  };
}

function setup(routes: Record<string, () => Response>, options: Omit<YtdlOptions, "fetch"> = {}) {
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

  test("a live result's watchers are not its view count", async () => {
    const { ytdl } = setup({ [SEARCH]: pages(LIVE_PAGE) });
    const [video] = await ytdl.search("NASA");
    expect(video).toMatchObject({ isLive: true, viewCount: undefined });
  });

  test("a live badge is recognized by its style and is not one of the badges", async () => {
    const labelled = JSON.parse(
      JSON.stringify(LIVE_PAGE).replace(
        '{"style":"BADGE_STYLE_TYPE_LIVE_NOW"}',
        '{"style":"BADGE_STYLE_TYPE_LIVE_NOW","label":"LIVE"}',
      ),
    );
    const { ytdl } = setup({ [SEARCH]: pages(labelled) });
    const [video] = await ytdl.search("NASA");
    expect(video).toMatchObject({ isLive: true, badges: [] });
  });

  test("a result with no length, badge or schedule is live, and a scheduled premiere is not", async () => {
    const [liveId, premiereId] = videoIds(UNBADGED_PAGE);
    const { ytdl } = setup({ [SEARCH]: pages(UNBADGED_PAGE) });

    const videos = await ytdl.search("NASA");

    expect(videos.map(({ id, isLive, lengthSeconds }) => ({ id, isLive, lengthSeconds }))).toEqual([
      { id: liveId!, isLive: true, lengthSeconds: undefined },
      { id: premiereId!, isLive: false, lengthSeconds: undefined },
    ]);
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

describe("song search", () => {
  test("a limit past the first page fetches one continuation from YouTube Music and repeats no song", async () => {
    const first = songIds(SONGS_PAGE);
    const fresh = songIds(SONGS_NEXT_PAGE).filter((id) => !first.includes(id));
    expect(fresh.length).toBeLessThan(songIds(SONGS_NEXT_PAGE).length);
    const { yt, ytdl, bodies } = setup({ [MUSIC_SEARCH]: pages(SONGS_PAGE, SONGS_NEXT_PAGE) });

    const songs = await ytdl.search("kevin macleod", { type: SearchType.Song, limit: 30 });

    expect(songs.map((song) => song.id)).toEqual([...first, ...fresh].slice(0, 30));
    expect(bodies(MUSIC_SEARCH)).toMatchObject([
      { query: "kevin macleod", params: SONGS_PARAMS, context: { client: { clientName: "WEB_REMIX" } } },
      { continuation: "SONGS-PAGE-2" },
    ]);
    const headers = new Headers(yt.requests.find((request) => request.url === MUSIC_SEARCH)?.init?.headers);
    expect(headers.get("Origin")).toBe("https://music.youtube.com");
    expect(headers.get("X-YouTube-Client-Name")).toBe("67");
  });

  test("a song carries its artists, length, plays and labels", async () => {
    const { ytdl } = setup({ [MUSIC_SEARCH]: pages(SONGS_PAGE) });
    const badged = setup({ [MUSIC_SEARCH]: pages(SONG_BADGES_PAGE) }).ytdl;

    const [song] = await ytdl.search("kevin macleod", { type: SearchType.Song, limit: 1 });
    const [explicit] = await badged.search("relabelled", { type: SearchType.Song, limit: 1 });

    expect(song).toMatchObject({
      id: RADIO_SEED,
      url: `https://www.youtube.com/watch?v=${RADIO_SEED}`,
      title: "Clear Air - Somewhere Sunny",
      lengthSeconds: 184,
      viewCount: 48_000,
      badges: [],
      isLive: false,
      isUpcoming: false,
      upcomingAt: undefined,
    });
    expect(song?.author).toMatchObject({
      id: "UCBqb0wSlWVFBnSuTI3Tcxig",
      name: "Kevin MacLeod",
      url: "https://www.youtube.com/channel/UCBqb0wSlWVFBnSuTI3Tcxig",
    });
    expect(song?.thumbnails.length).toBeGreaterThan(0);
    expect(explicit).toMatchObject({
      lengthSeconds: 236,
      viewCount: 1_300_000_000,
      badges: ["Explicit"],
      isLive: false,
    });
    expect(explicit?.author).toMatchObject({ id: "UCrelabeledArtist2000000", name: "First Artist & Second Artist" });
  });

  test("an album named with digits is not the song's length", async () => {
    const numberedAlbum = JSON.parse(JSON.stringify(SONG_BADGES_PAGE).replace('"Album 2"', '"25"'));
    const { ytdl } = setup({ [MUSIC_SEARCH]: pages(numberedAlbum) });

    const [song] = await ytdl.search("relabelled", { type: SearchType.Song, limit: 1 });

    expect(song?.lengthSeconds).toBe(236);
  });

  test("a song row whose credits end in an album named with digits has no length", async () => {
    const unlengthed = JSON.parse(
      JSON.stringify(SONG_BADGES_PAGE).replace('"Album 2"', '"25"').replace(',{"text":" • "},{"text":"3:56"}', ""),
    );
    const { ytdl } = setup({ [MUSIC_SEARCH]: pages(unlengthed) });

    const [song] = await ytdl.search("relabelled", { type: SearchType.Song, limit: 1 });

    expect(song?.lengthSeconds).toBeUndefined();
  });

  test("a query nothing matches resolves to an empty list", async () => {
    const { ytdl } = setup({ [MUSIC_SEARCH]: pages(NO_SONGS) });
    expect(await ytdl.search("zzzzzz", { type: SearchType.Song })).toEqual([]);
  });
});

describe("music suggestions", () => {
  test("returns YouTube Music's text completions in answer order, without entity rows", async () => {
    const { yt, ytdl, bodies } = setup(
      { [MUSIC_SUGGEST]: () => Response.json(MUSIC_SUGGESTIONS) },
      { lang: "de", country: "DE" },
    );

    const suggestions = await ytdl.getSuggestions("kevin macl", { music: true });

    expect(suggestions).toEqual([
      "kevin macleod",
      "kevin macleod action cuts",
      "fluffing a duck (kevin macleod)",
      "the complex kevin macleod",
      "monkeys spinning monkeys – kevin macleod",
      "killers kevin macleod",
    ]);
    expect(bodies(MUSIC_SUGGEST)).toMatchObject([
      { input: "kevin macl", context: { client: { clientName: "WEB_REMIX", hl: "de", gl: "DE" } } },
    ]);
    const headers = new Headers(yt.requests.find((request) => request.url === MUSIC_SUGGEST)?.init?.headers);
    expect(headers.get("X-Goog-Visitor-Id")).toBe("VISITOR-1");
  });

  test.each([
    ["HTTP 503", 503, YtdlErrorCode.REQUEST_FAILED],
    ["HTTP 429", 429, YtdlErrorCode.RATE_LIMITED],
  ] as const)("%s rejects %s", async (_, status, code) => {
    const { yt, ytdl } = setup({ [MUSIC_SUGGEST]: () => new Response("no", { status }) });
    expect((await rejection(ytdl.getSuggestions("kevin macl", { music: true }))).code).toBe(code);
    expect(yt.requests.map((request) => request.url)).toContain(MUSIC_SUGGEST);
  });
});

describe("music radio", () => {
  test("one next request with no player request returns the radio without its seed", async () => {
    const { yt, ytdl, bodies } = setup({ [MUSIC_NEXT]: pages(RADIO) });

    const radio = await ytdl.getRelated(RADIO_SEED, { music: true });

    expect(radioIds(RADIO)[0]).toBe(RADIO_SEED);
    expect(radio.map((song) => song.id)).toEqual(radioIds(RADIO).slice(1));
    expect(radio[0]).toMatchObject({ id: "_rh4iAZdLdU", title: "Clear Air", lengthSeconds: 184, viewCount: undefined });
    expect(radio[0]?.author).toMatchObject({ id: "UCBqb0wSlWVFBnSuTI3Tcxig", name: "Kevin MacLeod" });
    expect(bodies(MUSIC_NEXT)).toMatchObject([
      { videoId: RADIO_SEED, playlistId: `RDAMVM${RADIO_SEED}`, context: { client: { clientName: "WEB_REMIX" } } },
    ]);
    expect(yt.playerCalls).toHaveLength(0);
  });

  test("a radio seed continues that radio from the given song, without the song", async () => {
    const { ytdl, bodies } = setup({ [MUSIC_NEXT]: pages(RADIO) });

    const radio = await ytdl.getRelated("_rh4iAZdLdU", {
      music: true,
      radioSeed: `https://music.youtube.com/watch?v=${RADIO_SEED}`,
    });

    expect(bodies(MUSIC_NEXT)).toMatchObject([{ videoId: "_rh4iAZdLdU", playlistId: `RDAMVM${RADIO_SEED}` }]);
    expect(radio.map((song) => song.id)).not.toContain("_rh4iAZdLdU");
    expect(radio.length).toBe(radioIds(RADIO).length - 1);
  });
});

describe("discovery arguments", () => {
  test.each([
    ["a blank search query", (ytdl: Ytdl) => ytdl.search("   ")],
    ["a zero search limit", (ytdl: Ytdl) => ytdl.search("nasa", { limit: 0 })],
    ["a fractional search limit", (ytdl: Ytdl) => ytdl.search("nasa", { limit: 1.5 })],
    ["a zero playlist limit", (ytdl: Ytdl) => ytdl.getPlaylist(PLAYLIST_ID, { limit: 0 })],
    ["a blank suggestion query", (ytdl: Ytdl) => ytdl.getSuggestions(" ")],
    [
      "a non-boolean suggestion music",
      (ytdl: Ytdl) => ytdl.getSuggestions("nasa", { music: "yes" as unknown as boolean }),
    ],
    ["a non-boolean related music", (ytdl: Ytdl) => ytdl.getRelated(VIDEO_ID, { music: "yes" as unknown as boolean })],
    ["a radio seed without music", (ytdl: Ytdl) => ytdl.getRelated(VIDEO_ID, { radioSeed: RADIO_SEED })],
    [
      "a radio seed that is no video",
      (ytdl: Ytdl) => ytdl.getRelated(VIDEO_ID, { music: true, radioSeed: "not a video" }),
    ],
  ])("%s rejects INVALID_ARGUMENT before any request", async (_, call) => {
    const { yt, ytdl } = setup({});
    expect((await rejection(call(ytdl))).code).toBe("INVALID_ARGUMENT");
    expect(yt.requests).toHaveLength(0);
  });

  test.each([
    `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://example.com/playlist?list=${PLAYLIST_ID}`,
    VIDEO_ID,
    `RD${VIDEO_ID}`,
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

  test("a YouTube Music curated list is browsed as a playlist", async () => {
    const curated = "RDCLAK5uy_abcdefghijklmnopqrstuvwxyz0123456";
    const { ytdl, bodies } = setup({ [BROWSE]: pages(SHORT_PLAYLIST_PAGE) });

    const playlist = await ytdl.getPlaylist(curated);

    expect(playlist.id).toBe(curated);
    expect(bodies(BROWSE)).toMatchObject([{ browseId: `VL${curated}` }]);
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

  test("a recommended video after the entries is not an entry", async () => {
    const page = {
      metadata: { playlistMetadataRenderer: { title: "Blender open movies" } },
      contents: [
        playlistEntry("aqz-KE-bpKQ"),
        playlistEntry("R6MlUcmOul8"),
        playlistEntry("eRsGyueVLvQ", { style: "PLAYLIST_VIDEO_RENDERER_STYLE_RECOMMENDED_VIDEO" }),
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

  test("a playlist that ends on its 70th page resolves with every entry", async () => {
    const { ytdl } = setup({ [BROWSE]: numberedPages(70) });

    const playlist = await ytdl.getPlaylist(PLAYLIST_ID);

    expect(playlist.videos.map((video) => video.id)).toEqual(Array.from({ length: 70 }, (_, i) => `video-${i + 1}`));
  });

  test("a playlist that keeps offering new pages rejects REQUEST_FAILED after 1000 pages", async () => {
    const { ytdl, bodies } = setup({ [BROWSE]: numberedPages(Number.POSITIVE_INFINITY) });

    expect((await rejection(ytdl.getPlaylist(PLAYLIST_ID))).code).toBe("REQUEST_FAILED");
    expect(bodies(BROWSE)).toHaveLength(1000);
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

  test("song search then a music radio on a new instance fetch visitor data once and both send it", async () => {
    const { yt, ytdl } = setup({ [MUSIC_SEARCH]: pages(SONGS_PAGE), [MUSIC_NEXT]: pages(RADIO) });

    await ytdl.search("kevin macleod", { type: SearchType.Song, limit: 1 });
    await ytdl.getRelated(RADIO_SEED, { music: true });

    expect(yt.visitorFetches()).toBe(1);
    const visitors = yt.requests
      .filter((request) => request.url === MUSIC_SEARCH || request.url === MUSIC_NEXT)
      .map((request) => new Headers(request.init?.headers).get("X-Goog-Visitor-Id"));
    expect(visitors).toEqual(["VISITOR-1", "VISITOR-1"]);
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

  test("a German instance searches in English and asks for suggestions in German", async () => {
    const yt = fakeYouTube({
      player: () => playable(VIDEO_ID),
      routes: { [SEARCH]: pages(SEARCH_PAGE) },
      media: (url) => (url.hostname === "suggestqueries-clients6.youtube.com" ? new Response(SUGGESTIONS) : undefined),
    });
    const ytdl = new Ytdl({ fetch: yt.fetch, lang: "de" });

    await ytdl.search("blender open movie", { limit: 1 });
    await ytdl.getSuggestions("blender open movie");

    const search = JSON.parse(String(yt.requests.find((request) => request.url === SEARCH)?.init?.body));
    expect(search.context.client.hl).toBe("en");
    expect(new URL(yt.requests.at(-1)?.url ?? "").searchParams.get("hl")).toBe("de");
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

describe("playlist search", () => {
  const FIRST = [
    "PLXIclLvfETS0GFbNbRpwCgh1CGwO6hLrv",
    "PLxA687tYuMWgeHrs69WUDoU0PZxYdEzew",
    "PLINj2JJM1jxMKUSiMcZPYvORDFh5sa8XH",
  ];

  test("a limit past the first page fetches the next page once, in order, without the mix", async () => {
    const { ytdl, bodies } = setup({ [SEARCH]: pages(PLAYLISTS_PAGE, PLAYLISTS_NEXT_PAGE) });

    const playlists = await ytdl.search("taylor swift", { type: SearchType.Playlist, limit: 4 });

    expect(playlists.map((playlist) => playlist.id)).toEqual([...FIRST, "PLmU8B4gZ41icKdheg4d2KZBgDR1wSWfbH"]);
    expect(playlists[0]?.url).toBe(`https://www.youtube.com/playlist?list=${FIRST[0]}`);
    expect(bodies(SEARCH).map((body) => body.continuation)).toEqual([undefined, "PLAYLIST-PAGE-2"]);
    expect(bodies(SEARCH)[0]).toMatchObject({ query: "taylor swift", params: "EgIQAw%3D%3D" });
  });

  test("a playlist carries its owner, count badge and update text", async () => {
    const { ytdl } = setup({ [SEARCH]: pages(PLAYLISTS_PAGE) });

    const [updated, verified, artist] = await ytdl.search("taylor swift", { type: SearchType.Playlist, limit: 3 });

    expect(updated).toMatchObject({ videoCount: 11, updatedText: "Updated 2 days ago" });
    expect(updated?.author).toMatchObject({ verified: false, badges: [] });
    expect(verified).toMatchObject({ title: "Taylor Swift Greatest Hits", videoCount: 186, updatedText: undefined });
    expect(verified?.author).toEqual({
      id: "UCYXIviXPAaaaU_AOotpXTAw",
      name: "Revive Music",
      url: "https://www.youtube.com/@revive",
      thumbnails: [],
      verified: true,
      badges: ["Verified"],
    });
    expect(verified?.thumbnails.length).toBeGreaterThan(0);
    expect(artist).toMatchObject({ videoCount: undefined, updatedText: undefined });
    expect(artist?.author).toMatchObject({ id: CHANNEL_ID, verified: true, badges: ["Official Artist Channel"] });
  });
});

describe("safe search", () => {
  test("asks for restricted mode on every page", async () => {
    const { ytdl, bodies } = setup({ [SEARCH]: pages(SEARCH_PAGE, SEARCH_NEXT_PAGE) });

    await ytdl.search("blender open movie", { safeSearch: true, limit: videoIds(SEARCH_PAGE).length + 1 });

    expect(bodies(SEARCH).map((body) => body.context.user)).toEqual([
      { enableSafetyMode: true },
      { enableSafetyMode: true },
    ]);
  });

  test("a default search does not ask for restricted mode", async () => {
    const { ytdl, bodies } = setup({ [SEARCH]: pages(SEARCH_PAGE) });
    await ytdl.search("blender open movie", { limit: 1 });
    expect(bodies(SEARCH)[0].context.user).toBeUndefined();
  });

  test.each([
    ["an unknown type", (ytdl: Ytdl) => ytdl.search("nasa", { type: "channel" as SearchType })],
    ["a non-boolean safeSearch", (ytdl: Ytdl) => ytdl.search("nasa", { safeSearch: "yes" as unknown as boolean })],
  ])("%s rejects INVALID_ARGUMENT before any request", async (_, call) => {
    const { yt, ytdl } = setup({});
    expect((await rejection(call(ytdl))).code).toBe("INVALID_ARGUMENT");
    expect(yt.requests).toHaveLength(0);
  });
});

describe("summary details", () => {
  test("a result carries its URL, badges and owner badges", async () => {
    const { ytdl } = setup({ [SEARCH]: pages(BADGES_PAGE) });

    const [artist, plain] = await ytdl.search("taylor swift", { limit: 2 });

    expect(artist).toMatchObject({
      id: "1FVF-9KQiPo",
      url: "https://www.youtube.com/watch?v=1FVF-9KQiPo",
      badges: ["4K"],
    });
    expect(artist?.author).toMatchObject({
      id: CHANNEL_ID,
      url: `https://www.youtube.com/channel/${CHANNEL_ID}`,
      verified: true,
      badges: ["Official Artist Channel"],
    });
    expect(artist?.author.thumbnails.length).toBeGreaterThan(0);
    expect(plain).toMatchObject({ badges: [], author: { verified: false, badges: [] } });
  });

  test("a scheduled premiere is upcoming at its start time", async () => {
    const { ytdl } = setup({ [SEARCH]: pages(UNBADGED_PAGE) });

    const videos = await ytdl.search("nasa", { limit: 100 });

    expect(videos.find((video) => video.id === "pAKqJxuxDgk")).toMatchObject({
      isUpcoming: true,
      upcomingAt: 1_792_778_400_000,
    });
    expect(videos.find((video) => video.id === "awQzjn72bI0")).toMatchObject({
      isUpcoming: false,
      upcomingAt: undefined,
    });
  });

  test("a playlist header gives its description and counts", async () => {
    const { ytdl } = setup({ [BROWSE]: pages(PLAYLIST_PAGE, PLAYLIST_NEXT_PAGE) });

    const playlist = await ytdl.getPlaylist(PLAYLIST_ID, { limit: 1 });

    expect(playlist).toMatchObject({ videoCount: 113, viewCount: 1_259_717 });
    expect(playlist.description).toStartWith("Perseverance is searching for signs of habitable conditions on Mars");
  });

  test("an instance's UTC offset goes with every InnerTube request", async () => {
    const { ytdl, bodies } = setup({ [SEARCH]: pages(SEARCH_PAGE) }, { utcOffsetMinutes: 420 });
    await ytdl.search("blender open movie", { limit: 1 });
    expect(bodies(SEARCH)[0].context.client.utcOffsetMinutes).toBe(420);
  });

  test("a fractional UTC offset rejects INVALID_ARGUMENT", () => {
    expect(() => new Ytdl({ utcOffsetMinutes: 30.5 })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});

describe("channel uploads", () => {
  test("a channel ID browses its uploads list with no resolve request", async () => {
    const { yt, ytdl, bodies } = setup({ [BROWSE]: pages(UPLOADS_PAGE) });

    const uploads = await ytdl.getPlaylist(CHANNEL_ID, { limit: 3 });

    expect(bodies(BROWSE)[0].browseId).toBe("VLUUqECaJ8Gagnn7YCbPEzWH6g");
    expect(yt.requests.some((request) => request.url === RESOLVE)).toBe(false);
    expect(uploads).toMatchObject({ id: "UUqECaJ8Gagnn7YCbPEzWH6g", videoCount: 669, viewCount: 5_197_045 });
    expect(uploads.videos.map((video) => video.id)).toEqual(["j8pR1tyoRFc", "mw3kSNIxjqo", "BpR280fXISA"]);
  });

  test("a channel's live station is a live entry without a view count or live badge", async () => {
    const { ytdl } = setup({ [BROWSE]: pages(UPLOADS_PAGE) });

    const uploads = await ytdl.getPlaylist(CHANNEL_ID, { limit: 4 });
    const station = uploads.videos.find((video) => video.id === "c0Y4PqvDvqc");

    expect(station).toMatchObject({ isLive: true, viewCount: undefined, lengthSeconds: undefined, badges: [] });
    expect(station?.thumbnails.length).toBeGreaterThan(0);
  });

  // Trimmed from NASA's uploads, recorded 2026-10-28; the premiere row is another channel's upcoming premiere.
  test.each([
    ["scheduled stream", ["12 waiting", "Scheduled for 10/29/26, 10:30 AM"]],
    ["premiere", ["Premieres 10/31/26, 4:00 PM"]],
  ])("an upcoming %s is upcoming without a view count or badge", async (_, row) => {
    const lockupViewModel = {
      contentId: "hv867HnY4j4",
      contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
      contentImage: {
        thumbnailViewModel: {
          overlays: [
            {
              thumbnailBottomOverlayViewModel: {
                badges: [
                  {
                    thumbnailBadgeViewModel: { text: "Upcoming", badgeStyle: "THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT" },
                  },
                ],
              },
            },
          ],
        },
      },
      metadata: {
        lockupMetadataViewModel: {
          title: { content: "U.S. Spacewalk 100" },
          metadata: {
            contentMetadataViewModel: {
              metadataRows: [
                { metadataParts: [{ text: { content: "NASA" } }] },
                { metadataParts: row.map((content) => ({ text: { content } })) },
              ],
            },
          },
        },
      },
    };
    const page = appendedPage([{ lockupViewModel }], { metadata: { playlistMetadataRenderer: { title: "Uploads" } } });
    const { ytdl } = setup({ [BROWSE]: pages(page) });

    const [video] = (await ytdl.getPlaylist("UCLA_DiR1FfKNvjuUpBHmylQ")).videos;

    expect(video).toMatchObject({
      id: "hv867HnY4j4",
      isUpcoming: true,
      isLive: false,
      viewCount: undefined,
      lengthSeconds: undefined,
      badges: [],
    });
  });

  test.each(["", "/videos"])("a handle URL%s is resolved once, then its uploads are browsed", async (tab) => {
    const { ytdl, bodies } = setup({ [RESOLVE]: pages(RESOLVED_CHANNEL), [BROWSE]: pages(UPLOADS_PAGE) });

    await ytdl.getPlaylist(`https://www.youtube.com/@TaylorSwift${tab}`, { limit: 3 });

    expect(bodies(RESOLVE).map((body) => body.url)).toEqual(["https://www.youtube.com/@TaylorSwift"]);
    expect(bodies(BROWSE)[0].browseId).toBe("VLUUqECaJ8Gagnn7YCbPEzWH6g");
  });

  test("a handle naming no channel rejects NOT_FOUND without browsing", async () => {
    const { yt, ytdl } = setup({ [RESOLVE]: () => Response.json({ error: { code: 404 } }, { status: 404 }) });

    expect((await rejection(ytdl.getPlaylist("https://www.youtube.com/@nobody-here-0x9q"))).code).toBe("NOT_FOUND");
    expect(yt.requests.some((request) => request.url === BROWSE)).toBe(false);
  });
});

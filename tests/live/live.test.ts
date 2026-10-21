import { afterAll, describe, expect, test } from "bun:test";
import {
  type ChooseFormatOptions,
  Client,
  chooseFormat,
  createPoTokenProvider,
  type Filter,
  type Media,
  Quality,
  Ytdl,
  type VideoInfo,
} from "../../src/index.ts";

const LIVE = process.env.YTDL_LIVE === "1";
const COOKIE = process.env.YTDL_COOKIE;
const HOST = process.env.YTDL_HOST ?? "unlabelled";
const TIMEOUT = 300_000;

const VIDEOS = {
  normal: "aqz-KE-bpKQ", // Big Buck Bunny, Blender, CC BY 3.0
  long: "KG6SL6Mf7ak", // NASA ISS views, 2 h 39 min
  short: "yuT7iQC-yro", // NASA
  kids: "wZK2xTNzgq8", // NASA Space Place, made for kids: VISIONOS lists no formats
  live: "https://www.youtube.com/@NASA/live",
} as const;
const SEARCH_QUERY = "blender open movie";
const PLAYLIST = "PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5"; // NASA, Perseverance Mars Rover, over 100 entries

const rows: string[] = [];
afterAll(() => {
  if (LIVE) console.log(`live check on host "${HOST}":\n${rows.join("\n")}`);
});

async function read(media: Media, start: number, length: number): Promise<Buffer> {
  return Buffer.concat(await media.read({ range: { start, end: start + length - 1 } }).toArray());
}

const withoutDirectUrls = (async (input: string | URL | Request, init?: RequestInit) => {
  const response = await fetch(input, init);
  if (!String(input instanceof Request ? input.url : input).includes("/youtubei/v1/player")) return response;
  const body = (await response.json()) as { streamingData?: { adaptiveFormats?: Record<string, unknown>[] } };
  for (const format of body.streamingData?.adaptiveFormats ?? []) {
    delete format.url;
    delete format.signatureCipher;
  }
  return Response.json(body, { status: response.status });
}) as typeof fetch;

async function plays(label: string, yt: Ytdl, id: string, offsets: readonly number[] = [0]): Promise<VideoInfo> {
  const info = await yt.getInfo(id);
  const format = chooseFormat(info.formats, {
    quality: Quality.HighestAudio,
    filter: { hasAudio: true, hasVideo: false },
  });
  const media = yt.open(info, format);
  const size = format.contentLength ?? 0;
  for (const offset of offsets) {
    const start = offset === 0 ? 0 : Math.floor(size * offset);
    expect((await read(media, start, 256 * 1024)).length).toBe(Math.min(256 * 1024, size - start));
  }
  rows.push(`  ${label} ${id}: ${info.client}, itag ${format.itag}, offsets ${offsets.join(", ")}`);
  return info;
}

describe.skipIf(!LIVE)("real YouTube", () => {
  const yt = new Ytdl();

  test("normal video", () => plays("normal", yt, VIDEOS.normal), TIMEOUT);

  test(
    "long video, read past 60 s and past 95 %",
    async () => {
      const info = await yt.getInfo(VIDEOS.long);
      expect(info.videoDetails.lengthSeconds).toBeGreaterThan(2 * 60 * 60);
      await plays("long", yt, VIDEOS.long, [70 / info.videoDetails.lengthSeconds, 0.96]);
    },
    TIMEOUT,
  );

  test(
    "SABR matches the direct bytes for the long video's best audio and a 1080p video format",
    async () => {
      const sabr = new Ytdl({ fetch: withoutDirectUrls });
      const cases: [string, ChooseFormatOptions, readonly number[]][] = [
        [VIDEOS.long, { quality: Quality.HighestAudio, filter: { hasAudio: true, hasVideo: false } }, [0.0079, 0.96]],
        [VIDEOS.normal, { quality: Quality.HighestVideo, filter: (format) => format.height === 1080 }, [0, 0.5]],
      ];
      for (const [id, choice, offsets] of cases) {
        const info = await sabr.getInfo(id);
        const format = chooseFormat(info.formats, choice);
        expect(format.url).toBeUndefined();
        const direct = await yt.getInfo(id);
        const directFormat = chooseFormat(direct.formats, { format });
        expect(directFormat.url).toBeString();
        const [sabrMedia, directMedia] = [sabr.open(info, format), yt.open(direct, directFormat)];
        const size = format.contentLength ?? 0;
        for (const offset of offsets) {
          const start = Math.floor(size * offset);
          const bytes = await read(sabrMedia, start, 1024 * 1024);
          expect(bytes.length).toBe(Math.min(1024 * 1024, size - start));
          expect(bytes.equals(await read(directMedia, start, 1024 * 1024))).toBe(true);
        }
        rows.push(`  sabr ${id}: ${info.client}, itag ${format.itag}, offsets ${offsets.join(", ")}`);
      }
    },
    2 * TIMEOUT,
  );

  test("Short", () => plays("short", yt, VIDEOS.short), TIMEOUT);
  test("made-for-kids video", () => plays("kids", yt, VIDEOS.kids), TIMEOUT);

  test(
    "a captioned video lists tracks and returns WebVTT",
    async () => {
      const info = await yt.getInfo(VIDEOS.short);
      expect(info.captionTracks.length).toBeGreaterThan(0);
      const text = await yt.getCaptions(info);
      expect(text).toStartWith("WEBVTT");
      rows.push(`  captions ${VIDEOS.short}: ${info.client}, ${info.captionTracks.length} tracks`);
    },
    TIMEOUT,
  );

  test(
    "discovery search returns videos",
    async () => {
      const [found] = await yt.search(SEARCH_QUERY, { limit: 5 });
      expect(found?.id).toMatch(/^[\w-]{11}$/u);
      expect(found?.title).toBeString();
      rows.push(`  search "${SEARCH_QUERY}": first ${found?.id}`);
    },
    TIMEOUT,
  );

  test(
    "discovery playlist returns entries across pages",
    async () => {
      const playlist = await yt.getPlaylist(PLAYLIST);
      expect(playlist.videos.length).toBeGreaterThan(100);
      rows.push(`  playlist ${PLAYLIST}: ${playlist.videos.length} entries`);
    },
    TIMEOUT,
  );

  test(
    "discovery related videos come without a player lookup",
    async () => {
      const urls: string[] = [];
      const counting = ((input: string | URL | Request, init?: RequestInit) => {
        urls.push(String(input instanceof Request ? input.url : input));
        return fetch(input, init);
      }) as typeof fetch;
      const related = await new Ytdl({ fetch: counting }).getRelated(VIDEOS.normal);
      expect(related.length).toBeGreaterThan(0);
      expect(urls.filter((url) => url.includes("/youtubei/v1/player"))).toEqual([]);
      rows.push(`  related ${VIDEOS.normal}: ${related.length} videos`);
    },
    TIMEOUT,
  );

  test(
    "discovery suggestions return completions",
    async () => {
      const suggestions = await yt.getSuggestions(SEARCH_QUERY);
      expect(suggestions.length).toBeGreaterThan(0);
      rows.push(`  suggestions "${SEARCH_QUERY}": ${suggestions.length}`);
    },
    TIMEOUT,
  );

  async function streams(label: string, filter: Filter): Promise<void> {
    const info = await yt.getInfo(VIDEOS.live);
    expect(info.videoDetails.isLive).toBe(true);
    const format = chooseFormat(info.formats, { quality: Quality.Lowest, filter });
    const controller = new AbortController();
    let bytes = 0;
    const started = Date.now();
    const stream = yt.open(info, format).read({ signal: controller.signal });
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Uint8Array) => {
        bytes += chunk.length;
        if (Date.now() - started >= 30_000) {
          controller.abort();
          resolve();
        }
      });
      stream.on("error", (error) => (controller.signal.aborted ? resolve() : reject(error)));
      stream.on("end", resolve);
    });
    expect(bytes).toBeGreaterThan(0);
    rows.push(
      `  ${label} ${VIDEOS.live}: ${info.client}, itag ${format.itag} at ${format.bitrate} bps, ${bytes} bytes in 30 s`,
    );
  }

  test("live stream over HLS, 30 s of segments", () => streams("live hls", (format) => format.isHLS), TIMEOUT);
  test(
    "live stream over DASH, 30 s of segments",
    () => streams("live dash", { isLive: true, hasAudio: true, hasVideo: false }),
    TIMEOUT,
  );

  test.each([Client.VisionOS, Client.WebEmbedded, Client.Tv])(
    "the %s client plays on its own",
    async (client) => {
      const info = await plays(client, new Ytdl({ clients: [client] }), VIDEOS.normal);
      expect(info.client).toBe(client);
    },
    TIMEOUT,
  );

  test.skipIf(!COOKIE)(
    "YTDL_COOKIE signs in the account-only WEB_CREATOR client",
    async () => {
      const getPoToken = await createPoTokenProvider();
      try {
        const signedIn = new Ytdl({ cookie: COOKIE, clients: [Client.WebCreator], getPoToken });
        const info = await plays("web_creator+cookie", signedIn, VIDEOS.normal);
        expect(info.client).toBe("web_creator");
      } finally {
        await getPoToken.dispose();
      }
    },
    TIMEOUT,
  );

  test(
    "the MWEB rung through createPoTokenProvider",
    async () => {
      const getPoToken = await createPoTokenProvider();
      try {
        const info = await plays("mweb", new Ytdl({ clients: [Client.Mweb], getPoToken }), VIDEOS.normal);
        expect(info.client).toBe("mweb");
      } finally {
        await getPoToken.dispose();
      }
    },
    TIMEOUT,
  );
});

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  type ChooseFormatOptions,
  Client,
  chooseFormat,
  createPoTokenProvider,
  type GetPoToken,
  type Filter,
  type Media,
  Quality,
  SearchType,
  Ytdl,
  type VideoInfo,
} from "../../src/index.ts";
import { audioFormat, fakeYouTube, MEDIA_HOST, playable } from "../fake-youtube.ts";

const LIVE = process.env.YTDL_LIVE === "1";
const COOKIE = process.env.YTDL_COOKIE;
const HOST = process.env.YTDL_HOST ?? "unlabelled";
const TIMEOUT = 300_000;
const LIVE_MS = 3 * 60_000;
const PROBE_BYTES = 2 * 1024 * 1024;

const VIDEOS = {
  normal: "aqz-KE-bpKQ", // Big Buck Bunny, Blender, CC BY 3.0
  long: "KG6SL6Mf7ak", // NASA ISS views, 2 h 39 min
  short: "yuT7iQC-yro", // NASA
  kids: "wZK2xTNzgq8", // NASA Space Place, made for kids: VISIONOS lists no formats
  live: "https://www.youtube.com/@NASA/live",
} as const;
const SEARCH_QUERY = "blender open movie";
const PLAYLIST = "PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5"; // NASA, Perseverance Mars Rover, over 100 entries

const EJS_COMMIT = "68448fa"; // yt-dlp/ejs src/yt/solver/test/tests.ts, Unlicense

interface Vector {
  readonly input: string;
  readonly expected: string;
}

const PINNED_PLAYERS: Record<string, { readonly n: readonly Vector[]; readonly sig: readonly Vector[] }> = {
  "74edf1a3": {
    n: [
      { input: "IlLiA21ny7gqA2m4p37", expected: "9nRTxrbM1f0yHg" },
      { input: "eabGFpsUKuWHXGh6FR4", expected: "izmYqDEY6kl7Sg" },
      { input: "eabGF/ps%UK=uWHXGh6FR4", expected: "LACmqlhaBpiPlgE-a" },
    ],
    sig: [
      {
        input:
          "NJAJEij0EwRgIhAI0KExTgjfPk-MPM9MAdzyyPRt=BM8-XO5tm5hlMCSVpAiEAv7eP3CURqZNSPow8BXXAoazVoXgeMP7gH9BdylHCwgw=gwzz",
        expected:
          "NJAJEij0EwRgIhAI0KExTgjfPk-MPM9MAdzyyPRt=BM8-XO5tm5hzMCSVpAiEAv7eP3CURqZNSPow8BXXAoazVoXgeMP7gH9BdylHCwgw=gwzl",
      },
      {
        input:
          "\u0000\u0001\u0002%\u0003\u0004\u0005\u0006\u0007\b\t\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019 !\"#$%&'()0123456789@ABCDEFGHI",
        expected:
          "\u0000\u0001\u0002%\u0003\u0004\u0005\u0006\u0007\b\t\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019 !\"#$%&'()0123456789@ABIDEFGHC",
      },
    ],
  },
  "901741ab": {
    n: [{ input: "BQoJvGBkC2nj1ZZLK-", expected: "UMPovvBZRh-sjb" }],
    sig: [
      {
        input:
          "NJAJEij0EwRgIhAI0KExTgjfPk-MPM9MAdzyyPRt=BM8-XO5tm5hlMCSVpAiEAv7eP3CURqZNSPow8BXXAoazVoXgeMP7gH9BdylHCwgw=gwzz",
        expected:
          "wgwCHlydB9Hg7PMegXoVzaoAXXB8woPSNZqRUC3Pe7vAEiApVSCMlhwmt5ON-8MB=5RPyyzdAM9MPM-kPfjgTxEK0IAhIgRwE0jiEJA",
      },
    ],
  },
  e7573094: {
    n: [{ input: "IlLiA21ny7gqA2m4p37", expected: "3KuQ3235dojTSjo4" }],
    sig: [
      {
        input:
          "NJAJEij0EwRgIhAI0KExTgjfPk-MPM9MAdzyyPRt=BM8-XO5tm5hlMCSVpAiEAv7eP3CURqZNSPow8BXXAoazVoXgeMP7gH9BdylHCwgw=gwzz",
        expected:
          "yEij0EwRgIhAI0KExTgjfPk-MPM9MAdzyNPRt=BM8-XO5tm5hlMCSVNAiEAvpeP3CURqZJSPow8BXXAoazVoXgeMP7gH9BdylHCwgw=g",
      },
    ],
  },
  "9fcf08e8": {
    n: [{ input: "4JRSxxN0E_fLVnxmd", expected: "xhAoMP8xPcR5wg" }],
    sig: [
      {
        input:
          "\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\b\t\n\u000b\f\r\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghij",
        expected:
          "jihgfedcba`_^]\\[ZYXWVUTSRQPONMLKJIHGFEDCBA@?>=<;:9876543210/.-,+*)('&%$#\"! \u001f\u001e\u001d\u001c\u001b\u001a\u0019\u0018\u0017\u0016\u0015\u0014\u0013\u0012\u0011\u0010\u000f\u000e\r\f\u000b\u0003\t\b\u0007\u0006\u0005\u0004\n",
      },
    ],
  },
};

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

function audioStreams(bytes: Buffer): number {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", "-i", "pipe:0"],
    {
      input: bytes,
      encoding: "utf8",
    },
  );
  if (probe.error) throw probe.error;
  return probe.stdout.split("\n").filter((line) => line.trim() === "audio").length;
}

async function longOffsets(yt: Ytdl): Promise<number[]> {
  const info = await yt.getInfo(VIDEOS.long);
  return [0, 70 / info.videoDetails.lengthSeconds];
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

  test.each(Object.entries(PINNED_PLAYERS))(
    `pinned player %s solves sig and n to the yt-dlp/ejs ${EJS_COMMIT} reference values`,
    async (playerId, { n, sig }) => {
      const videoId = VIDEOS.normal;
      const formats = Array.from({ length: Math.max(n.length, sig.length) }, (_, index) => {
        const query = `itag=${251 - index}&expire=4102444800${n[index] ? `&n=${encodeURIComponent(n[index].input)}` : ""}`;
        const url = `${MEDIA_HOST}?${query}`;
        const cipher = sig[index]
          ? { url: undefined, signatureCipher: new URLSearchParams({ s: sig[index].input, sp: "sig", url }).toString() }
          : { url };
        return audioFormat(251 - index, cipher);
      });
      const answers = fakeYouTube({ player: () => playable(videoId, formats) });
      const fetch = ((input: string | URL | Request, init?: RequestInit) =>
        String(input).includes("/s/player/")
          ? globalThis.fetch(input, init)
          : answers.fetch(input, init)) as typeof globalThis.fetch;
      const info = await new Ytdl({ fetch, playerId, clients: [Client.Tv] }).getInfo(videoId);
      expect(info.formats).toHaveLength(formats.length);
      for (const [index, format] of formats.entries()) {
        const solved = new URL(info.formats.find((candidate) => candidate.itag === format.itag)?.url ?? "");
        expect(solved.searchParams.get("n")).toBe(n[index]?.expected ?? null);
        expect(solved.searchParams.get("sig")).toBe(sig[index]?.expected ?? null);
      }
      rows.push(`  player ${playerId}: ${n.length} n, ${sig.length} sig solved`);
    },
    TIMEOUT,
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
    "discovery playlist search returns playlists getPlaylist expands",
    async () => {
      const [found] = await yt.search("lofi hip hop", { type: SearchType.Playlist, limit: 3 });
      expect(found?.url).toBe(`https://www.youtube.com/playlist?list=${found?.id}`);
      const playlist = await yt.getPlaylist(found?.id ?? "", { limit: 5 });
      expect(playlist.videos.length).toBeGreaterThan(0);
      rows.push(`  playlist search: first ${found?.id}, ${found?.videoCount} videos`);
    },
    TIMEOUT,
  );

  test(
    "discovery safe search resolves",
    async () => {
      const videos = await yt.search(SEARCH_QUERY, { safeSearch: true, limit: 5 });
      expect(videos.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    "discovery expands a channel handle's uploads",
    async () => {
      const uploads = await yt.getPlaylist("https://www.youtube.com/@TaylorSwift", { limit: 5 });
      expect(uploads.id).toMatch(/^UU[\w-]{22}$/u);
      expect(uploads.videos).toHaveLength(5);
    },
    TIMEOUT,
  );

  test(
    "discovery marks a verified channel's results",
    async () => {
      const videos = await yt.search("taylor swift", { limit: 10 });
      expect(videos.some((video) => video.author.verified)).toBe(true);
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

  async function streams(label: string, filter: Filter, probeAudio = false): Promise<void> {
    const info = await yt.getInfo(VIDEOS.live);
    expect(info.videoDetails.isLive).toBe(true);
    const format = chooseFormat(info.formats, { quality: Quality.Lowest, filter });
    const controller = new AbortController();
    let bytes = 0;
    const head: Buffer[] = [];
    const started = Date.now();
    const stream = yt.open(info, format).read({ signal: controller.signal });
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Uint8Array) => {
        if (bytes < PROBE_BYTES) head.push(Buffer.from(chunk));
        bytes += chunk.length;
        if (Date.now() - started >= LIVE_MS) {
          controller.abort();
          resolve();
        }
      });
      stream.on("error", (error) => (controller.signal.aborted ? resolve() : reject(error)));
      stream.on("end", resolve);
    });
    expect(bytes).toBeGreaterThan(0);
    if (probeAudio) {
      expect(format.hasAudio).toBe(true);
      expect(audioStreams(Buffer.concat(head))).toBeGreaterThan(0);
    }
    rows.push(
      `  ${label} ${VIDEOS.live}: ${info.client}, itag ${format.itag} at ${format.bitrate} bps, ${bytes} bytes in ${LIVE_MS / 1000} s`,
    );
  }

  test(
    "live stream over HLS, 3 minutes of segments",
    () => streams("live hls", (format) => format.isHLS && format.hasAudio, true),
    2 * TIMEOUT,
  );
  test(
    "live stream over DASH, 3 minutes of segments",
    () => streams("live dash", (format) => format.isLive && !format.isHLS && format.hasAudio && !format.hasVideo),
    2 * TIMEOUT,
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
        const info = await plays("web_creator+cookie", signedIn, VIDEOS.long, await longOffsets(signedIn));
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
        const mweb = new Ytdl({ clients: [Client.Mweb], getPoToken });
        const info = await plays("mweb", mweb, VIDEOS.long, await longOffsets(mweb));
        expect(info.client).toBe("mweb");
      } finally {
        await getPoToken.dispose();
      }
    },
    TIMEOUT,
  );

  test(
    "SABR on MWEB with a PO token matches the direct bytes",
    async () => {
      const provider = await createPoTokenProvider();
      const bindings: string[] = [];
      const getPoToken: GetPoToken = (request) => {
        bindings.push(request.contentBinding);
        return provider(request);
      };
      try {
        const sabr = new Ytdl({ clients: [Client.Mweb], getPoToken, fetch: withoutDirectUrls });
        const direct = new Ytdl({ clients: [Client.Mweb], getPoToken });
        const info = await sabr.getInfo(VIDEOS.long);
        const format = chooseFormat(info.formats, {
          quality: Quality.HighestAudio,
          filter: { hasAudio: true, hasVideo: false },
        });
        expect(format.url).toBeUndefined();
        const directInfo = await direct.getInfo(VIDEOS.long);
        const directFormat = chooseFormat(directInfo.formats, { format });
        expect(directFormat.url).toBeString();
        const size = format.contentLength ?? 0;
        const start = Math.floor((size * 70) / info.videoDetails.lengthSeconds);
        const mintsBefore = bindings.length;
        const bytes = await read(sabr.open(info, format), start, 1024 * 1024);
        const sabrMints = bindings.slice(mintsBefore);
        expect(bytes.length).toBe(Math.min(1024 * 1024, size - start));
        expect(bytes.equals(await read(direct.open(directInfo, directFormat), start, 1024 * 1024))).toBe(true);
        expect(sabrMints.every((binding) => binding === VIDEOS.long)).toBe(true);
        rows.push(`  sabr+po ${VIDEOS.long}: ${info.client}, itag ${format.itag}, ${sabrMints.length} SABR mints`);
      } finally {
        await provider.dispose();
      }
    },
    2 * TIMEOUT,
  );

  test(
    "a full download of the normal video ends at its content length",
    async () => {
      const choice: ChooseFormatOptions = {
        quality: Quality.HighestAudio,
        filter: { hasAudio: true, hasVideo: false },
      };
      const info = await yt.getInfo(VIDEOS.normal);
      const expected = chooseFormat(info.formats, choice).contentLength;
      expect(expected).toBeGreaterThan(0);
      let retries = 0;
      let bytes = 0;
      const started = Date.now();
      for await (const chunk of yt.download(info, { ...choice, onRetry: () => retries++ }))
        bytes += (chunk as Buffer).length;
      expect(bytes).toBe(expected as number);
      rows.push(`  download ${VIDEOS.normal}: ${bytes} bytes, ${retries} retries, ${Date.now() - started} ms`);
    },
    TIMEOUT,
  );
});

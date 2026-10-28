import { describe, expect, test } from "bun:test";
import { chooseFormat, Quality, Ytdl, YtdlError } from "../src/index.ts";
import { audioFormat, fakeYouTube, fixture, playable, VISIONOS } from "./fake-youtube.ts";

// Recorded 2026-10-20 from VISIONOS and WEB `next` for aqz-KE-bpKQ (Big Buck Bunny, CC BY 3.0), personal data
// removed and related videos relabelled as Blender open movies.
const ID = "aqz-KE-bpKQ";
const PLAYER = fixture("player-visionos.json");
const NEXT = fixture("next-web.json");
const MICROFORMAT = {
  microformat: {
    playerMicroformatRenderer: {
      publishDate: "2014-11-10T06:05:55-08:00",
      uploadDate: "2014-11-10T06:05:55-08:00",
      category: "Film & Animation",
      isUnlisted: false,
      isFamilySafe: true,
      availableCountries: ["US", "VN"],
    },
  },
};

const marker = (title: string, startTimeSeconds: number) => ({
  macroMarkersListItemRenderer: {
    title: { simpleText: title },
    timeDescription: { simpleText: "0:00" },
    onTap: { watchEndpoint: { startTimeSeconds } },
  },
});

function recorded() {
  return fakeYouTube({
    player: ({ client }) => (client === VISIONOS ? PLAYER : { videoDetails: { videoId: ID }, ...MICROFORMAT }),
    next: NEXT,
  });
}

const hlsPlaylist = (itag: number) =>
  `https://manifest.googlevideo.com/api/manifest/hls_playlist/id/live/itag/${itag}/index.m3u8`;

function liveWithAudioRenditions() {
  const manifest = "https://manifest.googlevideo.com/api/manifest/hls_variant/id/live";
  return fakeYouTube({
    player: () => ({
      ...playable(ID, []),
      videoDetails: { videoId: ID, isLive: true },
      streamingData: { adaptiveFormats: [], hlsManifestUrl: manifest },
    }),
    routes: {
      [manifest]: () =>
        new Response(
          [
            "#EXTM3U",
            `#EXT-X-MEDIA:TYPE=AUDIO,NAME="audio",DEFAULT=YES,AUTOSELECT=YES,GROUP-ID="233",URI="${hlsPlaylist(233)}"`,
            `#EXT-X-MEDIA:TYPE=AUDIO,NAME="audio",DEFAULT=YES,AUTOSELECT=YES,GROUP-ID="234",URI="${hlsPlaylist(234)}"`,
            '#EXT-X-STREAM-INF:BANDWIDTH=290000,CODECS="avc1.42c00b,mp4a.40.5",RESOLUTION=256x144,FRAME-RATE=30,AUDIO="233"',
            hlsPlaylist(269),
            '#EXT-X-STREAM-INF:BANDWIDTH=2500000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=30,AUDIO="234"',
            hlsPlaylist(311),
          ].join("\n"),
        ),
    },
  });
}

const ad = (seconds: number) => ({ instreamVideoAdRenderer: { playerVars: `length_seconds=${seconds}&x=1` } });

describe("getInfo details", () => {
  test("reads details, author, likes, storyboards and related videos", async () => {
    const yt = recorded();
    const info = await new Ytdl({ fetch: yt.fetch }).getInfo(ID);
    const details = info.videoDetails;

    expect(details).toMatchObject({
      id: ID,
      url: `https://www.youtube.com/watch?v=${ID}`,
      title: "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film",
      lengthSeconds: 635,
      likes: 110_211,
      category: "Film & Animation",
      publishDate: "2014-11-10T06:05:55-08:00",
      isLive: false,
      isFamilySafe: true,
      isAgeRestricted: false,
      availableCountries: ["US", "VN"],
      chapters: [],
    });
    expect(details.author).toMatchObject({
      id: "UCSMOQeBJ2RAnuFungnQOxLg",
      name: "Blender",
      verified: true,
      subscriberCount: 1_250_000,
    });
    expect(details.storyboards).toHaveLength(3);
    // Level 0 is one sheet; the others page through sheets with `$M`.
    expect(details.storyboards[1]?.templateUrl).toContain("M$M.jpg");
    // Four lockups; the mix playlist is not a video.
    expect(info.relatedVideos.map((video) => video.id)).toEqual(["eRsGyueVLvQ", "R6MlUcmOul8", "Y-rmzh0PI3c"]);
    expect(info.relatedVideos[2]).toMatchObject({
      author: { name: "Blender" },
      lengthSeconds: 731,
      viewCount: 5_700_000,
    });
    expect(info.relatedVideos[0]?.thumbnails[0]?.url).toStartWith("https://i.ytimg.com/");

    const { adaptiveFormats } = PLAYER.streamingData as { adaptiveFormats: { itag: number }[] };
    expect(info.formats.map((format) => format.itag)).toEqual(adaptiveFormats.map((format) => format.itag));
  });

  test("a video without chapters, likes or related videos still resolves", async () => {
    const yt = fakeYouTube({ player: () => playable(ID), next: {} });
    const details = (await new Ytdl({ fetch: yt.fetch }).getInfo(ID)).videoDetails;
    expect(details.chapters).toEqual([]);
    expect(details.likes).toBeUndefined();
    expect(details.author.verified).toBeUndefined();
  });

  test("chapters come from the macro markers panel", async () => {
    const yt = fakeYouTube({ player: () => playable(ID), next: { panels: [marker("Intro", 0), marker("Verse", 75)] } });
    const details = (await new Ytdl({ fetch: yt.fetch }).getInfo(ID)).videoDetails;
    expect(details.chapters).toEqual([
      { title: "Intro", startTime: 0 },
      { title: "Verse", startTime: 75 },
    ]);
  });
});

describe("getInfo", () => {
  test("lists DRM and OTF formats flagged, and leaves out URL-less ones", async () => {
    const yt = fakeYouTube({
      player: () =>
        playable(ID, [
          audioFormat(251),
          audioFormat(140, { drmFamilies: ["WIDEVINE"] }),
          audioFormat(250, { type: "FORMAT_STREAM_TYPE_OTF" }),
          audioFormat(249, { url: undefined }),
        ]),
    });
    const info = await new Ytdl({ fetch: yt.fetch }).getInfo(ID);
    expect(info.formats.map(({ itag, isDrm, isOtf }) => ({ itag, isDrm, isOtf }))).toEqual([
      { itag: 251, isDrm: false, isOtf: false },
      { itag: 140, isDrm: true, isOtf: false },
      { itag: 250, isDrm: false, isOtf: true },
    ]);
    expect(info.formats[1]?.drmFamilies).toEqual(["WIDEVINE"]);
    expect(info.expiresAt).toBe(4_102_444_800_000);
  });

  test("a live caption track keeps its captionTrack and has no audio or video", async () => {
    const captions = {
      ...audioFormat(386, { mimeType: 'text/mp4; codecs="unknown"', contentLength: undefined, bitrate: undefined }),
      captionTrack: {
        displayName: "English (auto-generated)",
        vssId: "a.en",
        languageCode: "en",
        kind: "asr",
        id: "asr.en",
      },
      targetDurationSec: 5,
      maxDvrDurationSec: 43200,
    };
    const live = { ...playable(ID, [audioFormat(140), captions]), videoDetails: { videoId: ID, isLive: true } };
    const info = await new Ytdl({ fetch: fakeYouTube({ player: () => live }).fetch }).getInfo(ID);
    const track = info.formats.find((format) => format.itag === 386);

    expect(track).toMatchObject({
      captionTrack: { kind: "asr", languageCode: "en", displayName: "English (auto-generated)" },
      targetDurationSec: 5,
      maxDvrDurationSec: 43200,
      hasAudio: false,
      hasVideo: false,
    });
  });

  test("a format keeps YouTube's byte layout, loudness and quality fields with numbers parsed", async () => {
    const entry = audioFormat(251, {
      initRange: { start: "0", end: "258" },
      indexRange: { start: "259", end: "1022" },
      lastModified: "1729213425893470",
      averageBitrate: 129_000,
      loudnessDb: -3.25,
      trackAbsoluteLoudnessLkfs: -17.25,
      quality: "tiny",
      qualityOrdinal: "QUALITY_ORDINAL_UNKNOWN",
      audioQuality: "AUDIO_QUALITY_MEDIUM",
      audioSampleRate: "48000",
      audioTrack: { displayName: "German", id: "de.3", audioIsDefault: false },
      projectionType: "RECTANGULAR",
      highReplication: true,
      xtags: "CgcKAmxhEgFl",
    });
    const info = await new Ytdl({ fetch: fakeYouTube({ player: () => playable(ID, [entry]) }).fetch }).getInfo(ID);

    expect(info.formats[0]).toMatchObject({
      initRange: { start: 0, end: 258 },
      indexRange: { start: 259, end: 1022 },
      lastModified: 1_729_213_425_893_470,
      averageBitrate: 129_000,
      loudnessDb: -3.25,
      trackAbsoluteLoudnessLkfs: -17.25,
      quality: "tiny",
      qualityOrdinal: "QUALITY_ORDINAL_UNKNOWN",
      audioQuality: "AUDIO_QUALITY_MEDIUM",
      audioSampleRate: 48_000,
      audioTrack: { displayName: "German", id: "de.3", audioIsDefault: false },
      projectionType: "RECTANGULAR",
      highReplication: true,
      xtags: "CgcKAmxhEgFl",
    });
    expect(info.formats[0]).not.toHaveProperty("signatureCipher");
  });

  test("a field YouTube omits is absent from the format", async () => {
    const info = await new Ytdl({ fetch: fakeYouTube({ player: () => playable(ID) }).fetch }).getInfo(ID);
    for (const field of ["colorInfo", "captionTrack", "width", "fps", "audioTrack"]) {
      expect(info.formats[0]).not.toHaveProperty(field);
    }
  });

  test("playableAt waits out a preroll sent as an ad placement or as a sequential ad slot", async () => {
    const placement = {
      adPlacements: [
        {
          adPlacementRenderer: { config: { adPlacementConfig: { kind: "AD_PLACEMENT_KIND_START" } }, renderer: ad(6) },
        },
        { adPlacementRenderer: { config: { adPlacementConfig: { kind: "AD_PLACEMENT_KIND_END" } }, renderer: ad(30) } },
      ],
    };
    const slots = {
      adSlots: [
        {
          adSlotRenderer: {
            adSlotMetadata: { triggerEvent: "SLOT_TRIGGER_EVENT_BEFORE_CONTENT" },
            fulfillmentContent: {
              fulfilledLayout: {
                playerBytesAdLayoutRenderer: {
                  renderingContent: {
                    playerBytesSequentialLayoutRenderer: {
                      sequentialLayouts: [
                        { playerBytesAdLayoutRenderer: { renderingContent: ad(4) } },
                        { playerBytesAdLayoutRenderer: { renderingContent: ad(5) } },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      ],
    };
    for (const [extra, waitMs] of [
      [placement, 6000],
      [slots, 9000],
    ] as const) {
      const yt = fakeYouTube({ player: () => playable(ID, [audioFormat(251)], extra) });
      const before = Date.now();
      const info = await new Ytdl({ fetch: yt.fetch }).getInfo(ID);
      expect(info.playableAt).toBeGreaterThanOrEqual(before + waitMs);
      expect(info.playableAt).toBeLessThanOrEqual(Date.now() + waitMs);
    }
  });

  test("live videos list their HLS variants and DASH formats", async () => {
    const manifest = "https://manifest.googlevideo.com/api/manifest/hls_variant/id/live";
    const variant = "https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/95/index.m3u8";
    const yt = fakeYouTube({
      player: () => ({
        ...playable(ID, [audioFormat(251)]),
        videoDetails: { videoId: ID, isLive: true },
        streamingData: { adaptiveFormats: [audioFormat(251)], hlsManifestUrl: manifest },
      }),
      routes: {
        [manifest]: () =>
          new Response(
            `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=30\n${variant}\n`,
          ),
      },
    });
    const info = await new Ytdl({ fetch: yt.fetch }).getInfo(ID);
    expect(info.hlsManifestUrl).toBe(manifest);
    expect(info.formats).toHaveLength(2);
    expect(info.formats[1]).toMatchObject({ itag: 251, isHLS: false, isLive: true, hasAudio: true });
    expect(info.formats[0]).toMatchObject({
      itag: 95,
      url: variant,
      isHLS: true,
      isLive: true,
      hasAudio: true,
      hasVideo: true,
      qualityLabel: "720p",
    });
  });

  test("a live master's audio renditions are listed audio-only and the variants that use them report no audio", async () => {
    const yt = liveWithAudioRenditions();

    const info = await new Ytdl({ fetch: yt.fetch }).getInfo(ID);

    expect(info.formats.map(({ itag, hasAudio, hasVideo }) => ({ itag, hasAudio, hasVideo }))).toEqual([
      { itag: 233, hasAudio: true, hasVideo: false },
      { itag: 234, hasAudio: true, hasVideo: false },
      { itag: 269, hasAudio: false, hasVideo: true },
      { itag: 311, hasAudio: false, hasVideo: true },
    ]);
    expect(info.formats[0]).toMatchObject({
      url: hlsPlaylist(233),
      audioCodec: "mp4a.40.5",
      isHLS: true,
      isLive: true,
    });
    expect(info.formats[1]).toMatchObject({
      url: hlsPlaylist(234),
      audioCodec: "mp4a.40.2",
      isHLS: true,
      isLive: true,
    });
  });

  test("quality keywords rank a live master's audio renditions by bitrate, not list order", async () => {
    const info = await new Ytdl({ fetch: liveWithAudioRenditions().fetch }).getInfo(ID);

    expect(chooseFormat(info.formats, { quality: Quality.HighestAudio }).itag).toBe(234);
    expect(chooseFormat(info.formats, { quality: Quality.LowestAudio }).itag).toBe(233);
  });

  describe("a live video whose HLS master answers 500", () => {
    const manifest = "https://manifest.googlevideo.com/api/manifest/hls_variant/id/live";
    const live = (adaptiveFormats: readonly Record<string, unknown>[]) =>
      fakeYouTube({
        player: () => ({
          ...playable(ID, adaptiveFormats),
          videoDetails: { videoId: ID, isLive: true },
          streamingData: { adaptiveFormats, hlsManifestUrl: manifest },
        }),
        routes: { [manifest]: () => new Response("unavailable", { status: 500 }) },
      });

    test("keeps its DASH formats", async () => {
      const info = await new Ytdl({ fetch: live([audioFormat(251)]).fetch }).getInfo(ID);
      expect(info.formats).toEqual([expect.objectContaining({ itag: 251, isHLS: false, isLive: true })]);
    });

    test("rejects REQUEST_FAILED without DASH formats", async () => {
      const error = await new Ytdl({ fetch: live([]).fetch }).getInfo(ID).catch((caught: unknown) => caught);
      expect(YtdlError.is(error, "REQUEST_FAILED")).toBe(true);
    });
  });

  test("a download reuses unexpired info without another lookup", async () => {
    const media = "https://rr1---sn-test.googlevideo.com/videoplayback?itag=251&expire=4102444800";
    const yt = fakeYouTube({
      player: () => playable(ID, [audioFormat(251, { contentLength: "3" })]),
      routes: { [media]: () => new Response(new Uint8Array([1, 2, 3])) },
    });
    const ytdl = new Ytdl({ fetch: yt.fetch });
    const info = await ytdl.getInfo(ID);
    const before = yt.playerCalls.length;
    const chunks: Uint8Array[] = [];
    for await (const chunk of ytdl.download(info)) chunks.push(chunk as Uint8Array);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect(yt.playerCalls.length).toBe(before);
  });
});

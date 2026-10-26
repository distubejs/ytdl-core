import { describe, expect, test } from "bun:test";
import { parseFormats } from "../src/formats.ts";
import { chooseFormat, Quality, YtdlError } from "../src/index.ts";
import type { ChooseFormatOptions, FormatCriteria, VideoFormat } from "../src/index.ts";
import { fixture } from "./fake-youtube.ts";

// The adaptive formats of a recorded VISIONOS answer, plus one muxed format. Assertions hold for any
// recording, so YouTube changing its itags or format list only means a new fixture.
const recorded = parseFormats(fixture("player-visionos.json"), "visionos").map((format) => ({
  ...format.metadata,
  url: format.url ?? "",
}));
const muxed: VideoFormat = {
  ...recorded[0]!,
  itag: 18,
  container: "mp4",
  mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
  codecs: "avc1.42001E, mp4a.40.2",
  videoCodec: "avc1.42001E",
  audioCodec: "mp4a.40.2",
  qualityLabel: "360p",
  height: 360,
  bitrate: 500_000,
  audioBitrate: 96,
  hasAudio: true,
  hasVideo: true,
};
const audio = (itag: number, container: string, audioCodec: string, audioBitrate: number): VideoFormat => ({
  ...muxed,
  itag,
  container,
  mimeType: `audio/${container}; codecs="${audioCodec}"`,
  codecs: audioCodec,
  videoCodec: undefined,
  audioCodec,
  qualityLabel: undefined,
  width: undefined,
  height: undefined,
  audioBitrate,
  hasVideo: false,
});
const formats: readonly VideoFormat[] = [...recorded, muxed];
const audioOnly = formats.filter((format) => format.hasAudio && !format.hasVideo);
const video = formats.filter((format) => format.hasVideo);
const videoOnly = video.filter((format) => !format.hasAudio);
const most = (list: readonly VideoFormat[], value: (format: VideoFormat) => number) => Math.max(...list.map(value));

function errorCode(options: ChooseFormatOptions, list: readonly VideoFormat[] = formats): string | undefined {
  try {
    chooseFormat(list, options);
  } catch (error) {
    return YtdlError.is(error) ? error.code : String(error);
  }
  return undefined;
}

describe("format metadata", () => {
  test("reads container, codecs and media kind from the mime type", () => {
    expect(audioOnly.length).toBeGreaterThan(0);
    expect(videoOnly.length).toBeGreaterThan(0);
    for (const format of recorded) {
      expect(format.container).toBe(/^\w+\/(\w+)/u.exec(format.mimeType)?.[1] ?? "");
      expect(format.hasAudio).toBe(format.audioCodec !== undefined);
      expect(format.hasVideo).toBe(format.videoCodec !== undefined);
      for (const codec of [format.audioCodec, format.videoCodec]) if (codec) expect(format.codecs).toContain(codec);
      if (format.hasAudio) expect(format.audioBitrate).toBeGreaterThan(0);
      if (format.hasVideo) expect(format.qualityLabel).toStartWith(`${format.height}p`);
    }
  });
});

describe("chooseFormat", () => {
  test("highest audio with audioonly takes the best audio-only original", () => {
    const chosen = chooseFormat(formats, { quality: "highestaudio", filter: { hasAudio: true, hasVideo: false } });
    expect(audioOnly).toContain(chosen);
    expect(chosen.isDrc).toBe(false);
    expect(chosen.audioBitrate).toBe(most(audioOnly, (format) => format.audioBitrate ?? 0));
  });

  test("highest audio prefers less video among equal audio", () => {
    const best = chooseFormat(formats, { quality: "highestaudio", filter: { hasAudio: true, hasVideo: false } });
    const tied = {
      ...muxed,
      audioBitrate: best.audioBitrate,
      audioCodec: best.audioCodec,
      codecs: `${muxed.videoCodec}, ${best.audioCodec}`,
    };
    expect(chooseFormat([tied, ...formats], { quality: "highestaudio" })).toBe(best);
  });

  test("highest is the muxed format", () => {
    expect(chooseFormat(formats)).toBe(muxed);
  });

  test("highest video takes the tallest, then the highest bitrate; lowest takes the shortest", () => {
    const highest = chooseFormat(formats, { quality: "highestvideo" });
    const tallest = most(video, (format) => format.height ?? 0);
    expect(highest.height).toBe(tallest);
    expect(highest.bitrate).toBe(
      most(
        video.filter((format) => format.height === tallest),
        (format) => format.bitrate ?? 0,
      ),
    );
    const lowest = chooseFormat(formats, { quality: "lowestvideo", filter: { hasAudio: false, hasVideo: true } });
    expect(lowest.height).toBe(Math.min(...videoOnly.map((format) => format.height ?? 0)));
  });

  test.each(["lowest", "lowestaudio"] as const)("%s never takes an unknown bitrate over a known one", (quality) => {
    const known = audio(901, "mp4", "mp4a.40.2", 48);
    const unknown = { ...audio(902, "mp4", "mp4a.40.2", 0), audioBitrate: undefined };
    const options = { quality, filter: { hasAudio: true, hasVideo: false } };
    expect(chooseFormat([known, unknown], options)).toBe(known);
    expect(chooseFormat([unknown, known], options)).toBe(known);
    expect(chooseFormat([unknown], options)).toBe(unknown);
  });

  test("lowestvideo never takes an unknown bitrate over a known one", () => {
    const known = { ...muxed, itag: 903, hasAudio: false, bitrate: 300_000 };
    const unknown = { ...known, itag: 904, bitrate: undefined };
    expect(chooseFormat([known, unknown], { quality: "lowestvideo" })).toBe(known);
    expect(chooseFormat([unknown, known], { quality: "lowestvideo" })).toBe(known);
  });

  test("lowest picks a video format of known bitrate over audio renditions of unknown bitrate", () => {
    const rendition = { ...audio(905, "mp4", "mp4a.40.2", 0), audioBitrate: undefined };
    const variant = { ...muxed, itag: 906, hasAudio: false, audioBitrate: undefined, bitrate: 300_000 };
    const larger = { ...variant, itag: 907, height: 720, bitrate: 2_000_000 };
    for (const list of [
      [rendition, variant, larger],
      [larger, variant, rendition],
    ]) {
      expect(chooseFormat(list, { quality: "lowest" }).itag).toBe(906);
    }
  });

  test("an itag list falls through to the first available", () => {
    const [missing, present] = [...new Set(audioOnly.map((format) => format.itag))];
    const without = formats.filter((format) => format.itag !== missing);
    expect(chooseFormat(without, { quality: [missing!, present!] }).itag).toBe(present!);
  });

  test("an explicit format wins over quality and filter", () => {
    const wanted = audioOnly[0]!;
    expect(
      chooseFormat(formats, { format: wanted, quality: "highestvideo", filter: { hasAudio: false, hasVideo: true } }),
    ).toBe(wanted);
  });

  test("nothing matching throws NO_FORMAT", () => {
    const unknown = most(formats, (format) => format.itag) + 1;
    expect(errorCode({ quality: unknown })).toBe("NO_FORMAT");
  });

  test.each<[string, unknown]>([
    ["an unknown name", "best"],
    ["a bigint", 1n],
  ])("a quality that is %s throws INVALID_ARGUMENT", (_, quality) => {
    expect(errorCode({ quality: quality as Quality })).toBe("INVALID_ARGUMENT");
  });
});

describe("unplayable formats", () => {
  test("a DRM format is never chosen, even when passed as the format", () => {
    const plain = audio(140, "mp4", "mp4a.40.2", 128);
    const drm: VideoFormat = { ...audio(141, "mp4", "mp4a.40.2", 256), isDrm: true };
    const otf: VideoFormat = { ...audio(142, "mp4", "mp4a.40.2", 192), isOtf: true };

    expect(chooseFormat([drm, otf, plain], { quality: Quality.HighestAudio }).itag).toBe(140);
    expect(errorCode({ format: drm }, [drm, otf, plain])).toBe("NO_FORMAT");
    expect(errorCode({ format: otf }, [drm, otf, plain])).toBe("NO_FORMAT");
  });
});

describe("stable-volume variants", () => {
  // YouTube lists a DRC copy under the same itag, with its own size.
  const originalOf = (copy: VideoFormat) =>
    audioOnly.find(
      (format) => format.itag === copy.itag && !format.isDrc && format.contentLength !== copy.contentLength,
    );
  const drc = audioOnly.find((format) => format.isDrc && originalOf(format))!;
  const original = originalOf(drc)!;
  const withDrc = [drc, ...formats.filter((format) => format !== drc)];

  test("the recording lists a DRC copy with its own size", () => {
    expect(drc).toBeDefined();
  });

  test("an itag picks the original", () => {
    expect(chooseFormat(withDrc, { quality: drc.itag })).toBe(original);
  });

  test("an itag only a DRC copy carries picks the copy", () => {
    const onlyDrc = withDrc.filter((format) => format !== original);
    expect(chooseFormat(onlyDrc, { quality: drc.itag })).toBe(drc);
  });

  test("an explicit DRC format resolves to the DRC entry of a fresh list", () => {
    const fresh = withDrc.map((format) => ({ ...format, url: `${format.url}&fresh=1` }));
    const chosen = chooseFormat(fresh, { format: drc });
    expect(chosen.isDrc).toBe(true);
    expect(chosen.contentLength).toBe(drc.contentLength);
    expect(chosen.url).toEndWith("&fresh=1");
  });
});

// `xtags` as plN7JMbadRg's player answer sends them: base64url protobuf of acont and lang pairs.
const XTAGS = {
  originalEn: "ChEKBWFjb250EghvcmlnaW5hbAoKCgRsYW5nEgJlbg",
  dubbedDe: "Cg8KBWFjb250EgZkdWJiZWQKCgoEbGFuZxICZGU",
  dubbedFr: "Cg8KBWFjb250EgZkdWJiZWQKCgoEbGFuZxICZnI",
};

const track = (id: string, xtags: string, audioIsDefault: boolean): VideoFormat => ({
  ...audio(251, "webm", "opus", 130),
  audioTrack: { id, displayName: id, audioIsDefault },
  xtags,
});

describe("dubbed audio tracks", () => {
  const dub = track("de.3", XTAGS.dubbedDe, true);
  const original = track("en.4", XTAGS.originalEn, false);
  const otherDub = track("fr.3", XTAGS.dubbedFr, false);

  test.each([
    ["the dub first", [dub, otherDub, original]],
    ["the original last, the dub marked default", [otherDub, dub, original]],
  ])("highest audio picks the original with %s", (_, list) => {
    expect(chooseFormat(list, { quality: "highestaudio" })).toBe(original);
    expect(chooseFormat(list, { quality: 251 })).toBe(original);
  });

  test("a dub is picked when the list has no original", () => {
    expect(chooseFormat([dub, otherDub], { quality: "highestaudio" })).toBe(dub);
  });

  test.each([
    ["itag 251 beside an original itag 140", [audio(140, "mp4", "mp4a.40.2", 128)], 251],
    ["highest audio", [], Quality.HighestAudio],
  ] as const)("%s picks the original-language DRC copy over a dub", (_, others, quality) => {
    const originalDrc = { ...original, isDrc: true };
    expect(chooseFormat([dub, originalDrc, ...others], { quality })).toBe(originalDrc);
  });

  test("an itag only a dub carries picks the dub", () => {
    expect(chooseFormat([audio(140, "mp4", "mp4a.40.2", 128), dub], { quality: 251 })).toBe(dub);
  });

  test("an explicit dub format resolves to its own entry", () => {
    expect(chooseFormat([original, dub], { format: dub })).toBe(dub);
  });
});

describe("filters", () => {
  const opus = audio(251, "webm", "opus", 130);
  const aac = audio(140, "mp4", "mp4a.40.2", 160);

  test.each([
    [{ hasAudio: true, hasVideo: true }, undefined],
    [{ hasVideo: true }, undefined],
    [{ hasAudio: false, hasVideo: true }, "NO_FORMAT"],
    [{ hasAudio: true }, undefined],
    [{ hasAudio: true, hasVideo: false }, "NO_FORMAT"],
  ])("%o keeps only formats with its media kinds", (filter, onlyMuxed) => {
    for (const quality of [Quality.Highest, Quality.Lowest]) {
      expect(chooseFormat(formats, { filter, quality })).toMatchObject(filter);
    }
    expect(errorCode({ filter }, [muxed])).toBe(onlyMuxed);
  });

  test("criteria pick Opus audio-only over better AAC and muxed audio", () => {
    const filter = { hasVideo: false, audioCodec: "opus" };
    expect(chooseFormat([aac, opus, muxed], { filter, quality: Quality.HighestAudio })).toBe(opus);
  });

  test("a codec criterion matches its family before the first dot", () => {
    expect(chooseFormat([opus, aac], { filter: { audioCodec: "mp4a" } })).toBe(aac);
    expect(chooseFormat([opus, aac], { filter: { audioCodec: "mp4a.40.2" } })).toBe(aac);
    expect(errorCode({ filter: { audioCodec: "mp4" } }, [opus, aac])).toBe("NO_FORMAT");
  });

  test("a list picks with its first entry that yields a format", () => {
    const opusFirst = [{ hasVideo: false, audioCodec: "opus" }, { hasVideo: false }, { hasAudio: true }];
    const quality = Quality.HighestAudio;
    expect(chooseFormat([aac, opus, muxed], { filter: opusFirst, quality })).toBe(opus);
    expect(chooseFormat([aac, muxed], { filter: opusFirst, quality })).toBe(aac);
    expect(chooseFormat([muxed], { filter: opusFirst, quality })).toBe(muxed);
  });

  test("a list where no entry matches throws NO_FORMAT", () => {
    expect(errorCode({ filter: [{ hasAudio: true, hasVideo: false }, (format) => !format.hasVideo] }, [muxed])).toBe(
      "NO_FORMAT",
    );
  });

  test.each([
    ["an unknown criterion", { bitrate: 128 }],
    ["a criterion of the wrong type", { hasVideo: "no" }],
    ["a 4.x filter string", "audioonly"],
    ["an empty list", []],
    ["a bigint", 1n],
  ])("%s throws INVALID_ARGUMENT", (_, filter) => {
    expect(errorCode({ filter: filter as FormatCriteria })).toBe("INVALID_ARGUMENT");
  });
});

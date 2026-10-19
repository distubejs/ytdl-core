import { describe, expect, test } from "bun:test";
import { filterFormats, parseFormats } from "../src/formats.ts";
import { chooseFormat, YtdlError } from "../src/index.ts";
import type { VideoFormat } from "../src/index.ts";
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
const formats: readonly VideoFormat[] = [...recorded, muxed];
const audioOnly = formats.filter((format) => format.hasAudio && !format.hasVideo);
const video = formats.filter((format) => format.hasVideo);
const videoOnly = video.filter((format) => !format.hasAudio);
const most = (list: readonly VideoFormat[], value: (format: VideoFormat) => number) => Math.max(...list.map(value));

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
    const chosen = chooseFormat(formats, { quality: "highestaudio", filter: "audioonly" });
    expect(audioOnly).toContain(chosen);
    expect(chosen.isDrc).toBe(false);
    expect(chosen.audioBitrate).toBe(most(audioOnly, (format) => format.audioBitrate ?? 0));
  });

  test("highest audio prefers less video among equal audio", () => {
    const best = chooseFormat(formats, { quality: "highestaudio", filter: "audioonly" });
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
    const lowest = chooseFormat(formats, { quality: "lowestvideo", filter: "videoonly" });
    expect(lowest.height).toBe(Math.min(...videoOnly.map((format) => format.height ?? 0)));
  });

  test("an itag list falls through to the first available", () => {
    const [missing, present] = [...new Set(audioOnly.map((format) => format.itag))];
    const without = formats.filter((format) => format.itag !== missing);
    expect(chooseFormat(without, { quality: [missing!, present!] }).itag).toBe(present!);
  });

  test("an explicit format wins over quality and filter", () => {
    const wanted = audioOnly[0]!;
    expect(chooseFormat(formats, { format: wanted, quality: "highestvideo", filter: "videoonly" })).toBe(wanted);
  });

  test("nothing matching throws NO_FORMAT", () => {
    const unknown = most(formats, (format) => format.itag) + 1;
    const error = (() => {
      try {
        chooseFormat(formats, { quality: unknown });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(YtdlError.is(error, "NO_FORMAT")).toBe(true);
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

  test("an explicit DRC format resolves to the DRC entry of a fresh list", () => {
    const fresh = withDrc.map((format) => ({ ...format, url: `${format.url}&fresh=1` }));
    const chosen = chooseFormat(fresh, { format: drc });
    expect(chosen.isDrc).toBe(true);
    expect(chosen.contentLength).toBe(drc.contentLength);
    expect(chosen.url).toEndWith("&fresh=1");
  });
});

describe("filterFormats", () => {
  test("keeps matching formats in their original order", () => {
    expect(filterFormats(formats, "audio")).toEqual(formats.filter((format) => format.hasAudio));
    expect(filterFormats(formats, "audioandvideo")).toEqual([muxed]);
    expect(filterFormats(formats, "videoonly")).toEqual(videoOnly);
  });
});

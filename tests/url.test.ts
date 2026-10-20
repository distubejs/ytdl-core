import { describe, expect, test } from "bun:test";
import { YtdlError } from "../src/errors.ts";
import { getVideoTarget, parsePlaylistId, parseVideoId } from "../src/url.ts";

describe("parseVideoId", () => {
  test.each([
    ["abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/watch?v=abcdefghijk&t=30s", "abcdefghijk"],
    ["https://youtu.be/abcdefghijk?si=x", "abcdefghijk"],
    ["https://www.youtube.com/shorts/abcdefghijk?feature=share", "abcdefghijk"],
    ["https://www.youtube.com/embed/abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/live/abcdefghijk?feature=shared", "abcdefghijk"],
    ["https://www.youtube.com/v/abcdefghijk", "abcdefghijk"],
    ["https://m.youtube.com/watch?v=abcdefghijk", "abcdefghijk"],
    ["https://music.youtube.com/watch?v=abcdefghijk&list=RDAMVM", "abcdefghijk"],
    ["https://www.youtube-nocookie.com/embed/abcdefghijk", "abcdefghijk"],
    ["youtube.com/watch?v=abc-defg_ij", "abc-defg_ij"],
  ])("%s", (input, expected) => {
    expect(parseVideoId(input)).toBe(expected);
  });

  test.each([
    "https://example.com/watch?v=abcdefghijk",
    "https://www.youtube.com/playlist?list=PL1234567890",
    "https://www.youtube.com/watch?v=short",
    "https://youtu.be/",
    "abcdefghij",
    "ftp://youtube.com/watch?v=abcdefghijk",
    "not a url",
  ])("rejects %s", (input) => {
    expect(parseVideoId(input)).toBeUndefined();
  });
});

describe("getVideoTarget", () => {
  test.each([
    ["https://www.youtube.com/@NASA/live", "https://www.youtube.com/@NASA/live"],
    ["youtube.com/@NASA/live/", "https://www.youtube.com/@NASA/live"],
    [
      "https://m.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/live",
      "https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/live",
    ],
    ["https://www.youtube.com/c/NASA/live?si=x", "https://www.youtube.com/c/NASA/live"],
    ["https://www.youtube.com/user/NASAtelevision/live", "https://www.youtube.com/user/NASAtelevision/live"],
  ])("%s is a channel live URL", (input, channelLive) => {
    expect(getVideoTarget(input)).toEqual({ channelLive });
  });

  test("a video URL keeps its ID and needs no lookup", () => {
    expect(getVideoTarget("https://www.youtube.com/live/abcdefghijk")).toEqual({ id: "abcdefghijk" });
    expect(parseVideoId("https://www.youtube.com/@NASA/live")).toBeUndefined();
  });

  test.each([
    "https://example.com/watch?v=abcdefghijk",
    "https://www.youtube.com/@NASA",
    "https://www.youtube.com/@NASA/videos",
    "https://youtu.be/@NASA/live",
    "https://example.com/@NASA/live",
  ])("rejects %s with INVALID_URL", (input) => {
    let caught: unknown;
    try {
      getVideoTarget(input);
    } catch (error) {
      caught = error;
    }
    expect(YtdlError.is(caught, "INVALID_URL")).toBe(true);
  });
});

describe("parsePlaylistId", () => {
  test.each([
    ["https://www.youtube.com/playlist?list=PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5", "PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5"],
    ["https://www.youtube.com/watch?v=abcdefghijk&list=PL6B3937A5D230E335", "PL6B3937A5D230E335"],
    ["PL6B3937A5D230E335", "PL6B3937A5D230E335"],
  ])("%s", (input, expected) => {
    expect(parsePlaylistId(input)).toBe(expected);
  });

  test.each([
    "https://www.youtube.com/watch?v=abcdefghijk&list=WL",
    "abcdefghijk",
    "https://example.com/playlist?list=PL6B3937A5D230E335",
  ])("returns undefined for %s", (input) => {
    expect(parsePlaylistId(input)).toBeUndefined();
  });
});

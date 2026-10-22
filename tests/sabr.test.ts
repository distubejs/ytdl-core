import { describe, expect, test } from "bun:test";
import { Ytdl, YtdlError } from "../src/index.ts";
import type { DownloadOptions, PoTokenRequest, ProgressEvent, RetryEvent, VideoInfo } from "../src/index.ts";
import { audioFormat, fakeYouTube, type FakeOptions, playable, VISIONOS, WEB_EMBEDDED } from "./fake-youtube.ts";
import { type SabrFormatSpec, sabrPlayable, sabrServer, type SabrServerOptions } from "./fake-sabr.ts";

const ID = "aqz-KE-bpKQ";
const PLAYER_ID = "aaaa0001";
const OPUS = 'audio/webm; codecs="opus"';
const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, index) => (index * seed + 3) % 256);
const AUDIO: SabrFormatSpec = { itag: 251, mimeType: OPUS, bytes: bytes(50_000, 7) };
const SMALL_AUDIO: SabrFormatSpec = { itag: 249, mimeType: OPUS, bytes: bytes(5_000, 11), bitrate: 50_000 };
const VIDEO: SabrFormatSpec = {
  itag: 136,
  mimeType: 'video/mp4; codecs="avc1.4d401f"',
  bytes: bytes(60_000, 13),
  segments: 5,
};
const FORMATS = [AUDIO, SMALL_AUDIO, VIDEO];

interface Setup extends Omit<SabrServerOptions, "formats" | "failOn"> {
  readonly formats?: readonly SabrFormatSpec[];
  readonly player?: FakeOptions["player"];
  readonly media?: FakeOptions["media"];
  /** Fails every POST from this 0-based index until the download resolves the video again. */
  readonly failFrom?: number;
  readonly getPoToken?: (request: PoTokenRequest) => Promise<string>;
}

function setup({ formats = FORMATS, player, media, failFrom, getPoToken, ...server }: Setup = {}) {
  const yt = fakeYouTube({ player: player ?? (() => sabrPlayable(ID, formats)), media });
  const failOn = failFrom === undefined ? undefined : (index: number) => index >= failFrom && yt.clients().length === 1;
  const sabr = sabrServer({ formats, failOn, ...server });
  return { yt, sabr, ytdl: new Ytdl({ fetch: sabr.fetch(yt.fetch), getPoToken, playerId: PLAYER_ID }) };
}

function recorder() {
  const progress: ProgressEvent[] = [];
  const retries: RetryEvent[] = [];
  return {
    progress,
    retries,
    onProgress: (event: ProgressEvent) => progress.push(event),
    onRetry: (event: RetryEvent) => retries.push(event),
  };
}

async function download(ytdl: Ytdl, options: DownloadOptions, video: string | VideoInfo = ID) {
  const seen = recorder();
  const body = Buffer.concat(await ytdl.download(video, { ...options, ...seen }).toArray());
  return { body, progress: seen.progress, retries: seen.retries };
}

function downloadError(ytdl: Ytdl, options: DownloadOptions): Promise<unknown> {
  return ytdl
    .download(ID, options)
    .toArray()
    .then(
      () => undefined,
      (caught: unknown) => caught,
    );
}

/** An init segment of 1,000 bytes, then 1,000 bytes per 10 seconds. */
const tenSecondSegments = (count: number): SabrFormatSpec => ({
  itag: 251,
  mimeType: OPUS,
  bytes: bytes((count + 1) * 1_000, 23),
  segments: count,
  durationMs: count * 10_000,
});

async function rangeInFirstSegment(laterPost: (init: RequestInit | undefined) => Promise<Response>) {
  const track = tenSecondSegments(20);
  const yt = fakeYouTube({ player: () => sabrPlayable(ID, [track]) });
  const served = sabrServer({ formats: [track] }).fetch(yt.fetch);
  let posts = 0;
  const spy = ((input: string | URL | Request, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : input).searchParams.has("sabr") && ++posts > 1) {
      return laterPost(init);
    }
    return served(input, init);
  }) as typeof globalThis.fetch;
  const ytdl = new Ytdl({ fetch: spy, playerId: PLAYER_ID });
  const { body } = await download(ytdl, { quality: 251, range: { start: 0, end: 1_500 } });
  expect(body).toEqual(Buffer.from(track.bytes.subarray(0, 1_501)));
}

describe("SABR delivery", () => {
  test("SABR-only formats are listed without a URL", async () => {
    const info = await setup().ytdl.getInfo(ID);

    expect(info.formats.map((format) => [format.itag, format.url])).toEqual([
      [251, undefined],
      [249, undefined],
      [136, undefined],
    ]);
  });

  test("an audio format streams its exact bytes with a progress total", async () => {
    const { body, progress } = await download(setup().ytdl, { quality: 251 });

    expect(body).toEqual(Buffer.from(AUDIO.bytes));
    expect(progress.at(-1)).toMatchObject({ downloaded: AUDIO.bytes.length, total: AUDIO.bytes.length });
  });

  test("a video format streams its exact bytes next to the smallest audio", async () => {
    const { sabr, ytdl } = setup();
    const { body } = await download(ytdl, { quality: 136 });

    expect(body).toEqual(Buffer.from(VIDEO.bytes));
    expect(sabr.requests[0]?.itags.toSorted()).toEqual([136, 249]);
  });

  test("a DRC variant or dubbed track sharing the itag streams its own bytes", async () => {
    const drc: SabrFormatSpec = { ...AUDIO, bytes: bytes(40_000, 17), isDrc: true };
    const dubbed: SabrFormatSpec = { ...AUDIO, bytes: bytes(30_000, 19), audioTrackId: "de.3" };
    const { ytdl } = setup({ formats: [AUDIO, drc, dubbed] });
    const info = await ytdl.getInfo(ID);

    for (const [variant, pick] of [
      [drc, info.formats.find((format) => format.isDrc)],
      [dubbed, info.formats.find((format) => format.audioTrack?.id === "de.3")],
    ] as const) {
      const { body } = await download(ytdl, { format: pick }, info);
      expect(body).toEqual(Buffer.from(variant.bytes));
    }
  });

  test("a cloned info streams a SABR format on another instance without a lookup", async () => {
    const info = structuredClone(await setup().ytdl.getInfo(ID));
    const other = setup();
    const { body } = await download(other.ytdl, { quality: 251 }, info);

    expect(body).toEqual(Buffer.from(AUDIO.bytes));
    expect(other.yt.playerCalls).toEqual([]);
  });

  test("a spread info keeps its SABR session", async () => {
    const { yt, ytdl } = setup();
    const info = await ytdl.getInfo(ID);
    const lookups = yt.playerCalls.length;
    const { body } = await download(ytdl, { quality: 251 }, { ...info });

    expect(body).toEqual(Buffer.from(AUDIO.bytes));
    expect(yt.playerCalls).toHaveLength(lookups);
  });

  test("opening a format the info does not list throws NO_FORMAT", async () => {
    const { ytdl } = setup();
    const info = await ytdl.getInfo(ID);
    const foreign = { ...info.formats[0]!, itag: 18 };

    expect(() => ytdl.open(info, foreign)).toThrow(expect.objectContaining({ code: "NO_FORMAT" }));
  });

  test("opening a DRM format throws NO_FORMAT", async () => {
    const { ytdl } = setup();
    const info = await ytdl.getInfo(ID);
    const drm = { ...info.formats[0]!, isDrm: true };

    expect(() => ytdl.open({ ...info, formats: [drm] }, drm)).toThrow(expect.objectContaining({ code: "NO_FORMAT" }));
  });

  test("an opened format reads twice through one SABR session lookup", async () => {
    const { yt, ytdl } = setup();
    const info = await ytdl.getInfo(ID);
    const lookups = yt.playerCalls.length;
    const media = ytdl.open(info, info.formats[0]!);
    const head = Buffer.concat(await media.read({ range: { start: 0, end: 999 } }).toArray());
    const tail = Buffer.concat(await media.read({ range: { start: 40_000 } }).toArray());

    expect([head, tail]).toEqual([
      Buffer.from(AUDIO.bytes.subarray(0, 1000)),
      Buffer.from(AUDIO.bytes.subarray(40_000)),
    ]);
    expect(yt.playerCalls).toHaveLength(lookups);
  });

  test("a range yields exactly its bytes", async () => {
    const { body, progress } = await download(setup().ytdl, { quality: 251, range: { start: 12_345, end: 33_333 } });

    expect(body).toEqual(Buffer.from(AUDIO.bytes.subarray(12_345, 33_334)));
    expect(progress.at(-1)?.total).toBe(33_333 - 12_345 + 1);
  });

  test("a range ending on a segment's first byte yields that byte", async () => {
    const { body } = await download(setup().ytdl, { quality: 251, range: { start: 0, end: 20_000 } });

    expect(body).toEqual(Buffer.from(AUDIO.bytes.subarray(0, 20_001)));
  });

  test("a range starting mid-segment that fails partway skips the bytes it already emitted", async () => {
    const { body, retries } = await download(setup({ failFrom: 2 }).ytdl, { quality: 251, range: { start: 12_345 } });

    expect(body).toEqual(Buffer.from(AUDIO.bytes.subarray(12_345)));
    expect(retries).toEqual([{ attempt: 1, client: "visionos", reason: "SABR session failed" }]);
  });

  test("a session that fails partway resumes and still yields the exact bytes", async () => {
    const { ytdl } = setup({ failFrom: 1 });
    const { body, retries } = await download(ytdl, { quality: 251 });

    expect(body).toEqual(Buffer.from(AUDIO.bytes));
    expect(retries).toEqual([{ attempt: 1, client: "visionos", reason: "SABR session failed" }]);
  });

  test("a session that fails at the end of segment 7 of 9 resumes at segment 7's start time with the exact bytes", async () => {
    const track = tenSecondSegments(9);
    const { sabr, ytdl } = setup({ formats: [track], failFrom: 7 });
    const { body } = await download(ytdl, { quality: 251 });

    expect(body).toEqual(Buffer.from(track.bytes));
    expect(sabr.requests.map((request) => request.playerTimeMs).filter((time) => time < 70_000)).toEqual([
      0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 60_000,
    ]);
  });

  test("a failed session without byte offsets restarts at time 0 with the exact bytes", async () => {
    const track = tenSecondSegments(9);
    const { sabr, ytdl } = setup({ formats: [track], failFrom: 7, omitByteOffsets: () => true });
    const { body } = await download(ytdl, { quality: 251 });

    expect(body).toEqual(Buffer.from(track.bytes));
    expect(sabr.requests.filter((request) => request.playerTimeMs === 0)).toHaveLength(2);
  });

  test("a resumed session that rewinds to time 0 still yields the exact bytes", async () => {
    const track = tenSecondSegments(9);
    const { sabr, ytdl } = setup({ formats: [track], failFrom: 7, initOnlyOnLateStart: true });
    const { body, retries } = await download(ytdl, { quality: 251 });

    expect(body).toEqual(Buffer.from(track.bytes));
    expect(retries).toHaveLength(1);
    expect(sabr.requests.filter((request) => request.playerTimeMs === 0)).toHaveLength(2);
  });

  test("a replacement session past 0 without byte offsets fails and the next one restarts at time 0", async () => {
    const track = tenSecondSegments(9);
    const { sabr, ytdl } = setup({ formats: [track], failFrom: 3, omitByteOffsets: (index) => index >= 3 });
    const { body, retries } = await download(ytdl, { quality: 251 });
    const times = sabr.requests.map((request) => request.playerTimeMs);

    expect(body).toEqual(Buffer.from(track.bytes));
    expect(retries.map((retry) => retry.reason)).toEqual(["SABR session failed", "SABR session failed"]);
    expect(times.filter((time) => time === 0 || time === 20_000)).toEqual([0, 20_000, 20_000, 0, 20_000]);
  });

  test("a session that skips a segment resumes from the missing byte instead of leaving a gap", async () => {
    const { body, retries } = await download(setup({ skipSegmentOnce: 2 }).ytdl, { quality: 251 });

    expect(body).toEqual(Buffer.from(AUDIO.bytes));
    expect(retries.map((retry) => retry.reason)).toEqual(["SABR session failed"]);
  });

  test("a resume that answers with a direct URL finishes the bytes through ranged requests", async () => {
    let answers = 0;
    const { ytdl } = setup({
      failFrom: 1,
      player: () =>
        answers++ === 0
          ? sabrPlayable(ID, FORMATS)
          : playable(ID, [audioFormat(251, { contentLength: String(AUDIO.bytes.length) })]),
      media: (url) => {
        const [start = 0, end = 0] = (url.searchParams.get("range") ?? "").split("-").map(Number);
        return new Response(AUDIO.bytes.slice(start, end + 1));
      },
    });
    const { body, retries } = await download(ytdl, { quality: 251, chunkSize: 7_000 });

    expect(body).toEqual(Buffer.from(AUDIO.bytes));
    expect(retries).toHaveLength(1);
  });

  test("a resume that offers another file under the same itag fails instead of stitching it", async () => {
    let answers = 0;
    const stream = setup({
      failFrom: 1,
      player: () =>
        answers++ === 0
          ? sabrPlayable(ID, FORMATS)
          : playable(ID, [audioFormat(251, { contentLength: String(AUDIO.bytes.length - 1) })]),
    }).ytdl.download(ID, { quality: 251 });
    const error = await stream.toArray().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "NO_FORMAT" });
  });

  test("sessions that keep ending short spend the resume budget and fail", async () => {
    const answer = sabrPlayable(ID, FORMATS) as { streamingData: { adaptiveFormats: Record<string, unknown>[] } };
    answer.streamingData.adaptiveFormats[0]!.contentLength = String(AUDIO.bytes.length + 1_000);
    const { retries, ...seen } = recorder();
    const stream = setup({ player: () => answer }).ytdl.download(ID, { quality: 251, ...seen });
    const error = await stream.toArray().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(YtdlError);
    expect(error).toMatchObject({ code: "REQUEST_FAILED" });
    expect(retries.map((retry) => retry.attempt)).toEqual([1, 2, 3]);
  });

  test("a VISIONOS session that keeps answering 403 moves to WEB_EMBEDDED on the second resume with the exact bytes", async () => {
    const yt = fakeYouTube({
      player: ({ client }) => {
        const answer = sabrPlayable(ID, FORMATS) as { streamingData: { serverAbrStreamingUrl: string } };
        if (client === VISIONOS) answer.streamingData.serverAbrStreamingUrl += "&c=visionos";
        return answer;
      },
    });
    const served = sabrServer({ formats: FORMATS }).fetch(yt.fetch);
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.searchParams.get("c") === "visionos") return Promise.resolve(new Response("", { status: 403 }));
      return served(input, init);
    }) as typeof globalThis.fetch;

    const { body, retries } = await download(new Ytdl({ fetch, playerId: PLAYER_ID }), { quality: 251 });

    expect(body).toEqual(Buffer.from(AUDIO.bytes));
    expect(retries).toEqual([
      { attempt: 1, client: "visionos", reason: "HTTP 403" },
      { attempt: 2, client: "visionos", reason: "HTTP 403" },
    ]);
    expect(yt.clients()).toEqual([VISIONOS, VISIONOS, WEB_EMBEDDED]);
  }, 15_000);

  test("an onProgress that throws ends the stream once with its error, without a retry or a gap", async () => {
    const listenerFailure = new Error("listener failed");
    const { retries, onRetry } = recorder();
    let calls = 0;
    const stream = setup().ytdl.download(ID, {
      quality: 251,
      onRetry,
      onProgress: () => {
        if (++calls === 2) throw listenerFailure;
      },
    });
    const chunks: Uint8Array[] = [];
    const errors: unknown[] = [];
    stream.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    stream.on("error", (error) => errors.push(error));
    await new Promise((resolve) => stream.once("close", resolve));
    const body = Buffer.concat(chunks);

    expect(errors).toEqual([listenerFailure]);
    expect(retries).toEqual([]);
    expect(body).toEqual(Buffer.from(AUDIO.bytes.subarray(0, body.length)));
  });

  test("a range that ends in the first media segment stops its SABR session", async () => {
    const stopped = Promise.withResolvers<void>();
    await rangeInFirstSegment(
      (init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              stopped.resolve();
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    await stopped.promise;
  });

  test("destroying the stream stops a session that waits on the server", async () => {
    const { sabr, ytdl } = setup({ requireAttestation: true });
    const stream = ytdl.download(ID, { quality: 251 });
    stream.on("error", () => {});
    stream.resume();
    while (sabr.requests.length < 2) await Bun.sleep(5);
    stream.destroy();
    const sent = sabr.requests.length;
    await Bun.sleep(200);

    expect(sabr.requests.length).toBe(sent);
  });

  test("attestation mints a token bound to the video ID", async () => {
    const calls: PoTokenRequest[] = [];
    const { sabr, ytdl } = setup({
      requireAttestation: true,
      getPoToken: async (request) => {
        calls.push(request);
        return "dG9rZW4";
      },
    });
    const { body } = await download(ytdl, { quality: 251 });

    expect(body).toEqual(Buffer.from(AUDIO.bytes));
    expect(calls).toEqual([expect.objectContaining({ contentBinding: ID, client: "visionos" })]);
    expect(sabr.requests.some((request) => request.poToken)).toBe(true);
  });

  test("a failed session after a failed mint reports the getPoToken error instead of resuming", async () => {
    const minter = new Error("minter down");
    const { retries, ...seen } = recorder();
    const stream = setup({ failFrom: 1, getPoToken: () => Promise.reject(minter) }).ytdl.download(ID, {
      quality: 251,
      ...seen,
    });
    const error = await stream.toArray().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "REQUEST_FAILED", cause: minter });
    expect(retries).toEqual([]);
  });

  test("a start time streams the init segment, then from the segment containing it to the end without a retry", async () => {
    const track = tenSecondSegments(6);
    const { sabr, ytdl } = setup({ formats: [track] });
    const { body, progress, retries } = await download(ytdl, { quality: 251, startTimeMs: 45_000 });

    expect(body).toEqual(Buffer.concat([track.bytes.subarray(0, 1_000), track.bytes.subarray(5_000, 7_000)]));
    expect(sabr.requests[0]?.playerTimeMs).toBe(45_000);
    expect(retries).toEqual([]);
    expect(progress.at(-1)).toEqual({ chunkBytes: expect.any(Number), downloaded: 3_000, total: undefined });
  });

  test("a time-started session that fails partway restarts at the time without gap or repeat", async () => {
    const track = tenSecondSegments(10);
    const { body, retries } = await download(setup({ formats: [track], failFrom: 1 }).ytdl, {
      quality: 251,
      startTimeMs: 45_000,
    });

    expect(body).toEqual(Buffer.concat([track.bytes.subarray(0, 1_000), track.bytes.subarray(5_000)]));
    expect(retries).toEqual([{ attempt: 1, client: "visionos", reason: "SABR session failed" }]);
  });

  test.each([
    [45_000, 5_000],
    [40_000, 5_000],
    [5_000, 1_000],
  ])(
    "a session started at %d ms that rewinds to time 0 yields the init segment, then the bytes from %d",
    async (startTimeMs, firstByte) => {
      const track = tenSecondSegments(6);
      const { sabr, ytdl } = setup({ formats: [track], initOnlyOnLateStart: true });
      const { body, retries } = await download(ytdl, { quality: 251, startTimeMs });

      expect(body).toEqual(Buffer.concat([track.bytes.subarray(0, 1_000), track.bytes.subarray(firstByte)]));
      expect(retries).toEqual([]);
      expect(sabr.requests.map((request) => request.playerTimeMs)).toContain(0);
    },
  );

  test.each([
    ["a negative start time", { startTimeMs: -1 }],
    ["an infinite start time", { startTimeMs: Infinity }],
    ["a start time with a range", { startTimeMs: 1_000, range: { start: 0 } }],
  ])("%s errors with INVALID_ARGUMENT before any SABR request", async (_, options) => {
    const { sabr, ytdl } = setup();

    expect(await downloadError(ytdl, { quality: 251, ...options })).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(sabr.requests).toEqual([]);
  });

  test("a direct format rejects a start time before any media request", async () => {
    const media: URL[] = [];
    const { ytdl } = setup({
      player: () => playable(ID, [audioFormat(251, { contentLength: "1000" })]),
      media: (url) => {
        media.push(url);
        return new Response(new Uint8Array(1_000));
      },
    });

    expect(await downloadError(ytdl, { quality: 251, startTimeMs: 1_000 })).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(media).toEqual([]);
  });

  test("a time-started session resumed onto a direct URL fails instead of reading bytes from the file start", async () => {
    const track = tenSecondSegments(10);
    let answers = 0;
    const media: URL[] = [];
    const { ytdl } = setup({
      formats: [track],
      failFrom: 1,
      player: () =>
        answers++ === 0
          ? sabrPlayable(ID, [track])
          : playable(ID, [audioFormat(251, { contentLength: String(track.bytes.length) })]),
      media: (url) => {
        media.push(url);
        return new Response(track.bytes.slice());
      },
    });

    const error = await downloadError(ytdl, { quality: 251, startTimeMs: 45_000 });

    expect(error).toMatchObject({ code: "NO_FORMAT" });
    expect((error as Error).cause).toMatchObject({
      code: "REQUEST_FAILED",
      message: expect.stringContaining("SABR session failed"),
    });
    expect(media).toEqual([]);
  });
});

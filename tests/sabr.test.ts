import { describe, expect, test } from "bun:test";
import { Ytdl, YtdlError } from "../src/index.ts";
import type { DownloadOptions, PoTokenRequest, ProgressEvent, RetryEvent, VideoInfo } from "../src/index.ts";
import { audioFormat, fakeYouTube, type FakeOptions, playable } from "./fake-youtube.ts";
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
  /** Fails every POST after the first until the download resolves the video again. */
  readonly failUntilResumed?: boolean;
  readonly getPoToken?: (request: PoTokenRequest) => Promise<string>;
}

function setup({ formats = FORMATS, player, media, failUntilResumed, getPoToken, ...server }: Setup = {}) {
  const yt = fakeYouTube({ player: player ?? (() => sabrPlayable(ID, formats)), media });
  const failOn = failUntilResumed ? (index: number) => index > 0 && yt.clients().length === 1 : undefined;
  const sabr = sabrServer({ formats, failOn, ...server });
  return { sabr, ytdl: new Ytdl({ fetch: sabr.fetch(yt.fetch), getPoToken, playerId: PLAYER_ID }) };
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

  test("a range yields exactly its bytes", async () => {
    const { body, progress } = await download(setup().ytdl, { quality: 251, range: { start: 12_345, end: 33_333 } });

    expect(body).toEqual(Buffer.from(AUDIO.bytes.subarray(12_345, 33_334)));
    expect(progress.at(-1)?.total).toBe(33_333 - 12_345 + 1);
  });

  test("a session that fails partway resumes and still yields the exact bytes", async () => {
    const { ytdl } = setup({ failUntilResumed: true });
    const { body, retries } = await download(ytdl, { quality: 251 });

    expect(body).toEqual(Buffer.from(AUDIO.bytes));
    expect(retries).toEqual([{ attempt: 1, client: "visionos", reason: "SABR session failed" }]);
  });

  test("a resume that answers with a direct URL finishes the bytes through ranged requests", async () => {
    let answers = 0;
    const { ytdl } = setup({
      failUntilResumed: true,
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
      failUntilResumed: true,
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

  test("attestation mints a token with an empty videoId and the info's visitor", async () => {
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
    expect(calls).toContainEqual(
      expect.objectContaining({ videoId: "", client: "visionos", visitorData: "VISITOR-1" }),
    );
    expect(sabr.requests.some((request) => request.poToken)).toBe(true);
  });

  test("a failed session after a failed mint reports the getPoToken error instead of resuming", async () => {
    const minter = new Error("minter down");
    const { retries, ...seen } = recorder();
    const stream = setup({ failUntilResumed: true, getPoToken: () => Promise.reject(minter) }).ytdl.download(ID, {
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
});

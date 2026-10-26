import { describe, expect, jest, test } from "bun:test";
import type { Readable } from "node:stream";
import { deliver, Media } from "../src/delivery/index.ts";
import { YtdlError } from "../src/errors.ts";
import type { Delivery, ReadOptions, ResumeRequest } from "../src/delivery/index.ts";
import type { ProgressEvent, RetryEvent } from "../src/delivery/index.ts";
import type { VideoFormat } from "../src/formats.ts";
import type { VideoInfo } from "../src/info.ts";
import { Client, Ytdl } from "../src/index.ts";
import {
  audioFormat,
  fakeYouTube,
  MEDIA_HOST,
  playable,
  REQUEST_BUDGET,
  TV,
  VISIONOS,
  visitorBody,
  WEB_EMBEDDED,
} from "./fake-youtube.ts";

const SOURCE = pseudoRandomBytes(5500);
const VIDEO_ID = "aqz-KE-bpKQ";

function pseudoRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = 7;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

interface MediaRequest {
  readonly url: URL;
  /** `gen` query parameter: 1 for the first URL, +1 per resume. */
  readonly generation: number;
  readonly start: number;
  readonly end: number;
  readonly signal: AbortSignal;
  readonly at: number;
}

type Handler = (request: MediaRequest) => Response | Promise<Response> | undefined;

/** Serves `content` honoring `range=start-end`; `handler` overrides single answers. */
const MEDIA_BUDGET = 200;

function mediaServer(content: Uint8Array, handler?: Handler, budget = MEDIA_BUDGET) {
  const requests: MediaRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (requests.length >= budget) throw new Error("fake request budget exceeded");
    const url = new URL(String(input));
    const [start = 0, end = content.length - 1] = (url.searchParams.get("range") ?? "").split("-").map(Number);
    const signal = init?.signal ?? new AbortController().signal;
    const request = { url, generation: Number(url.searchParams.get("gen")), start, end, signal, at: Date.now() };
    requests.push(request);
    return (await handler?.(request)) ?? new Response(content.slice(start, end + 1));
  };
  return { requests, fetch: fetch as typeof globalThis.fetch };
}

function budgeted(fetch: typeof globalThis.fetch, budget: number): typeof globalThis.fetch {
  let calls = 0;
  return ((input, init) => {
    if (++calls > budget) throw new Error("fake request budget exceeded");
    return fetch(input, init);
  }) as typeof globalThis.fetch;
}

function format(generation: number, overrides: Partial<VideoFormat> = {}): VideoFormat {
  return {
    itag: 251,
    client: generation === 1 ? "visionos" : "tv",
    url: `https://media.test/videoplayback?itag=251&gen=${generation}&sig=SECRETSIG`,
    contentLength: SOURCE.length,
    isHLS: false,
    ...overrides,
  } as VideoFormat;
}

function info(overrides: Partial<VideoInfo> = {}): VideoInfo {
  return { expiresAt: Date.now() + 6 * 3600_000, playableAt: 0, ...overrides } as VideoInfo;
}

interface Setup {
  readonly fetch: typeof fetch;
  readonly options?: ReadOptions;
  readonly info?: VideoInfo;
  readonly format?: VideoFormat;
  /** Replaces the default resume, which returns the next URL generation. */
  readonly resume?: Delivery["resume"];
}

interface Input {
  readonly delivery: Delivery;
  readonly info: VideoInfo;
  readonly format: VideoFormat;
  readonly options: ReadOptions;
}

function setup({ fetch, options = {}, resume, ...rest }: Setup) {
  const resumes: ResumeRequest[] = [];
  const retries: RetryEvent[] = [];
  const progress: ProgressEvent[] = [];
  let generation = 1;
  const delivery: Delivery = {
    fetch,
    resume: async (request) => {
      if (resumes.length >= REQUEST_BUDGET) throw new Error("fake resume budget exceeded");
      resumes.push(request);
      if (resume) return resume(request);
      generation++;
      return {
        info: info(),
        format: format(generation, {
          isHLS: request.format.isHLS,
          url: request.format.url?.replace(/gen=\d+/u, `gen=${generation}`),
        }),
      };
    },
    mintPoToken: async () => "POTOKEN-for-test",
  };
  const input: Input = {
    delivery,
    info: rest.info ?? info(),
    format: rest.format ?? format(1),
    options: { ...options, onProgress: (event) => progress.push(event), onRetry: (event) => retries.push(event) },
  };
  return { input, resumes, retries, progress };
}

function nodeStream(input: Input): Readable {
  return new Media(input.delivery, input.info, input.format).read(input.options);
}

async function collectNode(stream: Readable): Promise<{ data: Uint8Array; errors: unknown[] }> {
  const parts: Uint8Array[] = [];
  const errors: unknown[] = [];
  stream.on("data", (chunk: Uint8Array) => parts.push(chunk));
  stream.on("error", (error) => errors.push(error));
  await new Promise((resolve) => stream.once("close", resolve));
  await Bun.sleep(5);
  return { data: new Uint8Array(Buffer.concat(parts)), errors };
}

// Bun's fake timers also fake setImmediate and Bun.sleep; a MessageChannel message is still a real macrotask.
function nextMacrotask(): Promise<void> {
  const { port1, port2 } = new MessageChannel();
  const received = new Promise<void>((resolve) => {
    port1.addEventListener("message", () => resolve(), { once: true });
  });
  port1.start();
  port2.postMessage(undefined);
  return received.finally(() => port1.close());
}

/** Collects a live read under fake timers, firing the next timer whenever the read waits on one. */
async function collectLive(input: Input): Promise<{ data: Uint8Array; errors: unknown[] }> {
  jest.useFakeTimers();
  try {
    const stream = nodeStream(input);
    const collected = collectNode(stream);
    const ended = collected.then(() => true);
    for (let turn = 0; !(await Promise.race([ended, nextMacrotask().then(() => false)])); turn++) {
      if (turn > 100_000) {
        stream.destroy();
        throw new Error("the live read neither ends nor waits on a timer");
      }
      if (jest.getTimerCount() > 0) jest.advanceTimersToNextTimer();
    }
    return await collected;
  } finally {
    jest.useRealTimers();
  }
}

function forbidden(): Response {
  return new Response(null, { status: 403 });
}

function serverError(): Response {
  return new Response(null, { status: 500 });
}

/** Sends `bytes`, then fails the body like a reset connection. */
function brokenAfter(bytes: Uint8Array, init?: ResponseInit): Response {
  return new Response(
    new ReadableStream({
      start: (controller) => {
        if (bytes.length > 0) controller.enqueue(bytes);
      },
      pull: (controller) => controller.error(new TypeError("socket reset")),
    }),
    init,
  );
}

function resetConnection(): never {
  throw new TypeError("connection reset");
}

/** A ranged download whose window at byte `start` gets `answer`. */
function failingAt(start: number, answer: () => Response, resume?: Delivery["resume"]) {
  const server = mediaServer(SOURCE, (request) => (request.start === start ? answer() : undefined));
  return setup({ fetch: server.fetch, options: { chunkSize: 1000 }, resume });
}

const hlsPlaylist = (itag: number) =>
  `https://manifest.googlevideo.com/api/manifest/hls_playlist/id/live/itag/${itag}/index.m3u8`;

function playlist(first: number, last: number, ended = false, targetDuration = 0.01): string {
  const lines = ["#EXTM3U", `#EXT-X-TARGETDURATION:${targetDuration}`, `#EXT-X-MEDIA-SEQUENCE:${first}`];
  for (let sequence = first; sequence <= last; sequence++) lines.push("#EXTINF:1.0,", `seg/${sequence}.ts`);
  if (ended) lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

describe("ranged delivery", () => {
  test("resumes after a 403 at a chunk boundary without losing bytes", async () => {
    const server = mediaServer(SOURCE, ({ generation, start }) => {
      if (generation === 1 && start === 2000) return forbidden();
      if (generation === 2 && start === 4000) return forbidden();
      return undefined;
    });
    const { input, resumes, retries } = setup({ fetch: server.fetch, options: { chunkSize: 1000 } });

    const { data, errors } = await collectNode(nodeStream(input));

    expect(errors).toEqual([]);
    expect(data).toEqual(SOURCE);
    // Each block follows progress, so each is a first attempt.
    expect(
      resumes.map(({ format: failed, attempt }) => ({ itag: failed.itag, client: failed.client, attempt })),
    ).toEqual([
      { itag: 251, client: "visionos", attempt: 1 },
      { itag: 251, client: "tv", attempt: 1 },
    ]);
    expect(retries).toEqual([
      { attempt: 1, client: "visionos", reason: "HTTP 403" },
      { attempt: 1, client: "tv", reason: "HTTP 403" },
    ]);
  });

  test("resumes mid-window from the next unreceived byte", async () => {
    const server = mediaServer(SOURCE, ({ generation, start }) => {
      // A short answer leaves the window half read; the follow-up for its rest is blocked.
      if (generation === 1 && start === 1000) return new Response(SOURCE.slice(1000, 1500));
      if (generation === 1 && start === 1500) return forbidden();
      return undefined;
    });
    const { input } = setup({ fetch: server.fetch, options: { chunkSize: 1000 } });

    const { data } = await collectNode(nodeStream(input));

    expect(data).toEqual(SOURCE);
    expect(server.requests.find((request) => request.generation === 2)?.start).toBe(1500);
  });

  test("resumes a body that breaks off mid-window from the next unreceived byte", async () => {
    const server = mediaServer(SOURCE, ({ generation, start }) =>
      generation === 1 && start === 1000 ? brokenAfter(SOURCE.slice(1000, 1500)) : undefined,
    );
    const { input, retries } = setup({ fetch: server.fetch, options: { chunkSize: 1000 } });

    const { data, errors } = await collectNode(nodeStream(input));

    expect(errors).toEqual([]);
    expect(data).toEqual(SOURCE);
    expect(retries).toEqual([{ attempt: 1, client: "visionos", reason: "response broke off" }]);
    expect(server.requests.find((request) => request.generation === 2)?.start).toBe(1500);
  });

  test("resumes a request that fails before its headers at the same byte", async () => {
    const server = mediaServer(SOURCE, ({ generation, start }) => {
      if (generation === 1 && start === 1000) resetConnection();
      return undefined;
    });
    const { input, retries } = setup({ fetch: server.fetch, options: { chunkSize: 1000 } });

    const { data, errors } = await collectNode(nodeStream(input));

    expect(errors).toEqual([]);
    expect(data).toEqual(SOURCE);
    expect(retries).toEqual([{ attempt: 1, client: "visionos", reason: "request failed" }]);
    expect(server.requests.find((request) => request.generation === 2)?.start).toBe(1000);
  });

  test.each([
    ["403", forbidden, "403"],
    ["broken body", () => brokenAfter(new Uint8Array()), "broke off"],
    ["failed request", resetConnection, "request failed"],
  ])("gives up after three resumes without progress, keeping the last %s", async (_, answer, cause) => {
    const server = mediaServer(SOURCE, ({ start }) => (start >= 1000 ? answer() : undefined));
    const { input, retries } = setup({ fetch: server.fetch, options: { chunkSize: 1000 } });

    const { data, errors } = await collectNode(nodeStream(input));

    expect(data).toEqual(SOURCE.slice(0, 1000));
    expect(retries.map((retry) => retry.attempt)).toEqual([1, 2, 3]);
    expect(errors).toHaveLength(1);
    const [error] = errors;
    expect(YtdlError.is(error, "REQUEST_FAILED")).toBe(true);
    expect(error instanceof Error && error.cause instanceof YtdlError && error.cause.message).toContain(cause);
  });

  test("destroying mid-body neither retries nor requests again", async () => {
    const waiting = Promise.withResolvers<void>();
    const server = mediaServer(SOURCE, ({ start, signal }) => {
      if (start !== 1000) return undefined;
      let pulls = 0;
      return new Response(
        new ReadableStream(
          {
            start: (controller) => signal.addEventListener("abort", () => controller.error(signal.reason)),
            pull: (controller) => {
              if (++pulls === 1) controller.enqueue(SOURCE.slice(1000, 1500));
              else waiting.resolve();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    });
    const { input, retries } = setup({ fetch: server.fetch, options: { chunkSize: 1000 } });
    const stream = nodeStream(input);
    const collected = collectNode(stream);
    await waiting.promise;
    stream.destroy();
    const { data } = await collected;
    await Bun.sleep(30);

    expect(data).toEqual(SOURCE.slice(0, 1500));
    expect(retries).toEqual([]);
    expect(server.requests).toHaveLength(2);
  });

  test("a format of unknown length continues after a short window until the range past its end answers 400", async () => {
    const server = mediaServer(SOURCE, ({ generation, start }) => {
      if (start >= SOURCE.length) return new Response(null, { status: 400 });
      if (generation === 1 && start === 1000) return new Response(SOURCE.slice(1000, 1500));
      return undefined;
    });
    const { input, progress } = setup({
      fetch: server.fetch,
      format: format(1, { contentLength: undefined }),
      options: { chunkSize: 1000 },
    });

    const { data, errors } = await collectNode(nodeStream(input));

    expect(errors).toEqual([]);
    expect(data).toEqual(SOURCE);
    expect(progress.at(-1)).toMatchObject({ downloaded: SOURCE.length, total: undefined });
  });

  test("a format of unknown length with a range end past the file ends at the 400 past its last byte", async () => {
    const file = SOURCE.subarray(0, 2500);
    const server = mediaServer(file, ({ start }) =>
      start >= file.length ? new Response(null, { status: 400 }) : undefined,
    );
    const { input, retries, progress } = setup({
      fetch: server.fetch,
      format: format(1, { contentLength: undefined }),
      options: { range: { start: 0, end: 4999 } },
    });

    const { data, errors } = await collectNode(nodeStream(input));

    expect(errors).toEqual([]);
    expect(data).toEqual(file);
    expect(retries).toEqual([]);
    expect(progress.at(-1)).toMatchObject({ downloaded: file.length, total: undefined });
  });

  test("an empty body chunk before the bytes is skipped without another request", async () => {
    const server = mediaServer(SOURCE, ({ start, end }) =>
      start === 0
        ? new Response(
            new ReadableStream({
              start: (controller) => {
                controller.enqueue(new Uint8Array());
                controller.enqueue(SOURCE.slice(start, end + 1));
                controller.close();
              },
            }),
          )
        : undefined,
    );
    const { input, retries } = setup({ fetch: server.fetch, options: { chunkSize: 1000 } });

    const { data, errors } = await collectNode(nodeStream(input));

    expect(errors).toEqual([]);
    expect(data).toEqual(SOURCE);
    expect(retries).toEqual([]);
    expect(server.requests.map((request) => request.start)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
  });

  test("a resume that finds no format ends the stream once with NO_FORMAT caused by the 403", async () => {
    const noFormat = new YtdlError("NO_FORMAT", "No client offers itag 251");
    const { data, errors } = await collectNode(
      nodeStream(failingAt(1000, forbidden, () => Promise.reject(noFormat)).input),
    );

    expect(data).toEqual(SOURCE.slice(0, 1000));
    expect(errors).toHaveLength(1);
    const [error] = errors;
    expect(YtdlError.is(error, "NO_FORMAT")).toBe(true);
    expect(error instanceof Error && error.cause instanceof YtdlError && error.cause.message).toContain("403");
  });

  test("other statuses fail once with REQUEST_FAILED naming the itag and status, never the signature", async () => {
    const { input, resumes } = failingAt(1000, serverError);

    const { errors } = await collectNode(nodeStream(input));

    expect(errors).toHaveLength(1);
    const [error] = errors;
    expect(YtdlError.is(error, "REQUEST_FAILED")).toBe(true);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("251");
    expect(message).toContain("500");
    expect(message).not.toContain("SECRETSIG");
    expect(resumes).toEqual([]);
  });

  test("a failed lookup is the stream's one error", async () => {
    const lookup = new YtdlError("PRIVATE", "Private video");
    const { input } = setup({ fetch: mediaServer(SOURCE).fetch });

    const { errors } = await collectNode(deliver(input.delivery, () => Promise.reject(lookup)));

    expect(errors).toEqual([lookup]);
  });

  test("a later range read uses the refreshed URL and resolves nothing again", async () => {
    const server = mediaServer(SOURCE, ({ generation, start }) =>
      generation === 1 && start === 1000 ? forbidden() : undefined,
    );
    const { input, resumes } = setup({ fetch: server.fetch });
    const media = new Media(input.delivery, input.info, input.format);

    expect(await collectNode(media.read({ range: { start: 0, end: 1999 }, chunkSize: 1000 }))).toEqual({
      data: SOURCE.slice(0, 2000),
      errors: [],
    });
    const before = server.requests.length;
    const second = await collectNode(media.read({ range: { start: 3000, end: 3999 } }));

    expect(second.data).toEqual(SOURCE.slice(3000, 4000));
    expect(server.requests[before]?.generation).toBe(2);
    expect(media.format.client).toBe("tv");
    expect(resumes).toHaveLength(1);
  });

  test("an expired URL is replaced before the first media request", async () => {
    const server = mediaServer(SOURCE);
    const { input, resumes } = setup({ fetch: server.fetch, info: info({ expiresAt: Date.now() - 1 }) });

    const { data } = await collectNode(nodeStream(input));

    expect(data).toEqual(SOURCE);
    expect(resumes.map((request) => request.reason)).toEqual(["URL expired"]);
    expect(server.requests.every((request) => request.generation === 2)).toBe(true);
  });

  test("emits exactly the requested byte range", async () => {
    const server = mediaServer(SOURCE);
    const { input, progress } = setup({
      fetch: server.fetch,
      options: { range: { start: 1000, end: 1999 }, chunkSize: 300 },
    });

    const { data } = await collectNode(nodeStream(input));

    expect(data).toEqual(SOURCE.slice(1000, 2000));
    expect(server.requests.every((request) => request.start >= 1000 && request.end <= 1999)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ downloaded: 1000, total: 1000 });
  });

  test("a slow consumer stops range requests until it reads", async () => {
    const server = mediaServer(SOURCE);
    const { input } = setup({ fetch: server.fetch, options: { chunkSize: 1000, highWaterMark: 1 } });
    const stream = nodeStream(input);

    await new Promise((resolve) => stream.once("readable", resolve));
    await Bun.sleep(30);
    expect(server.requests).toHaveLength(1);

    const { data } = await collectNode(stream);
    expect(data).toEqual(SOURCE);
    expect(server.requests).toHaveLength(6);
  });

  test("waits out the preroll before the first media request", async () => {
    const server = mediaServer(SOURCE);
    const playableAt = Date.now() + 80;
    const { input } = setup({ fetch: server.fetch, info: info({ playableAt }) });

    await collectNode(nodeStream(input));

    expect(server.requests[0]?.at).toBeGreaterThanOrEqual(playableAt);
  });

  test("aborting the caller's signal ends the preroll wait with one error and no request", async () => {
    const server = mediaServer(SOURCE);
    const caller = new AbortController();
    const { input } = setup({
      fetch: server.fetch,
      info: info({ playableAt: Date.now() + 60_000 }),
      options: { signal: caller.signal },
    });
    const started = Date.now();
    setTimeout(() => caller.abort(), 20);

    const { errors } = await collectNode(nodeStream(input));

    expect(Date.now() - started).toBeLessThan(1000);
    expect(errors).toHaveLength(1);
    expect(errors[0] instanceof Error && errors[0].name).toBe("AbortError");
    expect(server.requests).toEqual([]);
  });

  test("aborting the caller's signal closes a Node stream nobody reads", async () => {
    const server = mediaServer(SOURCE);
    const caller = new AbortController();
    const { input } = setup({
      fetch: server.fetch,
      options: { chunkSize: 1000, highWaterMark: 1000, signal: caller.signal },
    });
    const stream = nodeStream(input);
    const errors: unknown[] = [];
    stream.on("error", (error) => errors.push(error));
    const closed = new Promise((resolve) => stream.once("close", resolve));
    await new Promise((resolve) => stream.once("readable", resolve));
    caller.abort();

    expect(await Promise.race([closed.then(() => "closed"), Bun.sleep(500).then(() => "open")])).toBe("closed");
    expect(errors).toHaveLength(1);
    expect(errors[0] instanceof Error && errors[0].name).toBe("AbortError");
  });

  test("aborting the caller's signal after the first chunk aborts the in-flight request and requests nothing more", async () => {
    const second = Promise.withResolvers<void>();
    const server = mediaServer(SOURCE, ({ start, signal }) => {
      if (start !== 1000) return undefined;
      second.resolve();
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    const caller = new AbortController();
    const { input } = setup({ fetch: server.fetch, options: { chunkSize: 1000, signal: caller.signal } });
    const collected = collectNode(nodeStream(input));
    await second.promise;
    caller.abort();
    const { data, errors } = await collected;
    await Bun.sleep(30);

    expect(data).toEqual(SOURCE.slice(0, 1000));
    expect(errors).toHaveLength(1);
    expect(server.requests[1]?.signal.aborted).toBe(true);
    expect(server.requests).toHaveLength(2);
  });

  test("destroying during a resume aborts it and no media request follows", async () => {
    const server = mediaServer(SOURCE, forbidden);
    let resumeSignal: AbortSignal | undefined;
    let stream: Readable | undefined;
    const { input } = setup({
      fetch: server.fetch,
      // Ignores its signal on purpose: delivery itself must not continue.
      resume: async ({ signal }) => {
        resumeSignal = signal;
        stream?.destroy();
        await Bun.sleep(30);
        return { info: info(), format: format(2) };
      },
    });
    stream = nodeStream(input);

    const { errors } = await collectNode(stream);
    await Bun.sleep(50);

    expect(resumeSignal?.aborted).toBe(true);
    expect(errors).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  test("a 403 on the last window resumes it and the progress ends at the file's total", async () => {
    const server = mediaServer(SOURCE, ({ generation, start }) =>
      generation === 1 && start === 5000 ? forbidden() : undefined,
    );
    const { input, progress } = setup({ fetch: server.fetch, options: { chunkSize: 1000 } });

    const { data, errors } = await collectNode(nodeStream(input));

    expect(errors).toEqual([]);
    expect(data).toEqual(SOURCE);
    expect(server.requests.slice(-2).map(({ generation, start, end }) => [generation, start, end])).toEqual([
      [1, 5000, 5499],
      [2, 5000, 5499],
    ]);
    expect(progress.at(-1)).toEqual({ chunkBytes: 500, downloaded: 5500, total: 5500 });
  });

  test("a last window of one byte is requested and emitted", async () => {
    const server = mediaServer(SOURCE);
    const { input } = setup({ fetch: server.fetch, options: { range: { start: 0, end: 3000 }, chunkSize: 1000 } });

    const { data } = await collectNode(nodeStream(input));

    expect(data).toEqual(SOURCE.slice(0, 3001));
    expect(server.requests.map(({ start, end }) => [start, end])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [3000, 3000],
    ]);
  });

  test("a window whose last byte arrives in its own body chunk takes no extra request", async () => {
    const server = mediaServer(SOURCE, ({ start, end }) => {
      const window = SOURCE.slice(start, end + 1);
      return new Response(
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(window.subarray(0, -1));
            controller.enqueue(window.subarray(-1));
            controller.close();
          },
        }),
      );
    });
    const { input } = setup({ fetch: server.fetch, options: { chunkSize: 1000 } });

    const { data } = await collectNode(nodeStream(input));

    expect(data).toEqual(SOURCE);
    expect(server.requests.map((request) => request.start)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
  });

  test("a server answering past the window yields only the window and cancels the rest of the body", async () => {
    let cancelled = false;
    const server = mediaServer(SOURCE, ({ start }) => {
      const pieces = [SOURCE.slice(start), SOURCE.slice(0, 100)];
      return new Response(
        new ReadableStream(
          {
            pull: (controller) => {
              const piece = pieces.shift();
              if (piece) controller.enqueue(piece);
              else controller.close();
            },
            cancel: () => {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      );
    });
    const { input } = setup({ fetch: server.fetch, options: { range: { start: 1000, end: 1999 } } });

    const { data } = await collectNode(nodeStream(input));

    expect(data).toEqual(SOURCE.slice(1000, 2000));
    expect(cancelled).toBe(true);
    expect(server.requests).toHaveLength(1);
  });
});

describe("resume through the resolver", () => {
  test("a client listing the itag as another file is skipped and a later client serving the same file continues", async () => {
    const served: string[] = [];
    const answer = (client: string, contentLength: number) =>
      playable(VIDEO_ID, [
        audioFormat(251, {
          url: `${MEDIA_HOST}?itag=251&expire=4102444800&c=${client}`,
          contentLength: String(contentLength),
        }),
      ]);
    const yt = fakeYouTube({
      player: ({ client }) => answer(client, client === TV ? SOURCE.length - 1 : SOURCE.length),
      media: (url) => {
        const [start = 0, end = 0] = (url.searchParams.get("range") ?? "").split("-").map(Number);
        const client = url.searchParams.get("c") ?? "";
        served.push(client);
        if (client === VISIONOS && start >= 1000) return forbidden();
        return new Response(SOURCE.slice(start, end + 1));
      },
    });
    const retries: RetryEvent[] = [];
    const ytdl = new Ytdl({ fetch: yt.fetch, clients: [Client.VisionOS, Client.Tv, Client.WebEmbedded] });

    const { data, errors } = await collectNode(
      ytdl.download(VIDEO_ID, { chunkSize: 1000, onRetry: (event) => retries.push(event) }),
    );

    expect(errors).toEqual([]);
    expect(data).toEqual(SOURCE);
    expect(retries).toEqual([
      { attempt: 1, client: "visionos", reason: "HTTP 403" },
      { attempt: 2, client: "visionos", reason: "HTTP 403" },
    ]);
    expect([...new Set(served)]).toEqual([VISIONOS, WEB_EMBEDDED]);
  });

  test("a failed visitor-data refresh resumes with the previous visitor data", async () => {
    const visitorAnswers = [
      () => new Response(visitorBody("VISITOR-A")),
      () => new Response(null, { status: 500 }),
      () => new Response(visitorBody("VISITOR-B")),
    ];
    let visitorFetches = 0;
    let lookups = 0;
    const yt = fakeYouTube({
      routes: { "https://www.youtube.com/sw.js_data": () => visitorAnswers[visitorFetches++]!() },
      player: ({ client }) =>
        playable(VIDEO_ID, [
          audioFormat(251, {
            url: `${MEDIA_HOST}?itag=251&expire=4102444800&gen=${client === "WEB" ? lookups : ++lookups}`,
            contentLength: String(SOURCE.length),
          }),
        ]),
      media: (url) => {
        const [start = 0, end = 0] = (url.searchParams.get("range") ?? "").split("-").map(Number);
        if (url.searchParams.get("gen") === "1" && start >= 1000) return forbidden();
        return new Response(SOURCE.slice(start, end + 1));
      },
    });
    const retries: RetryEvent[] = [];
    const ytdl = new Ytdl({ fetch: yt.fetch, clients: [Client.VisionOS] });

    const { data, errors } = await collectNode(
      ytdl.download(VIDEO_ID, { chunkSize: 1000, onRetry: (event) => retries.push(event) }),
    );

    expect(errors).toEqual([]);
    expect(data).toEqual(SOURCE);
    expect(retries).toEqual([{ attempt: 1, client: "visionos", reason: "HTTP 403" }]);
    expect(visitorFetches).toBe(2);
    const visionCalls = yt.playerCalls.filter((call) => call.client === VISIONOS);
    expect(visionCalls.map((call) => call.headers.get("X-Goog-Visitor-Id"))).toEqual(["VISITOR-A", "VISITOR-A"]);
  });
});

describe("explicit format", () => {
  test.each([
    ["an unexpired", 6 * 3600_000],
    ["an expiring", 30_000],
  ])(
    "a format from another video with %s info throws NO_FORMAT before any lookup or media request",
    async (_, expiresIn) => {
      const OTHER_ID = "YE7VzlLtp-4";
      const yt = fakeYouTube({
        player: ({ body }) =>
          body.videoId === VIDEO_ID
            ? playable(VIDEO_ID, [audioFormat(251)])
            : playable(OTHER_ID, [audioFormat(140, { mimeType: 'audio/mp4; codecs="mp4a.40.2"' })]),
        media: () => new Response(SOURCE.slice()),
      });
      const ytdl = new Ytdl({ fetch: yt.fetch });
      const [infoA, infoB] = await Promise.all([ytdl.getInfo(VIDEO_ID), ytdl.getInfo(OTHER_ID)]);
      const lookups = yt.playerCalls.length;

      const { errors } = await collectNode(
        ytdl.download({ ...infoA, expiresAt: Date.now() + expiresIn }, { format: infoB.formats[0]! }),
      );

      expect(errors).toHaveLength(1);
      expect(YtdlError.is(errors[0], "NO_FORMAT")).toBe(true);
      expect(yt.playerCalls).toHaveLength(lookups);
      expect(yt.requests.filter((request) => request.url.startsWith(MEDIA_HOST))).toEqual([]);
    },
  );

  test.each([
    ["an info that expires within a minute", (earlier: VideoInfo): string | VideoInfo => earlier],
    ["the video ID", (): string | VideoInfo => VIDEO_ID],
  ])("%s with a format the fresh first client lacks streams that file from a later client", async (_, input) => {
    const soon = Math.floor(Date.now() / 1000) + 30;
    let visionLookups = 0;
    const served: string[] = [];
    const yt = fakeYouTube({
      player: ({ client }) =>
        client === VISIONOS && visionLookups++ > 0
          ? playable(VIDEO_ID, [audioFormat(140, { mimeType: 'audio/mp4; codecs="mp4a.40.2"' })])
          : playable(VIDEO_ID, [
              audioFormat(251, {
                url: `${MEDIA_HOST}?itag=251&expire=${client === VISIONOS ? soon : 4102444800}&c=${client}`,
                contentLength: String(SOURCE.length),
              }),
            ]),
      media: (url) => {
        const [start = 0, end = 0] = (url.searchParams.get("range") ?? "").split("-").map(Number);
        served.push(url.searchParams.get("c") ?? "");
        return new Response(SOURCE.slice(start, end + 1));
      },
    });
    const ytdl = new Ytdl({ fetch: yt.fetch, clients: [Client.VisionOS, Client.WebEmbedded] });
    const earlier = await ytdl.getInfo(VIDEO_ID);
    const [wanted] = earlier.formats;

    const { data, errors } = await collectNode(ytdl.download(input(earlier), { format: wanted!, chunkSize: 1000 }));

    expect(errors).toEqual([]);
    expect(data).toEqual(SOURCE);
    expect([...new Set(served)]).toEqual([WEB_EMBEDDED]);
  });
});

describe("live delivery", () => {
  test.each([
    ["playlist", (url: URL) => url.pathname.endsWith(".m3u8"), "#EXTM3U\n"],
    ["segment", (url: URL) => url.pathname.endsWith("/seg/14.ts"), "1"],
  ])("a %s body that breaks off resumes without a gap or a repeat", async (_, breaks, partial) => {
    const playlists = [playlist(10, 15), playlist(13, 18), playlist(16, 19, true)];
    let polls = 0;
    let broke = false;
    const server = mediaServer(new Uint8Array(), ({ url }) => {
      if (!broke && breaks(url)) {
        broke = true;
        return brokenAfter(new TextEncoder().encode(partial));
      }
      if (url.pathname.endsWith(".m3u8")) return new Response(playlists[Math.min(polls++, playlists.length - 1)]);
      return new Response(`${/\/seg\/(\d+)\.ts$/u.exec(url.pathname)?.[1]},`);
    });
    const { input, retries } = setup({
      fetch: server.fetch,
      format: format(1, { isHLS: true, contentLength: undefined, url: "https://media.test/live/index.m3u8?gen=1" }),
      options: { liveBuffer: 3000 },
    });

    const { data, errors } = await collectNode(nodeStream(input));

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("13,14,15,16,17,18,19,");
    expect(retries).toEqual([{ attempt: 1, client: "visionos", reason: "response broke off" }]);
  });

  test("overlapping playlist refreshes emit each segment once, in order, until ENDLIST", async () => {
    const playlists = [playlist(10, 15), playlist(13, 18), playlist(16, 19, true)];
    let polls = 0;
    const server = mediaServer(new Uint8Array(), ({ url }) => {
      if (url.pathname.endsWith(".m3u8")) return new Response(playlists[Math.min(polls++, playlists.length - 1)]);
      return new Response(`${/\/seg\/(\d+)\.ts$/u.exec(url.pathname)?.[1]},`);
    });
    const { input } = setup({
      fetch: server.fetch,
      format: format(1, { isHLS: true, contentLength: undefined, url: "https://media.test/live/index.m3u8?gen=1" }),
      options: { liveBuffer: 3000 },
    });

    const { data, errors } = await collectNode(nodeStream(input));

    expect(errors).toEqual([]);
    // 3 s behind the edge of the first playlist is segment 13.
    expect(new TextDecoder().decode(data)).toBe("13,14,15,16,17,18,19,");
    expect(polls).toBe(3);
  });

  test("a playlist with a 1 s target duration that stops growing without ENDLIST ends 30 s after its last new segment", async () => {
    const playlists = [playlist(10, 15, false, 1), playlist(13, 18, false, 1)];
    let polls = 0;
    const server = mediaServer(new Uint8Array(), ({ url }) => {
      if (url.pathname.endsWith(".m3u8")) return new Response(playlists[Math.min(polls++, playlists.length - 1)]);
      return new Response(`${/\/seg\/(\d+)\.ts$/u.exec(url.pathname)?.[1]},`);
    });
    const { input } = setup({ fetch: server.fetch, format: hlsFormat(), options: { liveBuffer: 3000 } });

    const { data, errors } = await collectLive(input);
    const lastSegment = server.requests.findLast(({ url }) => url.pathname.endsWith("/seg/18.ts"))!;
    const lastPoll = server.requests.at(-1)!;

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("13,14,15,16,17,18,");
    expect(lastPoll.at - lastSegment.at).toBeGreaterThanOrEqual(30_000);
    expect(lastPoll.at - lastSegment.at).toBeLessThan(31_000);
  });

  test("a playlist that stalls for less than 30 s keeps streaming the segments that follow", async () => {
    let startedAt: number | undefined;
    const server = mediaServer(new Uint8Array(), ({ url }) => {
      const elapsed = Date.now() - (startedAt ??= Date.now());
      if (!url.pathname.endsWith(".m3u8")) return new Response(`${/\/seg\/(\d+)\.ts$/u.exec(url.pathname)?.[1]},`);
      if (elapsed === 0) return new Response(playlist(10, 15, false, 1));
      return new Response(elapsed < 25_000 ? playlist(13, 18, false, 1) : playlist(16, 21, true, 1));
    });
    const { input } = setup({ fetch: server.fetch, format: hlsFormat(), options: { liveBuffer: 3000 } });

    const { data, errors } = await collectLive(input);

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("13,14,15,16,17,18,19,20,21,");
  });

  test("a highest-audio download of a master with a separate audio rendition reads the rendition's segments", async () => {
    const manifest = "https://manifest.googlevideo.com/api/manifest/hls_variant/id/live";
    const yt = fakeYouTube({
      player: () => ({
        ...playable(VIDEO_ID, []),
        videoDetails: { videoId: VIDEO_ID, isLive: true },
        streamingData: { adaptiveFormats: [], hlsManifestUrl: manifest },
      }),
      routes: {
        [manifest]: () =>
          new Response(
            [
              "#EXTM3U",
              `#EXT-X-MEDIA:TYPE=AUDIO,NAME="audio",DEFAULT=YES,AUTOSELECT=YES,GROUP-ID="233",URI="${hlsPlaylist(233)}"`,
              '#EXT-X-STREAM-INF:BANDWIDTH=290000,CODECS="avc1.42c00b,mp4a.40.5",RESOLUTION=256x144,FRAME-RATE=30,AUDIO="233"',
              hlsPlaylist(269),
            ].join("\n"),
          ),
      },
      media: (url) => {
        const itag = /\/itag\/(\d+)\//u.exec(url.pathname)?.[1];
        if (url.pathname.endsWith(".m3u8"))
          return new Response(playlist(1, 2, true).replaceAll("seg/", `seg/${itag}-`));
        return new Response(`${/\/seg\/([\d-]+)\.ts$/u.exec(url.pathname)?.[1]},`);
      },
    });

    const stream = new Ytdl({ fetch: yt.fetch }).download(VIDEO_ID, { quality: "highestaudio" });
    const { data, errors } = await collectNode(stream);

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("233-1,233-2,");
  });
});

const DASH_BUDGET = 10_000;

/** A live DASH origin: segments 10 ms long; `sq=head+1` waits for the next segment until `last`. */
function dashOrigin({
  head = 20,
  last = 23,
  oldest = (): number => 0,
  answer = (_sq: number): Response | undefined => undefined,
} = {}) {
  const state = { head };
  const server = mediaServer(
    new Uint8Array(),
    ({ url }) => {
      const sq = Number(url.searchParams.get("sq"));
      if (sq === state.head + 1 && state.head < last) state.head++;
      const headers = { "x-head-seqnum": String(state.head), "x-head-time-millis": String(state.head * 10) };
      if (sq < Math.max(1, oldest()) || sq > state.head) return new Response(null, { status: 404, headers });
      return answer(sq) ?? new Response(`${sq},`, { headers });
    },
    DASH_BUDGET,
  );
  return { state, server };
}

function hlsFormat(): VideoFormat {
  return format(1, { isHLS: true, contentLength: undefined, url: "https://media.test/live/index.m3u8?gen=1" });
}

function dashSetup(fetch: typeof globalThis.fetch) {
  return setup({
    fetch,
    format: format(1, {
      isLive: true,
      contentLength: undefined,
      url: "https://media.test/videoplayback?itag=251&gen=1",
    }),
    options: { liveBuffer: 30 },
  });
}

describe("live DASH delivery", () => {
  test("starts liveBuffer behind the head and ends 30 s after the stream stops growing", async () => {
    const { server } = dashOrigin();
    const { data, errors } = await collectLive(dashSetup(server.fetch).input);
    const lastSegment = server.requests.find(({ url }) => url.searchParams.get("sq") === "23")!;

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("17,18,19,20,21,22,23,");
    expect(server.requests.at(-1)!.at - lastSegment.at).toBeGreaterThanOrEqual(30_000);
    expect(server.requests.at(-1)!.at - lastSegment.at).toBeLessThan(31_000);
  });

  test("a stall shorter than 30 s keeps polling and emits the segments that follow", async () => {
    const { server } = dashOrigin();
    let startedAt: number | undefined;
    const stalling = budgeted(
      (async (input: string | URL | Request, init?: RequestInit) => {
        const elapsed = Date.now() - (startedAt ??= Date.now());
        if (new URL(String(input)).searchParams.get("sq") === "21" && elapsed < 25_000) {
          return new Response(null, { status: 404, headers: { "x-head-seqnum": "20", "x-head-time-millis": "200" } });
        }
        return server.fetch(input, init);
      }) as typeof globalThis.fetch,
      DASH_BUDGET,
    );
    const { data, errors } = await collectLive(dashSetup(stalling).input);

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("17,18,19,20,21,22,23,");
  });

  test.each([
    ["a 403", forbidden],
    [
      "a body that breaks off",
      () =>
        brokenAfter(new TextEncoder().encode("1"), { headers: { "x-head-seqnum": "20", "x-head-time-millis": "200" } }),
    ],
  ])("%s resumes on a new URL without a gap or a repeat", async (_, failure) => {
    let failed = false;
    const { server } = dashOrigin({
      answer: (sq) => (sq === 19 && !failed ? ((failed = true), failure()) : undefined),
    });
    const { input, resumes } = dashSetup(server.fetch);
    const { data, errors } = await collectLive(input);

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("17,18,19,20,21,22,23,");
    expect(resumes).toHaveLength(1);
    expect(server.requests.filter((request) => request.url.searchParams.get("sq") === "20")[0]?.generation).toBe(2);
  });

  test.each([
    ["naming the head", { "x-head-seqnum": "20", "x-head-time-millis": "200" }],
    ["naming no head", {}],
  ])("a 204 past the head %s counts as an idle poll and skips no segment", async (_, headers) => {
    const { server } = dashOrigin({ last: 21 });
    let empty = 0;
    const holding = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).searchParams.get("sq") === "21" && empty++ < 2) {
        return new Response(null, { status: 204, headers });
      }
      return server.fetch(input, init);
    }) as typeof globalThis.fetch;
    const { data, errors } = await collectLive(dashSetup(holding).input);

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("17,18,19,20,21,");
  });

  test("a segment that left the DVR window jumps to the head", async () => {
    let served = 0;
    const { state, server } = dashOrigin({
      oldest: () => (served >= 2 ? state.head : 0),
      answer: (sq) => {
        if (++served === 2) state.head = 40;
        return new Response(`${sq},`, { headers: { "x-head-seqnum": String(state.head) } });
      },
      last: 40,
    });
    const { data, errors } = await collectLive(dashSetup(server.fetch).input);

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("17,18,40,");
    const skipped = server.requests.filter(
      ({ url }) => Number(url.searchParams.get("sq")) > 20 && Number(url.searchParams.get("sq")) < 40,
    );
    expect(skipped).toEqual([]);
  });

  test("a 404 at the head ends the stream 30 s after the last new segment, polling once per segment duration", async () => {
    const { server } = dashOrigin({
      last: 20,
      answer: (sq) =>
        sq === 20
          ? new Response(null, { status: 404, headers: { "x-head-seqnum": "20", "x-head-time-millis": "200" } })
          : undefined,
    });
    const { data, errors } = await collectLive(dashSetup(server.fetch).input);
    const lastSegment = server.requests.find(({ url }) => url.searchParams.get("sq") === "19")!;
    const idle = server.requests.filter(({ url }) => url.searchParams.get("sq") === "20").map((request) => request.at);

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("17,18,19,");
    expect(idle.at(-1)! - lastSegment.at).toBeGreaterThanOrEqual(30_000);
    expect(idle.slice(1).every((at, index) => at - idle[index]! >= 10)).toBe(true);
  });

  test("destroying while waiting for the next segment requests nothing more", async () => {
    const { server } = dashOrigin({ last: 20 });
    const stream = nodeStream(dashSetup(server.fetch).input);
    stream.on("data", () => {});
    stream.on("error", () => {});
    while (!server.requests.some((request) => request.url.searchParams.get("sq") === "21")) await Bun.sleep(1);
    stream.destroy();
    const count = server.requests.length;
    await Bun.sleep(50);

    expect(server.requests).toHaveLength(count);
  });
});

import { describe, expect, test } from "bun:test";
import type { Readable } from "node:stream";
import { deliver, Media } from "../src/delivery/index.ts";
import { YtdlError } from "../src/errors.ts";
import type { Delivery, ReadOptions, ResumeRequest } from "../src/delivery/index.ts";
import type { ProgressEvent, RetryEvent } from "../src/delivery/index.ts";
import type { VideoFormat } from "../src/formats.ts";
import type { VideoInfo } from "../src/info.ts";

const SOURCE = pseudoRandomBytes(5500);

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
function mediaServer(content: Uint8Array, handler?: Handler) {
  const requests: MediaRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const [start = 0, end = content.length - 1] = (url.searchParams.get("range") ?? "").split("-").map(Number);
    const signal = init?.signal ?? new AbortController().signal;
    const request = { url, generation: Number(url.searchParams.get("gen")), start, end, signal, at: Date.now() };
    requests.push(request);
    return (await handler?.(request)) ?? new Response(content.slice(start, end + 1));
  };
  return { requests, fetch: fetch as typeof globalThis.fetch };
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
    mintPoToken: undefined,
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

function forbidden(): Response {
  return new Response(null, { status: 403 });
}

function serverError(): Response {
  return new Response(null, { status: 500 });
}

/** A ranged download whose window at byte `start` gets `answer`. */
function failingAt(start: number, answer: () => Response, resume?: Delivery["resume"]) {
  const server = mediaServer(SOURCE, (request) => (request.start === start ? answer() : undefined));
  return setup({ fetch: server.fetch, options: { chunkSize: 1000 }, resume });
}

function playlist(first: number, last: number, ended = false): string {
  const lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:0.01", `#EXT-X-MEDIA-SEQUENCE:${first}`];
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

  test("gives up after three resumes without progress, keeping the last 403", async () => {
    const server = mediaServer(SOURCE, ({ start }) => (start >= 1000 ? forbidden() : undefined));
    const { input, retries } = setup({ fetch: server.fetch, options: { chunkSize: 1000 } });

    const { data, errors } = await collectNode(nodeStream(input));

    expect(data).toEqual(SOURCE.slice(0, 1000));
    expect(retries.map((retry) => retry.attempt)).toEqual([1, 2, 3]);
    expect(errors).toHaveLength(1);
    const [error] = errors;
    expect(YtdlError.is(error, "REQUEST_FAILED")).toBe(true);
    expect(error instanceof Error && error.cause instanceof YtdlError && error.cause.message).toContain("403");
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
});

describe("live delivery", () => {
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
});

/** A live DASH origin: segments 10 ms long; `sq=head+1` waits for the next segment until `last`. */
function dashOrigin({
  head = 20,
  last = 23,
  oldest = (): number => 0,
  answer = (_sq: number): Response | undefined => undefined,
} = {}) {
  const state = { head };
  const server = mediaServer(new Uint8Array(), ({ url }) => {
    const sq = Number(url.searchParams.get("sq"));
    if (sq === state.head + 1 && state.head < last) state.head++;
    const headers = { "x-head-seqnum": String(state.head), "x-head-time-millis": String(state.head * 10) };
    if (sq < Math.max(1, oldest()) || sq > state.head) return new Response(null, { status: 404, headers });
    return answer(sq) ?? new Response(`${sq},`, { headers });
  });
  return { state, server };
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
  test("starts liveBuffer behind the head and ends once the stream stops growing", async () => {
    const { server } = dashOrigin();
    const { data, errors } = await collectNode(nodeStream(dashSetup(server.fetch).input));

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("17,18,19,20,21,22,23,");
  });

  test("a 403 resumes on a new URL without a gap or a repeat", async () => {
    let refused = false;
    const { server } = dashOrigin({
      answer: (sq) => (sq === 19 && !refused ? ((refused = true), forbidden()) : undefined),
    });
    const { input, resumes } = dashSetup(server.fetch);
    const { data, errors } = await collectNode(nodeStream(input));

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("17,18,19,20,21,22,23,");
    expect(resumes).toHaveLength(1);
    expect(server.requests.filter((request) => request.url.searchParams.get("sq") === "20")[0]?.generation).toBe(2);
  });

  test("a 204 past the head counts as an idle poll and skips no segment", async () => {
    const { server } = dashOrigin({ last: 21 });
    let empty = 0;
    const holding = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).searchParams.get("sq") === "21" && empty++ < 2) {
        return new Response(null, { status: 204, headers: { "x-head-seqnum": "20", "x-head-time-millis": "200" } });
      }
      return server.fetch(input, init);
    }) as typeof globalThis.fetch;
    const { data, errors } = await collectNode(nodeStream(dashSetup(holding).input));

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
    const { data, errors } = await collectNode(nodeStream(dashSetup(server.fetch).input));

    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("17,18,40,");
    const skipped = server.requests.filter(
      ({ url }) => Number(url.searchParams.get("sq")) > 20 && Number(url.searchParams.get("sq")) < 40,
    );
    expect(skipped).toEqual([]);
  });

  test("a 404 at the head counts as an idle poll and ends the stream", async () => {
    const { server } = dashOrigin({
      last: 20,
      answer: (sq) =>
        sq === 20
          ? new Response(null, { status: 404, headers: { "x-head-seqnum": "20", "x-head-time-millis": "200" } })
          : undefined,
    });
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      await Bun.sleep(1);
      return server.fetch(input, init);
    }) as typeof globalThis.fetch;
    const stream = nodeStream(dashSetup(slow).input);
    const collected = collectNode(stream);
    const ended = await Promise.race([collected.then(() => true), Bun.sleep(1000).then(() => false)]);
    if (!ended) stream.destroy();
    const { data, errors } = await collected;

    expect(ended).toBe(true);
    expect(errors).toEqual([]);
    expect(new TextDecoder().decode(data)).toBe("17,18,19,");
    expect(server.requests.filter((request) => request.url.searchParams.get("sq") === "20").length).toBeLessThanOrEqual(
      4,
    );
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

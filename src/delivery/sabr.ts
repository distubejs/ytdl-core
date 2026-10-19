import { ignore } from "../http.ts";
import { CLIENTS, type Client, userAgentHeader } from "../clients.ts";
import { redact, YtdlError } from "../errors.ts";
import { parseFormat, sameFormat } from "../formats.ts";
import type { SabrSource } from "../formats.ts";
import type { FormatMetadata } from "../types.ts";
import { type ReadEnd, type Session } from "./session.ts";

const SABR_REQUEST_RETRIES = 2;

type BuildSabrFormat = typeof import("googlevideo/utils").buildSabrFormat;
type SabrFormat = ReturnType<BuildSabrFormat>;

interface Track {
  readonly metadata: FormatMetadata;
  readonly sabr: SabrFormat;
}

function tracks(source: SabrSource, client: Client, build: BuildSabrFormat): Track[] {
  return source.formats.flatMap((entry) => {
    const metadata = parseFormat(entry, client)?.metadata;
    if (!metadata) return [];
    // `buildSabrFormat` reads YouTube.js's snake_case `is_drc` and `audio_track`, not InnerTube's fields.
    const built = build(entry as unknown as Parameters<BuildSabrFormat>[0]);
    return [{ metadata, sabr: { ...built, isDrc: metadata.isDrc, audioTrackId: metadata.audioTrack?.id } }];
  });
}

function cheapestAudio(available: readonly Track[]): Track | undefined {
  return available
    .filter(({ metadata }) => metadata.hasAudio && !metadata.hasVideo && !metadata.isDrc)
    .toSorted((a, b) => (a.metadata.bitrate ?? 0) - (b.metadata.bitrate ?? 0))[0];
}

async function drain(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  for (;;) if ((await reader.read()).done) return;
}

function tokenBytes(token: string): Uint8Array {
  return Uint8Array.from(atob(token.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
}

export async function* readSabr(
  session: Session,
  start: number,
  last: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array, ReadEnd, undefined> {
  const [{ SabrStream }, { buildSabrFormat, EnabledTrackTypes }] = await Promise.all([
    import("googlevideo/sabr-stream"),
    import("googlevideo/utils"),
  ]);
  let position = start;
  for (;;) {
    if (!(await session.ensureFresh())) {
      if (session.format.url !== undefined) return "switched";
      continue;
    }
    const { info, format, input } = session;
    const source = input.sabr(info);
    if (!source) {
      throw new YtdlError("INVALID_STATE", `itag ${format.itag}: this instance holds no SABR session for the info`);
    }
    const available = tracks(source, format.client, buildSabrFormat);
    const wanted = available.find((track) => sameFormat(track.metadata, format))?.sabr;
    // SABR has no video-only session, and cancelling either track aborts both.
    const audio = format.hasVideo ? cheapestAudio(available)?.sabr : wanted;
    if (!wanted || !audio) throw new YtdlError("NO_FORMAT", `itag ${format.itag}: missing from the SABR session`);
    const client = CLIENTS[format.client];
    const mint = input.mintPoToken;
    let mintFailure: unknown;
    const stream = new SabrStream({
      videoId: info.videoDetails.id,
      fetchFunction: ((url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(userAgentHeader(format.client))) headers.set(name, value);
        return input.fetch(url, { ...init, headers });
      }) as typeof fetch,
      serverAbrStreamingUrl: source.url,
      videoPlaybackUstreamerConfig: source.config,
      clientInfo: { clientName: client.nameId, clientVersion: client.version },
      formats: available.map((track) => track.sabr),
      callbacks: mint && {
        // googlevideo logs a failed mint and carries on without a token.
        onMintPoToken: () =>
          mint(info, signal).then(tokenBytes, (error: unknown) => {
            mintFailure ??= error;
            throw error;
          }),
      },
    });
    const { audioStream, videoStream } = stream.start({
      audioFormat: audio,
      videoFormat: format.hasVideo ? wanted : undefined,
      enabledTrackTypes: format.hasVideo ? EnabledTrackTypes.VIDEO_AND_AUDIO : EnabledTrackTypes.AUDIO_ONLY,
      isPostLiveDvr: false,
      maxRetries: SABR_REQUEST_RETRIES,
    });
    const abort = () => void stream.abort().catch(ignore);
    signal.addEventListener("abort", abort, { once: true });
    if (format.hasVideo) drain(audioStream).catch(ignore);
    const reader = (format.hasVideo ? videoStream : audioStream).getReader();
    let offset = 0;
    let failure: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const from = Math.max(position - offset, 0);
        const to = Math.min(chunk.length, last - offset + 1);
        offset += chunk.length;
        if (to > from) {
          position += to - from;
          yield chunk.subarray(from, to);
        }
        if (position > last) return "complete";
      }
      if (last === Infinity) return "complete";
      failure = new Error(`session ended at byte ${offset}`);
    } catch (error) {
      signal.throwIfAborted();
      failure = error;
    } finally {
      signal.removeEventListener("abort", abort);
      abort();
      reader.cancel().catch(ignore);
    }
    if (mintFailure !== undefined) {
      throw new YtdlError("REQUEST_FAILED", `itag ${format.itag}: getPoToken failed`, { cause: mintFailure });
    }
    const reason = redact(failure instanceof Error ? failure.message : String(failure));
    await session.resume(
      "SABR session failed",
      new YtdlError("REQUEST_FAILED", `itag ${format.itag}: SABR session failed: ${reason}`, { cause: failure }),
    );
    if (session.format.url !== undefined) return "switched";
  }
}

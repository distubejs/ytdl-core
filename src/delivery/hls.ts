import { YtdlError } from "../errors.ts";
import { LIVE_IDLE_MS, waitUntil, type Session } from "./session.ts";

interface Segment {
  readonly sequence: number;
  readonly duration: number;
  readonly uri: string;
}

interface MediaPlaylist {
  readonly targetDuration: number;
  readonly segments: readonly Segment[];
  readonly ended: boolean;
}

// YouTube live segments last about 5 s.
const DEFAULT_TARGET_DURATION = 5;

// YouTube's MPEG-TS live playlists carry no `#EXT-X-MAP`, `#EXT-X-KEY` or discontinuities.
function parsePlaylist(text: string, baseUrl: string): MediaPlaylist {
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  if (lines[0] !== "#EXTM3U") throw new YtdlError("REQUEST_FAILED", "The live playlist is not an HLS playlist");
  let sequence = 0;
  let targetDuration = DEFAULT_TARGET_DURATION;
  let duration = 0;
  let ended = false;
  const segments: Segment[] = [];
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) sequence = Number.parseInt(line.slice(22), 10);
    else if (line.startsWith("#EXT-X-TARGETDURATION:")) targetDuration = Number.parseFloat(line.slice(22));
    else if (line.startsWith("#EXTINF:")) duration = Number.parseFloat(line.slice(8));
    else if (line === "#EXT-X-ENDLIST") ended = true;
    else if (line !== "" && !line.startsWith("#")) {
      segments.push({ sequence: sequence++, duration, uri: new URL(line, baseUrl).href });
      duration = 0;
    }
  }
  return { targetDuration, segments, ended };
}

function startSequence(playlist: MediaPlaylist, liveBuffer: number): number {
  const { segments } = playlist;
  let start = (segments.at(-1)?.sequence ?? -1) + 1;
  if (playlist.ended) return segments[0]?.sequence ?? start;
  let buffered = 0;
  for (const segment of segments.toReversed()) {
    if (buffered >= liveBuffer / 1000) break;
    buffered += segment.duration;
    start = segment.sequence;
  }
  return start;
}

export async function* readLive(
  session: Session,
  liveBuffer: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array, void, undefined> {
  let next: number | undefined;
  let freshAt = Date.now();
  poll: for (;;) {
    const polledAt = Date.now();
    const url = session.format.url ?? "";
    const response = await session.request(url);
    if (!response) continue;
    const text = await session.read(response, (body) => body.text());
    if (text === undefined) continue;
    const playlist = parsePlaylist(text, url);
    next ??= startSequence(playlist, liveBuffer);
    let fresh = false;
    for (const segment of playlist.segments) {
      if (segment.sequence < next) continue;
      const media = await session.request(segment.uri);
      // A resumed playlist's segment URLs replace the old, expired ones.
      if (!media) continue poll;
      const bytes = await session.read(media, (body) => body.bytes());
      if (!bytes) continue poll;
      if (bytes.length > 0) {
        session.progress(bytes.length, undefined);
        yield bytes;
      }
      next = segment.sequence + 1;
      fresh = true;
      freshAt = Date.now();
    }
    if (playlist.ended || Date.now() - freshAt >= LIVE_IDLE_MS) return;
    // RFC 8216 6.3.4: reload after a target duration, or half of one when nothing was new.
    await waitUntil(polledAt + (fresh ? 1000 : 500) * playlist.targetDuration, signal);
  }
}

import { ignore } from "../http.ts";
import { YtdlError } from "../errors.ts";
import { LIVE_IDLE_MS, type Session, waitUntil } from "./session.ts";

const DEFAULT_SEGMENT_MS = 5000;

interface Head {
  readonly sequence: number;
  readonly segmentMs: number;
}

// YouTube numbers live segments by `sq`; each answer carries the newest number and its media time.
function headOf(response: Response): Head | undefined {
  const sequence = Number(response.headers.get("x-head-seqnum"));
  const timeMs = Number(response.headers.get("x-head-time-millis"));
  if (!Number.isSafeInteger(sequence) || sequence < 1) return undefined;
  return { sequence, segmentMs: timeMs > 0 ? timeMs / sequence : DEFAULT_SEGMENT_MS };
}

export async function* readDashLive(
  session: Session,
  liveBuffer: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array, void, undefined> {
  let next: number | undefined;
  let lastHead: Head | undefined;
  let freshAt = Date.now();
  for (;;) {
    const polledAt = Date.now();
    const { url, itag } = session.format;
    if (url === undefined) throw new YtdlError("INVALID_STATE", `itag ${itag}: a live DASH format has no URL`);
    // A request for the next segment waits until YouTube has it; one further ahead answers 404 and one behind the DVR
    // window 500. Without `sq` YouTube answers the init segment, which names the head.
    const response = await session.request(next === undefined ? url : `${url}&sq=${next}`, { allowNotFound: true });
    if (!response) continue;
    const idle = response.status === 404 || response.status === 204;
    const head = headOf(response) ?? (idle ? lastHead : undefined);
    if (!head) {
      response.body?.cancel().catch(ignore);
      throw new YtdlError("REQUEST_FAILED", `itag ${itag}: the live answer names no head segment`);
    }
    if (head.sequence > (lastHead?.sequence ?? 0)) lastHead = head;
    if (next === undefined) {
      response.body?.cancel().catch(ignore);
      next = Math.max(0, head.sequence - Math.ceil(liveBuffer / head.segmentMs));
      continue;
    }
    // YouTube answers 204 when the next segment does not arrive within its long-poll window.
    if (idle) {
      response.body?.cancel().catch(ignore);
      if (next < head.sequence) {
        next = head.sequence;
        continue;
      }
      if (Date.now() - freshAt >= LIVE_IDLE_MS) return;
      await waitUntil(polledAt + head.segmentMs, signal);
      continue;
    }
    const bytes = await session.read(response, (body) => body.bytes());
    if (!bytes) continue;
    if (bytes.length > 0) {
      session.progress(bytes.length, undefined);
      yield bytes;
    }
    next++;
    freshAt = Date.now();
  }
}

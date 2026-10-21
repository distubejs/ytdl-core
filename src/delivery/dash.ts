import { ignore } from "../http.ts";
import { YtdlError } from "../errors.ts";
import { type Session, waitUntil } from "./session.ts";

const DEFAULT_SEGMENT_MS = 5000;
const IDLE_POLLS_BEFORE_END = 3;

// YouTube numbers live segments by `sq`; each answer carries the newest number and its media time.
function headOf(response: Response): { readonly sequence: number; readonly segmentMs: number } | undefined {
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
  let lastHead = 0;
  let idlePolls = 0;
  for (;;) {
    const { url, itag } = session.format;
    if (url === undefined) throw new YtdlError("INVALID_STATE", `itag ${itag}: a live DASH format has no URL`);
    // A request for the next segment waits until YouTube has it; one further ahead or past the DVR window answers 404.
    const response = await session.request(`${url}&sq=${next ?? 0}`, { allowNotFound: true });
    if (!response) continue;
    const head = headOf(response);
    if (!head) {
      response.body?.cancel().catch(ignore);
      throw new YtdlError("REQUEST_FAILED", `itag ${itag}: the live answer names no head segment`);
    }
    if (head.sequence > lastHead) idlePolls = 0;
    lastHead = Math.max(lastHead, head.sequence);
    if (next === undefined) {
      response.body?.cancel().catch(ignore);
      next = Math.max(0, head.sequence - Math.ceil(liveBuffer / head.segmentMs));
      continue;
    }
    // YouTube answers 204 when the next segment does not arrive within its long-poll window.
    if (response.status === 404 || response.status === 204) {
      response.body?.cancel().catch(ignore);
      if (next < head.sequence) {
        next = head.sequence;
        continue;
      }
      if (++idlePolls >= IDLE_POLLS_BEFORE_END) return;
      await waitUntil(Date.now() + head.segmentMs, signal);
      continue;
    }
    const bytes = await session.read(response, (body) => body.bytes());
    if (!bytes) continue;
    if (bytes.length > 0) {
      session.progress(bytes.length, undefined);
      yield bytes;
    }
    next++;
  }
}

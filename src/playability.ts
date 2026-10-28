import type { YtdlErrorCode } from "./errors.ts";
import { at, type Json, list, text } from "./json.ts";

type Playability =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: YtdlErrorCode;
      readonly reason: string;
      readonly startTime?: Date;
      readonly availableCountries?: readonly string[];
    };

function playabilityReason(status: unknown): string {
  const parts = [
    text(at(status, "reason")),
    text(at(status, "errorScreen", "playerErrorMessageRenderer", "reason")),
    text(at(status, "errorScreen", "playerErrorMessageRenderer", "subreason")),
    ...(Array.isArray(at(status, "messages")) ? (at(status, "messages") as unknown[]).map(text) : []),
  ];
  return [...new Set(parts.filter((part): part is string => !!part))].join(" ");
}

export function availableCountries(player: unknown): readonly string[] | undefined {
  const countries = at(player, "microformat", "playerMicroformatRenderer", "availableCountries");
  return Array.isArray(countries) ? countries.filter((country) => typeof country === "string") : undefined;
}

// Reason strings follow yt-dlp and NewPipe. Copyright notices name the rights holder, so only whole phrases count.
const REGION_PHRASES = ["in your country", "your location"];
const COPYRIGHT_PHRASES = ["copyright claim", "copyright grounds"];
const PRIVATE_PHRASES = ["video is private", "private video"];
const PREMIUM_PHRASES = ["music premium", "premium members"];
const MEMBERS_PHRASES = ["members-only", "join this channel"];

const says = (reason: string, phrases: readonly string[]) => phrases.some((phrase) => reason.includes(phrase));

export function classifyPlayability(player: Json): Playability {
  const status = at(player, "playabilityStatus");
  const value = at(status, "status");
  if (value === "OK") return { ok: true };
  const reason = playabilityReason(status) || `status ${String(value)}`;
  const lower = reason.toLowerCase();
  const fail = (
    code: YtdlErrorCode,
    extra: Partial<Pick<Playability & { ok: false }, "startTime" | "availableCountries">> = {},
  ) => ({ ok: false, code, reason, ...extra }) as const;

  if (value === "LIVE_STREAM_OFFLINE" || lower.includes("live event will begin")) {
    const start = Number(
      at(
        status,
        "liveStreamability",
        "liveStreamabilityRenderer",
        "offlineSlate",
        "liveStreamOfflineSlateRenderer",
        "scheduledStartTime",
      ),
    );
    return fail("NOT_STARTED", Number.isFinite(start) && start > 0 ? { startTime: new Date(start * 1000) } : {});
  }
  if (
    value === "AGE_CHECK_REQUIRED" ||
    value === "AGE_VERIFICATION_REQUIRED" ||
    lower.includes("confirm your age") ||
    lower.includes("age-restricted")
  ) {
    return fail("AGE_RESTRICTED");
  }
  if (lower.includes("not a bot")) return fail("BOT_CHECK");
  if (says(lower, REGION_PHRASES)) {
    const countries = availableCountries(player);
    return fail("REGION_BLOCKED", countries ? { availableCountries: countries } : {});
  }
  if (says(lower, COPYRIGHT_PHRASES)) return fail("NOT_FOUND");
  if (says(lower, PRIVATE_PHRASES)) return fail("PRIVATE");
  if (says(lower, PREMIUM_PHRASES)) return fail("PREMIUM_ONLY");
  if (says(lower, MEMBERS_PHRASES)) return fail("MEMBERS_ONLY");
  if (lower.includes("try again later") || lower.includes("too many requests")) return fail("RATE_LIMITED");
  if (lower.includes("recording is not available")) return fail("NOT_FOUND");
  if (value === "LOGIN_REQUIRED") return fail("BOT_CHECK");
  if (
    value === "ERROR" &&
    (lower.includes("unavailable") ||
      lower.includes("removed") ||
      lower.includes("does not exist") ||
      lower.includes("terminated"))
  ) {
    return fail("NOT_FOUND");
  }
  // UNPLAYABLE without a recognised reason happens for made-for-kids on VISIONOS and "page needs to be reloaded".
  return fail("NO_FORMAT");
}

// GVS answers 403 to media requests before the enforced preroll ends; MWEB sends it as an ad slot.
export function prerollEnd(player: Json, answeredAt: number): number {
  const renderers: unknown[] = [];
  for (const placement of list(at(player, "adPlacements"))) {
    if (at(placement, "adPlacementRenderer", "config", "adPlacementConfig", "kind") !== "AD_PLACEMENT_KIND_START")
      continue;
    renderers.push(at(placement, "adPlacementRenderer", "renderer", "instreamVideoAdRenderer"));
  }
  for (const slot of list(at(player, "adSlots"))) {
    if (at(slot, "adSlotRenderer", "adSlotMetadata", "triggerEvent") !== "SLOT_TRIGGER_EVENT_BEFORE_CONTENT") continue;
    const content = at(
      slot,
      "adSlotRenderer",
      "fulfillmentContent",
      "fulfilledLayout",
      "playerBytesAdLayoutRenderer",
      "renderingContent",
    );
    renderers.push(at(content, "instreamVideoAdRenderer"));
    for (const layout of list(at(content, "playerBytesSequentialLayoutRenderer", "sequentialLayouts"))) {
      renderers.push(at(layout, "playerBytesAdLayoutRenderer", "renderingContent", "instreamVideoAdRenderer"));
    }
  }
  let waitMs = 0;
  for (const renderer of renderers) {
    const skip = Number(at(renderer, "skipOffsetMilliseconds"));
    if (Number.isFinite(skip) && skip > 0) {
      waitMs += skip;
      continue;
    }
    const vars = at(renderer, "playerVars");
    const length = typeof vars === "string" ? Number(new URLSearchParams(vars).get("length_seconds")) : Number.NaN;
    if (Number.isFinite(length) && length > 0) waitMs += length * 1000;
  }
  return answeredAt + waitMs;
}

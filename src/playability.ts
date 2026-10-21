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

// Reason strings follow yt-dlp and NewPipe.
export function classifyPlayability(player: Json): Playability {
  const status = at(player, "playabilityStatus");
  const value = at(status, "status");
  if (value === "OK") return { ok: true };
  const reason = playabilityReason(status) || `status ${String(value)}`;
  const lower = reason.toLowerCase();
  const countries = at(player, "microformat", "playerMicroformatRenderer", "availableCountries");
  const fail = (
    code: YtdlErrorCode,
    extra: Partial<Pick<Playability & { ok: false }, "startTime" | "availableCountries">> = {},
  ) => ({ ok: false, code, reason, ...extra }) as const;

  if (value === "LIVE_STREAM_OFFLINE") {
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
  if (value === "AGE_CHECK_REQUIRED" || value === "AGE_VERIFICATION_REQUIRED" || lower.includes("confirm your age")) {
    return fail("AGE_RESTRICTED");
  }
  if (lower.includes("not a bot")) return fail("BOT_CHECK");
  if (lower.includes("private")) return fail("PRIVATE");
  if (lower.includes("premium")) return fail("PREMIUM_ONLY");
  if (lower.includes("members") || lower.includes("join this channel")) return fail("MEMBERS_ONLY");
  if (lower.includes("country") || lower.includes("your location")) {
    return fail(
      "REGION_BLOCKED",
      Array.isArray(countries) ? { availableCountries: countries.filter((c) => typeof c === "string") } : {},
    );
  }
  if (lower.includes("try again later") || lower.includes("too many requests")) return fail("RATE_LIMITED");
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

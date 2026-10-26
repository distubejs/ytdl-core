import { inspect } from "node:util";
import type { Client } from "./clients.ts";

/**
 * The `code` of every `YtdlError`.
 * @enum
 */
export const YtdlErrorCode = {
  /** The input is not a video ID, YouTube video URL or channel live URL. Thrown before any request. */
  INVALID_URL: "INVALID_URL",
  /** An option is invalid. Thrown before any request. */
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  /** Called on something that can't work, such as a disposed PO token provider. */
  INVALID_STATE: "INVALID_STATE",
  /**
   * The video does not exist or was removed, an ended live stream kept no recording, or a channel live URL names no
   * channel or no live stream.
   */
  NOT_FOUND: "NOT_FOUND",
  /** The video is private. */
  PRIVATE: "PRIVATE",
  /** The video needs the cookie of an age-verified account. */
  AGE_RESTRICTED: "AGE_RESTRICTED",
  /** The video is for channel members. */
  MEMBERS_ONLY: "MEMBERS_ONLY",
  /** The video needs YouTube Premium or a rental. */
  PREMIUM_ONLY: "PREMIUM_ONLY",
  /** The video is not available in this country; see `availableCountries`. */
  REGION_BLOCKED: "REGION_BLOCKED",
  /** A premiere or scheduled live stream that has not started; see `startTime`. */
  NOT_STARTED: "NOT_STARTED",
  /** YouTube asked to confirm this is not a bot. */
  BOT_CHECK: "BOT_CHECK",
  /** YouTube is rate limiting this IP. */
  RATE_LIMITED: "RATE_LIMITED",
  /** No client returned a playable format, or none matched the options. */
  NO_FORMAT: "NO_FORMAT",
  /** The video has no caption track in the requested language, or none at all. */
  NO_CAPTIONS: "NO_CAPTIONS",
  /** The player script could not be solved for signatures. */
  PLAYER_SOLVE_FAILED: "PLAYER_SOLVE_FAILED",
  /** YouTube treats the cookie as signed out. */
  AUTH_FAILED: "AUTH_FAILED",
  /** A request failed, or a download gave up after repeated failures. */
  REQUEST_FAILED: "REQUEST_FAILED",
} as const;

export type YtdlErrorCode = (typeof YtdlErrorCode)[keyof typeof YtdlErrorCode];

/** The stage of one client's lookup that failed. */
export type AttemptStep = "player" | "embed" | "visitor" | "po-token" | "request" | "playability" | "formats" | "solve";

/** One client's outcome inside a lookup, kept on the final error. */
export interface AttemptRecord {
  readonly client: Client;
  /** Whether the request carried the instance's `cookie`. */
  readonly signedIn: boolean;
  readonly step: AttemptStep;
  readonly code: YtdlErrorCode;
  readonly reason: string;
  /** The redacted error behind a thrown failure. */
  readonly cause?: unknown;
}

export interface YtdlErrorDetails {
  readonly attempts?: readonly AttemptRecord[];
  /** `NOT_STARTED`: the scheduled start, when the provider gives one. */
  readonly startTime?: Date;
  /** `REGION_BLOCKED`: ISO country codes allowed to play the video. */
  readonly availableCountries?: readonly string[];
  readonly cause?: unknown;
}

export class YtdlError extends Error {
  override readonly name = "YtdlError";
  readonly code: YtdlErrorCode;
  readonly attempts: readonly AttemptRecord[];
  readonly startTime: Date | undefined;
  readonly availableCountries: readonly string[] | undefined;

  constructor(code: YtdlErrorCode, message: string, details: YtdlErrorDetails = {}) {
    super(redact(message), details.cause === undefined ? undefined : { cause: redactCause(details.cause) });
    this.code = code;
    this.attempts = Object.freeze(
      (details.attempts ?? []).map(({ cause, ...attempt }) => ({
        ...attempt,
        reason: redact(attempt.reason),
        ...(cause === undefined ? {} : { cause: redactCause(cause) }),
      })),
    );
    this.startTime = details.startTime;
    this.availableCountries = details.availableCountries && Object.freeze([...details.availableCountries]);
  }

  static is(error: unknown, code?: YtdlErrorCode): error is YtdlError {
    return error instanceof YtdlError && (code === undefined || error.code === code);
  }
}

const SIGNED_PARAMS = /([?&](?:sig|signature|n|pot|lsig|s)=)[^&#\s"']*/giu;
const SIGNED_PATH_SEGMENTS = /(\/(?:sig|signature|n|pot|lsig|s)\/)(?!player\/)[^/?#\s"']*/giu;
// Process-wide, so secrets outlive their instance; key it per instance if that matters.
const SECRETS = new Set<string>();

export function registerSecret(secret: string): void {
  if (secret.length >= 8) SECRETS.add(secret);
}

export function redact(text: string): string {
  let out = text.replace(SIGNED_PARAMS, "$1[redacted]").replace(SIGNED_PATH_SEGMENTS, "$1[redacted]");
  for (const secret of SECRETS) out = out.split(secret).join("[redacted]");
  return out;
}

function redactCause(cause: unknown): unknown {
  if (typeof cause === "string") return redact(cause);
  if (cause instanceof YtdlError) return cause;
  const shown = inspect(cause, {
    depth: Infinity,
    showHidden: true,
    maxArrayLength: Infinity,
    maxStringLength: Infinity,
  });
  if (redact(shown) === shown) return cause;
  if (!(cause instanceof Error)) return new Error(redact(shown));
  const { code } = cause as { code?: unknown };
  return Object.assign(new Error(redact(cause.message)), { name: cause.name }, code === undefined ? {} : { code });
}

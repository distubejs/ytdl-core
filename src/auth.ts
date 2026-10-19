// Header format follows yt-dlp `_base.py` `_generate_cookie_auth_headers`.
import { createHash } from "node:crypto";
import { userAgentHeader, YOUTUBE_ORIGIN } from "./clients.ts";
import { YtdlError, registerSecret } from "./errors.ts";
import { abortable, fetchText } from "./http.ts";
import { str, ytcfg } from "./json.ts";

export function parseCookieHeader(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return cookies;
}

/** YouTube itself falls back to `__Secure-3PAPISID` when `SAPISID` is missing (yt-dlp#393). */
export function sapisidOf(cookies: ReadonlyMap<string, string>): string | undefined {
  return cookies.get("SAPISID") || cookies.get("__Secure-3PAPISID") || undefined;
}

interface Session {
  readonly dataSyncId: string | undefined;
  readonly userSessionId: string | undefined;
  readonly delegatedSessionId: string | undefined;
  readonly sessionIndex: string;
}

interface CookieAuthOptions {
  readonly cookie: string;
  readonly fetch: typeof fetch;
}

export class CookieAuth {
  readonly #cookie: string;
  readonly #sids: readonly (readonly [scheme: string, sid: string | undefined])[];
  readonly #fetch: typeof fetch;
  #session: Promise<Session> | undefined;

  constructor(options: CookieAuthOptions) {
    if (typeof options.cookie !== "string" || !sapisidOf(parseCookieHeader(options.cookie))) {
      throw new YtdlError("INVALID_ARGUMENT", "The cookie has no SAPISID or __Secure-3PAPISID value; it is signed out");
    }
    const cookies = parseCookieHeader(options.cookie);
    this.#cookie = options.cookie;
    this.#sids = [
      ["SAPISIDHASH", sapisidOf(cookies)],
      ["SAPISID1PHASH", cookies.get("__Secure-1PAPISID")],
      ["SAPISID3PHASH", cookies.get("__Secure-3PAPISID")],
    ];
    this.#fetch = options.fetch;
    registerSecret(options.cookie);
    for (const value of cookies.values()) registerSecret(value);
  }

  async headers(origin: string, signal?: AbortSignal): Promise<Readonly<Record<string, string>>> {
    const session = await abortable(this.#loadSession(), signal);
    const headers: Record<string, string> = {
      Cookie: this.#cookie,
      Authorization: this.#authorization(session.userSessionId, origin),
      "X-Origin": origin,
      "X-Goog-AuthUser": session.sessionIndex,
    };
    if (session.delegatedSessionId) headers["X-Goog-PageId"] = session.delegatedSessionId;
    return headers;
  }

  async dataSyncId(signal?: AbortSignal): Promise<string | undefined> {
    return (await abortable(this.#loadSession(), signal)).dataSyncId;
  }

  #authorization(userSessionId: string | undefined, origin: string): string {
    const timestamp = String(Math.round(Date.now() / 1000));
    const prefix = userSessionId ? `${userSessionId} ` : "";
    // YouTube hashes a user session ID first and adds the part name `u` as a suffix.
    const suffix = userSessionId ? "_u" : "";
    const authorizations: string[] = [];
    for (const [scheme, sid] of this.#sids) {
      if (!sid) continue;
      const hash = createHash("sha1").update(`${prefix}${timestamp} ${sid} ${origin}`).digest("hex");
      authorizations.push(`${scheme} ${timestamp}_${hash}${suffix}`);
    }
    return authorizations.join(" ");
  }

  #loadSession(): Promise<Session> {
    this.#session ??= this.#fetchSession().catch((error: unknown) => {
      this.#session = undefined;
      throw error;
    });
    return this.#session;
  }

  // The home page ytcfg carries `SESSION_INDEX` and `LOGGED_IN`, which an InnerTube `responseContext` lacks.
  async #fetchSession(): Promise<Session> {
    const page = await fetchText(
      this.#fetch,
      `${YOUTUBE_ORIGIN}/`,
      { headers: { Cookie: this.#cookie, ...userAgentHeader("web_creator") } },
      "The signed-in YouTube home page",
    );
    const config = ytcfg(page);
    if (config.LOGGED_IN === false) {
      throw new YtdlError("AUTH_FAILED", "YouTube treats the cookie as signed out; export a fresh one");
    }
    const field = (name: string) => str(config[name]) || undefined;
    const dataSyncId = field("DATASYNC_ID");
    // `DELEGATED||USER` on a secondary channel, `USER||` on the primary one.
    const [first, second] = (dataSyncId ?? "").split("||");
    const delegatedSessionId = field("DELEGATED_SESSION_ID") ?? (second ? first : undefined);
    const userSessionId = field("USER_SESSION_ID") ?? (second || first || undefined);
    if (dataSyncId) registerSecret(dataSyncId);
    return {
      dataSyncId,
      userSessionId,
      delegatedSessionId,
      sessionIndex: String(config.SESSION_INDEX ?? "0"),
    };
  }
}

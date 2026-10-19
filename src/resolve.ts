import { CLIENTS, type Client } from "./clients.ts";
import { type AttemptRecord, YtdlError, type YtdlErrorCode, type YtdlErrorDetails } from "./errors.ts";
import { parseFormats, type RawFormat, type SabrSource, sabrSession, sameFormat } from "./formats.ts";
import { abortable } from "./http.ts";
import { fetchEmbedContext, fetchVisitorData, type RequestContext, requestPlayer } from "./innertube.ts";
import { at, type Json } from "./json.ts";
import { classifyPlayability, prerollEnd } from "./playability.ts";
import type { CookieAuth } from "./auth.ts";
import { loadPlayer, type PreparedPlayer } from "./solver/index.ts";
import type { FormatMetadata, GetPoToken, VideoFormat } from "./types.ts";

export const BLOCK_PERIOD_MS = 10 * 60 * 1000;

interface Rung {
  readonly client: Client;
  readonly signedIn: boolean;
}

interface PlanConfig {
  readonly clients: readonly Client[];
  readonly cookie: boolean;
  readonly poToken: boolean;
}

export function planClients(config: PlanConfig, blocked: ReadonlyMap<Client, number>, now: number): Rung[] {
  const rungs = config.clients.flatMap((client): Rung[] => {
    const { account, poToken } = CLIENTS[client];
    if (poToken && !config.poToken) return [];
    if (account === "required") return config.cookie ? [{ client, signedIn: true }] : [];
    const anonymous = { client, signedIn: false };
    return account === "optional" && config.cookie ? [anonymous, { client, signedIn: true }] : [anonymous];
  });
  const isBlocked = (rung: Rung) => {
    const since = blocked.get(rung.client);
    return since !== undefined && now - since < BLOCK_PERIOD_MS;
  };
  return [...rungs.filter((rung) => !isBlocked(rung)), ...rungs.filter(isBlocked)];
}

export interface ResolverState {
  readonly fetch: typeof fetch;
  readonly lang: string | undefined;
  readonly country: string | undefined;
  readonly playerId: string | undefined;
  readonly clients: readonly Client[];
  readonly auth: CookieAuth | undefined;
  readonly getPoToken: GetPoToken | undefined;
  readonly blocked: Map<Client, number>;
  visitor: Promise<string> | undefined;
}

export function requestContext(state: ResolverState, signal: AbortSignal | undefined): RequestContext {
  return { fetch: state.fetch, lang: state.lang, country: state.country, signal };
}

export function visitorData(state: ResolverState, context: RequestContext): Promise<string> {
  if (!state.visitor) {
    const pending = fetchVisitorData({ ...context, signal: undefined });
    state.visitor = pending;
    pending.catch(() => {
      if (state.visitor === pending) state.visitor = undefined;
    });
  }
  return abortable(state.visitor, context.signal);
}

export function replaceVisitorData(
  state: ResolverState,
  context: RequestContext,
  stale: string | undefined,
): Promise<string> {
  const current = state.visitor;
  if (!current || stale === undefined) return fresh();
  const settle = (value: string | undefined) =>
    state.visitor === current && (value === undefined || value === stale) ? fresh() : visitorData(state, context);
  return abortable(
    current.then(settle, () => settle(undefined)),
    context.signal,
  );
  function fresh(): Promise<string> {
    state.visitor = undefined;
    return visitorData(state, context);
  }
}

export interface Resolution {
  readonly client: Client;
  readonly visitorData: string | undefined;
  readonly player: Json;
  readonly formats: readonly VideoFormat[];
  readonly hlsManifestUrl: string | undefined;
  readonly sabr: SabrSource | undefined;
  readonly expiresAt: number;
  readonly playableAt: number;
  readonly attempts: readonly AttemptRecord[];
}

interface ResolveOptions {
  readonly signal: AbortSignal | undefined;
  readonly format?: FormatMetadata;
  readonly prefer?: readonly Client[];
}

const DEFAULT_EXPIRY_MS = 5 * 60 * 60 * 1000;

function expiry(urls: readonly (string | undefined)[], now: number): number {
  for (const url of urls) {
    const expire = url === undefined ? Number.NaN : Number(new URL(url).searchParams.get("expire"));
    if (Number.isFinite(expire) && expire > 0) return expire * 1000;
  }
  return now + DEFAULT_EXPIRY_MS;
}

type Outcome = Pick<AttemptRecord, "code" | "reason"> &
  Pick<YtdlErrorDetails, "startTime" | "availableCountries" | "cause">;
type Attempt = AttemptRecord & Outcome;
type RungFailure = Outcome & { readonly visitorData?: string | undefined };

const records = (attempts: readonly Attempt[]): AttemptRecord[] =>
  attempts.map(({ client, code, reason }) => ({ client, code, reason }));

const OUTCOME_PRECEDENCE: readonly YtdlErrorCode[] = [
  "PRIVATE",
  "NOT_FOUND",
  "MEMBERS_ONLY",
  "PREMIUM_ONLY",
  "AGE_RESTRICTED",
  "REGION_BLOCKED",
  "NOT_STARTED",
  "AUTH_FAILED",
  "PLAYER_SOLVE_FAILED",
  "RATE_LIMITED",
  "BOT_CHECK",
  "NO_FORMAT",
  "REQUEST_FAILED",
];

function mostSpecific<T extends { readonly code: YtdlErrorCode }>(attempts: readonly T[]): T | undefined {
  let best: T | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const attempt of attempts) {
    const rank = OUTCOME_PRECEDENCE.indexOf(attempt.code);
    if (rank !== -1 && rank < bestRank) {
      best = attempt;
      bestRank = rank;
    }
  }
  return best;
}

function failure(attempts: readonly Attempt[], videoId: string, account: boolean): YtdlError {
  const best = mostSpecific(attempts);
  const code = best?.code ?? "NO_FORMAT";
  let message = `Could not play ${videoId}: ${best?.reason ?? "no client returned a playable answer"}`;
  if (code === "AGE_RESTRICTED" && !account) {
    message += ". This video needs a signed-in, age-verified account: pass `cookie` to new Ytdl().";
  }
  return new YtdlError(code, message, {
    attempts: records(attempts),
    ...(best?.startTime ? { startTime: best.startTime } : {}),
    ...(best?.availableCountries ? { availableCountries: best.availableCountries } : {}),
    ...(best?.cause === undefined ? {} : { cause: best.cause }),
  });
}

export async function resolvePlayback(
  state: ResolverState,
  videoId: string,
  options: ResolveOptions,
): Promise<Resolution> {
  const context = requestContext(state, options.signal);
  const attempts: Attempt[] = [];
  let rungs = planClients(
    { clients: state.clients, cookie: state.auth !== undefined, poToken: state.getPoToken !== undefined },
    state.blocked,
    Date.now(),
  );
  if (options.prefer) {
    const preferred = options.prefer.flatMap((client) => rungs.filter((rung) => rung.client === client));
    rungs = [...preferred, ...rungs.filter((rung) => !preferred.includes(rung))];
  }
  for (const rung of rungs) {
    options.signal?.throwIfAborted();
    const record = (code: AttemptRecord["code"], reason: string, extra: object = {}) =>
      attempts.push({ client: rung.client, code, reason, ...extra });
    let replacedVisitor = false;
    for (;;) {
      try {
        const result = await tryRung(state, context, rung, videoId, options);
        if ("formats" in result) {
          return { ...result, attempts: records(attempts) };
        }
        if (result.code === "BOT_CHECK" && !rung.signedIn && !replacedVisitor) {
          replacedVisitor = true;
          if (
            await replaceVisitorData(state, context, result.visitorData).then(
              () => true,
              () => false,
            )
          )
            continue;
        }
        record(result.code, result.reason, result);
      } catch (error) {
        options.signal?.throwIfAborted();
        if (YtdlError.is(error)) record(error.code, error.message, { cause: error });
        else record("REQUEST_FAILED", error instanceof Error ? error.message : String(error), { cause: error });
      }
      break;
    }
  }
  throw failure(attempts, videoId, state.auth !== undefined);
}

async function tryRung(
  state: ResolverState,
  context: RequestContext,
  rung: Rung,
  videoId: string,
  options: ResolveOptions,
): Promise<Omit<Resolution, "attempts"> | RungFailure> {
  const client = CLIENTS[rung.client];
  let player: PreparedPlayer | undefined;
  if (client.needsPlayer) {
    // The TV client answers "page needs to be reloaded" without a signature timestamp, even for metadata.
    player = await loadPlayer({ fetch: state.fetch, playerId: state.playerId, signal: options.signal });
  }
  const embed = client.embedded ? await fetchEmbedContext(context, videoId) : undefined;
  const dataSyncId = rung.signedIn ? await state.auth?.dataSyncId(options.signal) : undefined;
  // A signed-in request binds to the account's Data Sync ID instead of visitor data.
  const visitor = dataSyncId ?? embed?.visitorData ?? (await visitorData(state, context));
  const poToken =
    client.poToken && state.getPoToken
      ? await state.getPoToken({
          videoId: client.poToken === "video" ? videoId : "",
          client: rung.client,
          visitorData: rung.signedIn ? undefined : visitor,
          dataSyncId,
          signal: options.signal,
        })
      : undefined;
  const authHeaders = rung.signedIn ? await state.auth?.headers(client.origin, options.signal) : undefined;
  const response = await requestPlayer(context, {
    client: rung.client,
    videoId,
    visitorData: visitor,
    signatureTimestamp: player?.signatureTimestamp,
    poToken,
    authHeaders,
    embed,
  });
  const answeredAt = Date.now();
  const playability = classifyPlayability(response);
  if (!playability.ok) {
    if (rung.signedIn && playability.code === "BOT_CHECK") {
      return { code: "AUTH_FAILED", reason: `${playability.reason} (signed-in request was treated as logged out)` };
    }
    return { ...playability, visitorData: visitor };
  }
  const answeredId = at(response, "videoDetails", "videoId");
  if (answeredId !== videoId) {
    return { code: "REQUEST_FAILED", reason: `${client.name} answered for another video (${String(answeredId)})` };
  }
  const isLive = at(response, "videoDetails", "isLive") === true;
  const hls = at(response, "streamingData", "hlsManifestUrl");
  const hlsManifestUrl = typeof hls !== "string" ? undefined : player ? player.solveUrl({ url: hls }) : hls;
  const raw = parseFormats(response, rung.client);
  if (raw.length === 0 && !(isLive && hlsManifestUrl)) {
    return { code: "NO_FORMAT", reason: `${client.name} returned no downloadable format` };
  }
  const wanted = options.format;
  if (wanted && !wanted.isHLS && !raw.some((format) => sameFormat(format.metadata, wanted))) {
    return { code: "NO_FORMAT", reason: `${client.name} does not offer itag ${wanted.itag}` };
  }
  const formats = solve(raw, player, poToken);
  const session = formats.some((format) => format.url === undefined) ? sabrSession(response) : undefined;
  const sabr = session && { ...session, url: player ? player.solveUrl({ url: session.url }) : session.url };
  return {
    client: rung.client,
    visitorData: dataSyncId ? undefined : visitor,
    player: response,
    formats,
    hlsManifestUrl,
    sabr,
    expiresAt: expiry([...formats.map((format) => format.url), sabr?.url], Date.now()),
    playableAt: prerollEnd(response, answeredAt),
  };
}

function solve(
  raw: readonly RawFormat[],
  player: PreparedPlayer | undefined,
  poToken: string | undefined,
): VideoFormat[] {
  return raw.map((format) => {
    if (!format.url && !format.signatureCipher) return { ...format.metadata, url: undefined };
    let url = player ? player.solveUrl(format) : format.url;
    if (!url)
      throw new YtdlError("PLAYER_SOLVE_FAILED", `Format ${format.metadata.itag} is ciphered but no player was loaded`);
    if (poToken) {
      const signed = new URL(url);
      signed.searchParams.set("pot", poToken);
      url = signed.href;
    }
    return { ...format.metadata, url };
  });
}

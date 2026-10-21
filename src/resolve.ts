import { CLIENTS, type Client } from "./clients.ts";
import type { CookieAuth } from "./auth.ts";
import { type AttemptRecord, YtdlError, type YtdlErrorCode, type YtdlErrorDetails } from "./errors.ts";
import {
  type FormatMetadata,
  parseFormats,
  type SabrSource,
  sabrSession,
  sameFormat,
  type VideoFormat,
} from "./formats.ts";
import type { InnerTube } from "./innertube.ts";
import { at, type Json, str } from "./json.ts";
import { classifyPlayability, prerollEnd } from "./playability.ts";
import type { GetPoToken } from "./po-token/index.ts";
import { loadPlayer, type PreparedPlayer, type SignedUrl } from "./solver/index.ts";

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

export interface ResolverOptions {
  readonly innertube: InnerTube;
  readonly clients: readonly Client[];
  readonly auth: CookieAuth | undefined;
  readonly getPoToken: GetPoToken | undefined;
  readonly playerId: string | undefined;
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

export class Resolver {
  readonly #options: ResolverOptions;
  readonly #blocked = new Map<Client, number>();

  constructor(options: ResolverOptions) {
    this.#options = options;
  }

  block(client: Client): void {
    this.#blocked.set(client, Date.now());
  }

  async resolve(videoId: string, options: ResolveOptions): Promise<Resolution> {
    const { innertube, clients, auth, getPoToken } = this.#options;
    const attempts: Attempt[] = [];
    let rungs = planClients(
      { clients, cookie: auth !== undefined, poToken: getPoToken !== undefined },
      this.#blocked,
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
          const result = await this.#tryRung(rung, videoId, options);
          if ("formats" in result) {
            return { ...result, attempts: records(attempts) };
          }
          if (result.code === "BOT_CHECK" && !rung.signedIn && !replacedVisitor) {
            replacedVisitor = true;
            if (
              await innertube.replaceVisitorData(result.visitorData, options.signal).then(
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
    throw failure(attempts, videoId, auth !== undefined);
  }

  async #tryRung(
    rung: Rung,
    videoId: string,
    options: ResolveOptions,
  ): Promise<Omit<Resolution, "attempts"> | RungFailure> {
    const { innertube, auth, getPoToken, playerId } = this.#options;
    const { signal } = options;
    const client = CLIENTS[rung.client];
    let player: PreparedPlayer | undefined;
    if (client.needsPlayer) {
      // The TV client answers "page needs to be reloaded" without a signature timestamp, even for metadata.
      player = await loadPlayer({ fetch: innertube.fetch, playerId, signal });
    }
    const embed = client.embedded ? await innertube.embedContext(videoId, signal) : undefined;
    const dataSyncId = rung.signedIn ? await auth?.dataSyncId(signal) : undefined;
    // A signed-in request binds to the account's Data Sync ID instead of visitor data.
    const visitor = dataSyncId ?? embed?.visitorData ?? (await innertube.visitorData(signal));
    const poToken =
      client.poToken && getPoToken
        ? await getPoToken({ contentBinding: videoId, client: rung.client, signal })
        : undefined;
    const authHeaders = rung.signedIn ? await auth?.headers(client.origin, signal) : undefined;
    const response = await innertube.player(
      {
        client: rung.client,
        videoId,
        visitorData: visitor,
        signatureTimestamp: player?.signatureTimestamp,
        poToken,
        authHeaders,
        embed,
      },
      signal,
    );
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
    const hls = str(at(response, "streamingData", "hlsManifestUrl"));
    const raw = parseFormats(response, rung.client);
    if (raw.length === 0 && !(isLive && hls)) {
      return { code: "NO_FORMAT", reason: `${client.name} returned no downloadable format` };
    }
    const wanted = options.format;
    if (wanted && !wanted.isHLS && !raw.some((format) => sameFormat(format.metadata, wanted))) {
      return { code: "NO_FORMAT", reason: `${client.name} does not offer itag ${wanted.itag}` };
    }
    const session = raw.some((format) => !format.url && !format.signatureCipher) ? sabrSession(response) : undefined;
    const signed = raw.filter((format) => format.url || format.signatureCipher);
    const inputs: SignedUrl[] = [...signed, ...(hls ? [{ url: hls }] : []), ...(session ? [{ url: session.url }] : [])];
    if (!player && inputs.some((input) => input.signatureCipher)) {
      throw new YtdlError("PLAYER_SOLVE_FAILED", `${client.name} sent ciphered formats but no player was loaded`);
    }
    const outputs = player ? await player.solve(inputs) : inputs.map((input) => input.url);
    const urls = new Map(signed.map((format, index) => [format, outputs[index]]));
    const hlsManifestUrl = hls ? outputs[signed.length] : undefined;
    const sabrUrl = session ? outputs.at(-1) : undefined;
    const formats = raw.map((format): VideoFormat => {
      const url = urls.get(format) ?? format.url;
      return { ...format.metadata, url: url && poToken ? withPoToken(url, poToken) : url };
    });
    const sabr = session && sabrUrl ? { ...session, url: sabrUrl } : undefined;
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
}

function withPoToken(url: string, poToken: string): string {
  const signed = new URL(url);
  signed.searchParams.set("pot", poToken);
  return signed.href;
}

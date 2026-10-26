import { CLIENTS, type Client } from "./clients.ts";
import type { CookieAuth } from "./auth.ts";
import {
  type AttemptRecord,
  type AttemptStep,
  YtdlError,
  type YtdlErrorCode,
  type YtdlErrorDetails,
} from "./errors.ts";
import {
  type FormatMetadata,
  isPlayable,
  parseFormats,
  type SabrSource,
  sabrSession,
  sameFormat,
  type VideoFormat,
} from "./formats.ts";
import type { InnerTube } from "./innertube.ts";
import { at, type Json, str } from "./json.ts";
import { availableCountries, classifyPlayability, prerollEnd } from "./playability.ts";
import type { GetPoToken } from "./po-token/index.ts";
import { loadPlayer, type SignedUrl } from "./solver/index.ts";

const BLOCK_PERIOD_MS = 10 * 60 * 1000;

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

type Details = Pick<YtdlErrorDetails, "startTime" | "availableCountries">;
type Attempt = AttemptRecord & Details;
type RungFailure = Omit<Attempt, "client" | "signedIn"> & { readonly visitorData?: string | undefined };

const records = (attempts: readonly Attempt[]): AttemptRecord[] =>
  attempts.map(({ client, signedIn, step, code, reason, cause }) => ({ client, signedIn, step, code, reason, cause }));

const RANK: Readonly<Record<YtdlErrorCode, number>> = {
  PRIVATE: 0,
  MEMBERS_ONLY: 1,
  PREMIUM_ONLY: 2,
  REGION_BLOCKED: 3,
  NOT_STARTED: 4,
  NOT_FOUND: 5,
  PLAYER_SOLVE_FAILED: 6,
  INVALID_STATE: 7,
  AGE_RESTRICTED: 8,
  AUTH_FAILED: 9,
  RATE_LIMITED: 10,
  BOT_CHECK: 11,
  REQUEST_FAILED: 12,
  NO_FORMAT: 13,
  INVALID_URL: 14,
  INVALID_ARGUMENT: 14,
  NO_CAPTIONS: 14,
};

const credentialFailure = (attempt: Attempt) =>
  attempt.step === "po-token" || (attempt.signedIn && attempt.code === "AUTH_FAILED");
const anonymousUnplayable = (attempt: Attempt) =>
  !attempt.signedIn && attempt.step === "playability" && attempt.code === "NO_FORMAT";

function highest(attempts: readonly Attempt[]): Attempt | undefined {
  const rank = Math.min(...attempts.map((attempt) => RANK[attempt.code]));
  const tied = attempts.filter((attempt) => RANK[attempt.code] === rank);
  return tied.find((attempt) => attempt.availableCountries || attempt.startTime) ?? tied[0];
}

function mostSpecific(attempts: readonly Attempt[]): Attempt | undefined {
  const verdicts = attempts.filter((attempt) => !credentialFailure(attempt));
  const verdict = highest(verdicts);
  return verdict?.code === "NO_FORMAT" && verdicts.some(anonymousUnplayable) ? verdict : highest(attempts);
}

function failure(
  attempts: readonly Attempt[],
  best: Attempt | undefined,
  videoId: string,
  account: boolean,
  countries: readonly string[] | undefined,
): YtdlError {
  const code = best?.code ?? "NO_FORMAT";
  let message = `Could not play ${videoId}: ${best?.reason ?? "no client returned a playable answer"}`;
  if (code === "AGE_RESTRICTED" && !account) {
    const sentence = /[.!?]$/u.test(message) ? message : `${message}.`;
    message = `${sentence} This video needs a signed-in, age-verified account: pass \`cookie\` to new Ytdl().`;
  }
  const allowed = best?.availableCountries ?? countries;
  return new YtdlError(code, message, {
    attempts: records(attempts),
    ...(best?.startTime ? { startTime: best.startTime } : {}),
    ...(allowed ? { availableCountries: allowed } : {}),
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
      let replacedVisitor = false;
      for (;;) {
        const result = await this.#tryRung(rung, videoId, options);
        if ("formats" in result) return { ...result, attempts: records(attempts) };
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
        attempts.push({ client: rung.client, signedIn: rung.signedIn, ...result });
        break;
      }
    }
    const best = mostSpecific(attempts);
    const countries =
      best?.code === "REGION_BLOCKED" && !best.availableCountries
        ? await this.#regionCountries(videoId, options.signal)
        : undefined;
    throw failure(attempts, best, videoId, auth !== undefined, countries);
  }

  async #regionCountries(videoId: string, signal: AbortSignal | undefined): Promise<readonly string[] | undefined> {
    const { innertube } = this.#options;
    const metadata = await innertube
      .visitorData(signal)
      .then((visitor) => innertube.webMetadata(videoId, visitor, signal))
      .catch(() => undefined);
    signal?.throwIfAborted();
    return availableCountries(metadata);
  }

  async #tryRung(
    rung: Rung,
    videoId: string,
    options: ResolveOptions,
  ): Promise<Omit<Resolution, "attempts"> | RungFailure> {
    const { innertube, auth, getPoToken, playerId } = this.#options;
    const { signal } = options;
    const client = CLIENTS[rung.client];
    let step: AttemptStep = "player";
    try {
      // The TV client answers "page needs to be reloaded" without a signature timestamp, even for metadata.
      const player = client.needsPlayer ? await loadPlayer({ fetch: innertube.fetch, playerId, signal }) : undefined;
      step = "embed";
      const embed = client.embedded ? await innertube.embedContext(videoId, signal) : undefined;
      step = "visitor";
      const dataSyncId = rung.signedIn ? await auth?.dataSyncId(signal) : undefined;
      // A signed-in request binds to the account's Data Sync ID instead of visitor data.
      const visitor = dataSyncId ?? embed?.visitorData ?? (await innertube.visitorData(signal));
      step = "po-token";
      const poToken =
        client.poToken && getPoToken
          ? await getPoToken({ contentBinding: videoId, client: rung.client, signal })
          : undefined;
      step = "request";
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
        const { ok: _, ...outcome } = playability;
        if (rung.signedIn && outcome.code === "BOT_CHECK") {
          return {
            step: "playability",
            code: "AUTH_FAILED",
            reason: `${outcome.reason} (signed-in request was treated as logged out)`,
          };
        }
        return { step: "playability", ...outcome, visitorData: visitor };
      }
      const answeredId = at(response, "videoDetails", "videoId");
      if (answeredId !== videoId) {
        return {
          step: "request",
          code: "REQUEST_FAILED",
          reason: `${client.name} answered for another video (${String(answeredId)})`,
        };
      }
      step = "formats";
      const isLive = at(response, "videoDetails", "isLive") === true;
      const hls = str(at(response, "streamingData", "hlsManifestUrl"));
      const raw = parseFormats(response, rung.client);
      if (!raw.some((format) => isPlayable(format.metadata)) && !(isLive && hls)) {
        return { step, code: "NO_FORMAT", reason: `${client.name} returned no downloadable format` };
      }
      const wanted = options.format;
      if (wanted && !wanted.isHLS) {
        const offered = raw.filter((format) => sameFormat(format.metadata, wanted));
        if (offered.length === 0) {
          return { step, code: "NO_FORMAT", reason: `${client.name} does not offer itag ${wanted.itag}` };
        }
        if (
          wanted.contentLength !== undefined &&
          !offered.some((format) => format.metadata.contentLength === wanted.contentLength)
        ) {
          return { step, code: "NO_FORMAT", reason: `${client.name} serves another file as itag ${wanted.itag}` };
        }
      }
      step = "solve";
      const session = raw.some((format) => !format.url && !format.signatureCipher) ? sabrSession(response) : undefined;
      const signed = raw.filter((format) => format.url || format.signatureCipher);
      const inputs: SignedUrl[] = [
        ...signed,
        ...(hls ? [{ url: hls }] : []),
        ...(session ? [{ url: session.url }] : []),
      ];
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
    } catch (error) {
      signal?.throwIfAborted();
      return YtdlError.is(error)
        ? { step, code: error.code, reason: error.message, cause: error }
        : {
            step,
            code: "REQUEST_FAILED",
            reason: error instanceof Error ? error.message : String(error),
            cause: error,
          };
    }
  }
}

function withPoToken(url: string, poToken: string): string {
  const signed = new URL(url);
  signed.searchParams.set("pot", poToken);
  return signed.href;
}

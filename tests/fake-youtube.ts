import { readFileSync } from "node:fs";

export const PLAYER_JS = readFileSync(new URL("./fixtures/solver/player.js", import.meta.url), "utf8");
export const SIGNATURE_TIMESTAMP = 20123;
export const MEDIA_HOST = "https://rr1---sn-test.googlevideo.com/videoplayback";

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/innertube/${name}`, import.meta.url), "utf8"));
}

export interface PlayerCall {
  readonly client: string;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

export type PlayerHandler = (call: PlayerCall) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface FakeOptions {
  readonly player: PlayerHandler;
  readonly next?: Record<string, unknown>;
  readonly resolveUrl?: (url: string) => Response;
  readonly routes?: Record<string, () => Response>;
  readonly media?: (url: URL) => Response | undefined;
}

export const REQUEST_BUDGET = 2000;

export function visitorBody(visitor: string): string {
  return `)]}'\n${JSON.stringify([[null, null, [[[...Array.from({ length: 13 }, () => null), visitor]]]]])}`;
}

export function fakeYouTube(options: FakeOptions) {
  const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
  const playerCalls: PlayerCall[] = [];
  let visitors = 0;
  const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (requests.length >= REQUEST_BUDGET) throw new Error("fake request budget exceeded");
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, init });
    init?.signal?.throwIfAborted();
    const route = options.routes?.[url.split("&range=")[0] ?? url];
    if (route) return route();
    if (url === "https://www.youtube.com/sw.js_data") {
      visitors++;
      return new Response(visitorBody(`VISITOR-${visitors}`));
    }
    if (url === "https://www.youtube.com/iframe_api") {
      return new Response("var scriptUrl = 'https:\\/\\/www.youtube.com\\/s\\/player\\/fa4e0001\\/www-widgetapi.js';");
    }
    if (/\/s\/player\/\w+\/player_ias\.vflset\/en_US\/base\.js$/u.test(url)) return new Response(PLAYER_JS);
    if (url.startsWith("https://www.youtube.com/embed/")) {
      return new Response(
        `ytcfg.set({"VISITOR_DATA":"EMBED-VISITOR","WEB_PLAYER_CONTEXT_CONFIGS":{"WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER":{"encryptedHostFlags":"HOST-FLAGS"}}});`,
      );
    }
    if (url.startsWith("https://www.youtube.com/youtubei/v1/player")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const context = body.context as { client: { clientName: string } };
      const call = {
        client: context.client.clientName,
        body,
        headers: new Headers(init?.headers),
      };
      playerCalls.push(call);
      return Response.json(await options.player(call));
    }
    if (url.startsWith("https://www.youtube.com/youtubei/v1/next")) return Response.json(options.next ?? {});
    if (url.startsWith("https://www.youtube.com/youtubei/v1/navigation/resolve_url")) {
      const { url: target } = JSON.parse(String(init?.body)) as { url: string };
      return options.resolveUrl?.(target) ?? new Response("not found", { status: 404 });
    }
    return options.media?.(new URL(url)) ?? new Response("not found", { status: 404 });
  };
  return {
    fetch: fetchFake as typeof fetch,
    requests,
    playerCalls,
    clients: () => playerCalls.map((call) => call.client).filter((client) => client !== "WEB"),
    visitorFetches: () => visitors,
  };
}

export const VISIONOS = "VISIONOS";
export const TV = "TVHTML5";
export const WEB_EMBEDDED = "WEB_EMBEDDED_PLAYER";
export const MWEB = "MWEB";

const details = (videoId: string, extra: Record<string, unknown> = {}) => ({
  videoId,
  title: `Title of ${videoId}`,
  lengthSeconds: "100",
  author: "Channel",
  channelId: "UCchannel",
  ...extra,
});

export function audioFormat(itag: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itag,
    url: `${MEDIA_HOST}?itag=${itag}&expire=4102444800`,
    mimeType: 'audio/webm; codecs="opus"',
    bitrate: 130_000,
    contentLength: "4000",
    ...extra,
  };
}

export function playable(
  videoId: string,
  formats: readonly Record<string, unknown>[] = [audioFormat(251)],
  extra: Record<string, unknown> = {},
) {
  return {
    playabilityStatus: { status: "OK" },
    streamingData: { adaptiveFormats: formats },
    videoDetails: details(videoId),
    ...extra,
  };
}

// The TV client sends ciphered formats.
export function ciphered(videoId: string, itag = 251, extra: Record<string, unknown> = {}) {
  const url = `${MEDIA_HOST}?itag=${itag}&expire=4102444800&n=xyz`;
  const signatureCipher = new URLSearchParams({ s: "abcdef", sp: "sig", url }).toString();
  return playable(videoId, [{ ...audioFormat(itag), url: undefined, signatureCipher }], extra);
}

export function unplayable(status: string, reason: string, extra: Record<string, unknown> = {}) {
  return { playabilityStatus: { status, reason, ...extra } };
}

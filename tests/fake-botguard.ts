import { fakeYouTube, type PlayerHandler } from "./fake-youtube.ts";

const interpreter = (minted: string) => `
globalThis.fakeBotGuard = {
  a(program, setup) {
    if (typeof document === "undefined" || location.origin !== "https://www.youtube.com") throw new Error("no DOM");
    if (window.yt?.config_?.EVENT_ID !== "home-event") throw new Error("no home page ytcfg");
    document.createElement("canvas").getContext("2d");
    const text = (bytes) => new TextDecoder().decode(bytes);
    setup((done, [, , output]) => {
      output.push(async (integrity) => async (binding) => new TextEncoder().encode(${minted}));
      done("bg-response");
    }, () => {}, () => {}, () => {});
    return [() => "sync"];
  },
};`;
export const INTERPRETER = interpreter('text(integrity) + "|" + text(binding)');
export const USER_AGENT_INTERPRETER = interpreter('text(integrity) + "|" + navigator.userAgent');
export const CRASHING_INTERPRETER = `
setTimeout(() => { throw new Error("boom"); });
globalThis.fakeBotGuard = { a() { return []; } };`;

const escapeForScript = (json: string) => json.replace(/[{}"]/g, (char) => `\\x${char.charCodeAt(0).toString(16)}`);
export const homePage = (interpreterUrl: string) => {
  const atN = {
    responseContext: {},
    bgChallenge: {
      interpreterUrl: { privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: interpreterUrl },
      interpreterHash: "hash",
      program: "program",
      globalName: "fakeBotGuard",
    },
  };
  return `<script>ytcfg.set({"EVENT_ID":"home-event","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB"}}});</script>
<script>if (window.ytAtN) {window.ytAtN({'R': '${escapeForScript(JSON.stringify(atN))}','T': 'trust',})}</script>`;
};
export const HOME_PAGE_URL = "https://www.youtube.com/";
export const GENERATE_IT_URL = "https://www.youtube.com/api/jnn/v1/GenerateIT";

export function fakeBotGuard({
  ttl,
  threshold,
  interpreters = [],
  page = homePage("//www.google.com/js/th/fake.js"),
}: {
  ttl: number;
  threshold: number;
  interpreters?: string[];
  page?: string;
}) {
  const requests: string[] = [];
  const homePageHeaders: Headers[] = [];
  const stalled = Promise.withResolvers<AbortSignal | null | undefined>();
  let challenges = 0;
  let integrityTokens = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === fake.stall) {
      stalled.resolve(init?.signal);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    if (url === HOME_PAGE_URL) {
      homePageHeaders.push(new Headers(init?.headers));
      return new Response(page);
    }
    if (url === "https://www.google.com/js/th/fake.js") return new Response(interpreters[challenges++] ?? INTERPRETER);
    if (url === GENERATE_IT_URL && init?.body === '["O43z0dpjhgX20SCx4KAo","bg-response"]') {
      return Response.json([btoa(`it-${++integrityTokens}`), ttl, threshold, "fallback"]);
    }
    return new Response(null, { status: 400 });
  }) as typeof globalThis.fetch;
  const fake = { fetch, requests, homePageHeaders, stall: undefined as string | undefined, stalled: stalled.promise };
  return fake;
}

const BOTGUARD_URLS = new Set([HOME_PAGE_URL, "https://www.google.com/js/th/fake.js", GENERATE_IT_URL]);

export function youTubeWithBotGuard(
  player: PlayerHandler,
  onHomePage?: (pass: () => Promise<Response>) => Promise<Response>,
) {
  const botGuard = fakeBotGuard({ ttl: 3600, threshold: 300 });
  const yt = fakeYouTube({ player });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === HOME_PAGE_URL && onHomePage) return onHomePage(() => botGuard.fetch(input, init));
    return BOTGUARD_URLS.has(url) ? botGuard.fetch(input, init) : yt.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { fetch, botGuard, yt };
}

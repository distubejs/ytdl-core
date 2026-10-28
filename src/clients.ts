// YouTube rejects stale versions and device fields without notice. Values track yt-dlp
// `yt_dlp/extractor/youtube/_base.py`.
/**
 * The InnerTube clients `Ytdl` can ask, for the `clients` option.
 * @enum
 */
export const Client = {
  /** Apple Vision Pro app. Needs no player script. */
  VisionOS: "visionos",
  /** Embedded player on a third-party page. Accepts a cookie. */
  WebEmbedded: "web_embedded",
  /** Samsung Tizen TV app. Accepts a cookie. */
  Tv: "tv",
  /** Mobile website. Accepts a cookie; needs a PO token. */
  Mweb: "mweb",
  /** YouTube Studio. Needs a cookie and a PO token. */
  WebCreator: "web_creator",
} as const;

export type Client = (typeof Client)[keyof typeof Client];

/** The clients a `Ytdl` asks without a `clients` option, in order. */
export const DEFAULT_CLIENTS: readonly Client[] = [
  Client.VisionOS,
  Client.WebEmbedded,
  Client.Tv,
  Client.Mweb,
  Client.WebCreator,
];

export interface ClientDefinition {
  readonly name: string;
  readonly nameId: number;
  readonly version: string;
  readonly userAgent: string | undefined;
  readonly context: Readonly<Record<string, string | number>>;
  readonly origin: string;
  readonly needsPlayer: boolean;
  readonly poToken: boolean;
  readonly account: "none" | "optional" | "required";
  /** Asks with the visitor data and host flags of the video's embed page. */
  readonly embedded: boolean;
}

export const YOUTUBE_ORIGIN = "https://www.youtube.com";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)";

export const BROWSER: Readonly<Record<string, string>> = { "User-Agent": CHROME };

const base = {
  context: {},
  origin: YOUTUBE_ORIGIN,
  needsPlayer: true,
  poToken: false,
  account: "optional",
  embedded: false,
} as const;

export function userAgentHeader(client: Client | ClientDefinition): Readonly<Record<string, string>> {
  const { userAgent } = typeof client === "string" ? CLIENTS[client] : client;
  return userAgent ? { "User-Agent": userAgent } : {};
}

export const CLIENTS: Readonly<Record<Client, ClientDefinition>> = {
  visionos: {
    ...base,
    name: "VISIONOS",
    nameId: 101,
    version: "1.02",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    context: { deviceMake: "Apple", deviceModel: "RealityDevice17,1", osName: "visionOS", osVersion: "26.5.23O471" },
    needsPlayer: false,
    account: "none",
  },
  web_embedded: {
    ...base,
    name: "WEB_EMBEDDED_PLAYER",
    nameId: 56,
    version: "2.20260708.00.00",
    userAgent: SAFARI,
    embedded: true,
  },
  tv: {
    ...base,
    name: "TVHTML5",
    nameId: 7,
    version: "5.20260707",
    userAgent:
      "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1",
    context: { deviceMake: "Samsung", deviceModel: "UKS9800", osName: "Tizen", osVersion: "2.4.0" },
  },
  mweb: {
    ...base,
    name: "MWEB",
    nameId: 2,
    version: "2.20260708.05.00",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)",
    poToken: true,
  },
  web_creator: {
    ...base,
    name: "WEB_CREATOR",
    nameId: 62,
    version: "1.20260708.06.00",
    userAgent: CHROME,
    poToken: true,
    account: "required",
  },
};

export const WEB: ClientDefinition = {
  ...base,
  name: "WEB",
  nameId: 1,
  version: "2.20260708.00.00",
  userAgent: CHROME,
};

export const WEB_MUSIC: ClientDefinition = {
  ...base,
  name: "WEB_REMIX",
  nameId: 67,
  version: "1.20260707.12.00",
  userAgent: CHROME,
  origin: "https://music.youtube.com",
};

// YouTube rejects stale versions and device fields without notice. Values track yt-dlp
// `yt_dlp/extractor/youtube/_base.py`.
/**
 * The InnerTube clients `Ytdl` can ask, for the `clients` option.
 * @enum
 */
export const Client = {
  /** Apple Vision Pro app. Needs no player script. */
  VisionOS: "visionos",
  /** Samsung Tizen TV app. Accepts a cookie. */
  Tv: "tv",
  /** PlayStation 4 TV app. Accepts a cookie; needs `getPoToken`. */
  TvPs4: "tv_ps4",
  /** Simplified TV app. Needs `getPoToken`. */
  TvSimply: "tv_simply",
  /** Android app. */
  Android: "android",
  /** Android VR (Oculus) app. */
  AndroidVr: "android_vr",
  /** iOS app. */
  Ios: "ios",
  /** Mobile website. Accepts a cookie; needs `getPoToken`. */
  Mweb: "mweb",
  /** Desktop website in Chrome. Accepts a cookie. */
  Web: "web",
  /** Desktop website in Safari. Accepts a cookie. */
  WebSafari: "web_safari",
  /** Embedded player on a third-party page. Accepts a cookie. */
  WebEmbedded: "web_embedded",
  /** YouTube Music website. Accepts a cookie; needs `getPoToken`. */
  WebMusic: "web_music",
  /** YouTube Studio. Needs a cookie and `getPoToken`. */
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
  readonly poToken: "video" | "session" | undefined;
  readonly account: "none" | "optional" | "required";
  /** Asks with the visitor data and host flags of the video's embed page. */
  readonly embedded: boolean;
}

export const YOUTUBE_ORIGIN = "https://www.youtube.com";
const MUSIC_ORIGIN = "https://music.youtube.com";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)";

const base = {
  context: {},
  origin: YOUTUBE_ORIGIN,
  needsPlayer: true,
  poToken: undefined,
  account: "optional",
  embedded: false,
} as const;

export function userAgentHeader(client: Client): Readonly<Record<string, string>> {
  const { userAgent } = CLIENTS[client];
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
  tv: {
    ...base,
    name: "TVHTML5",
    nameId: 7,
    version: "5.20260707",
    userAgent:
      "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1",
    context: { deviceMake: "Samsung", deviceModel: "UKS9800", osName: "Tizen", osVersion: "2.4.0" },
  },
  // TVHTML5 7.x answers "page needs to be reloaded" to the Cobalt user agent without the tcl player's timestamp.
  tv_ps4: {
    ...base,
    name: "TVHTML5",
    nameId: 7,
    version: "7.20260707.07.00",
    userAgent:
      "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
    poToken: "session",
  },
  tv_simply: {
    ...base,
    name: "TVHTML5_SIMPLY",
    nameId: 75,
    version: "1.0",
    userAgent: undefined,
    poToken: "session",
    account: "none",
  },
  android: {
    ...base,
    name: "ANDROID",
    nameId: 3,
    version: "21.26.364",
    userAgent: "com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip",
    context: { androidSdkVersion: 30, osName: "Android", osVersion: "11" },
    needsPlayer: false,
    account: "none",
  },
  android_vr: {
    ...base,
    name: "ANDROID_VR",
    nameId: 28,
    version: "1.65.10",
    userAgent:
      "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    context: {
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      androidSdkVersion: 32,
      osName: "Android",
      osVersion: "12L",
    },
    needsPlayer: false,
    account: "none",
  },
  ios: {
    ...base,
    name: "IOS",
    nameId: 5,
    version: "21.26.4",
    userAgent: "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    context: { deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82" },
    needsPlayer: false,
    account: "none",
  },
  mweb: {
    ...base,
    name: "MWEB",
    nameId: 2,
    version: "2.20260708.05.00",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)",
    poToken: "video",
  },
  web: { ...base, name: "WEB", nameId: 1, version: "2.20260708.00.00", userAgent: CHROME },
  web_safari: { ...base, name: "WEB", nameId: 1, version: "2.20260708.00.00", userAgent: SAFARI },
  web_embedded: {
    ...base,
    name: "WEB_EMBEDDED_PLAYER",
    nameId: 56,
    version: "2.20260708.00.00",
    userAgent: SAFARI,
    embedded: true,
  },
  web_music: {
    ...base,
    name: "WEB_REMIX",
    nameId: 67,
    version: "1.20260707.12.00",
    userAgent: CHROME,
    origin: MUSIC_ORIGIN,
    poToken: "video",
  },
  web_creator: {
    ...base,
    name: "WEB_CREATOR",
    nameId: 62,
    version: "1.20260708.06.00",
    userAgent: CHROME,
    poToken: "video",
    account: "required",
  },
};

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

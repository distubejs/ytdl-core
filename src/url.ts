import { YtdlError } from "./errors.ts";

const ID = /^[\w-]{11}$/u;
const PLAYLIST_ID = /^(?!RD(?!CLAK5uy_))(?!UC[\w-]{22}$)[\w-]{12,64}$/u;
const CHANNEL_ID = /^UC[\w-]{22}$/u;
const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "gaming.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const PATH_PREFIXES = ["/shorts/", "/embed/", "/live/", "/v/", "/e/"];
const CHANNEL_LIVE = /^\/(?:@[^/]+|channel\/[\w-]+|c\/[^/]+|user\/[^/]+)\/live\/?$/u;
const CHANNEL_PAGE = /^\/(?:channel\/(UC[\w-]{22})|@[^/]+|c\/[^/]+|user\/[^/]+)\/?$/u;

function youtubeUrl(text: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//iu.test(text) ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const host = url.hostname.toLowerCase();
  return host === "youtu.be" || HOSTS.has(host) ? url : undefined;
}

/** The 11-character video ID of a bare ID or a YouTube watch, short, embed, live or `youtu.be` URL. */
export function parseVideoId(input: string): string | undefined {
  const text = input.trim();
  if (ID.test(text)) return text;
  const url = youtubeUrl(text);
  if (!url) return undefined;
  let candidate: string | undefined;
  if (url.hostname.toLowerCase() === "youtu.be") candidate = url.pathname.split("/")[1];
  else if (url.pathname === "/watch") candidate = url.searchParams.get("v") ?? undefined;
  else {
    const prefix = PATH_PREFIXES.find((p) => url.pathname.startsWith(p));
    if (prefix) candidate = url.pathname.slice(prefix.length).split("/")[0];
  }
  return candidate !== undefined && ID.test(candidate) ? candidate : undefined;
}

export type VideoTarget = { readonly id: string } | { readonly channelLive: string };

export function getVideoTarget(input: string): VideoTarget {
  const id = parseVideoId(input);
  if (id !== undefined) return { id };
  const url = youtubeUrl(input.trim());
  if (url && url.hostname.toLowerCase() !== "youtu.be" && CHANNEL_LIVE.test(url.pathname)) {
    return { channelLive: `https://www.youtube.com${url.pathname.replace(/\/$/u, "")}` };
  }
  throw new YtdlError("INVALID_URL", `Not a YouTube video URL, channel live URL or ID: ${input.slice(0, 200)}`);
}

/**
 * The playlist ID of a bare ID or a YouTube URL's `list` parameter; `undefined` for account lists such as `WL`, for
 * mixes, whose IDs start with `RD`, and for channels. YouTube Music's curated lists, which start with `RDCLAK5uy_`,
 * are playlists.
 */
export function parsePlaylistId(input: string): string | undefined {
  const text = typeof input === "string" ? input.trim() : "";
  const id = PLAYLIST_ID.test(text) ? text : youtubeUrl(text)?.searchParams.get("list");
  return id && PLAYLIST_ID.test(id) ? id : undefined;
}

export type PlaylistTarget = { readonly id: string } | { readonly channel: string };

export const uploads = (channelId: string) => `UU${channelId.slice(2)}`;

export function getPlaylistTarget(input: string): PlaylistTarget {
  const id = parsePlaylistId(input);
  if (id !== undefined) return { id };
  const text = typeof input === "string" ? input.trim() : "";
  if (CHANNEL_ID.test(text)) return { id: uploads(text) };
  const url = youtubeUrl(text);
  const page = url && url.hostname.toLowerCase() !== "youtu.be" ? CHANNEL_PAGE.exec(url.pathname) : null;
  if (url && page) {
    return page[1]
      ? { id: uploads(page[1]) }
      : { channel: `https://www.youtube.com${url.pathname.replace(/\/$/u, "")}` };
  }
  throw new YtdlError("INVALID_URL", `Not a YouTube playlist, channel or ID: ${String(input).slice(0, 200)}`);
}

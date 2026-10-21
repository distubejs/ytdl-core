import { userAgentHeader, WEB } from "./clients.ts";
import { YtdlError } from "./errors.ts";
import type { InnerTube } from "./innertube.ts";
import {
  at,
  collect,
  isRecord,
  type Json,
  list,
  num,
  parseAbbreviated,
  parseClock,
  str,
  text,
  thumbnails,
} from "./json.ts";
import type { Thumbnail } from "./info.ts";

/** One video in search results, a playlist or a related list. */
export interface VideoSummary {
  readonly id: string;
  readonly title: string;
  readonly author: { readonly id: string | undefined; readonly name: string | undefined };
  readonly lengthSeconds: number | undefined;
  readonly viewCount: number | undefined;
  readonly thumbnails: readonly Thumbnail[];
  readonly isLive: boolean;
}

export interface PlaylistInfo {
  readonly id: string;
  readonly url: string;
  readonly title: string | undefined;
  readonly author: VideoSummary["author"];
  readonly thumbnails: readonly Thumbnail[];
  /** Entries in playlist order, without the ones YouTube marks unplayable. */
  readonly videos: readonly VideoSummary[];
}

const SUGGEST_URL = "https://suggestqueries-clients6.youtube.com/complete/search";
const SUMMARY_KINDS = ["videoRenderer", "compactVideoRenderer", "playlistVideoRenderer", "lockupViewModel"];

export function checkQuery(query: string): void {
  if (typeof query !== "string" || query.trim() === "") {
    throw new YtdlError("INVALID_ARGUMENT", "query must be a non-empty string");
  }
}

export function checkLimit(limit: number | undefined): number | undefined {
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    throw new YtdlError("INVALID_ARGUMENT", "limit must be a positive integer");
  }
  return limit;
}

function byline(value: unknown): VideoSummary["author"] {
  return { id: str(at(value, "runs", 0, "navigationEndpoint", "browseEndpoint", "browseId")), name: text(value) };
}

function rendererSummary(renderer: Json): VideoSummary | undefined {
  const id = str(at(renderer, "videoId"));
  const title = text(at(renderer, "title"));
  if (!id || !title || at(renderer, "isPlayable") === false) return undefined;
  const isLive =
    collect(renderer, "metadataBadgeRenderer").some((badge) => /LIVE/u.test(String(at(badge, "style")))) ||
    collect(renderer, "thumbnailOverlayTimeStatusRenderer").some((overlay) => at(overlay, "style") === "LIVE") ||
    (at(renderer, "lengthText") === undefined &&
      at(renderer, "lengthSeconds") === undefined &&
      at(renderer, "upcomingEventData") === undefined);
  return {
    id,
    title,
    author: byline(at(renderer, "ownerText") ?? at(renderer, "longBylineText") ?? at(renderer, "shortBylineText")),
    lengthSeconds: isLive
      ? undefined
      : (num(at(renderer, "lengthSeconds")) ?? parseClock(text(at(renderer, "lengthText")))),
    viewCount: parseAbbreviated(text(at(renderer, "viewCountText")) ?? text(at(renderer, "shortViewCountText"))),
    thumbnails: thumbnails(at(renderer, "thumbnail", "thumbnails")),
    isLive,
  };
}

function lockupSummary(lockup: Json): VideoSummary | undefined {
  if (at(lockup, "contentType") !== "LOCKUP_CONTENT_TYPE_VIDEO") return undefined;
  const id = str(at(lockup, "contentId"));
  const metadata = at(lockup, "metadata", "lockupMetadataViewModel");
  const title = text(at(metadata, "title"));
  if (!id || !title) return undefined;
  const badges = collect(lockup, "thumbnailBadgeViewModel").map((badge) => str(at(badge, "text")) ?? "");
  // Rows are [channel] then [views, age]; the views part has no "views" word for music.
  const rows = at(metadata, "metadata", "contentMetadataViewModel", "metadataRows");
  const part = (row: number, index: number) => text(at(rows, row, "metadataParts", index, "text"));
  return {
    id,
    title,
    author: {
      id: str(collect(at(metadata, "image"), "browseEndpoint").map((endpoint) => at(endpoint, "browseId"))[0]),
      name: part(0, 0),
    },
    lengthSeconds: badges.map(parseClock).find((value) => value !== undefined),
    viewCount: parseAbbreviated(part(1, 0)),
    thumbnails: thumbnails(at(lockup, "contentImage", "thumbnailViewModel", "image", "sources")),
    isLive: badges.some((badge) => /^live$/iu.test(badge)),
  };
}

function summary(kind: string, value: Json): VideoSummary | undefined {
  return kind === "lockupViewModel" ? lockupSummary(value) : rendererSummary(value);
}

function summaries(value: unknown, found: VideoSummary[] = []): VideoSummary[] {
  if (Array.isArray(value)) {
    for (const item of value) summaries(item, found);
  } else if (isRecord(value)) {
    for (const [name, child] of Object.entries(value)) {
      if (SUMMARY_KINDS.includes(name) && isRecord(child)) {
        const video = summary(name, child);
        if (video) found.push(video);
      } else summaries(child, found);
    }
  }
  return found;
}

// Shelves nest videos inside a result, so only the section's own entries count.
function searchResults(page: Json): VideoSummary[] {
  return collect(page, "itemSectionRenderer").flatMap((section) =>
    list(at(section, "contents")).flatMap((item) =>
      SUMMARY_KINDS.flatMap((kind) => {
        const value = at(item, kind);
        const video = isRecord(value) ? summary(kind, value) : undefined;
        return video ? [video] : [];
      }),
    ),
  );
}

function withoutRepeats(videos: readonly VideoSummary[], seen = new Set<string>()): VideoSummary[] {
  return videos.filter((video) => {
    if (seen.has(video.id)) return false;
    seen.add(video.id);
    return true;
  });
}

export function relatedVideos(next: Json): VideoSummary[] {
  return withoutRepeats(summaries(next));
}

const appended = (page: Json) =>
  collect(page, "appendContinuationItemsAction").map((action) => list(at(action, "continuationItems")));

const searchLists = (page: Json) => [
  ...collect(page, "sectionListRenderer").map((section) => list(at(section, "contents"))),
  ...appended(page),
];
// A playlist page also carries a section-level continuation for recommendations, so only the entry list's own counts.
const playlistLists = (page: Json) => [
  ...[...collect(page, "itemSectionRenderer"), ...collect(page, "playlistVideoListRenderer")].map((section) =>
    list(at(section, "contents")),
  ),
  ...appended(page),
];

function continuation(lists: readonly (readonly unknown[])[]): string | undefined {
  return lists
    .flat()
    .map(
      (item) =>
        str(at(item, "continuationItemRenderer", "continuationEndpoint", "continuationCommand", "token")) ??
        str(
          at(
            item,
            "continuationItemViewModel",
            "continuationCommand",
            "innertubeCommand",
            "continuationCommand",
            "token",
          ),
        ),
    )
    .find((token) => token !== undefined);
}

// Caps a playlist at 100 000 entries, 100 a page; raise it if a real list is longer.
const MAX_PAGES = 1000;

interface Paging {
  readonly first: Json;
  readonly more: (continuation: string) => Promise<Json>;
  readonly entries: (page: Json) => readonly VideoSummary[];
  readonly lists: (page: Json) => readonly (readonly unknown[])[];
  readonly limit: number;
  readonly unique: boolean;
  readonly signal: AbortSignal | undefined;
}

async function collectPages({ first, more, entries, lists, limit, unique, signal }: Paging): Promise<VideoSummary[]> {
  const videos: VideoSummary[] = [];
  const seen = new Set<string>();
  const followed = new Set<string>();
  for (let page = first, pages = 1; ; pages++) {
    videos.push(...(unique ? withoutRepeats(entries(page), seen) : entries(page)));
    const token = continuation(lists(page));
    if (videos.length >= limit || !token || followed.has(token)) return videos.slice(0, limit);
    if (pages >= MAX_PAGES) throw new YtdlError("REQUEST_FAILED", `YouTube offered more than ${MAX_PAGES} pages`);
    followed.add(token);
    signal?.throwIfAborted();
    page = await more(token);
  }
}

export async function searchVideos(
  innertube: InnerTube,
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<VideoSummary[]> {
  const visitorData = await innertube.visitorData(signal);
  return collectPages({
    first: await innertube.search({ query }, visitorData, signal),
    more: (token) => innertube.search({ continuation: token }, visitorData, signal),
    entries: searchResults,
    lists: searchLists,
    limit,
    unique: true,
    signal,
  });
}

export async function browsePlaylist(
  innertube: InnerTube,
  id: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<PlaylistInfo> {
  const visitorData = await innertube.visitorData(signal);
  const first = await innertube.browse({ playlistId: id }, visitorData, signal);
  const metadata = collect(first, "playlistMetadataRenderer")[0];
  const header = collect(first, "playlistHeaderRenderer")[0];
  const pageHeader = collect(first, "pageHeaderViewModel")[0];
  if (!metadata && !header && !pageHeader && summaries(first).length === 0) {
    throw new YtdlError("NOT_FOUND", `Playlist ${id} does not exist`);
  }
  const videos = await collectPages({
    first,
    more: (token) => innertube.browse({ continuation: token }, visitorData, signal),
    entries: summaries,
    lists: playlistLists,
    limit,
    unique: false,
    signal,
  });
  return {
    id,
    url: `https://www.youtube.com/playlist?list=${id}`,
    title:
      text(at(metadata, "title")) ??
      text(at(header, "title")) ??
      text(at(pageHeader, "title", "dynamicTextViewModel", "text")),
    author: byline(at(collect(first, "videoOwnerRenderer")[0], "title") ?? at(header, "ownerText")),
    thumbnails: thumbnails(at(collect(first, "playlistVideoThumbnailRenderer")[0], "thumbnail", "thumbnails")),
    videos,
  };
}

export async function fetchSuggestions(
  innertube: InnerTube,
  query: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const url = new URL(SUGGEST_URL);
  url.search = new URLSearchParams({
    client: "youtube",
    ds: "yt",
    hl: innertube.lang,
    gl: innertube.country,
    q: query,
  }).toString();
  const what = "YouTube suggestions";
  const body = await innertube.text(url.href, { headers: userAgentHeader(WEB), signal }, what);
  let parsed: unknown;
  try {
    parsed = JSON.parse(/^[^(]*\((.*)\)\s*;?\s*$/su.exec(body)?.[1] ?? "");
  } catch (cause) {
    throw new YtdlError("REQUEST_FAILED", `${what} were not JSONP`, { cause });
  }
  const entries = at(parsed, 1);
  if (!Array.isArray(entries)) throw new YtdlError("REQUEST_FAILED", `${what} had no completions`);
  return entries.flatMap((entry) => str(at(entry, 0)) ?? []);
}

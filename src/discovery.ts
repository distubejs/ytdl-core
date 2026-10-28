import { type ClientDefinition, userAgentHeader, WEB, WEB_MUSIC } from "./clients.ts";
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
import { parsePlaylistId, parseVideoId } from "./url.ts";

/** One video in search results, a playlist or a related list. */
export interface VideoSummary {
  readonly id: string;
  /** `https://www.youtube.com/watch?v=<id>`. */
  readonly url: string;
  readonly title: string;
  readonly author: {
    readonly id: string | undefined;
    readonly name: string | undefined;
    /** The channel page. */
    readonly url: string | undefined;
    readonly thumbnails: readonly Thumbnail[];
    /** True when an owner badge marks the channel verified; false also when the answer shows no owner badges. */
    readonly verified: boolean;
    /** Owner badges as YouTube labels them, such as `Verified` or `Official Artist Channel`. */
    readonly badges: readonly string[];
  };
  readonly lengthSeconds: number | undefined;
  readonly viewCount: number | undefined;
  readonly thumbnails: readonly Thumbnail[];
  /** Labels such as `4K`, `CC` or `New`. */
  readonly badges: readonly string[];
  readonly isLive: boolean;
  readonly isUpcoming: boolean;
  /** A scheduled premiere's start in epoch milliseconds. */
  readonly upcomingAt: number | undefined;
}

/** One playlist in search results. */
export interface PlaylistSummary {
  readonly id: string;
  /** The URL {@link PlaylistInfo} carries. */
  readonly url: string;
  readonly title: string;
  readonly author: VideoSummary["author"];
  readonly videoCount: number | undefined;
  /** As YouTube words it, such as `Updated 2 days ago`. */
  readonly updatedText: string | undefined;
  readonly thumbnails: readonly Thumbnail[];
}

export interface PlaylistInfo {
  readonly id: string;
  readonly url: string;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly author: VideoSummary["author"];
  readonly thumbnails: readonly Thumbnail[];
  readonly videoCount: number | undefined;
  readonly viewCount: number | undefined;
  /** Entries in playlist order, without the ones YouTube marks unplayable. */
  readonly videos: readonly VideoSummary[];
}

/**
 * What `search` returns, for its `type` option.
 * @enum
 */
export const SearchType = {
  /** {@link VideoSummary} values. */
  Video: "video",
  /** {@link PlaylistSummary} values. */
  Playlist: "playlist",
  /** YouTube Music songs as {@link VideoSummary} values, with the artists as `author`. */
  Song: "song",
} as const;

export type SearchType = (typeof SearchType)[keyof typeof SearchType];

// Search params `EgIQAQ==` and `EgIQAw==` select the "Videos" and "Playlists" type filters; YouTube Music's
// `EgWKAQIIAWoKEAoQAxAEEAkQBQ==` selects "Songs", as in yt-dlp `YoutubeMusicSearchURLIE._SECTIONS`.
const FILTERS: Readonly<Record<SearchType, string>> = {
  video: "EgIQAQ%3D%3D",
  playlist: "EgIQAw%3D%3D",
  song: "EgWKAQIIAWoKEAoQAxAEEAkQBQ%3D%3D",
};
const YOUTUBE = "https://www.youtube.com";

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

const isSearchType = (value: unknown): value is SearchType => Object.values<unknown>(SearchType).includes(value);

export function checkSearchType(type: SearchType | undefined): SearchType {
  if (type === undefined) return SearchType.Video;
  if (!isSearchType(type)) throw new YtdlError("INVALID_ARGUMENT", "type must be a SearchType value");
  return type;
}

export function checkMusic(music: boolean | undefined): boolean {
  if (music !== undefined && typeof music !== "boolean") {
    throw new YtdlError("INVALID_ARGUMENT", "music must be a boolean");
  }
  return music ?? false;
}

export function checkRadioSeed(radioSeed: string | undefined, music: boolean): string | undefined {
  if (radioSeed === undefined) return undefined;
  if (!music) throw new YtdlError("INVALID_ARGUMENT", "radioSeed needs music: true");
  const id = typeof radioSeed === "string" ? parseVideoId(radioSeed) : undefined;
  if (!id) throw new YtdlError("INVALID_ARGUMENT", "radioSeed must be a video ID or URL");
  return id;
}

export function checkSafeSearch(safeSearch: boolean | undefined): boolean {
  if (safeSearch !== undefined && typeof safeSearch !== "boolean") {
    throw new YtdlError("INVALID_ARGUMENT", "safeSearch must be a boolean");
  }
  return safeSearch ?? false;
}

interface OwnerBadge {
  readonly label: string | undefined;
  readonly verified: boolean;
}

function owner(
  id: string | undefined,
  name: string | undefined,
  path: string | undefined,
  avatars: readonly Thumbnail[],
  badges: readonly OwnerBadge[],
): VideoSummary["author"] {
  return {
    id,
    name,
    url: path?.startsWith("/") ? `${YOUTUBE}${path}` : id ? `${YOUTUBE}/channel/${id}` : undefined,
    thumbnails: avatars,
    verified: badges.some((badge) => badge.verified),
    badges: badges.flatMap((badge) => badge.label ?? []),
  };
}

function byline(value: unknown, badges: readonly OwnerBadge[] = [], avatars: readonly Thumbnail[] = []) {
  const endpoint = at(value, "runs", 0, "navigationEndpoint");
  return owner(
    str(at(endpoint, "browseEndpoint", "browseId")),
    text(value),
    str(at(endpoint, "commandMetadata", "webCommandMetadata", "url")) ??
      str(at(endpoint, "browseEndpoint", "canonicalBaseUrl")),
    avatars,
    badges,
  );
}

const rendererOwnerBadges = (renderer: Json): OwnerBadge[] =>
  list(at(renderer, "ownerBadges")).map((badge) => {
    const meta = at(badge, "metadataBadgeRenderer");
    return {
      label: str(at(meta, "tooltip")) ?? str(at(meta, "accessibilityData", "label")),
      verified: /VERIFIED/u.test(String(at(meta, "style"))),
    };
  });

function lockupOwner(metadata: unknown): VideoSummary["author"] {
  const part = at(metadata, "metadata", "contentMetadataViewModel", "metadataRows", 0, "metadataParts", 0);
  const endpoint = at(part, "text", "commandRuns", 0, "onTap", "innertubeCommand");
  const icon = at(part, "icon");
  const image = at(metadata, "image");
  return owner(
    str(at(endpoint, "browseEndpoint", "browseId")) ??
      str(collect(image, "browseEndpoint").map((browse) => at(browse, "browseId"))[0]),
    text(at(part, "text")),
    str(at(endpoint, "browseEndpoint", "canonicalBaseUrl")) ??
      str(at(endpoint, "commandMetadata", "webCommandMetadata", "url")),
    thumbnails(collect(image, "avatarViewModel").map((avatar) => at(avatar, "image", "sources"))[0]),
    isRecord(icon)
      ? [
          {
            label: str(at(icon, "accessibilityLabel")),
            verified: /CHECK_CIRCLE|AUDIO_BADGE/u.test(String(at(icon, "name"))),
          },
        ]
      : [],
  );
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
  const startTime = num(at(renderer, "upcomingEventData", "startTime"));
  return {
    id,
    url: watchUrl(id),
    title,
    author: byline(
      at(renderer, "ownerText") ?? at(renderer, "longBylineText") ?? at(renderer, "shortBylineText"),
      rendererOwnerBadges(renderer),
      thumbnails(
        at(
          renderer,
          "channelThumbnailSupportedRenderers",
          "channelThumbnailWithLinkRenderer",
          "thumbnail",
          "thumbnails",
        ),
      ),
    ),
    lengthSeconds: isLive
      ? undefined
      : (num(at(renderer, "lengthSeconds")) ?? parseClock(text(at(renderer, "lengthText")))),
    viewCount: parseAbbreviated(text(at(renderer, "viewCountText")) ?? text(at(renderer, "shortViewCountText"))),
    thumbnails: thumbnails(at(renderer, "thumbnail", "thumbnails")),
    badges: list(at(renderer, "badges")).flatMap((badge) => str(at(badge, "metadataBadgeRenderer", "label")) ?? []),
    isLive,
    isUpcoming: at(renderer, "upcomingEventData") !== undefined,
    upcomingAt: startTime === undefined ? undefined : startTime * 1000,
  };
}

function lockupSummary(lockup: Json): VideoSummary | undefined {
  if (at(lockup, "contentType") !== "LOCKUP_CONTENT_TYPE_VIDEO") return undefined;
  const id = str(at(lockup, "contentId"));
  const metadata = at(lockup, "metadata", "lockupMetadataViewModel");
  const title = text(at(metadata, "title"));
  if (!id || !title) return undefined;
  const badges = collect(lockup, "thumbnailBadgeViewModel").map((badge) => str(at(badge, "text")) ?? "");
  const isLive = badges.some((badge) => /^live$/iu.test(badge));
  // Rows are [channel] then [views, age]; the views part has no "views" word for music.
  const rows = at(metadata, "metadata", "contentMetadataViewModel", "metadataRows");
  return {
    id,
    url: watchUrl(id),
    title,
    author: lockupOwner(metadata),
    lengthSeconds: badges.map(parseClock).find((value) => value !== undefined),
    viewCount: parseAbbreviated(text(at(rows, 1, "metadataParts", 0, "text"))),
    thumbnails: thumbnails(at(lockup, "contentImage", "thumbnailViewModel", "image", "sources")),
    badges: badges.filter((badge) => badge !== "" && parseClock(badge) === undefined && !/^live$/iu.test(badge)),
    isLive,
    isUpcoming: false,
    upcomingAt: undefined,
  };
}

// Byline and description rows carry a row extension, and video previews and "View full playlist" are links.
function playlistSummary(lockup: Json): PlaylistSummary | undefined {
  if (at(lockup, "contentType") !== "LOCKUP_CONTENT_TYPE_PLAYLIST") return undefined;
  const id = str(at(lockup, "contentId"));
  const metadata = at(lockup, "metadata", "lockupMetadataViewModel");
  const title = text(at(metadata, "title"));
  if (!id || !title || parsePlaylistId(id) !== id) return undefined;
  const updated = list(at(metadata, "metadata", "contentMetadataViewModel", "metadataRows"))
    .filter((row) => at(row, "lockupContentMetadataRowExtension") === undefined)
    .map((row) => at(row, "metadataParts", 0, "text"))
    .find((part) => part !== undefined && at(part, "commandRuns") === undefined);
  return {
    id,
    url: playlistUrl(id),
    title,
    author: lockupOwner(metadata),
    videoCount: parseAbbreviated(str(at(collect(lockup, "thumbnailBadgeViewModel")[0], "text"))),
    updatedText: text(updated),
    thumbnails: thumbnails(
      at(
        lockup,
        "contentImage",
        "collectionThumbnailViewModel",
        "primaryThumbnail",
        "thumbnailViewModel",
        "image",
        "sources",
      ),
    ),
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

// A YouTube Music byline lists the artists, then ` • ` and the album, year or length.
function artists(value: unknown): VideoSummary["author"] {
  const runs = list(at(value, "runs"));
  const end = runs.findIndex((run) => at(run, "text") === " • ");
  const names = end === -1 ? runs : runs.slice(0, end);
  return owner(
    names.map((run) => str(at(run, "navigationEndpoint", "browseEndpoint", "browseId"))).find(Boolean),
    text({ runs: names }),
    undefined,
    [],
    [],
  );
}

function musicSummary(
  id: string,
  title: string,
  credits: unknown,
  lengthSeconds: number | undefined,
  rest: Pick<VideoSummary, "viewCount" | "thumbnails" | "badges">,
): VideoSummary {
  return {
    id,
    url: watchUrl(id),
    title,
    author: artists(credits),
    lengthSeconds,
    ...rest,
    isLive: false,
    isUpcoming: false,
    upcomingAt: undefined,
  };
}

function songSummary(row: Json): VideoSummary | undefined {
  const id = str(at(row, "playlistItemData", "videoId"));
  const [title, credits, plays] = list(at(row, "flexColumns")).map((column) =>
    at(column, "musicResponsiveListItemFlexColumnRenderer", "text"),
  );
  const name = text(title);
  if (!id || !name) return undefined;
  return musicSummary(
    id,
    name,
    credits,
    list(at(credits, "runs"))
      .map((run) => parseClock(str(at(run, "text"))))
      .find((value) => value !== undefined),
    {
      viewCount: parseAbbreviated(text(plays)),
      thumbnails: thumbnails(at(row, "thumbnail", "musicThumbnailRenderer", "thumbnail", "thumbnails")),
      badges: list(at(row, "badges")).flatMap(
        (badge) => str(at(badge, "musicInlineBadgeRenderer", "accessibilityData", "accessibilityData", "label")) ?? [],
      ),
    },
  );
}

function radioSummary(entry: Json): VideoSummary | undefined {
  const id = str(at(entry, "videoId"));
  const title = text(at(entry, "title"));
  if (!id || !title) return undefined;
  return musicSummary(id, title, at(entry, "longBylineText"), parseClock(text(at(entry, "lengthText"))), {
    viewCount: undefined,
    thumbnails: thumbnails(at(entry, "thumbnail", "thumbnails")),
    badges: [],
  });
}

const watchUrl = (id: string) => `${YOUTUBE}/watch?v=${id}`;
const playlistUrl = (id: string) => `${YOUTUBE}/playlist?list=${id}`;

// Shelves nest videos inside a result, so only the section's own entries count.
const sectionItems = (page: Json) =>
  collect(page, "itemSectionRenderer").flatMap((section) => list(at(section, "contents")));

const videoResults = (page: Json): VideoSummary[] =>
  sectionItems(page).flatMap((item) =>
    SUMMARY_KINDS.flatMap((kind) => {
      const value = at(item, kind);
      const video = isRecord(value) ? summary(kind, value) : undefined;
      return video ? [video] : [];
    }),
  );

const playlistResults = (page: Json): PlaylistSummary[] =>
  sectionItems(page).flatMap((item) => {
    const lockup = at(item, "lockupViewModel");
    const playlist = isRecord(lockup) ? playlistSummary(lockup) : undefined;
    return playlist ? [playlist] : [];
  });

function withoutRepeats<T extends { readonly id: string }>(entries: readonly T[], seen = new Set<string>()): T[] {
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

export function relatedVideos(next: Json): VideoSummary[] {
  return withoutRepeats(summaries(next));
}

const appended = (page: Json) =>
  collect(page, "appendContinuationItemsAction").map((action) => list(at(action, "continuationItems")));

const musicShelves = (page: Json) => [
  ...collect(page, "musicShelfRenderer"),
  ...collect(page, "musicShelfContinuation"),
];

const songResults = (page: Json): VideoSummary[] =>
  musicShelves(page).flatMap((shelf) =>
    list(at(shelf, "contents")).flatMap((item) => {
      const row = at(item, "musicResponsiveListItemRenderer");
      const song = isRecord(row) ? songSummary(row) : undefined;
      return song ? [song] : [];
    }),
  );

const songLists = (page: Json) => musicShelves(page).map((shelf) => list(at(shelf, "continuations")));

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
        str(at(item, "nextContinuationData", "continuation")) ??
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

interface Paging<T> {
  readonly first: Json;
  readonly more: (continuation: string) => Promise<Json>;
  readonly entries: (page: Json) => readonly T[];
  readonly lists: (page: Json) => readonly (readonly unknown[])[];
  readonly limit: number;
  readonly unique: boolean;
  readonly signal: AbortSignal | undefined;
}

async function collectPages<T extends { readonly id: string }>({
  first,
  more,
  entries,
  lists,
  limit,
  unique,
  signal,
}: Paging<T>): Promise<T[]> {
  const videos: T[] = [];
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

export interface SearchRequest {
  readonly safeSearch: boolean;
  readonly limit: number;
  readonly signal: AbortSignal | undefined;
}

interface SearchKind<T> {
  readonly type: SearchType;
  readonly identity: ClientDefinition;
  readonly entries: (page: Json) => readonly T[];
  readonly lists: (page: Json) => readonly (readonly unknown[])[];
}

async function searchPages<T extends { readonly id: string }>(
  innertube: InnerTube,
  query: string,
  { type, identity, entries, lists }: SearchKind<T>,
  { safeSearch, limit, signal }: SearchRequest,
): Promise<T[]> {
  const visitorData = await innertube.visitorData(signal);
  const search = (page: Parameters<InnerTube["search"]>[1]) =>
    innertube.search(identity, page, safeSearch, visitorData, signal);
  return collectPages({
    first: await search({ query, params: FILTERS[type] }),
    more: (token) => search({ continuation: token }),
    entries,
    lists,
    limit,
    unique: true,
    signal,
  });
}

export const searchVideos = (innertube: InnerTube, query: string, request: SearchRequest) =>
  searchPages(
    innertube,
    query,
    { type: SearchType.Video, identity: WEB, entries: videoResults, lists: searchLists },
    request,
  );

export const searchPlaylists = (innertube: InnerTube, query: string, request: SearchRequest) =>
  searchPages(
    innertube,
    query,
    { type: SearchType.Playlist, identity: WEB, entries: playlistResults, lists: searchLists },
    request,
  );

export const searchSongs = (innertube: InnerTube, query: string, request: SearchRequest) =>
  searchPages(
    innertube,
    query,
    { type: SearchType.Song, identity: WEB_MUSIC, entries: songResults, lists: songLists },
    request,
  );

export async function musicRadio(
  innertube: InnerTube,
  videoId: string,
  seed: string,
  signal: AbortSignal | undefined,
): Promise<VideoSummary[]> {
  const visitorData = await innertube.visitorData(signal);
  const page = await innertube.musicRadio(videoId, `RDAMVM${seed}`, visitorData, signal);
  const entries = collect(page, "playlistPanelVideoRenderer").flatMap((entry) => radioSummary(entry) ?? []);
  return withoutRepeats(entries, new Set([videoId]));
}

export async function fetchMusicSuggestions(
  innertube: InnerTube,
  query: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const visitorData = await innertube.visitorData(signal);
  const page = await innertube.musicSuggestions(query, visitorData, signal);
  return collect(page, "searchSuggestionRenderer").flatMap(
    (suggestion) => str(at(suggestion, "navigationEndpoint", "searchEndpoint", "query")) ?? [],
  );
}

// The page header lists "Playlist", the video count and the view count as parts after its byline row.
function headerCounts(header: unknown, pageHeader: unknown): Pick<PlaylistInfo, "videoCount" | "viewCount"> {
  if (header !== undefined) {
    return {
      videoCount: parseAbbreviated(text(at(header, "numVideosText"))),
      viewCount: parseAbbreviated(text(at(header, "viewCountText"))),
    };
  }
  const [videos, views] = list(at(pageHeader, "metadata", "contentMetadataViewModel", "metadataRows"))
    .slice(1)
    .flatMap((row) => list(at(row, "metadataParts")))
    .flatMap((part) => text(at(part, "text")) ?? [])
    .filter((part) => /\d/u.test(part));
  return { videoCount: parseAbbreviated(videos), viewCount: parseAbbreviated(views) };
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
    url: playlistUrl(id),
    title:
      text(at(metadata, "title")) ??
      text(at(header, "title")) ??
      text(at(pageHeader, "title", "dynamicTextViewModel", "text")),
    description:
      str(at(metadata, "description")) ??
      text(at(pageHeader, "description", "descriptionPreviewViewModel", "description")) ??
      text(at(header, "descriptionText")),
    author: byline(at(collect(first, "videoOwnerRenderer")[0], "title") ?? at(header, "ownerText")),
    thumbnails: thumbnails(at(collect(first, "playlistVideoThumbnailRenderer")[0], "thumbnail", "thumbnails")),
    ...headerCounts(header, pageHeader),
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

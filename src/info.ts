import { at, collect, type Json, list, num, parseAbbreviated, parseClock, str, text, thumbnails } from "./json.ts";
import type { Author, CaptionTrack, Chapter, Storyboard, VideoDetails, VideoInfo, VideoSummary } from "./types.ts";

function author(player: Json, next: Json): Author {
  const details = at(player, "videoDetails");
  const micro = at(player, "microformat", "playerMicroformatRenderer");
  const owner = collect(next, "videoOwnerRenderer")[0];
  const id = str(at(details, "channelId")) ?? str(at(micro, "externalChannelId")) ?? "";
  const badges = collect(owner, "metadataBadgeRenderer");
  return {
    id,
    name: str(at(details, "author")) ?? str(at(micro, "ownerChannelName")) ?? text(at(owner, "title")) ?? "",
    url: str(at(micro, "ownerProfileUrl")) ?? (id ? `https://www.youtube.com/channel/${id}` : ""),
    thumbnails: thumbnails(at(owner, "thumbnail", "thumbnails")),
    verified: owner ? badges.some((badge) => /VERIFIED/u.test(String(at(badge, "style")))) : undefined,
    subscriberCount: parseAbbreviated(text(at(owner, "subscriberCountText"))),
  };
}

// The spec is one string of `|`-separated levels.
function storyboards(player: Json): Storyboard[] {
  const spec = str(at(player, "storyboards", "playerStoryboardSpecRenderer", "spec"));
  if (!spec) return [];
  const [base, ...levels] = spec.split("|");
  if (!base) return [];
  return levels.flatMap((level, index) => {
    const [width, height, count, columns, rows, interval, name, sigh] = level.split("#");
    const values = [width, height, count, columns, rows, interval].map(Number);
    if (values.some((value) => !Number.isFinite(value)) || !name || !sigh) return [];
    const [thumbnailWidth = 0, thumbnailHeight = 0, thumbnailCount = 0, cols = 1, rowCount = 1, ms = 0] = values;
    const url = new URL(base.replace("$L", String(index)).replace("$N", name));
    url.searchParams.set("sigh", sigh);
    return [
      {
        templateUrl: url.href.replaceAll("%24M", "$M"),
        thumbnailWidth,
        thumbnailHeight,
        thumbnailCount,
        interval: ms,
        columns: cols,
        rows: rowCount,
        storyboardCount: Math.ceil(thumbnailCount / (cols * rowCount)),
      },
    ];
  });
}

function chapters(next: Json): Chapter[] {
  const fromMarkers = collect(next, "chapterRenderer").flatMap((chapter) => {
    const title = text(at(chapter, "title"));
    const start = num(at(chapter, "timeRangeStartMillis"));
    return title !== undefined && start !== undefined ? [{ title, startTime: start / 1000 }] : [];
  });
  if (fromMarkers.length > 0) return fromMarkers;
  return collect(next, "macroMarkersListItemRenderer").flatMap((item) => {
    const title = text(at(item, "title"));
    const start =
      num(at(item, "onTap", "watchEndpoint", "startTimeSeconds")) ?? parseClock(text(at(item, "timeDescription")));
    return title !== undefined && start !== undefined ? [{ title, startTime: start }] : [];
  });
}

function likes(next: Json): number | undefined {
  for (const button of collect(next, "likeButtonViewModel")) {
    for (const label of collect(button, "buttonViewModel")) {
      const accessibility = str(at(label, "accessibilityText"));
      if (accessibility && /along with/iu.test(accessibility))
        return parseAbbreviated(accessibility.split(/along with/iu)[1]);
    }
  }
  return undefined;
}

function relatedVideos(next: Json): VideoSummary[] {
  const seen = new Set<string>();
  const out: VideoSummary[] = [];
  const add = (video: VideoSummary) => {
    if (seen.has(video.id)) return;
    seen.add(video.id);
    out.push(video);
  };
  for (const renderer of collect(next, "compactVideoRenderer")) {
    const id = str(at(renderer, "videoId"));
    const title = text(at(renderer, "title"));
    if (!id || !title) continue;
    const byline = at(renderer, "longBylineText", "runs", 0);
    add({
      id,
      title,
      author: {
        id: str(at(byline, "navigationEndpoint", "browseEndpoint", "browseId")),
        name: text(at(renderer, "longBylineText")),
      },
      lengthSeconds: parseClock(text(at(renderer, "lengthText"))),
      viewCount: parseAbbreviated(text(at(renderer, "viewCountText"))),
      thumbnails: thumbnails(at(renderer, "thumbnail", "thumbnails")),
      isLive: collect(renderer, "metadataBadgeRenderer").some((badge) => /LIVE/u.test(String(at(badge, "style")))),
    });
  }
  for (const lockup of collect(next, "lockupViewModel")) {
    if (at(lockup, "contentType") !== "LOCKUP_CONTENT_TYPE_VIDEO") continue;
    const id = str(at(lockup, "contentId"));
    const metadata = at(lockup, "metadata", "lockupMetadataViewModel");
    const title = text(at(metadata, "title"));
    if (!id || !title) continue;
    const badges = collect(lockup, "thumbnailBadgeViewModel").map((badge) => str(at(badge, "text")) ?? "");
    // Rows are [channel] then [views, age]; the views part has no "views" word for music.
    const rows = at(metadata, "metadata", "contentMetadataViewModel", "metadataRows");
    const part = (row: number, index: number) => text(at(rows, row, "metadataParts", index, "text"));
    add({
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
    });
  }
  return out;
}

interface DetailsContext {
  readonly ageRestricted: boolean;
}

function videoDetails(player: Json, next: Json, context: DetailsContext): VideoDetails {
  const details = at(player, "videoDetails");
  const micro = at(player, "microformat", "playerMicroformatRenderer");
  const id = str(at(details, "videoId")) ?? "";
  const countries = at(micro, "availableCountries");
  const keywords = at(details, "keywords");
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: str(at(details, "title")) ?? text(at(micro, "title")) ?? "",
    description: str(at(details, "shortDescription")) ?? text(at(micro, "description")),
    lengthSeconds: num(at(details, "lengthSeconds")) ?? 0,
    viewCount: num(at(details, "viewCount")),
    likes: likes(next),
    publishDate: str(at(micro, "publishDate")),
    uploadDate: str(at(micro, "uploadDate")),
    keywords: Array.isArray(keywords) ? keywords.filter((word): word is string => typeof word === "string") : [],
    category: str(at(micro, "category")),
    thumbnails: thumbnails(at(details, "thumbnail", "thumbnails")),
    author: author(player, next),
    isLive: at(details, "isLive") === true,
    isUpcoming: at(details, "isUpcoming") === true,
    isUnlisted: typeof at(micro, "isUnlisted") === "boolean" ? (at(micro, "isUnlisted") as boolean) : undefined,
    isFamilySafe: typeof at(micro, "isFamilySafe") === "boolean" ? (at(micro, "isFamilySafe") as boolean) : undefined,
    isAgeRestricted: context.ageRestricted,
    availableCountries: Array.isArray(countries)
      ? countries.filter((c): c is string => typeof c === "string")
      : undefined,
    chapters: chapters(next),
    storyboards: storyboards(player),
  };
}

function captionTracks(player: Json): CaptionTrack[] {
  const renderer = at(player, "captions", "playerCaptionsTracklistRenderer");
  const audioTrack = at(renderer, "audioTracks", num(at(renderer, "defaultAudioTrackIndex")) ?? 0);
  const defaultIndex = num(at(audioTrack, "defaultCaptionTrackIndex"));
  return list(at(renderer, "captionTracks")).flatMap((track, index) => {
    const url = str(at(track, "baseUrl"));
    const languageCode = str(at(track, "languageCode"));
    if (!url || !languageCode) return [];
    return [
      {
        languageCode,
        name: text(at(track, "name")) ?? languageCode,
        isAutoGenerated: at(track, "kind") === "asr",
        isDefault: index === defaultIndex,
        url,
      },
    ];
  });
}

export type InfoBase = Pick<VideoInfo, "videoDetails" | "relatedVideos" | "playerResponse" | "captionTracks">;

export function basicInfo(player: Json, next: Json, context: DetailsContext): InfoBase {
  return {
    videoDetails: videoDetails(player, next, context),
    relatedVideos: relatedVideos(next),
    playerResponse: player,
    captionTracks: captionTracks(player),
  };
}

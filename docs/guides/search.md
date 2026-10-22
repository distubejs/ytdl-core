---
title: Search
description: Search videos and playlists, list related videos and get search suggestions.
sidebar:
  order: 4
---

Search results, playlist entries and related videos are all [`VideoSummary`](../../api/interfaces/videosummary/) values:

```ts
{
  id, url, title,
  author: { id, name, url, thumbnails, verified, badges },
  lengthSeconds, viewCount, thumbnails, badges, isLive, isUpcoming, upcomingAt,
}
```

A field YouTube leaves out is `undefined`, and a missing badge list is `[]`. A live video has `isLive: true` and no `lengthSeconds`. A scheduled premiere has `isUpcoming: true` and its start in `upcomingAt`, in epoch milliseconds. `badges` holds labels such as `4K` or `CC`; `author.badges` holds owner labels such as `Official Artist Channel`, and `author.verified` is true when one of them marks the channel verified. Pass `id` to `getInfo` or `download` to play one.

## Search

```ts
const videos = await yt.search("blender open movie");
const more = await yt.search("blender open movie", { limit: 50 });
```

`search` returns videos in YouTube's order, 20 unless `limit` says otherwise. It fetches more result pages until it has `limit` videos or YouTube runs out, and never repeats a video. Channels, playlists, shelves and Shorts shelves are left out. A query nothing matches resolves to `[]`.

### Playlists

```ts
import { SearchType } from "@distube/ytdl-core";

const playlists = await yt.search("lofi hip hop", { type: SearchType.Playlist, limit: 5 });
const playlist = await yt.getPlaylist(playlists[0].id);
```

`type: SearchType.Playlist` returns [`PlaylistSummary`](../../api/interfaces/playlistsummary/) values, paged and capped the same way:

```ts
{
  (id, url, title, author, videoCount, updatedText, thumbnails);
}
```

`author` has the video author shape. `updatedText` is YouTube's own wording, such as `Updated 2 days ago`, in the instance's `lang` and `utcOffsetMinutes`. Mixes are left out because `getPlaylist` cannot expand them. `SearchType.Video` is the default.

### Safe search

```ts
const videos = await yt.search("nasa", { safeSearch: true });
```

`safeSearch: true` asks YouTube for Restricted Mode results on every page, for either type. YouTube decides what it filters.

## Related videos

```ts
const related = await yt.getRelated("aqz-KE-bpKQ");
```

`getRelated` returns the same list as `getInfo(...).relatedVideos` from one request, without resolving formats. It takes the same input as `getInfo`.

## Suggestions

```ts
const completions = await yt.getSuggestions("blender open"); // ["blender open movie", ...]
```

The completions come in YouTube's order, in the instance's `lang` and `country`.

## Errors

| Code               | When                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT` | A blank query, a `limit` that is not a positive integer, a `type` that is not a `SearchType` or a `safeSearch` that is not a boolean. No request. |
| `RATE_LIMITED`     | YouTube answered HTTP 429.                                                                                                                        |
| `REQUEST_FAILED`   | Any other failed request or unreadable answer.                                                                                                    |

## Cancel

Every method takes a `signal`. Aborting it between result pages rejects with the signal's reason and requests no further page.

```ts
const videos = await yt.search("nasa", { limit: 100, signal: AbortSignal.timeout(10_000) });
```

## Session

Search and related videos share the instance's visitor data with `getInfo`. They never send the `cookie`, so searches are not tied to the account.

---
title: Search
description: Search videos, playlists and YouTube Music songs, list related videos or a song's radio, and get search suggestions.
sidebar:
  order: 5
---

Search results, playlist entries and related videos are all [`VideoSummary`](../../api/interfaces/videosummary/) values:

| Field                                | Holds                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `id`, `url`, `title`                 | The video. Pass `id` to `getInfo` or `download` to play it.                                                       |
| `author`                             | `id`, `name`, `url`, `thumbnails`, `verified` and `badges`. `verified` is true when an owner badge marks it so.   |
| `lengthSeconds`, `viewCount`         | Numbers. A live video has no `lengthSeconds`.                                                                     |
| `thumbnails`                         | A list of images.                                                                                                 |
| `badges`                             | Labels such as `4K` or `CC`. `author.badges` holds owner labels such as `Official Artist Channel`.                |
| `isLive`, `isUpcoming`, `upcomingAt` | A live video has `isLive: true`. A scheduled premiere has `isUpcoming: true` and its start in epoch milliseconds. |

A field YouTube leaves out is `undefined`, and a missing badge list is `[]`.

## Search

```ts
import { Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const videos = await yt.search("blender open movie");
const more = await yt.search("blender open movie", { limit: 50 });
```

`search` returns videos in YouTube's order, 20 unless `limit` says otherwise. It fetches more result pages until it has `limit` videos or YouTube runs out, and never repeats a video. Channels, playlists, shelves and Shorts shelves are left out. A query nothing matches resolves to `[]`.

### Playlists

```ts
import { SearchType, Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const playlists = await yt.search("lofi hip hop", { type: SearchType.Playlist, limit: 5 });
const playlist = await yt.getPlaylist(playlists[0].id);
```

`type: SearchType.Playlist` returns [`PlaylistSummary`](../../api/interfaces/playlistsummary/) values, paged and capped the same way. Each has `id`, `url`, `title`, `author`, `videoCount`, `updatedText` and `thumbnails`.

`author` has the video author shape. `updatedText` is YouTube's own wording, such as `Updated 2 days ago`, in the instance's `lang` and `utcOffsetMinutes`. Mixes are left out, because `getPlaylist` cannot expand them. `SearchType.Video` is the default.

### Safe search

```ts
import { Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const videos = await yt.search("nasa", { safeSearch: true });
```

`safeSearch: true` asks YouTube for Restricted Mode results on every page, for either type. YouTube decides what it filters.

### YouTube Music songs

```ts
import { SearchType, Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const songs = await yt.search("kevin macleod", { type: SearchType.Song, limit: 30 });
```

`type: SearchType.Song` searches YouTube Music's songs instead of YouTube's videos. The results are `VideoSummary` values, paged, capped and never repeated the same way, with these differences:

- `author.name` lists the song's artists as YouTube Music shows them, such as `First Artist & Second Artist`. `author.id` and `author.url` are the first artist's channel.
- `viewCount` is the play count.
- `badges` holds labels such as `Explicit`.
- A song is never live or upcoming.

Albums, artists, playlists and music videos are left out. A song's `id` is an ordinary video ID, so `getInfo` and `download` play it.

## Related videos

```ts
import { Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const related = await yt.getRelated("aqz-KE-bpKQ");
```

`getRelated` returns the same list as `getInfo(...).relatedVideos` from one request, without looking up formats. It takes the same input as `getInfo`.

### A song's radio

```ts
import { Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const radio = await yt.getRelated("4jTzgLFd5_4", { music: true });
const next = await yt.getRelated(radio[0].id, { music: true, radioSeed: "4jTzgLFd5_4" });
```

`music: true` returns the song's YouTube Music radio instead, from one request, without the song itself. Entries have the artists as `author` and no `viewCount`. YouTube Music shuffles a radio, so two calls for one song can return different orders.

A radio started from each new song drifts away from the first one. To stay on one radio, pass the song that started it as `radioSeed`: the answer is that radio, positioned at the video you ask for. `radioSeed` takes the same input as `getInfo` and needs `music: true`.

## Suggestions

```ts
import { Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const completions = await yt.getSuggestions("blender open"); // ["blender open movie", ...]
```

The completions come in YouTube's order, in the instance's `lang` and `country`. `getSuggestions(query, { music: true })` returns YouTube Music's completions instead, without the songs and artists YouTube Music suggests beside them.

## Errors

| Code               | When                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT` | A blank query, a `limit` that is not a positive integer, a `type` that is not a `SearchType`, a `safeSearch` or `music` that is not a boolean, or a `radioSeed` without `music: true` or that is no video. No request. |
| `RATE_LIMITED`     | YouTube answered HTTP 429.                                                                                                                                                                                             |
| `REQUEST_FAILED`   | Any other failed request or unreadable answer.                                                                                                                                                                         |

## Cancel

Every method takes a `signal`. Aborting it between result pages rejects with the signal's reason and requests no further page.

```ts
import { Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const videos = await yt.search("nasa", { limit: 100, signal: AbortSignal.timeout(10_000) });
```

## Session

Search, related videos and [playlists](../playlists/) use the same YouTube session as `getInfo`, and so do the YouTube Music calls. None of them, suggestions included, sends the cookie, so they are not tied to your account.

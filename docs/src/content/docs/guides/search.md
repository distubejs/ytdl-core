---
title: Search and playlists
description: Search videos, expand playlists, list related videos and get search suggestions.
---

Search results, playlist entries and related videos are all [`VideoSummary`](../../api/interfaces/videosummary/) values:

```ts
{ id, title, author: { id, name }, lengthSeconds, viewCount, thumbnails, isLive }
```

A field YouTube leaves out is `undefined`. A live video has `isLive: true` and no `lengthSeconds`. Pass `id` to `getInfo` or `download` to play one.

## Search

```ts
const videos = await yt.search("blender open movie");
const more = await yt.search("blender open movie", { limit: 50 });
```

`search` returns videos in YouTube's order, 20 unless `limit` says otherwise. It fetches more result pages until it has `limit` videos or YouTube runs out, and never repeats a video. Channels, playlists, shelves and Shorts shelves are left out. A query nothing matches resolves to `[]`.

## Playlists

```ts
const playlist = await yt.getPlaylist("PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5");
const url = "https://www.youtube.com/watch?v=SAPaWLQbU_s&list=PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5";
const firstTen = await yt.getPlaylist(url, { limit: 10 });

playlist.title;
playlist.author.name;
playlist.videos; // VideoSummary[], in playlist order
```

`getPlaylist` takes a playlist ID or any YouTube URL with a `list` parameter. Without `limit` it collects every entry, 100 per request, so a long playlist takes many requests; set `limit` when you need only the start. Private and deleted entries are left out. See [`PlaylistInfo`](../../api/interfaces/playlistinfo/) for every field.

Before choosing between a video and a playlist, `parsePlaylistId` reads the `list` parameter the way `getPlaylist` does:

```ts
import { parsePlaylistId } from "@distube/ytdl-core";

parsePlaylistId("https://www.youtube.com/watch?v=SAPaWLQbU_s&list=PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5"); // "PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5"
parsePlaylistId("https://www.youtube.com/watch?v=SAPaWLQbU_s&list=WL"); // undefined
```

Account lists such as `WL` (Watch later) need a signed-in session, so they read as no playlist.

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

| Code               | When                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `INVALID_ARGUMENT` | A blank query, or a `limit` that is not a positive integer. No request.  |
| `INVALID_URL`      | `getPlaylist` input that is neither a playlist ID nor a URL with `list`. |
| `NOT_FOUND`        | The playlist does not exist.                                             |
| `RATE_LIMITED`     | YouTube answered HTTP 429.                                               |
| `REQUEST_FAILED`   | Any other failed request or unreadable answer.                           |

## Cancel

Every method takes a `signal`. Aborting it between result pages rejects with the signal's reason and requests no further page.

```ts
const videos = await yt.search("nasa", { limit: 100, signal: AbortSignal.timeout(10_000) });
```

## Session

Search, playlists and related videos share the instance's visitor data with `getInfo`. They never send the `cookie`, so searches are not tied to the account.

---
title: Playlists
description: Expand playlists and parse playlist IDs.
sidebar:
  order: 5
---

```ts
const playlist = await yt.getPlaylist("PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5");
const url = "https://www.youtube.com/watch?v=SAPaWLQbU_s&list=PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5";
const firstTen = await yt.getPlaylist(url, { limit: 10 });

playlist.title;
playlist.author.name;
playlist.videos; // VideoSummary[], in playlist order
```

`getPlaylist` takes a playlist ID or any YouTube URL with a `list` parameter. Without `limit` it collects every entry, 100 per request, so a long playlist takes many requests; set `limit` when you need only the start. Private and deleted entries are left out. See [`PlaylistInfo`](../../api/interfaces/playlistinfo/) for every field.

Entries have the [`VideoSummary`](../search/) shape described on the search page.

Before choosing between a video and a playlist, `parsePlaylistId` reads the `list` parameter the way `getPlaylist` does:

```ts
import { parsePlaylistId } from "@distube/ytdl-core";

parsePlaylistId("https://www.youtube.com/watch?v=SAPaWLQbU_s&list=PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5"); // "PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5"
parsePlaylistId("https://www.youtube.com/watch?v=SAPaWLQbU_s&list=WL"); // undefined
```

Account lists such as `WL` (Watch later) need a signed-in session, so they read as no playlist.

## Errors

| Code               | When                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `INVALID_ARGUMENT` | A `limit` that is not a positive integer. No request.                    |
| `INVALID_URL`      | `getPlaylist` input that is neither a playlist ID nor a URL with `list`. |
| `NOT_FOUND`        | The playlist does not exist.                                             |
| `RATE_LIMITED`     | YouTube answered HTTP 429.                                               |
| `REQUEST_FAILED`   | Any other failed request or unreadable answer.                           |

## Cancel

Aborting the `signal` between pages rejects with the signal's reason and requests no further page.

```ts
const playlist = await yt.getPlaylist("PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5", {
  limit: 100,
  signal: AbortSignal.timeout(10_000),
});
```

## Session

Playlists share the instance's visitor data with `getInfo`. They never send the `cookie`.

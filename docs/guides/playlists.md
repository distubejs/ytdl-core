---
title: Playlists
description: Expand playlists and channel uploads, and parse playlist IDs.
sidebar:
  order: 6
---

```ts
import { Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const playlist = await yt.getPlaylist("PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5");
const url = "https://www.youtube.com/watch?v=SAPaWLQbU_s&list=PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5";
const firstTen = await yt.getPlaylist(url, { limit: 10 });

playlist.title;
playlist.description;
playlist.author.name;
playlist.videoCount; // as the header states it
playlist.viewCount;
playlist.videos; // VideoSummary[], in playlist order
```

`getPlaylist` takes a playlist ID or any YouTube URL with a `list` parameter. Without `limit` it collects every entry, 100 per request, so a long playlist takes many requests; set `limit` when you need only the start. Private and deleted entries are left out. See [`PlaylistInfo`](../../api/interfaces/playlistinfo/) for every field.

Entries have the [`VideoSummary`](../search/) shape. `videoCount` comes from the playlist header, so it can exceed `videos.length` when `limit` stops early or entries are unplayable.

## Channel uploads

```ts
import { Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const uploads = await yt.getPlaylist("https://www.youtube.com/@TaylorSwift", { limit: 20 });
```

A channel expands as its uploads playlist, newest first. `getPlaylist` takes a `UC…` channel ID or a `/channel/`, `/@handle`, `/user/` or `/c/` URL. A channel ID or `/channel/` URL needs no extra request. The other URLs take one request to find the channel ID, and reject with `NOT_FOUND` when they name no channel.

Before choosing between a video and a playlist, `parsePlaylistId` reads the `list` parameter the way `getPlaylist` does:

```ts
import { parsePlaylistId } from "@distube/ytdl-core";

parsePlaylistId("https://www.youtube.com/watch?v=SAPaWLQbU_s&list=PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5"); // "PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5"
parsePlaylistId("https://www.youtube.com/watch?v=SAPaWLQbU_s&list=WL"); // undefined
```

Account lists such as `WL` (Watch later) need a signed-in session, so they read as no playlist. Channel input also reads as no playlist; pass it to `getPlaylist` directly.

## Errors

| Code               | When                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT` | A `limit` that is not a positive integer. No request.                               |
| `INVALID_URL`      | `getPlaylist` input that is not a playlist ID, a URL with `list`, or channel input. |
| `NOT_FOUND`        | The playlist does not exist, or a channel URL names no channel.                     |
| `RATE_LIMITED`     | YouTube answered HTTP 429.                                                          |
| `REQUEST_FAILED`   | Any other failed request or unreadable answer.                                      |

## Cancel

Aborting the `signal` between pages rejects with the signal's reason and requests no further page.

```ts
import { Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const playlist = await yt.getPlaylist("PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5", {
  limit: 100,
  signal: AbortSignal.timeout(10_000),
});
```

## Session

Playlists never send the cookie. See [Search](../search/#session).

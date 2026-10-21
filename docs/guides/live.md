---
title: Live streams
description: Stream a live broadcast over HLS or DASH.
sidebar:
  order: 8
---

A live video lists two kinds of format:

- HLS formats (`isHLS`), with audio and video together.
- DASH formats (`isLive` and not `isHLS`), with audio or video only.

```ts
const live = await yt.getInfo(liveUrl);

live.videoDetails.isLive; // true
yt.download(live, { filter: (format) => format.isHLS });
yt.download(live, { quality: Quality.HighestAudio, filter: { isLive: true, hasAudio: true, hasVideo: false } });
```

Both start `liveBuffer` milliseconds behind the live edge, 20 seconds by default, and end when the broadcast does:

```ts
yt.download(live, { filter: (format) => format.isHLS, liveBuffer: 5_000 });
```

A channel's live URL works too. `Ytdl` looks up the stream the channel plays now, so a 24/7 stream that restarts under a new ID needs no change:

```ts
const live = await yt.getInfo("https://www.youtube.com/@NASA/live");
```

It also takes `/channel/<id>/live`, `/c/<name>/live` and `/user/<name>/live`. A channel that isn't live, or doesn't exist, fails with `NOT_FOUND`.

Live formats have no fixed size, so `range` is ignored. Stop a live download with `signal`.

A premiere or scheduled stream that hasn't started fails with `NOT_STARTED`, and `error.startTime` says when it begins.

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
import { Quality, Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;
declare const liveUrl: string;

const live = await yt.getInfo(liveUrl);

live.videoDetails.isLive; // true
yt.download(live, { filter: (format) => format.isHLS });
yt.download(live, { quality: Quality.HighestAudio, filter: { isLive: true, hasAudio: true, hasVideo: false } });
```

Both kinds start `liveBuffer` milliseconds behind the live edge, 20 seconds by default, and end when the broadcast does:

```ts
import { Ytdl, type VideoInfo } from "@distube/ytdl-core";

declare const yt: Ytdl;
declare const live: VideoInfo;

yt.download(live, { filter: (format) => format.isHLS, liveBuffer: 5_000 });
```

A channel's live URL works too. `Ytdl` looks up the stream the channel plays now, so a 24/7 stream that restarts under a new ID needs no change:

```ts
import { Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const live = await yt.getInfo("https://www.youtube.com/@NASA/live");
```

It also takes `/channel/<id>/live`, `/c/<name>/live` and `/user/<name>/live`. A channel that isn't live, or doesn't exist, fails with `NOT_FOUND`.

Live formats have no fixed size, so `range` is ignored. Stop a live download with `signal`.

## Quality and start point

A live video never streams over SABR, so its formats are the ones its HLS manifest and DASH list name. `startTimeMs` throws `INVALID_ARGUMENT` for them, and a download cannot rewind to the start of the broadcast.

## Resume and end

A live download [resumes](../download/#resume) like any other. An expired URL, an HTTP 403 or a broken request looks the video up again and continues at the next segment, calling `onRetry`. If YouTube no longer has the missed segments, the download skips to the newest one, so the recording has a gap.

The stream ends when the HLS playlist says the broadcast is over, or when no new segment arrives for 30 seconds. Both end the stream normally. To keep recording through a long stall, call `getInfo` again and start a new download while `videoDetails.isLive` is true.

## Record to a file

An HLS format sends MPEG-TS with audio and video together. ffmpeg remuxes it without re-encoding:

```ts
import { spawn } from "node:child_process";
import { Ytdl, type VideoInfo } from "@distube/ytdl-core";

declare const yt: Ytdl;
declare const live: VideoInfo;

const ffmpeg = spawn("ffmpeg", ["-i", "pipe:0", "-c", "copy", "live.mkv"], { stdio: ["pipe", "inherit", "inherit"] });
yt.download(live, { filter: (format) => format.isHLS && format.hasAudio }).pipe(ffmpeg.stdin);
```

A DASH format carries one track, so a recording with both takes one download for audio and one for video, merged afterwards.

A premiere or scheduled stream that hasn't started fails with `NOT_STARTED`, and `error.startTime` says when it begins.

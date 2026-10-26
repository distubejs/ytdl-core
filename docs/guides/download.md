---
title: Download
description: Stream a format with ranges, progress and cancellation, or read one format many times.
sidebar:
  order: 2
---

`download` returns a Node `Readable`:

```ts
import { Quality, Ytdl } from "@distube/ytdl-core";
import { createWriteStream } from "node:fs";

declare const yt: Ytdl;
declare const url: string;

yt.download(url, { quality: Quality.HighestAudio, filter: { hasAudio: true, hasVideo: false } }).pipe(
  createWriteStream("audio.webm"),
);
```

`Quality.Highest` can pick video without audio. See [Quality](../formats/#quality).

Pass the info you already have to skip a second lookup. Info that has not expired is reused as is:

```ts
import { Quality, Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;
declare const url: string;

const info = await yt.getInfo(url);
yt.download(info, { quality: Quality.HighestAudio });
```

## Read one format many times

`open` takes an info and one of its formats and returns a `Media` without a request. Each `read` streams it with the same options as `download`, except the format choice:

```ts
import { createWriteStream } from "node:fs";
import { Quality, Ytdl, chooseFormat, type VideoInfo } from "@distube/ytdl-core";

declare const yt: Ytdl;
declare const info: VideoInfo;

const media = yt.open(info, chooseFormat(info.formats, { quality: Quality.HighestAudio }));

media.read({ range: { start: 0, end: 1_048_575 } }).pipe(createWriteStream("head.webm"));
media.read({ startTimeMs: 90_000 }); // a SABR format only, see Start time
```

When a read resumes on a fresh lookup, `media.info` and `media.format` become the fresh ones and later reads start from them, so a seek after an hour doesn't look the video up again. `open` throws `NO_FORMAT` for a format that isn't in `info.formats`.

## Web streams

Convert the Node stream with `Readable.toWeb`:

```ts
import { createWriteStream } from "node:fs";
import { Quality, Ytdl, type VideoInfo } from "@distube/ytdl-core";
import { Readable, Writable } from "node:stream";

declare const yt: Ytdl;
declare const info: VideoInfo;

const stream = Readable.toWeb(yt.download(info, { quality: Quality.HighestAudio }));
await stream.pipeTo(Writable.toWeb(createWriteStream("audio.webm")));
```

Cancelling the web stream destroys the download and aborts its requests.

## Byte ranges

`range` is inclusive and counts bytes of the format:

```ts
import { Ytdl, type VideoInfo } from "@distube/ytdl-core";

declare const yt: Ytdl;
declare const info: VideoInfo;

yt.download(info, { range: { start: 0, end: 1_048_575 } }); // the first MiB
yt.download(info, { range: { start: 5_000_000 } }); // from 5 MB to the end
```

## Start time

A format without a `url` streams over YouTube's SABR protocol, and only such a format can start at a time instead. `startTimeMs` starts at the media segment that contains it, so the first media bytes may come a few seconds early:

```ts
import { Ytdl, type VideoFormat, type VideoInfo } from "@distube/ytdl-core";

declare const yt: Ytdl;
declare const info: VideoInfo;
declare const format: VideoFormat;

yt.download(info, { format, startTimeMs: 90_000 }); // from about 1:30 to the end
```

The stream sends the format's initialization segment first, then media to the end, and `onProgress` reports no `total`. `startTimeMs` with a format that has a `url`, or with `range`, fails with `INVALID_ARGUMENT`. Seek those formats with `range` through their container index.

## Progress

```ts
import { Ytdl, type VideoInfo } from "@distube/ytdl-core";

declare const yt: Ytdl;
declare const info: VideoInfo;

yt.download(info, {
  onProgress: ({ downloaded, total }) => console.log(`${downloaded} / ${total}`),
  onRetry: ({ attempt, client, reason }) => console.log("resuming", attempt, client, reason),
});
```

A callback that throws fails the download with that error.

## Cancel

```ts
import { Ytdl, type VideoInfo } from "@distube/ytdl-core";

declare const yt: Ytdl;
declare const info: VideoInfo;

const controller = new AbortController();
const stream = yt.download(info, { signal: controller.signal });

controller.abort();
```

`stream.destroy()` stops it the same way.

## Resume

YouTube cuts media URLs off, often about a minute in, and they expire after a few hours. The stream doesn't end when that happens. It looks the format up again and continues from the byte it stopped at, calling `onRetry` each time. After three resumes in a row without a byte, it fails with `REQUEST_FAILED`.

A request that fails, or a response that breaks off or sends nothing for `timeoutMs` (a `new Ytdl` option, default 30 seconds), resumes the same way. A lookup that gets no answer within `timeoutMs` fails with `REQUEST_FAILED`. Live DASH holds each request for up to about 8 seconds while it waits for the next segment, so keep `timeoutMs` above that for live videos.

## All options

See [`DownloadOptions`](../../api/interfaces/downloadoptions/) and [`ReadOptions`](../../api/interfaces/readoptions/), including `chunkSize` and `highWaterMark` for tuning.

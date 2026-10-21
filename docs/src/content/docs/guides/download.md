---
title: Download
description: Stream a format as a Node or web stream, with ranges, progress and cancellation.
---

`download` returns a Node `Readable`:

```ts
import { createWriteStream } from "node:fs";
import { Filter, Quality } from "@distube/ytdl-core";

yt.download(url, { quality: Quality.Highest }).pipe(createWriteStream("video.mp4"));
```

Pass the info you already have to skip a second lookup. Info that has not expired is reused as is:

```ts
const info = await yt.getInfo(url);
yt.download(info, { quality: Quality.HighestAudio });
```

## Web streams

`downloadReadableStream` takes the same options and returns a `ReadableStream<Uint8Array>`:

```ts
import { Writable } from "node:stream";

const stream = yt.downloadReadableStream(info, { quality: Quality.HighestAudio, filter: Filter.AudioOnly });
await stream.pipeTo(Writable.toWeb(createWriteStream("audio.webm")));
```

## Byte ranges

`range` is inclusive and counts bytes of the format:

```ts
yt.download(info, { range: { start: 0, end: 1_048_575 } }); // the first MiB
yt.download(info, { range: { start: 5_000_000 } }); // from 5 MB to the end
```

## Start time

A SABR format, one without a `url`, can start at a time instead. `startTimeMs` starts at the media segment that contains it, so the first media bytes may come a few seconds early:

```ts
yt.download(info, { format, startTimeMs: 90_000 }); // from about 1:30 to the end
```

The stream sends the format's initialization segment first, then media to the end, and `onProgress` reports no `total`. `startTimeMs` with a direct format or with `range` fails with `INVALID_ARGUMENT`. Seek a direct format with `range` through its container index.

## Progress

```ts
yt.download(info, {
  onInfo: (info, format) => console.log("streaming itag", format.itag),
  onProgress: ({ downloaded, total }) => console.log(`${downloaded} / ${total}`),
  onRetry: ({ attempt, client, reason }) => console.log("resuming", attempt, client, reason),
});
```

A callback that throws fails the download with that error.

## Cancel

```ts
const controller = new AbortController();
const stream = yt.download(info, { signal: controller.signal });

controller.abort();
```

Destroying the stream works too: `stream.destroy()`, or `stream.cancel()` on a web stream.

## Resume

YouTube cuts media URLs off, often about a minute in, and they expire after a few hours. The stream doesn't end when that happens. It looks the format up again and continues from the byte it stopped at, calling `onRetry` each time. After three resumes in a row without a byte, it fails with `REQUEST_FAILED`.

## All options

See [`DownloadOptions`](../../api/interfaces/downloadoptions/), including `chunkSize` and `highWaterMark` for tuning.

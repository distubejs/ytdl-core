---
title: Choose a format
description: Pick a format by quality, itag or your own filter.
sidebar:
  order: 7
---

`download` picks one format with `quality` and `filter`. `chooseFormat` does the same on a list, so you can inspect the choice first:

```ts
import { chooseFormat, Quality } from "@distube/ytdl-core";

const format = chooseFormat(info.formats, { quality: Quality.HighestVideo, filter: { hasAudio: false } });
console.log(format.qualityLabel, format.container);

yt.download(info, { format });
```

It throws `NO_FORMAT` when nothing matches.

## Quality

`quality` is a `Quality` value, an itag, or a list of itags tried in order. The default is `Quality.Highest`.

```ts
yt.download(info, { quality: Quality.LowestAudio });
yt.download(info, { quality: Quality.HighestVideo, filter: { hasAudio: false } });
```

Every value is listed in [`Quality`](../../api/enumerations/quality/).

## Filter

`filter` is a criteria object, a function, or a list of them:

```ts
yt.download(info, { filter: { hasAudio: true, hasVideo: false } });
yt.download(info, { filter: { hasVideo: false, audioCodec: "opus" } });
yt.download(info, { filter: (format) => format.container === "mp4" && format.hasAudio });
```

The 4.x strings map to criteria: `audioonly` is `{ hasAudio: true, hasVideo: false }`, `videoonly` is `{ hasVideo: true, hasAudio: false }`, `audioandvideo` is `{ hasAudio: true, hasVideo: true }`, `audio` is `{ hasAudio: true }` and `video` is `{ hasVideo: true }`. A string throws `INVALID_ARGUMENT`.

A criteria object matches formats where every given field matches: `hasAudio`, `hasVideo`, `audioCodec`, `videoCodec`, `container`, `isDrc` and `isLive`. A codec matches exactly or by its family before the first `.`, so `"mp4a"` matches `mp4a.40.2` and `"av01"` matches every AV1 profile. Any other key, or a value of the wrong type, throws `INVALID_ARGUMENT`.

A list of filters is tried in order. The first entry that yields a format under `quality` wins, and `NO_FORMAT` comes only when none does:

```ts
const format = chooseFormat(info.formats, {
  quality: Quality.HighestAudio,
  filter: [{ hasVideo: false, audioCodec: "opus" }, { hasVideo: false }, { hasAudio: true }],
});
```

## Stable volume and dubbed audio

Some videos have stable-volume copies (`isDrc`) that share their itag with the original, and dubbed tracks (`audioTrack`). `chooseFormat` prefers the original. To get a specific track, filter on it:

```ts
yt.download(info, { filter: (format) => format.audioTrack?.isDefault === true && !format.isDrc });
```

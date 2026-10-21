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

`quality` is a `Quality` value, an itag, or a list of itags tried in order. The default is `Quality.Highest`. Most clients answer with separate audio and video formats, so it can pick video without audio; joining the two needs a muxer such as ffmpeg.

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

Some videos have stable-volume copies (`isDrc`) that share their itag with the original, and dubbed tracks (`audioTrack`). `chooseFormat` prefers the original copy and the original-language track, and falls back to a dub only when the list has no original. `audioTrack.audioIsDefault` is YouTube's default for the request language and does not promise the original, so do not filter on it to find the original. To get a specific track, filter on its id:

```ts
yt.download(info, { filter: (format) => format.audioTrack?.id.startsWith("de") === true && !format.isDrc });
```

## What a format carries

A format has YouTube's own fields under YouTube's names. A field YouTube leaves out is absent, and numeric strings are numbers:

- `quality`, `qualityLabel`, `qualityOrdinal`, `audioQuality`, `bitrate` and `averageBitrate`
- `width`, `height`, `fps`, `colorInfo` and `projectionType`
- `audioSampleRate`, `audioChannels`, `loudnessDb` and `trackAbsoluteLoudnessLkfs`
- `contentLength`, `approxDurationMs` and `lastModified` (microseconds)
- `initRange` and `indexRange`, the byte ranges of the container header and seek index
- `audioTrack` and `captionTrack`
- `targetDurationSec` and `maxDvrDurationSec` on live formats

ytdl-core adds `container`, `codecs`, `audioCodec`, `videoCodec`, `audioBitrate` in kbps, `hasAudio`, `hasVideo`, `isLive`, `isHLS`, `isDrm`, `isOtf` and `client`. `url` is ready to request after signature solving. Every field is listed in [`VideoFormat`](../../api/interfaces/videoformat/).

A live stream can list its auto-generated captions as a format with neither audio nor video:

```ts
const captions = live.formats.find((format) => format.captionTrack?.kind === "asr");
captions?.captionTrack?.languageCode; // "en"
```

## Formats that can't be downloaded

DRM-protected formats (`isDrm`, with their `drmFamilies`) and OTF formats (`isOtf`) are listed so you can see them. `chooseFormat` never picks one, and `open` or `download` with one throws `NO_FORMAT`. If you walk `info.formats` yourself, skip them.

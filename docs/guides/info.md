---
title: Get info
description: Read a video's details, formats and related videos.
sidebar:
  order: 3
---

```ts
import { Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;

const info = await yt.getInfo("aqz-KE-bpKQ");

info.videoDetails.title;
info.videoDetails.lengthSeconds;
info.videoDetails.author.name;
info.videoDetails.chapters; // [{ title, startTime }]
info.formats;
info.relatedVideos;
```

Fields YouTube leaves out are `undefined`, and missing lists are empty.

`relatedVideos` holds [`VideoSummary`](../../api/interfaces/videosummary/) values. To get them without a player lookup, call [`getRelated`](../search/#related-videos).

Everything `getInfo` returns is listed in [`VideoInfo`](../../api/interfaces/videoinfo/), [`VideoDetails`](../../api/interfaces/videodetails/) and [`VideoFormat`](../../api/interfaces/videoformat/).

A format whose `url` is `undefined` streams over SABR. `download` still streams it. See [Start time](../download/#start-time).

## Cancel a lookup

```ts
import { Ytdl } from "@distube/ytdl-core";

declare const yt: Ytdl;
declare const url: string;

const info = await yt.getInfo(url, { signal: AbortSignal.timeout(10_000) });
```

## Parse a video ID

```ts
import { parseVideoId } from "@distube/ytdl-core";

parseVideoId("https://youtu.be/aqz-KE-bpKQ"); // "aqz-KE-bpKQ"
parseVideoId("not a video"); // undefined
```

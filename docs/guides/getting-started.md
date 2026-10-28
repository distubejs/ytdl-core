---
title: Getting started
description: Install ytdl-core and download your first video.
sidebar:
  order: 1
---

## Install

```bash
npm install @distube/ytdl-core
```

```bash
bun add @distube/ytdl-core
```

ytdl-core runs on Node.js 22.22.2+ on 22.x, 24.15.0+ on 24.x, or 26+, and on Bun.

## Download a video

```ts
import { createWriteStream } from "node:fs";
import { Quality, Ytdl } from "@distube/ytdl-core";

const yt = new Ytdl();

yt.download("https://www.youtube.com/watch?v=aqz-KE-bpKQ", {
  quality: Quality.HighestAudio,
  filter: { hasAudio: true, hasVideo: false },
}).pipe(createWriteStream("audio.webm"));
```

Every method accepts a video ID or any YouTube URL.

## One instance per app

Create one `Ytdl` and reuse it. It keeps the session YouTube gave it, the cookie, and the clients it found blocked, so later lookups are faster and less likely to hit a bot check. Use a separate instance for each account or proxy. The instance mints its own [PO tokens](../po-tokens/), so there is nothing to set up for them. A [cookie](../cookies/) lets it play age-restricted videos.

```ts
import { Ytdl } from "@distube/ytdl-core";

const yt = new Ytdl({
  cookie: process.env.YT_COOKIE,
  lang: "en",
  country: "US",
});
```

All options are listed in [`YtdlOptions`](../../api/interfaces/ytdloptions/).

## Next steps

- [Get info](../info/) about a video
- [Download](../download/) with ranges, progress and cancellation
- [Choose a format](../formats/)
- Pick the [clients](../clients/) to ask
- [Migrate from v4](../migrating-from-v4/)

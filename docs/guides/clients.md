---
title: Clients
description: Which YouTube clients ytdl-core asks, and what each one plays.
sidebar:
  order: 12
---

YouTube answers each of its apps differently: one plays age-restricted videos, another plays live streams, another needs a PO token. `Ytdl` asks the clients in `clients` in order, and the first one that plays wins.

```ts
import { Client, Ytdl } from "@distube/ytdl-core";

const yt = new Ytdl({ clients: [Client.WebEmbedded, Client.Tv] });
```

`Client` lists only the clients that played a video when asked alone. `DEFAULT_CLIENTS` is all six in this order: `visionos`, `web_embedded`, `tv`, `mweb`, `web_creator` and `web_music`. An unknown name, such as a 4.x client like `"android"`, throws `INVALID_ARGUMENT`.

- mweb, web_creator and web_music need a [PO token](../po-tokens/), which the instance mints itself unless you pass `getPoToken`.
- web_music is the YouTube Music website. It plays songs and music live streams and answers "Video unavailable" for other videos, so it comes last. It has no signed-in attempt.
- With a [cookie](../cookies/), a client that accepts one is asked again signed in, right after its signed-out request. web_creator is only asked signed in.
- A client whose media URLs keep failing counts as blocked for ten minutes and moves to the end of the list.

## What each client plays

The signed-out table comes from a run of one client at a time on 2026-10-21, over one to three videos per class. The web_music row comes from a run on 2026-10-30 over three normal, one made-for-kids and two age-restricted videos and one music live stream. It also played the Creative Commons song `4jTzgLFd5_4`. Cells are ✅ when `getInfo` returned a playable format for every video, ❌ when it did for none, and "some" when the result depended on the video. The signed-in table comes from a cookie run on 2026-10-22 and is narrower, see below.

Without a cookie:

| Client       | Normal | Age-restricted | Made for kids | Embedding disabled | Live HLS | Live DASH |
| ------------ | :----: | :------------: | :-----------: | :----------------: | :------: | :-------: |
| visionos     |   ✅   |       ❌       |      ❌       |         ✅         |    ✅    |    ✅     |
| web_embedded |   ✅   |      some      |      ✅       |         ❌         |    ✅    |    ✅     |
| tv           |   ✅   |       ❌       |      ✅       |         ✅         |    ❌    |    ✅     |
| mweb         |   ✅   |       ❌       |      ✅       |         ✅         |    ✅    |    ✅     |
| web_music    |   ❌   |       ❌       |      ❌       |    not measured    |    ✅    |    ✅     |

- web_embedded played one of two age-restricted videos and reported `AGE_RESTRICTED` for the other. Pass a [cookie](../cookies/) when age-restricted videos matter.
- visionos answers a made-for-kids video with no formats, so ytdl-core moves on to web_embedded.
- tv lists live formats without an HLS manifest. For an upcoming live event, tv reports `NOT_STARTED` like the others, without a start time when YouTube gives none.
- visionos lists a live stream's video variants with no audio. The audio comes as a separate HLS rendition, which `getInfo` lists as an audio-only format with `isHLS`. Choose it with `filter: { hasAudio: true, hasVideo: false }`, or use a variant that reports `hasAudio`.

With a cookie, the table lists what each signed-in attempt returned. Error codes are `YtdlErrorCode` values. A YouTube status is marked as such. visionos has no signed-in attempt, so it plays signed out even when you pass a cookie. "Not measured" means no run asked that client signed in for that class.

| Client       | Normal       | Age-restricted                               | Made for kids | Live         | Region-blocked   |
| ------------ | ------------ | -------------------------------------------- | ------------- | ------------ | ---------------- |
| web_embedded | not measured | YouTube status `ERROR` (1 of 2 videos asked) | not measured  | not measured | `NOT_FOUND`      |
| tv           | not measured | played (1 of 1 asked)                        | not measured  | not measured | `REGION_BLOCKED` |
| mweb         | not measured | not measured                                 | not measured  | not measured | `REGION_BLOCKED` |
| web_creator  | ✅           | ✅                                           | ✅            | ✅           | `REGION_BLOCKED` |

- web_creator was the only client in the run, with a cookie and a PO token provider, over seven videos. It played every video except the region-blocked one. The sweep did not separate HLS from DASH live streams.
- web_embedded played the age-restricted video `HtVdAasjOgU` signed out, so its signed-in attempt was never asked. For `Tq92D6wQ1mg` it returned `UNPLAYABLE` signed out and `ERROR` signed in, and tv played it signed in after `LOGIN_REQUIRED` signed out.
- On the region-blocked video the signed-in web_embedded attempt reported `NOT_FOUND` and the other attempts `REGION_BLOCKED`. `NOT_FOUND` ranks after `REGION_BLOCKED`, so the error is `REGION_BLOCKED`.

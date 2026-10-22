---
title: Migrating from v4
description: Map the 4.x API to v5.
sidebar:
  order: 14
---

v5 is a rewrite with no compatibility layer. The module exports a `Ytdl` class instead of a callable `ytdl` function, and one instance holds the session YouTube gives it. Create it once and reuse it:

```ts
import { Ytdl } from "@distube/ytdl-core";

const yt = new Ytdl();
```

## Requirements and imports

The package is ESM-only and has no default export. `import ytdl from "@distube/ytdl-core"` throws, and `require("@distube/ytdl-core")` returns the module namespace, not a function, so `ytdl(url)` fails. Use the named `Ytdl` import shown above.

4.15.1 declared Node.js `>=14.0`, and 4.16.0 raised that to `>=20.18.1`. v5 needs `^22.22.2 || ^24.15.0 || >=26.0.0`, or Bun.

## Functions

| 4.x                                        | v5                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `ytdl(url, options)`                       | `yt.download(url, options)`                                          |
| `ytdl.downloadFromInfo(info, options)`     | `yt.download(info, options)`                                         |
| `ytdl.getInfo(url)`                        | `yt.getInfo(url)`                                                    |
| `ytdl.getBasicInfo(url)`                   | `yt.getInfo(url)`; there is no lighter lookup                        |
| `ytdl.chooseFormat(formats, options)`      | `chooseFormat(formats, options)`                                     |
| `ytdl.filterFormats(formats, "audioonly")` | `formats.filter((format) => format.hasAudio && !format.hasVideo)`    |
| `ytdl.getVideoID(input)`, `getURLVideoID`  | `parseVideoId(input)`, which returns `undefined` instead of throwing |
| `ytdl.validateID(id)`, `validateURL(url)`  | `parseVideoId(input) !== undefined`                                  |
| `ytdl.createAgent(cookies)`                | `new Ytdl({ cookie })` with the [cookie export](../cookies/) as text |
| `ytdl.createProxyAgent({ uri }, cookies)`  | `new Ytdl({ fetch, cookie })` with a [proxied fetch](../proxies/)    |

`ytdl.cache` and `ytdl.version` are gone. Every other 4.15.1 export is in the table. v5 exports `Ytdl`, `chooseFormat`, `parseVideoId`, `parsePlaylistId`, `Quality`, `Client`, `DEFAULT_CLIENTS`, `CaptionFormat`, `createPoTokenProvider`, `YtdlError` and `YtdlErrorCode`.

## Options

| 4.x                           | v5                                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality: "highestaudio"`     | `quality: Quality.HighestAudio`; every string has a `Quality` value                                                                                                                          |
| `filter: "audioonly"`         | `filter: { hasAudio: true, hasVideo: false }`; see the [string mapping](../formats/#filter)                                                                                                  |
| `format`                      | `format`, unchanged                                                                                                                                                                          |
| `range: { start, end }`       | `range`, unchanged                                                                                                                                                                           |
| `begin`                       | `startTimeMs` in milliseconds, for SABR formats only; see [Start time](../download/#start-time). 4.x also used `&begin=` to seek live and direct formats, and v5 has no equivalent for those |
| `dlChunkSize`                 | `chunkSize`; there is no unchunked mode                                                                                                                                                      |
| `liveBuffer`, `highWaterMark` | unchanged                                                                                                                                                                                    |
| `lang`                        | `new Ytdl({ lang })`                                                                                                                                                                         |
| `agent`, `requestOptions`     | `new Ytdl({ fetch })`                                                                                                                                                                        |
| `fetch` (4.16)                | `new Ytdl({ fetch })`. v5 calls it like the standard `fetch(input, init)`, not with undici `request` options, so set a dispatcher or proxy inside it; see [Proxies](../proxies/)             |
| `requestCallback`             | none; 4.15.1 never called it                                                                                                                                                                 |
| `rewriteRequest`              | none; change the URL or init in a wrapper around `fetch`                                                                                                                                     |
| `IPv6Block`                   | a `fetch` bound to one local address; see [Proxies](../proxies/)                                                                                                                             |
| `playerClients`               | `new Ytdl({ clients })` with `Client` values; see [Clients](../clients/)                                                                                                                     |

## Stream events

The stream is a plain Node `Readable`. Its 4.x events become options or calls:

```ts
// 4.x
ytdl(url)
  .on("info", (info, format) => {})
  .on("progress", (chunk, downloaded, total) => {});

// v5
const info = await yt.getInfo(url);
const format = chooseFormat(info.formats, { quality: Quality.HighestAudio });
yt.download(info, { format, onProgress: ({ chunkBytes, downloaded, total }) => {} });
```

To read the same format again later, for example to seek, keep a [`Media`](../download/#read-one-format-many-times) from `yt.open(info, format)` instead of the info. `stream.destroy()` still stops a download, and `signal` cancels one with an `AbortController`.

## Formats

A format keeps the field names 4.x copied from YouTube, such as `itag`, `mimeType`, `bitrate`, `initRange`, `audioQuality`, `audioTrack` and `colorInfo`, with numeric strings parsed to numbers. Two differ: `url` is already solved, and `signatureCipher` is gone. ytdl-core's own additions are listed in [Choose a format](../formats/#what-a-format-carries). DRM and OTF formats are listed with `isDrm` and `isOtf`, and `chooseFormat` skips them.

| 4.x `videoFormat`                                                                            | v5 `VideoFormat`                                                                             |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `contentLength`, `lastModified`, `audioSampleRate`, `approxDurationMs`                       | numbers, not strings; `lastModified` is microseconds                                         |
| `initRange`, `indexRange`                                                                    | `{ start, end }` as numbers                                                                  |
| `url`                                                                                        | optional; a format without one streams over SABR                                             |
| `signatureCipher`                                                                            | gone, the URL is solved                                                                      |
| `isDashMPD`                                                                                  | gone; live DASH formats have `isLive` and no `isHLS`                                         |
| `quality`, `qualityLabel`                                                                    | `string`, not a literal union                                                                |
| `container`, `codecs`, `videoCodec`, `audioCodec`, `hasVideo`, `hasAudio`, `isLive`, `isHLS` | unchanged                                                                                    |
| none                                                                                         | `isDrc`, `isDrm`, `isOtf`, `client`, `captionTrack`, `xtags`, `qualityOrdinal`, `loudnessDb` |

## Info

`getInfo` returns a `VideoInfo` with eleven fields where 4.x returned about a hundred. Keys 4.x copied from YouTube's watch page (`iv_*`, `ad*`, `fmt_list`, `html5player`, `fexp`, `cver` and the rest) are gone, and so is `full`.

| 4.x `videoInfo`            | v5 `VideoInfo`                                                               |
| -------------------------- | ---------------------------------------------------------------------------- |
| `videoDetails`             | `videoDetails`, reshaped below                                               |
| `formats`                  | `formats`                                                                    |
| `related_videos`           | `relatedVideos`, a list of `VideoSummary`                                    |
| `player_response`          | `playerResponse`, typed `unknown`; narrow it before you read it              |
| `player_response.captions` | `captionTracks`; see [Captions](../captions/)                                |
| `html5player`              | gone                                                                         |
| none                       | `client`, `hlsManifestUrl`, `sabr`, `visitorData`, `expiresAt`, `playableAt` |

| 4.x `videoDetails`                                                                                                                         | v5 `videoDetails`                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `videoId`                                                                                                                                  | `id`                                                            |
| `video_url`                                                                                                                                | `url`                                                           |
| `shortDescription`, `description`                                                                                                          | `description`, `undefined` when empty                           |
| `lengthSeconds`, `viewCount`                                                                                                               | numbers, not strings                                            |
| `likes`                                                                                                                                    | `likes`, `undefined` instead of `null`                          |
| `title`, `publishDate`                                                                                                                     | unchanged                                                       |
| `published`                                                                                                                                | typed in 4.x but never filled; use `publishDate`                |
| `uploadDate`, `category`, `keywords`, `isLive`                                                                                             | unchanged                                                       |
| `age_restricted`                                                                                                                           | `isAgeRestricted`                                               |
| `isLiveContent`                                                                                                                            | none; true for past broadcasts too, `isLive` is only while live |
| `externalChannelId`                                                                                                                        | `author.id`                                                     |
| `ownerGplusProfileUrl`                                                                                                                     | gone                                                            |
| `isUnlisted`, `isFamilySafe`, `availableCountries`                                                                                         | unchanged, `undefined` when YouTube omits them                  |
| `thumbnails`, `storyboards`                                                                                                                | unchanged; `Thumbnail` width and height are optional            |
| `chapters`                                                                                                                                 | `chapters`, each `{ title, startTime }` instead of `start_time` |
| `author`                                                                                                                                   | an `Author` object, below                                       |
| `channelId`                                                                                                                                | `author.id`                                                     |
| `ownerChannelName`                                                                                                                         | `author.name`                                                   |
| `ownerProfileUrl`                                                                                                                          | `author.url`                                                    |
| `liveBroadcastDetails`                                                                                                                     | none; use `isLive` and `isUpcoming`                             |
| `media`                                                                                                                                    | gone                                                            |
| `averageRating`, `allowRatings`, `isOwnerViewing`, `isCrawlable`, `isPrivate`, `isUnpluggedCorpus`, `hasYpcMetadata`, `embed`, `thumbnail` | gone                                                            |
| none                                                                                                                                       | `isUpcoming`                                                    |

| 4.x `Author`                   | v5 `Author`                                                |
| ------------------------------ | ---------------------------------------------------------- |
| `id`, `name`                   | unchanged                                                  |
| `channel_url`                  | `https://www.youtube.com/channel/${author.id}`             |
| `user_url`                     | `url`, the profile URL YouTube sends, else the channel URL |
| `subscriber_count`             | `subscriberCount`                                          |
| `verified`                     | `verified`, `undefined` when unknown                       |
| `thumbnails`                   | `thumbnails`, always a list                                |
| `avatar`                       | `thumbnails[0]?.url`                                       |
| `user`, `external_channel_url` | gone                                                       |

| 4.x `relatedVideo`                                             | v5 `VideoSummary`      |
| -------------------------------------------------------------- | ---------------------- |
| `id`, `title`, `isLive`, `thumbnails`                          | unchanged              |
| `length_seconds`                                               | `lengthSeconds`        |
| `view_count`, `short_view_count_text`                          | `viewCount`, a number  |
| `author` (an `Author` or a string), `ucid`, `author_thumbnail` | `author: { id, name }` |
| `published`, `video_thumbnail`, `richThumbnails`               | gone                   |

## Errors

Failures are `YtdlError` values with a `code`, such as `PRIVATE`, `AGE_RESTRICTED` or `NO_FORMAT`, instead of messages to match. See [Errors](../errors/).

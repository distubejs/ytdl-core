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

`ytdl.cache` and `ytdl.version` are gone.

## Options

| 4.x                           | v5                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `quality: "highestaudio"`     | `quality: Quality.HighestAudio`; every string has a `Quality` value                        |
| `filter: "audioonly"`         | `filter: { hasAudio: true, hasVideo: false }`; see [Choose a format](../formats/#filter)   |
| `format`                      | `format`, unchanged                                                                        |
| `range: { start, end }`       | `range`, unchanged                                                                         |
| `begin`                       | `startTimeMs` in milliseconds, for SABR formats; see [Start time](../download/#start-time) |
| `dlChunkSize`                 | `chunkSize`; there is no unchunked mode                                                    |
| `liveBuffer`, `highWaterMark` | unchanged                                                                                  |
| `lang`                        | `new Ytdl({ lang })`                                                                       |
| `agent`, `requestOptions`     | `new Ytdl({ fetch })`                                                                      |
| `IPv6Block`                   | a `fetch` bound to one local address; see [Proxies](../proxies/)                           |
| `playerClients`               | `new Ytdl({ clients })` with `Client` values; see [Clients](../clients/)                   |

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

## Errors

Failures are `YtdlError` values with a `code`, such as `PRIVATE`, `AGE_RESTRICTED` or `NO_FORMAT`, instead of messages to match. See [Errors](../errors/).

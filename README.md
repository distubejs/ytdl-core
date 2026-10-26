# @distube/ytdl-core

YouTube video info and downloads for Node.js. A DisTube fork of [fent/node-ytdl-core](https://github.com/fent/node-ytdl-core).

**[Documentation](https://distube.js.org/ytdl-core/)** · [Getting started](https://distube.js.org/ytdl-core/guides/getting-started/) · [API reference](https://distube.js.org/ytdl-core/api/readme/)

<a href='https://ko-fi.com/skick' target='_blank'><img height='48' src='https://storage.ko-fi.com/cdn/kofi3.png' alt='Buy Me a Coffee at ko-fi.com' /></a>

## Features

- Video details, chapters, storyboards, related videos and every format
- Caption tracks as WebVTT, JSON or XML text
- Video and playlist search, playlists and channel uploads with every page, related videos and search suggestions
- Node `Readable` downloads with byte ranges or a start time, and one format read many times through `open`
- Downloads that resume on their own when YouTube cuts a URL off
- Live streams over HLS or DASH
- SABR-only formats, which on some clients means everything above 360p
- Signatures solved locally, no remote service
- Age-restricted videos with a cookie
- PO tokens minted in a worker thread with no setup, for the clients that need one
- Proxies through any `fetch`

## Install

```bash
npm install @distube/ytdl-core
```

```bash
bun add @distube/ytdl-core
```

Requires Node.js 22.22.2+ on 22.x, 24.15.0+ on 24.x, or 26+, or Bun.

## Usage

```ts
import { createWriteStream } from "node:fs";
import { Quality, Ytdl } from "@distube/ytdl-core";

const yt = new Ytdl();

const info = await yt.getInfo("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
console.log(info.videoDetails.title);

yt.download(info, { quality: Quality.HighestAudio, filter: { hasAudio: true, hasVideo: false } }).pipe(
  createWriteStream("audio.webm"),
);

const [first] = await yt.search("blender open movie", { limit: 5 });
const playlist = await yt.getPlaylist("https://www.youtube.com/playlist?list=PL2aBZuCeDwlRF14ds9UR1uVpLRjDQy7d5");
console.log(first?.title, playlist.videos.length);
```

Search, formats, live streams, clients, cookies, PO tokens, proxies and errors are covered in the [documentation](https://distube.js.org/ytdl-core/). Coming from 4.x? Read [Migrating from v4](https://distube.js.org/ytdl-core/guides/migrating-from-v4/).

## Development

Run `bun install`, then `bun run verify` for the offline gates.

## License

MIT.

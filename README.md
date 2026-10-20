# @distube/ytdl-core

YouTube video info and downloads for Node.js. A DisTube fork of `ytdl-core`.

**[Documentation](https://distubejs.github.io/ytdl-core/)** · [Getting started](https://distubejs.github.io/ytdl-core/getting-started/) · [API reference](https://distubejs.github.io/ytdl-core/api/readme/)

<a href='https://ko-fi.com/skick' target='_blank'><img height='48' src='https://storage.ko-fi.com/cdn/kofi3.png' alt='Buy Me a Coffee at ko-fi.com' /></a>

## Features

- Video details, chapters, storyboards, related videos and every format
- Node `Readable` and web `ReadableStream` downloads, with byte ranges
- Downloads that resume on their own when YouTube cuts a URL off
- Live streams over HLS or DASH
- SABR-only formats, which on some clients means everything above 360p
- Signatures solved locally, no remote service
- Age-restricted videos with a cookie, and a built-in PO token provider
- Proxies through any `fetch`

## Install

```bash
npm install @distube/ytdl-core
```

```bash
bun add @distube/ytdl-core
```

Requires Node.js 22.12 or later, or Bun.

## Usage

```ts
import { createWriteStream } from "node:fs";
import { Filter, Quality, Ytdl } from "@distube/ytdl-core";

const yt = new Ytdl();

const info = await yt.getInfo("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
console.log(info.videoDetails.title);

yt.download(info, { quality: Quality.HighestAudio, filter: Filter.AudioOnly }).pipe(createWriteStream("audio.webm"));
```

Formats, live streams, clients, cookies, PO tokens, proxies and errors are covered in the [documentation](https://distubejs.github.io/ytdl-core/).

## Development

Run `bun install`, then `bun run verify` for the offline gates.

## License

MIT. Originally [fent/node-ytdl-core](https://github.com/fent/node-ytdl-core) and its contributors.

SABR streaming uses [googlevideo](https://github.com/LuanRT/googlevideo), MIT, as a dependency.

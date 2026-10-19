---
title: PO tokens
description: Mint proof-of-origin tokens for the clients that need them.
---

Some [clients](../clients/) only play with a proof-of-origin (PO) token. Without `getPoToken`, `Ytdl` skips them.

## Built-in provider

The provider runs YouTube's BotGuard in a worker thread, so your process's globals stay untouched:

```ts
import { createPoTokenProvider, Ytdl } from "@distube/ytdl-core";

const getPoToken = await createPoTokenProvider();
const yt = new Ytdl({ getPoToken });

// on shutdown
await getPoToken.dispose();
```

Behind a proxy, give the provider the same `fetch` as `Ytdl`:

```ts
const getPoToken = await createPoTokenProvider({ fetch: proxiedFetch });
const yt = new Ytdl({ fetch: proxiedFetch, getPoToken });
```

After `dispose()`, calls reject with `INVALID_STATE`. Aborting `options.signal` disposes it too.

## Your own minter

Any function that returns a token works, for example one that calls a separate token server:

```ts
const yt = new Ytdl({
  getPoToken: async ({ videoId, visitorData, dataSyncId, client, signal }) => {
    const response = await fetch("http://localhost:4416/token", {
      method: "POST",
      body: JSON.stringify({ videoId, visitorData, dataSyncId, client }),
      signal,
    });
    return response.text();
  },
});
```

An empty `videoId` asks for a session token, bound to `dataSyncId` when signed in and to `visitorData` otherwise.

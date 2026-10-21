---
title: PO tokens
description: Mint proof-of-origin tokens for the clients that need them.
sidebar:
  order: 11
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

`timeoutMs` bounds each request the provider makes, meaning the response headers and each body chunk. It defaults to 30 000. A stalled request fails that mint with `REQUEST_FAILED`, and the next mint starts over:

```ts
const getPoToken = await createPoTokenProvider({ timeoutMs: 10_000 });
```

After `dispose()`, calls reject with `INVALID_STATE`. Aborting `options.signal` disposes it too.

## Your own minter

Any function that returns a token works, for example one that calls a separate token server:

```ts
const yt = new Ytdl({
  getPoToken: async ({ contentBinding, client, signal }) => {
    const response = await fetch("http://localhost:4416/token", {
      method: "POST",
      body: JSON.stringify({ contentBinding, client }),
      signal,
    });
    return response.text();
  },
});
```

`contentBinding` is what the token binds to: the video ID, both for a player request and for a SABR session that asks for attestation. The built-in provider mints and caches one token per `contentBinding`.

---
title: PO tokens
description: How ytdl-core mints proof-of-origin tokens, and how to bring your own.
sidebar:
  order: 13
---

Some [clients](../clients/), mweb, web_creator and web_music, only play with a proof-of-origin (PO) token. `Ytdl` mints one for them with no setup, and one for every SABR session.

## Built-in provider

Without `getPoToken`, each `Ytdl` instance starts its own provider the first time it needs a token. The provider runs in a worker thread, so your process's globals stay untouched. It sends its requests through the `fetch` and `timeoutMs` you gave `Ytdl`, so it works behind the same proxy.

- A lookup that an earlier client answers starts no worker. A SABR download always starts one, because it needs a token when it begins.
- If the provider fails to start, that client's attempt fails with step `po-token` and the error as `cause`. The next request starts a fresh provider. See [Errors](../errors/#attempts).
- There is nothing to dispose. The idle worker does not keep your process running.
- The instance holds its worker until the process exits, so create one `Ytdl` per account or network identity, not one per request.

To keep the worker from starting at all, leave mweb, web_creator and web_music out of `clients`. A SABR download still starts one.

## Sharing or disposing a provider

`createPoTokenProvider` starts the same provider yourself. Pass it as `getPoToken` to share one worker across instances or to stop it on shutdown:

```ts
import { createPoTokenProvider, Ytdl } from "@distube/ytdl-core";

declare const proxiedFetch: typeof fetch;

const getPoToken = await createPoTokenProvider({ fetch: proxiedFetch });
const yt = new Ytdl({ fetch: proxiedFetch, getPoToken });

// on shutdown
await getPoToken.dispose();
```

`timeoutMs` bounds each request the provider makes, meaning the response headers and each body chunk. It defaults to 30 000. A stalled request fails that mint with `REQUEST_FAILED`, and the next mint starts over. After `dispose()`, calls reject with `INVALID_STATE`. Aborting `options.signal` disposes it too.

## Your own minter

Any function that returns a token works, for example one that calls a separate token server:

```ts
import { Ytdl } from "@distube/ytdl-core";

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

Ytdl calls it for each player request that needs a token and once when a SABR download starts. `contentBinding` is the video ID in both cases. The built-in provider mints and caches one token per `contentBinding`.

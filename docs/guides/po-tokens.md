---
title: PO tokens
description: How ytdl-core mints proof-of-origin tokens, and how to bring your own.
sidebar:
  order: 11
---

Some [clients](../clients/), mweb and web_creator, only play with a proof-of-origin (PO) token. `Ytdl` mints one for them with no setup, and one for every SABR session.

## Built-in provider

Without `getPoToken`, each `Ytdl` instance starts its own provider the first time it needs a token. The provider runs YouTube's BotGuard in a worker thread, so your process's globals stay untouched. It sends its requests through the `fetch` and `timeoutMs` you gave `Ytdl`, so it works behind the same proxy.

- A lookup that an earlier client answers starts no worker. A SABR download always starts one, because the stream asks for a token when it begins.
- If the provider fails to start, that client's attempt fails with step `po-token` and the error as `cause`. The next token starts a fresh provider.
- There is nothing to dispose. The idle worker does not keep your process running.
- The instance holds its worker until the process exits, so create one `Ytdl` per account or network identity, not one per request.

To keep the worker from starting at all, leave mweb and web_creator out of `clients`. A SABR download still starts one.

## Sharing or disposing a provider

`createPoTokenProvider` starts the same provider yourself. Pass it as `getPoToken` to share one worker across instances or to stop it on shutdown:

```ts
import { createPoTokenProvider, Ytdl } from "@distube/ytdl-core";

const getPoToken = await createPoTokenProvider({ fetch: proxiedFetch });
const yt = new Ytdl({ fetch: proxiedFetch, getPoToken });

// on shutdown
await getPoToken.dispose();
```

`timeoutMs` bounds each request the provider makes, meaning the response headers and each body chunk. It defaults to 30 000. A stalled request fails that mint with `REQUEST_FAILED`, and the next mint starts over. After `dispose()`, calls reject with `INVALID_STATE`. Aborting `options.signal` disposes it too.

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

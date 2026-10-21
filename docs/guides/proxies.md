---
title: Proxies
description: Route every request through a proxy or a local address.
sidebar:
  order: 12
---

Every request goes through the `fetch` option, so a proxy is a fetch with a dispatcher. The examples use undici, which is not a dependency of ytdl-core. Install it with `npm install undici` or `bun add undici`.

```ts
import { Ytdl } from "@distube/ytdl-core";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const dispatcher = new ProxyAgent("http://proxy.example:8080");
const proxiedFetch = ((url: string | URL, init?: RequestInit) =>
  undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch;
const yt = new Ytdl({ fetch: proxiedFetch });
```

To send from one local address, for example one of several IPv6 addresses, use an `Agent`:

```ts
import { Ytdl } from "@distube/ytdl-core";
import { Agent, fetch as undiciFetch } from "undici";

const dispatcher = new Agent({ connect: { localAddress: "2001:db8::10" } });
const proxiedFetch = ((url: string | URL, init?: RequestInit) =>
  undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch;
const yt = new Ytdl({ fetch: proxiedFetch });
```

Media URLs only work from the IP that looked them up, so look up and download through the same `Ytdl`. Use one instance per proxy or address.

Datacenter IPs get bot checks more often than home connections.

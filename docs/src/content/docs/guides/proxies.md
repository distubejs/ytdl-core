---
title: Proxies
description: Route every request through a proxy or a local address.
---

Every request goes through the `fetch` option, so a proxy is a fetch with a dispatcher:

```ts
import { fetch, ProxyAgent } from "undici";

const dispatcher = new ProxyAgent("http://proxy.example:8080");
const yt = new Ytdl({ fetch: (url, init) => fetch(url, { ...init, dispatcher }) });
```

To send from one local address, for example one of several IPv6 addresses, use an `Agent`:

```ts
import { Agent, fetch } from "undici";

const dispatcher = new Agent({ connect: { localAddress: "2001:db8::10" } });
const yt = new Ytdl({ fetch: (url, init) => fetch(url, { ...init, dispatcher }) });
```

Media URLs only work from the IP that looked them up, so look up and download through the same `Ytdl`. Use one instance per proxy or address.

Datacenter IPs get bot checks more often than home connections.

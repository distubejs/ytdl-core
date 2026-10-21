---
title: Clients
description: Which YouTube clients ytdl-core asks, and what each one plays.
sidebar:
  order: 9
---

YouTube answers each of its apps differently: one plays age-restricted videos, another plays live streams, another needs a PO token. `Ytdl` asks the clients in `clients` in order, and the first one that plays wins.

```ts
import { Client, Ytdl } from "@distube/ytdl-core";

const yt = new Ytdl({ clients: [Client.WebEmbedded, Client.Tv] });
```

`Client` lists only clients that played a video in the live suite when each was the only client. `DEFAULT_CLIENTS` is all five in this order: `visionos`, `web_embedded`, `tv`, `mweb` and `web_creator`. An unknown name, such as a 4.x client like `"android"`, throws `INVALID_ARGUMENT`.

- A client that needs a PO token is skipped without [`getPoToken`](../po-tokens/): mweb and web_creator.
- With a [cookie](../cookies/), a client that accepts one is asked again signed in, right after its signed-out request. web_creator is only asked signed in.
- A client whose media URLs keep failing counts as blocked for ten minutes and moves to the end of the list.

## What each client plays

Without a cookie:

| Client       | Normal | Age-restricted | Made for kids | Live HLS | Live DASH |
| ------------ | :----: | :------------: | :-----------: | :------: | :-------: |
| visionos     |   ✅   |       ❌       |      ❌       |    ✅    |    ✅     |
| web_embedded |   ✅   |       ✅       |      ✅       |    ✅    |    ✅     |
| tv           |   ✅   |       ❌       |      ✅       |    ❌    |    ✅     |
| mweb         |   ✅   |       ❌       |      ✅       |    ✅    |    ✅     |

With a cookie, for the clients that accept one:

| Client       | Normal | Age-restricted | Made for kids | Live HLS | Live DASH |
| ------------ | :----: | :------------: | :-----------: | :------: | :-------: |
| web_embedded |   ✅   |       ✅       |      ✅       |    ✅    |    ✅     |
| tv           |   ✅   |       ✅       |      ✅       |    ❌    |    ✅     |
| mweb         |   ✅   |       ✅       |      ✅       |    ✅    |    ✅     |
| web_creator  |   ✅   |       ✅       |      ✅       |    ✅    |    ✅     |

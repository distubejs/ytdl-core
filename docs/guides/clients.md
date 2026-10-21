---
title: Clients
description: Which YouTube clients ytdl-core asks, and what each one plays.
sidebar:
  order: 9
---

YouTube answers each of its apps differently: one plays age-restricted videos, another plays live streams, another needs a PO token. `Ytdl` asks the clients in `clients` in order, and the first one that plays wins.

```ts
import { Client, DEFAULT_CLIENTS, Ytdl } from "@distube/ytdl-core";

const yt = new Ytdl({ clients: [Client.WebEmbedded, Client.Tv] });
const withAndroid = new Ytdl({ clients: [...DEFAULT_CLIENTS, Client.AndroidVr] });
```

`DEFAULT_CLIENTS` is `visionos`, `web_embedded`, `tv`, `mweb` and `web_creator`, shown in bold below.

- A client that needs a PO token is skipped without [`getPoToken`](../po-tokens/): tv_ps4, tv_simply, mweb, web_music and web_creator.
- With a [cookie](../cookies/), a client that accepts one is asked again signed in, right after its signed-out request. web_creator is only asked signed in.
- A client whose media URLs keep failing counts as blocked for ten minutes and moves to the end of the list.

## What each client plays

Without a cookie:

| Client           | Normal | Age-restricted | Made for kids | Live HLS | Live DASH |
| ---------------- | :----: | :------------: | :-----------: | :------: | :-------: |
| **visionos**     |   ✅   |       ❌       |      ❌       |    ✅    |    ✅     |
| **web_embedded** |   ✅   |       ✅       |      ✅       |    ✅    |    ✅     |
| **tv**           |   ✅   |       ❌       |      ✅       |    ❌    |    ✅     |
| **mweb**         |   ✅   |       ❌       |      ✅       |    ✅    |    ✅     |
| tv_ps4           |   ✅   |       ❌       |      ✅       |    ❌    |    ✅     |
| tv_simply        |   ✅   |       ❌       |      ✅       |    ✅    |    ✅     |
| android          |   ❌   |       ❌       |      ❌       |    ✅    |    ❌     |
| android_vr       |   ❌   |       ❌       |      ❌       |    ✅    |    ✅     |
| ios              |   ❌   |       ❌       |      ❌       |    ❌    |    ❌     |
| web              |   ❌   |       ❌       |      ❌       |    ❌    |    ✅     |
| web_safari       |   ❌   |       ❌       |      ❌       |    ❌    |    ✅     |
| web_music        |   ❌   |       ❌       |      ✅       |    ✅    |    ✅     |

With a cookie, for the clients that accept one:

| Client           | Normal | Age-restricted | Made for kids | Live HLS | Live DASH |
| ---------------- | :----: | :------------: | :-----------: | :------: | :-------: |
| **web_embedded** |   ✅   |       ✅       |      ✅       |    ✅    |    ✅     |
| **tv**           |   ✅   |       ✅       |      ✅       |    ❌    |    ✅     |
| **mweb**         |   ✅   |       ✅       |      ✅       |    ✅    |    ✅     |
| **web_creator**  |   ✅   |       ✅       |      ✅       |    ✅    |    ✅     |
| tv_ps4           |   ✅   |       ✅       |      ✅       |    ❌    |    ✅     |
| web              |   ❌   |       ✅       |      ❌       |    ❌    |    ✅     |
| web_safari       |   ❌   |       ✅       |      ❌       |    ❌    |    ✅     |
| web_music        |   ❌   |       ❌       |      ✅       |    ✅    |    ✅     |

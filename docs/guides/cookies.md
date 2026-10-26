---
title: Cookies
description: Sign in with a cookie for age-restricted videos.
sidebar:
  order: 10
---

:::caution
Signed-in automated access can get a YouTube account suspended. Use an account you can afford to lose.
:::

Videos the default clients can't play without an account need the cookie of an age-verified account. Copy it from the browser:

1. Open a private window and sign in to [youtube.com](https://www.youtube.com).
2. Open DevTools with F12, select the Network tab and type `youtubei` in its filter. Play any video so requests appear.
3. Select one of the requests. Under Headers, find `cookie` in the request headers and copy its whole value.
4. Close the private window without signing out. Signing out invalidates the cookie.

Paste the value into `.env`, in double quotes because it contains `;` and `=`:

```dotenv
YT_COOKIE="SAPISID=AbCdEf/GhIjKl; LOGIN_INFO=AFmmF2sw...; __Secure-3PAPISID=AbCdEf/GhIjKl; ..."
```

```ts
const yt = new Ytdl({ cookie: process.env.YT_COOKIE });
```

A Netscape `cookies.txt` export works too, such as one from [Get cookies.txt LOCALLY](https://github.com/kairi003/Get-cookies.txt-LOCALLY) or `yt-dlp --cookies-from-browser`. Pass the file's text, and `Ytdl` keeps its youtube.com cookies and ignores the rest:

```ts
import { readFileSync } from "node:fs";

const yt = new Ytdl({ cookie: readFileSync("www.youtube.com_cookies.txt", "utf8") });
```

An export or header without `SAPISID` or `__Secure-3PAPISID` is signed out, and the constructor throws `INVALID_ARGUMENT`. A cookie YouTube no longer accepts fails the lookup with `AUTH_FAILED`; copy a fresh one.

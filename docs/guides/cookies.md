---
title: Cookies
description: Sign in with a cookie for age-restricted videos.
sidebar:
  order: 10
---

:::caution
Signed-in automated access can get a YouTube account suspended. Use an account you can afford to lose.
:::

Videos the default clients can't play without an account need the cookie of an age-verified account. To get it:

1. Install [Get cookies.txt LOCALLY](https://github.com/kairi003/Get-cookies.txt-LOCALLY) for [Chrome](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) or [Firefox](https://addons.mozilla.org/firefox/addon/get-cookies-txt-locally/), and allow it in private windows.
2. Open a private window, sign in to [youtube.com](https://www.youtube.com), and export with the extension. It saves `www.youtube.com_cookies.txt`.
3. Close the private window without signing out. Signing out invalidates the cookie.

Pass the file's text as `cookie`. `Ytdl` keeps its youtube.com cookies and ignores the rest:

```ts
import { readFileSync } from "node:fs";

const yt = new Ytdl({ cookie: readFileSync("www.youtube.com_cookies.txt", "utf8") });
```

A `Cookie` header works too, for example from a `.env` file, quoted because it contains `;` and `=`:

```dotenv
YT_COOKIE="SAPISID=AbCdEf/GhIjKl; LOGIN_INFO=AFmmF2sw...; __Secure-3PAPISID=AbCdEf/GhIjKl; ..."
```

```ts
const yt = new Ytdl({ cookie: process.env.YT_COOKIE });
```

An export or header without `SAPISID` or `__Secure-3PAPISID` is signed out, and the constructor throws `INVALID_ARGUMENT`. A cookie YouTube no longer accepts fails the lookup with `AUTH_FAILED`; export a fresh one.

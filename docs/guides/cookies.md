---
title: Cookies
description: Copy a YouTube cookie from your browser to play age-restricted videos and get past bot checks.
sidebar:
  order: 9
---

## When you need a cookie

Two failures call for one. `AGE_RESTRICTED` means the video needs a signed-in, age-verified account. `BOT_CHECK` means YouTube answered "Sign in to confirm you're not a bot", which is common on datacenter and VPS IP addresses.

If YouTube refuses the cookie you pass, the signed-in attempts in `error.attempts` fail with `AUTH_FAILED`. The error's own code is `AUTH_FAILED` unless another client gave a more specific answer, so an age-restricted video still fails with `AGE_RESTRICTED`. See [Confirming it works](#confirming-it-works) and [When it stops working](#when-it-stops-working).

## Account risk

Signed-in automated access can get a YouTube account suspended. Use a throwaway account that you have age-verified, never your main one.

## Copy the cookie from Chrome or Edge

1. Open a private window and sign in to [youtube.com](https://www.youtube.com) with the throwaway account.
2. Open DevTools with F12 and select the Network panel.
3. Type `youtubei` in the filter box.
4. Play any video so requests appear in the list.
5. Select one of the requests and open its Headers tab.
6. Under Request Headers, find `cookie` and copy its whole value.
7. Close the private window without signing out. Signing out invalidates the cookie.

## Copy the cookie from Firefox

1. Open a private window and sign in to [youtube.com](https://www.youtube.com) with the throwaway account.
2. Open the Web Developer Tools with F12 and select the Network panel.
3. Type `youtubei` in the filter box.
4. Play any video so requests appear in the list.
5. Select one of the requests and open its Headers tab.
6. Under Request Headers, turn on the Raw toggle so the headers show as plain text.
7. Find the `Cookie` line and copy its whole value, without the `Cookie:` prefix.
8. Close the private window without signing out. Signing out invalidates the cookie.

## Export a cookies.txt file instead

A Netscape `cookies.txt` export works too. Make one with a browser extension such as [Get cookies.txt LOCALLY](https://github.com/kairi003/Get-cookies.txt-LOCALLY), or with `yt-dlp --cookies-from-browser firefox --cookies cookies.txt --skip-download <video URL>`, run against a browser profile signed in to the throwaway account. Pass the file's text as the cookie. `Ytdl` keeps only the `youtube.com` cookies from the export and ignores the rest.

## Store the cookie

The value contains `;` and `=`, so put it in double quotes in a `.env` file:

```dotenv
YT_COOKIE="SAPISID=AbCdEf/GhIjKl; LOGIN_INFO=AFmmF2sw...; __Secure-3PAPISID=AbCdEf/GhIjKl; ..."
```

On a hosting panel, paste the value into an environment variable field.

Or keep a cookies.txt export in a file outside your repository and read it at startup:

```ts
import { Ytdl } from "@distube/ytdl-core";
import { readFileSync } from "node:fs";

const ytdl = new Ytdl({ cookie: readFileSync("youtube-cookies.txt", "utf8") });
```

Never commit the cookie. Anyone who has it can act as that account.

## Confirming it works

`new Ytdl({ cookie })` throws a `YtdlError` with code `INVALID_ARGUMENT` when the value has no `SAPISID` or `__Secure-3PAPISID` cookie. That is a signed-out copy, so copy it again while signed in.

For the real test, look up an age-restricted video. If it returns formats, the cookie works. If the lookup fails, `error.attempts` lists every client that was tried, and the signed-in ones show `signedIn: true`:

```ts
import { Ytdl, YtdlError } from "@distube/ytdl-core";

declare const ytdl: Ytdl;
declare const ageRestrictedUrl: string;

try {
  await ytdl.getInfo(ageRestrictedUrl);
  console.log("The cookie works");
} catch (error) {
  if (!YtdlError.is(error)) throw error;
  console.log(error.code);
  for (const attempt of error.attempts.filter((attempt) => attempt.signedIn)) {
    console.log(attempt.client, attempt.step, attempt.code, attempt.reason);
  }
}
```

Read more about the error in the [error guide](https://distube.js.org/ytdl-core/guides/errors/).

## When it stops working

Signing out of the browser session that made the cookie invalidates it, so keep that session signed in or close its window without signing out. YouTube can also expire a cookie on its own. When the signed-in entries of `error.attempts` show `AUTH_FAILED`, YouTube is treating your cookie as signed out, even if `error.code` is `AGE_RESTRICTED` or `BOT_CHECK`. Copy a fresh one and restart the process that uses it.

---
title: Cookies
description: Sign in with a cookie for age-restricted videos.
---

:::caution
Signed-in automated access can get a YouTube account suspended. Use an account you can afford to lose.
:::

Videos the default clients can't play without an account need the cookie of an age-verified account. To get it:

1. Install [Get cookies.txt LOCALLY](https://github.com/kairi003/Get-cookies.txt-LOCALLY) for [Chrome](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) or [Firefox](https://addons.mozilla.org/firefox/addon/get-cookies-txt-locally/), and allow it in private windows.
2. Open a private window, sign in to [youtube.com](https://www.youtube.com), and export with the extension. It saves `www.youtube.com_cookies.txt`.
3. Close the private window without signing out. Signing out invalidates the cookie.
4. Convert the file and check it on a video:

```bash
npx @distube/ytdl-core cookies www.youtube.com_cookies.txt --check aqz-KE-bpKQ
```

It reports whether the account is signed in, prints the cookie on its own line and copies it to the clipboard when it can. Paste the whole line as `cookie`:

```ts
const yt = new Ytdl({ cookie: "SAPISID=AbCdEf/GhIjKl; LOGIN_INFO=AFmmF2sw...; __Secure-3PAPISID=AbCdEf/GhIjKl; ..." });
```

Better, keep it out of your code in a `.env` file, quoted because it contains `;` and `=`:

```dotenv
YT_COOKIE="SAPISID=AbCdEf/GhIjKl; LOGIN_INFO=AFmmF2sw...; __Secure-3PAPISID=AbCdEf/GhIjKl; ..."
```

```ts
const yt = new Ytdl({ cookie: process.env.YT_COOKIE });
```

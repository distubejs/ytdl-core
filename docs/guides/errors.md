---
title: Errors
description: Handle failures by their code.
sidebar:
  order: 11
---

Every failure is a `YtdlError` with a `code`. Switch on the code, not the message. For `AGE_RESTRICTED` and `BOT_CHECK`, see [Cookies](../cookies/).

```ts
import { Ytdl, YtdlError } from "@distube/ytdl-core";

declare const yt: Ytdl;
declare const url: string;

try {
  await yt.getInfo(url);
} catch (error) {
  if (YtdlError.is(error, "AGE_RESTRICTED")) console.log("pass a cookie");
  else if (YtdlError.is(error, "REGION_BLOCKED")) console.log("allowed in", error.availableCountries);
  else throw error;
}
```

`getCaptions` rejects with `NO_CAPTIONS` when the video has no track in the language you asked for. See [Captions](../captions/#choose-a-track).

During a download, a SABR stream that gets HTTP 403 from YouTube resumes, as described in [Resume](../download/#resume). `onRetry` receives `reason: "HTTP 403"`. From the second retry the failed client is skipped, so a persistent 403 moves the download to the next client.

A download stream emits the same errors as an `error` event, or rejects its reads for a web stream.

Every code is listed in [`YtdlErrorCode`](../../api/enumerations/ytdlerrorcode/).

## Attempts

When every client fails, the error takes the highest-ranked outcome any of them reported. A private video says `PRIVATE` even if another client only saw a bot check. `error.attempts` lists every attempt, in order:

```ts
import { YtdlError } from "@distube/ytdl-core";

declare const error: YtdlError;

for (const { client, signedIn, step, code, reason, cause } of error.attempts) {
  console.log(client, signedIn ? "signed in" : "signed out", step, code, reason, cause);
}
```

| Field      | Holds                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `client`   | the client asked                                                                                                    |
| `signedIn` | whether the attempt sent your [cookie](../cookies/); [Clients](../clients/) lists which clients are asked signed in |
| `step`     | where the attempt failed, see below                                                                                 |
| `code`     | the outcome of that attempt                                                                                         |
| `reason`   | what YouTube or the library said; for an InnerTube error answer it includes YouTube's status and message            |
| `cause`    | the underlying error, redacted, such as the failed fetch or the player script error                                 |

`step` is one of:

| Step          | The attempt failed while                                        |
| ------------- | --------------------------------------------------------------- |
| `player`      | fetching or preparing the player script                         |
| `embed`       | loading the embed page for an embedded client                   |
| `visitor`     | getting visitor data, or the Data Sync ID when signed in        |
| `po-token`    | minting a PO token, with your `getPoToken` or the built-in one  |
| `request`     | sending the InnerTube `/player` request                         |
| `playability` | reading YouTube's verdict, such as private, region or bot check |
| `formats`     | finding a playable format, or the exact file a resume asked for |
| `solve`       | solving the signature and `n` parameter of the URLs             |

The step tells a library failure from a verdict about the video. An attempt that fails at `player` or `solve` says nothing about whether the video is age-restricted, and its `cause` names the error.

### Ranking

The error takes the `code` and `cause` of the attempt that ranks first. From first to last:

1. `PRIVATE`, `MEMBERS_ONLY`, `PREMIUM_ONLY`, `REGION_BLOCKED`, `NOT_STARTED`, `NOT_FOUND`, in that order. These are facts about the video. `NOT_FOUND` ranks last of them, because a signed-in client can report it for a video that another client reports as region-blocked.
2. `PLAYER_SOLVE_FAILED`, `INVALID_STATE`. These are library failures you can fix by updating or by reading the `cause`.
3. `AGE_RESTRICTED`, `AUTH_FAILED`, `RATE_LIMITED`, `BOT_CHECK`, `REQUEST_FAILED`, `NO_FORMAT`.

One exception covers credential failures, meaning a signed-in client's `AUTH_FAILED` or any failure at step `po-token`. Ignore those and look at what ranks first among the rest. If that is `NO_FORMAT`, and a signed-out client answered `NO_FORMAT` at step `playability`, the error is that `NO_FORMAT`. That answer is about the video, and a fresh cookie or token would not change it. Otherwise the order above holds. A dead cookie still wins over a signed-out `BOT_CHECK` or `RATE_LIMITED`, because the cookie is what gets past those.

A live stream that ended without a recording reports `NOT_FOUND`.

`INVALID_URL`, `INVALID_ARGUMENT` and `NO_CAPTIONS` come last, because no attempt reports them. Among attempts with the winning code, the first one that carries `availableCountries` or `startTime` supplies them. The losing attempts stay in `attempts` with their own code, so an `AGE_RESTRICTED` attempt is still listed when a broken player wins.

An `AGE_RESTRICTED` error from an instance without a cookie says once that you need to pass `cookie`. When no client names the allowed countries for a `REGION_BLOCKED` error, ytdl-core asks YouTube once more to fill `availableCountries`.

Messages never contain your cookie, tokens, or the signed parameters of media URLs.

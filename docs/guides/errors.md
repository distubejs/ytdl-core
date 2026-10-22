---
title: Errors
description: Handle failures by their code.
sidebar:
  order: 13
---

Every failure is a `YtdlError` with a `code`. Switch on the code, not the message:

```ts
import { YtdlError } from "@distube/ytdl-core";

try {
  await yt.getInfo(url);
} catch (error) {
  if (YtdlError.is(error, "AGE_RESTRICTED")) console.log("pass a cookie");
  else if (YtdlError.is(error, "REGION_BLOCKED")) console.log("allowed in", error.availableCountries);
  else throw error;
}
```

`getCaptions` rejects with `NO_CAPTIONS` when the video has no track in the language you asked for, and the message lists the languages it has.

During a download, a SABR stream that fails after YouTube answers a media request with HTTP 403 resumes. `onRetry` receives `reason: "HTTP 403"`, and from the second retry the failed client is skipped, so a persistent 403 moves the download to the next client.

A download stream emits the same errors as an `error` event, or rejects its reads for a web stream.

Every code and what it means is listed in [`YtdlErrorCode`](../../api/enumerations/ytdlerrorcode/).

## Attempts

When every client fails, the error takes the highest-ranked outcome any of them reported. A private video says `PRIVATE` even if another client only saw a bot check. `error.attempts` lists every rung tried, in order:

```ts
for (const { client, signedIn, step, code, reason, cause } of error.attempts) {
  console.log(client, signedIn ? "signed in" : "signed out", step, code, reason, cause);
}
```

| Field      | Holds                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| `client`   | the client asked                                                                                         |
| `signedIn` | whether the rung sent your cookie; see Clients for which rungs are asked signed in                       |
| `step`     | where the rung failed, see below                                                                         |
| `code`     | the outcome of that rung                                                                                 |
| `reason`   | what YouTube or the library said; for an InnerTube error answer it includes YouTube's status and message |
| `cause`    | the underlying error, redacted, such as the failed fetch or the player script error                      |

`step` is one of:

| Step          | The rung failed while                                           |
| ------------- | --------------------------------------------------------------- |
| `player`      | fetching or preparing the player script                         |
| `embed`       | loading the embed page for an embedded client                   |
| `visitor`     | getting visitor data, or the Data Sync ID when signed in        |
| `po-token`    | calling your `getPoToken`                                       |
| `request`     | sending the InnerTube `/player` request                         |
| `playability` | reading YouTube's verdict, such as private, region or bot check |
| `formats`     | finding a playable format, or the exact file a resume asked for |
| `solve`       | solving the signature and `n` parameter of the URLs             |

The step tells a library failure from a verdict about the video. A rung that fails at `player` or `solve` says nothing about whether the video is age-restricted, and its `cause` names the error.

### Ranking

The error's `code` is the attempt code that ranks first, and its own `cause` is that attempt's cause. From first to last:

1. `PRIVATE`, `MEMBERS_ONLY`, `PREMIUM_ONLY`, `REGION_BLOCKED`, `NOT_STARTED`, `NOT_FOUND`, in that order. These are facts about the video. `NOT_FOUND` ranks last of them because a signed-in rung can report it for a video that another client reports as region-blocked.
2. `PLAYER_SOLVE_FAILED`, `INVALID_STATE`. These are library failures you can fix by updating or by reading the `cause`.
3. `AGE_RESTRICTED`, `AUTH_FAILED`, `RATE_LIMITED`, `BOT_CHECK`, `REQUEST_FAILED`, `NO_FORMAT`.

The ranks sit in `RANK` in `src/resolve.ts`. `INVALID_URL`, `INVALID_ARGUMENT` and `NO_CAPTIONS` come last because no rung reports them. Among attempts with the winning code, the first one that carries `availableCountries` or `startTime` supplies them. The losing attempts stay in `attempts` with their own code, so an `AGE_RESTRICTED` rung is still listed when a broken player wins.

An `AGE_RESTRICTED` error from an instance without a cookie says once that you need to pass `cookie`. A `REGION_BLOCKED` error with no allowed countries from any client asks YouTube's web metadata once to fill `availableCountries`.

Messages never contain your cookie, tokens, or the signed parameters of media URLs.

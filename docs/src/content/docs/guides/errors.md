---
title: Errors
description: Handle failures by their code.
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

A download stream emits the same errors as an `error` event, or rejects its reads for a web stream.

Every code and what it means is listed in [`YtdlErrorCode`](../../api/enumerations/ytdlerrorcode/).

## Attempts

When every client fails, the error takes the most specific outcome any of them reported. A private video says `PRIVATE` even if another client only saw a bot check. `error.attempts` lists what each client answered:

```ts
for (const { client, code, reason } of error.attempts) console.log(client, code, reason);
```

Messages never contain your cookie, tokens, or the signed parameters of media URLs.

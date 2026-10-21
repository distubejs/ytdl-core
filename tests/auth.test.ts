import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CookieAuth } from "../src/auth.ts";
import { YtdlError } from "../src/errors.ts";
import { Ytdl } from "../src/index.ts";
import { fakeFetch } from "./fixtures/auth/fake-fetch.ts";

const NOW = 1_700_000_000_000;
const ORIGIN = "https://www.youtube.com";
const fixture = (name: string) => readFileSync(new URL(`fixtures/auth/${name}`, import.meta.url), "utf8");
const FULL_COOKIE =
  "PREF=hl=en; SAPISID=sapisid-value-aaaa; __Secure-1PAPISID=one-p-value-bbbb; __Secure-3PAPISID=three-p-value-cccc";

function homePage(ytcfg: string): Response {
  return new Response(`<html><script>ytcfg.set({${ytcfg}});</script></html>`);
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return YtdlError.is(error) ? error.code : `not a YtdlError: ${String(error)}`;
  }
  return undefined;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("cookie account", () => {
  beforeEach(() => setSystemTime(new Date(NOW)));
  afterEach(() => setSystemTime());

  test("signs with the SAPISIDHASH family bound to the user session", async () => {
    const fetch = fakeFetch(() => homePage(`"DATASYNC_ID":"111||","SESSION_INDEX":"0","LOGGED_IN":true`));
    const auth = new CookieAuth({ cookie: FULL_COOKIE, fetch });

    expect(await auth.headers(ORIGIN)).toEqual({
      Cookie: FULL_COOKIE,
      Authorization:
        "SAPISIDHASH 1700000000_477d611e27c043cf022c95c64518bc27493cd818_u " +
        "SAPISID1PHASH 1700000000_48a95c1ffae22ffee6b92568d2b88bec5714ade7_u " +
        "SAPISID3PHASH 1700000000_5ddfb9ea6b93a630af45ba4f5b86bc02db0bf4da_u",
      "X-Origin": "https://www.youtube.com",
      "X-Goog-AuthUser": "0",
    });
    expect(await auth.dataSyncId()).toBe("111||");
    expect(fetch.calls[0]?.url).toBe("https://www.youtube.com/");
    expect(new Headers(fetch.calls[0]?.init?.headers).get("Cookie")).toBe(FULL_COOKIE);
  });

  test("a Netscape export signs in with only its youtube.com cookies", async () => {
    const fetch = fakeFetch(() => homePage(`"LOGGED_IN":true`));
    const auth = new CookieAuth({ cookie: fixture("signed-in.txt"), fetch });

    expect((await auth.headers(ORIGIN)).Cookie).toBe(
      "SAPISID=sapisid-value-aaaa; LOGIN_INFO=login-info-value; __Secure-3PAPISID=three-p-value-cccc; PREF=hl=en",
    );
  });

  test("falls back to __Secure-3PAPISID when SAPISID is missing", async () => {
    const fetch = fakeFetch(() => homePage(`"LOGGED_IN":true`));
    const auth = new CookieAuth({ cookie: "__Secure-3PAPISID=three-p-value-cccc", fetch });

    const hash = "1700000000_689ae500eee405c6b9a4e73b40e7dc2adb838d71";
    expect((await auth.headers(ORIGIN)).Authorization).toBe(`SAPISIDHASH ${hash} SAPISID3PHASH ${hash}`);
    expect(await auth.dataSyncId()).toBeUndefined();
  });

  test("a secondary channel sends its delegated session as the page ID", async () => {
    const fetch = fakeFetch(() => homePage(`"DATASYNC_ID":"222||333","SESSION_INDEX":"1"`));
    const auth = new CookieAuth({ cookie: FULL_COOKIE, fetch });

    const headers = await auth.headers(ORIGIN);
    expect(headers["X-Goog-PageId"]).toBe("222");
    expect(headers["X-Goog-AuthUser"]).toBe("1");
  });

  test("concurrent callers share one Data Sync ID lookup", async () => {
    const page = deferred<Response>();
    const fetch = fakeFetch(() => page.promise);
    const auth = new CookieAuth({ cookie: FULL_COOKIE, fetch });

    const pending = Promise.all([auth.dataSyncId(), auth.headers(ORIGIN), auth.dataSyncId(), auth.headers(ORIGIN)]);
    page.resolve(homePage(`"DATASYNC_ID":"111||"`));
    const [first, , third] = await pending;
    await auth.headers(ORIGIN);

    expect([first, third]).toEqual(["111||", "111||"]);
    expect(fetch.calls).toHaveLength(1);
  });

  test("a signed-out page fails the account and a later call asks again", async () => {
    let loggedIn = false;
    const fetch = fakeFetch(() => homePage(`"LOGGED_IN":${loggedIn}`));
    const auth = new CookieAuth({ cookie: FULL_COOKIE, fetch });

    expect(await codeOf(auth.headers(ORIGIN))).toBe("AUTH_FAILED");
    loggedIn = true;
    expect(await codeOf(auth.headers(ORIGIN))).toBeUndefined();
    expect(fetch.calls).toHaveLength(2);
  });

  test("an aborted caller stops waiting while the shared lookup continues", async () => {
    const page = deferred<Response>();
    const auth = new CookieAuth({ cookie: FULL_COOKIE, fetch: fakeFetch(() => page.promise) });
    const controller = new AbortController();

    const aborted = auth.dataSyncId(controller.signal);
    const other = auth.dataSyncId();
    controller.abort(new Error("caller gave up"));
    page.resolve(homePage(`"DATASYNC_ID":"111||"`));

    await expect(aborted).rejects.toThrow("caller gave up");
    expect(await other).toBe("111||");
  });
});

describe("account options", () => {
  const fetch = fakeFetch(() => {
    throw new Error("no request expected");
  });

  test("a signed-out cookie fails construction with INVALID_ARGUMENT and no request", () => {
    expect(() => new Ytdl({ cookie: "PREF=hl=en; __Secure-1PAPISID=one-p-value-bbbb", fetch })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(fetch.calls).toHaveLength(0);
  });

  test("a signed-out cookie export fails construction with INVALID_ARGUMENT and no request", () => {
    expect(() => new Ytdl({ cookie: fixture("signed-out.txt"), fetch })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(fetch.calls).toHaveLength(0);
  });
});

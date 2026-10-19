import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { type CliIo, main } from "../src/cli.ts";
import { fakeYouTube, playable, unplayable } from "./fake-youtube.ts";

const SIGNED_IN = fileURLToPath(new URL("fixtures/auth/signed-in.txt", import.meta.url));
const SIGNED_OUT = fileURLToPath(new URL("fixtures/auth/signed-out.txt", import.meta.url));
const SIGNED_IN_HEADER =
  "SAPISID=sapisid-value-aaaa; LOGIN_INFO=login-info-value; __Secure-3PAPISID=three-p-value-cccc; PREF=hl=en";

async function run(argv: string[], io: Partial<CliIo> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...io,
  });
  return { code, stdout, stderr };
}

describe("ytdl-core cookies", () => {
  test("converts the youtube.com cookies of a Netscape export to a Cookie header", async () => {
    const { code, stdout, stderr } = await run(["cookies", SIGNED_IN]);

    expect(code).toBe(0);
    expect(stdout).toBe(`${SIGNED_IN_HEADER}\n`);
    expect(stderr).toContain("can get the YouTube account suspended");
    expect(stderr).toContain("Signed in");
  });

  test("the cookie goes to the clipboard when one is available", async () => {
    const copied: string[] = [];
    const { stdout, stderr } = await run(["cookies", SIGNED_IN], {
      copy: async (text) => (copied.push(text), true),
    });

    expect(copied).toEqual([SIGNED_IN_HEADER]);
    expect(stdout).toBe(`${SIGNED_IN_HEADER}\n`);
    expect(stderr).toContain("copied to the clipboard");
  });

  test("a signed-out export prints nothing and exits non-zero", async () => {
    const { code, stdout, stderr } = await run(["cookies", SIGNED_OUT]);

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Signed out");
  });

  test("--check reports the outcome code of getInfo with the cookie", async () => {
    const ageGated = fakeYouTube({ player: () => unplayable("AGE_CHECK_REQUIRED", "Sign in to confirm your age") });
    const failing = await run(["cookies", SIGNED_IN, "--check", "aqz-KE-bpKQ"], { fetch: ageGated.fetch });
    const open = fakeYouTube({ player: () => playable("aqz-KE-bpKQ") });
    const passing = await run(["cookies", SIGNED_IN, "--check", "aqz-KE-bpKQ"], { fetch: open.fetch });

    expect(failing.code).not.toBe(0);
    expect(failing.stderr).toContain("AGE_RESTRICTED");
    expect(
      ageGated.requests.some((request) => new Headers(request.init?.headers).get("Cookie") === SIGNED_IN_HEADER),
    ).toBe(true);
    expect(passing.code).toBe(0);
    expect(passing.stderr).toContain("aqz-KE-bpKQ: OK");
  });
});

test("--help prints usage and unknown commands exit non-zero", async () => {
  expect(await run(["--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("ytdl-core cookies") });
  expect((await run(["login"])).code).not.toBe(0);
});

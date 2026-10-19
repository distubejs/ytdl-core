#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseCookieHeader, sapisidOf } from "./auth.ts";
import { YtdlError } from "./errors.ts";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly copy?: (text: string) => Promise<boolean>;
}

const USAGE = `Usage:
  ytdl-core cookies <file> [--check <video>]
                                           Convert a Netscape cookie export to a Cookie header
  ytdl-core --help                         Show this help

Pass the printed value to new Ytdl({ cookie }).
`;

const WARNING =
  "Warning: signed-in automated access can get the YouTube account suspended. Use an account you can afford to lose.\n";

const parse = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" }, check: { type: "string" } },
  });

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (command === "cookies" && rest.length === 1 && rest[0]) return cookiesCommand(rest[0], values.check, io);
  io.stderr(USAGE);
  return 2;
}

async function cookiesCommand(file: string, video: string | undefined, io: CliIo): Promise<number> {
  io.stderr(WARNING);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    io.stderr(`Cannot read ${file}: ${describe(error)}\n`);
    return 1;
  }
  const header = netscapeToCookieHeader(text);
  const parsed = parseCookieHeader(header);
  // LOGIN_INFO is cleared on sign-out while __Secure-3PAPISID can survive a rotation (yt-dlp `_has_auth_cookies`).
  if (!sapisidOf(parsed) || !parsed.has("LOGIN_INFO")) {
    io.stderr(
      "Signed out: the export has no SAPISID or LOGIN_INFO cookie for youtube.com. Export again while signed in.\n",
    );
    return 1;
  }
  io.stderr("Signed in: the export has a YouTube session.\n");
  const code = video === undefined ? 0 : await check(header, video, io);
  const copied = (await io.copy?.(header)) ?? false;
  io.stderr(copied ? "\nCookie, copied to the clipboard:\n" : "\nCookie:\n");
  io.stdout(`${header}\n`);
  return code;
}

async function check(header: string, video: string, io: CliIo): Promise<number> {
  try {
    await checkWithYtdl(header, video, io);
    io.stderr(`Check ${video}: OK\n`);
    return 0;
  } catch (error) {
    io.stderr(`Check ${video}: ${YtdlError.is(error) ? `${error.code} (${error.message})` : describe(error)}\n`);
    return 1;
  }
}

const CLIPBOARDS: Readonly<Partial<Record<NodeJS.Platform, readonly (readonly string[])[]>>> = {
  darwin: [["pbcopy"]],
  win32: [["clip"]],
  linux: [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]],
};

async function copyToClipboard(text: string): Promise<boolean> {
  for (const [command, ...args] of CLIPBOARDS[process.platform] ?? []) {
    if (command && (await pipeTo(command, args, text))) return true;
  }
  return false;
}

function pipeTo(command: string, args: readonly string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}

// curl marks HttpOnly cookies with a `#HttpOnly_` prefix.
function netscapeToCookieHeader(text: string): string {
  const cookies = new Map<string, string>();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.startsWith("#HttpOnly_") ? raw.slice("#HttpOnly_".length) : raw;
    if (line.startsWith("#") || line.trim() === "") continue;
    const [domain, , , , , name, value] = line.split("\t");
    if (domain === undefined || !name || value === undefined) continue;
    const host = domain.replace(/^\./u, "");
    if (host !== "youtube.com" && !host.endsWith(".youtube.com")) continue;
    cookies.set(name, value);
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function checkWithYtdl(cookie: string, video: string, io: CliIo): Promise<void> {
  const { Ytdl } = await import("./ytdl.ts");
  await new Ytdl({ cookie, fetch: io.fetch }).getInfo(video, { signal: io.signal });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEntry(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    signal: controller.signal,
    copy: process.stdout.isTTY ? copyToClipboard : undefined,
  });
}

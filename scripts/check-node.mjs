import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlayer } from "../dist/solver/index.js";

if (process.versions.bun) throw new Error("check:node must run on Node, not Bun");

const HOOK = "var hook=function(){};";
const MEDIA = "https://rr1---sn-abc.googlevideo.com/videoplayback?itag=251&n=xyz";
const SETTLE_MS = 15_000;
const HEALTHY = "h0000099";

const fixture = (name) => readFileSync(new URL(`../tests/fixtures/solver/${name}`, import.meta.url), "utf8");
const player = fixture("player.js");
const hostile = JSON.parse(fixture("hostile-players.json"));

function attempt(players, playerId) {
  const fetch = async (input) => {
    const body = players[/\/s\/player\/(\w+)\//u.exec(String(input))?.[1] ?? ""];
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  };
  let timer;
  const pending = new Promise((resolve) => {
    timer = setTimeout(resolve, SETTLE_MS, `still pending after ${SETTLE_MS} ms`);
  });
  const solving = loadPlayer({ fetch, playerId })
    .then((loaded) => loaded.solve([{ url: MEDIA }]))
    .then(
      ([url]) => new URL(url).searchParams.get("n"),
      (error) => error?.code ?? String(error),
    );
  return Promise.race([solving, pending]).finally(() => clearTimeout(timer));
}

console.log(`Node ${process.version}`);
const dir = mkdtempSync(join(tmpdir(), "ytdl-check-node-"));
let failures = 0;
try {
  for (const [index, { name, payload, outcome }] of hostile.cases.entries()) {
    const playerId = `h000000${index}`;
    const marker = join(dir, playerId);
    const prelude = hostile.prelude.replace("MARKER", JSON.stringify(marker));
    const players = { [playerId]: player.replace(HOOK, `${prelude}${payload}`), [HEALTHY]: player };
    const result = await attempt(players, playerId);
    const escaped = existsSync(marker);
    const healthy = await attempt(players, HEALTHY);
    const ok = result === outcome && !escaped && healthy === "xyz3";
    if (!ok) failures++;
    console.log(
      `${ok ? "ok  " : "FAIL"} a player that ${name}: ${result} (want ${outcome}), host reached: ${escaped}, healthy player: ${healthy}`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);

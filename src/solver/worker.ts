import vm from "node:vm";
import { type MessagePort, parentPort, workerData } from "node:worker_threads";
import { type ESTree, parseScript } from "meriyah";

export type LoadRequest = { readonly kind: "load"; readonly handle: number; readonly source: string };
export type DropRequest = { readonly kind: "drop"; readonly handle: number };
export type LoadReply = { readonly handle: number; readonly error?: string };
export interface SolveRequest {
  readonly seq: number;
  readonly handle: number;
  readonly sig?: string;
  readonly n?: string;
  readonly flag: Int32Array;
}
export type SolveReply = { readonly seq: number; readonly sig?: string; readonly n?: string; readonly error?: string };

const TIMEOUT_MS = 2000;

// The stubs yt-dlp/ejs gives the player; every URL builder must agree, as in ejs `multiTry`.
const SETUP = `
var XMLHttpRequest = { prototype: {} };
var location = { hash: "", host: "www.youtube.com", hostname: "www.youtube.com", href: "https://www.youtube.com/watch?v=", origin: "https://www.youtube.com", pathname: "/watch", port: "", protocol: "https:", search: "" };
var document = Object.create(null), navigator = Object.create(null), self = globalThis, window = globalThis;
var __ytdl = {
  builders: [],
  solve: function (sig, n) {
    var results = [], errors = [];
    for (var i = 0; i < this.builders.length; i++) {
      try {
        var url = this.builders[i]("https://www.youtube.com/watch?v=", "s", sig === undefined ? undefined : encodeURIComponent(sig));
        if (n !== undefined) url.set("n", n);
        var proto = Object.getPrototypeOf(url);
        var keys = Object.keys(proto).concat(Object.getOwnPropertyNames(proto));
        for (var j = 0; j < keys.length; j++) {
          if (["constructor", "set", "get", "clone"].indexOf(keys[j]) === -1) { url[keys[j]](); break; }
        }
        var s = url.get("s");
        results.push(JSON.stringify([s ? decodeURIComponent(s) : null, url.get("n") || null]));
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (results.length === 0) throw new Error("Every URL builder threw: " + errors.join("; "));
    for (var k = 1; k < results.length; k++) {
      if (results[k] !== results[0]) throw new Error("URL builders disagree");
    }
    return results[0];
  },
};
`;
const SOLVE = new vm.Script("__ytdl.solve(__ytdlSig, __ytdlN)");

const players = new Map<number, vm.Context>();

function prepare(source: string): vm.Context {
  const { block, skip } = playerBody(parseScript(source, { ranges: true }));
  // Top-level calls other than assignments touch the DOM; the builder needs only declarations.
  const kept = block.body
    .slice(skip)
    .filter(
      (node) =>
        node.type !== "ExpressionStatement" ||
        node.expression.type === "AssignmentExpression" ||
        node.expression.type === "Literal",
    );
  const builders = kept.flatMap(builderNames).map((node) => slice(source, node));
  if (builders.length === 0) throw new Error('No function calls ("alr", "yes"); the player layout changed');
  const code = [
    SETUP,
    source.slice(0, start(block) + 1),
    ...kept.map((node) => slice(source, node)),
    `;__ytdl.builders = [${builders.join(", ")}];`,
    source.slice(end(block) - 1),
  ].join("\n");
  const context = vm.createContext({}, { microtaskMode: "afterEvaluate" });
  vm.runInContext(code, context, { timeout: TIMEOUT_MS });
  return context;
}

/** `var _yt_player={};(function(g){var window=this;...})(_yt_player)` or `(function(){...}).call(this)`. */
function playerBody(program: ESTree.Program): { block: ESTree.BlockStatement; skip: number } {
  const [first, second] = program.body;
  if (program.body.length === 2 && second?.type === "ExpressionStatement") {
    const call = second.expression;
    if (call.type === "CallExpression" && call.callee.type === "FunctionExpression" && call.callee.body) {
      const block = call.callee.body;
      // Drop `var window = this;` so `window` is the stub.
      const head = block.body[0];
      const isWindow =
        head?.type === "VariableDeclaration" &&
        head.declarations[0]?.id.type === "Identifier" &&
        head.declarations[0].id.name === "window";
      return { block, skip: isWindow ? 1 : 0 };
    }
  }
  if (program.body.length === 1 && first?.type === "ExpressionStatement") {
    const call = first.expression;
    if (
      call.type === "CallExpression" &&
      call.callee.type === "MemberExpression" &&
      call.callee.object.type === "FunctionExpression" &&
      call.callee.object.body
    ) {
      return { block: call.callee.object.body, skip: 0 };
    }
  }
  throw new Error("Unexpected player wrapper");
}

/** Names of top-level functions whose body has the statement `x.y("alr", "yes")`. */
function builderNames(node: ESTree.Statement): ESTree.Node[] {
  const functions: [ESTree.Node, ESTree.FunctionExpression | ESTree.FunctionDeclaration][] = [];
  if (node.type === "FunctionDeclaration" && node.id && !node.async) functions.push([node.id, node]);
  if (node.type === "ExpressionStatement" && node.expression.type === "AssignmentExpression") {
    const { operator, left, right } = node.expression;
    if (operator === "=" && right.type === "FunctionExpression" && !right.async) functions.push([left, right]);
  }
  if (node.type === "VariableDeclaration") {
    for (const { id, init } of node.declarations) {
      if (init?.type === "FunctionExpression" && !init.async) functions.push([id, init]);
    }
  }
  return functions.filter(([, fn]) => fn.body?.body.some(isAlrYes)).map(([name]) => name);
}

function isAlrYes(node: ESTree.Statement): boolean {
  if (node.type !== "ExpressionStatement") return false;
  const call = node.expression;
  if (call.type !== "CallExpression" || call.callee.type !== "MemberExpression") return false;
  if (call.callee.object.type !== "Identifier") return false;
  const [key, value] = call.arguments;
  return key?.type === "Literal" && key.value === "alr" && value?.type === "Literal" && value.value === "yes";
}

function start(node: ESTree.Node): number {
  if (node.start === undefined) throw new Error("Parser returned no ranges");
  return node.start;
}

function end(node: ESTree.Node): number {
  if (node.end === undefined) throw new Error("Parser returned no ranges");
  return node.end;
}

function slice(source: string, node: ESTree.Node): string {
  return source.slice(start(node), end(node));
}

function solve(request: SolveRequest): Omit<SolveReply, "seq"> {
  const context = players.get(request.handle);
  if (!context) throw new Error("Player is no longer loaded");
  context["__ytdlSig"] = request.sig;
  context["__ytdlN"] = request.n;
  const out: unknown = JSON.parse(String(SOLVE.runInContext(context, { timeout: TIMEOUT_MS })));
  const [sig, n]: unknown[] = Array.isArray(out) ? out : [];
  if (request.sig !== undefined && typeof sig !== "string") throw new Error("URL builder returned no signature");
  if (request.n !== undefined && typeof n !== "string") throw new Error("URL builder returned no n");
  return {
    sig: request.sig !== undefined && typeof sig === "string" ? sig : undefined,
    n: request.n !== undefined && typeof n === "string" ? n : undefined,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// V8 reports unhandled rejections per isolate, which no vm context option contains; they end here, not in the host.
process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});

parentPort?.on("message", (request: LoadRequest | DropRequest) => {
  if (request.kind === "drop") {
    players.delete(request.handle);
    return;
  }
  let reply: LoadReply;
  try {
    players.set(request.handle, prepare(request.source));
    reply = { handle: request.handle };
  } catch (error) {
    reply = { handle: request.handle, error: message(error) };
  }
  parentPort?.postMessage(reply);
});

const solvePort = (workerData as { solvePort: MessagePort }).solvePort;
solvePort.on("message", (request: SolveRequest) => {
  let reply: SolveReply;
  try {
    reply = { seq: request.seq, ...solve(request) };
  } catch (error) {
    reply = { seq: request.seq, error: message(error) };
  }
  solvePort.postMessage(reply);
  Atomics.store(request.flag, 0, 1);
  Atomics.notify(request.flag, 0);
});

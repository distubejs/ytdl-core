import { types } from "node:util";
import vm from "node:vm";
import { type ESTree, parseScript } from "meriyah";
import { serve } from "../worker-rpc.ts";

export interface Challenge {
  readonly sig?: string | undefined;
  readonly n?: string | undefined;
}

export type SolverRequest =
  | { readonly kind: "load"; readonly handle: number; readonly source: string }
  | { readonly kind: "drop"; readonly handle: number }
  | { readonly kind: "solve"; readonly handle: number; readonly challenges: readonly Challenge[] };

const TIMEOUT_MS = 2000;
const NO_MESSAGE = "Player code threw a value without a message";

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
  solveAll: function (challenges) {
    var out = [];
    for (var i = 0; i < challenges.length; i++) out.push(this.solve(challenges[i].sig, challenges[i].n));
    return "[" + out.join(",") + "]";
  },
};
`;
const STANDARD_GLOBALS = [
  "globalThis",
  "Infinity",
  "NaN",
  "undefined",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
  "Object",
  "Function",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Date",
  "RegExp",
  "Promise",
  "Proxy",
  "Reflect",
  "Math",
  "JSON",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "ArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
];
const KEEP_STANDARD_GLOBALS = `(function (allowed) {
  var names = Object.getOwnPropertyNames(globalThis);
  for (var i = 0; i < names.length; i++) if (allowed.indexOf(names[i]) === -1 && !delete globalThis[names[i]]) globalThis[names[i]] = undefined;
  return Object.getOwnPropertyNames(globalThis).filter(function (name) { return allowed.indexOf(name) === -1 && globalThis[name] !== undefined; }).join(", ");
})(${JSON.stringify(STANDARD_GLOBALS)})`;

const players = new Map<number, vm.Context>();

function standardContext(): vm.Context {
  const context = vm.createContext(Object.create(null), {
    microtaskMode: "afterEvaluate",
    codeGeneration: { strings: false },
  });
  const survivors: unknown = vm.runInContext(KEEP_STANDARD_GLOBALS, context);
  if (survivors !== "") throw new Error(`The solver context kept non-standard globals: ${String(survivors)}`);
  return context;
}

function prepare(source: string): vm.Context {
  const program = parseScript(source, { ranges: true });
  if (hasDynamicImport(program)) throw new Error("The player uses import()");
  const { block, skip } = playerBody(program);
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
  const context = standardContext();
  runPlayer(code, context);
  return context;
}

function hasDynamicImport(program: ESTree.Program): boolean {
  const pending: unknown[] = [program];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (typeof node !== "object" || node === null) continue;
    if ("type" in node && node.type === "ImportExpression") return true;
    for (const value of Object.values(node)) pending.push(value);
  }
  return false;
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

function runPlayer(code: string, context: vm.Context): unknown {
  const guarded = `try{\n${code}\n}catch(e){let m;try{m=e.message}catch{}throw typeof m==="string"?m:${JSON.stringify(NO_MESSAGE)}}`;
  try {
    return vm.runInContext(guarded, context, { timeout: TIMEOUT_MS });
  } catch (error) {
    throw new Error(ownMessage(error), { cause: error });
  }
}

function ownMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && !types.isProxy(error)) {
    const message: unknown = Object.getOwnPropertyDescriptor(error, "message")?.value;
    if (typeof message === "string") return message;
  }
  return NO_MESSAGE;
}

function solve(handle: number, challenges: readonly Challenge[]): Challenge[] {
  const context = players.get(handle);
  if (!context) throw new Error("Player is no longer loaded");
  const raw = runPlayer(`__ytdl.solveAll(JSON.parse(${JSON.stringify(JSON.stringify(challenges))}))`, context);
  if (typeof raw !== "string") throw new Error("URL builder returned no answers");
  const out: unknown = JSON.parse(raw);
  if (!Array.isArray(out) || out.length !== challenges.length) throw new Error("URL builder returned no answers");
  return challenges.map((challenge, index) => {
    const [sig, n]: unknown[] = Array.isArray(out[index]) ? out[index] : [];
    if (challenge.sig !== undefined && typeof sig !== "string") throw new Error("URL builder returned no signature");
    if (challenge.n !== undefined && (typeof n !== "string" || n.endsWith(challenge.n))) {
      throw new Error("URL builder did not transform n");
    }
    return {
      sig: challenge.sig !== undefined && typeof sig === "string" ? sig : undefined,
      n: challenge.n !== undefined && typeof n === "string" ? n : undefined,
    };
  });
}

// V8 reports unhandled rejections per isolate, which no vm context option contains; they end here, not in the host.
process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});

serve((message) => {
  const request = message as SolverRequest;
  if (request.kind === "load") players.set(request.handle, prepare(request.source));
  else if (request.kind === "drop") players.delete(request.handle);
  else return solve(request.handle, request.challenges);
  return undefined;
});

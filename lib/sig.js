const querystring = require("querystring");
const Cache = require("./cache");
const utils = require("./utils");
const vm = require("vm");

// A shared cache to keep track of html5player js functions.
exports.cache = new Cache(1);

/**
 * Extract signature deciphering and n parameter transform functions from html5player file.
 *
 * @param {string} html5playerfile
 * @param {Object} options
 * @returns {Promise<Array.<string>>}
 */
exports.getFunctions = (html5playerfile, options) =>
  exports.cache.getOrSet(html5playerfile, async () => {
    // Rewrite tce player script URLs to non-tce variant
    if (html5playerfile.includes("/player_ias_tce.vflset/")) {
      console.debug("jsUrl URL points to tce-variant player script, rewriting to non-tce.");
      html5playerfile = html5playerfile.replace("/player_ias_tce.vflset/", "/player_ias.vflset/");
    }

    const body = await utils.request(html5playerfile, options);
    const functions = exports.extractFunctions(body);
    exports.cache.set(html5playerfile, functions);
    return functions;
  });

// Updated VARIABLE_PART based on the Java code
const VARIABLE_PART = "[a-zA-Z_\\$][a-zA-Z_0-9\\$]*";

const DECIPHER_NAME_REGEXPS = {
  "\\b([a-zA-Z0-9_$]+)&&\\(\\1=([a-zA-Z0-9_$]{2,})\\(decodeURIComponent\\(\\1\\)\\)": 2,
  '([a-zA-Z0-9_$]+)\\s*=\\s*function\\(\\s*([a-zA-Z0-9_$]+)\\s*\\)\\s*{\\s*\\2\\s*=\\s*\\2\\.split\\(\\s*""\\s*\\)\\s*;\\s*[^}]+;\\s*return\\s+\\2\\.join\\(\\s*""\\s*\\)': 1,
  '/(?:\\b|[^a-zA-Z0-9_$])([a-zA-Z0-9_$]{2,})\\s*=\\s*function\\(\\s*a\\s*\\)\\s*{\\s*a\\s*=\\s*a\\.split\\(\\s*""\\s*\\)(?:;[a-zA-Z0-9_$]{2}\\.[a-zA-Z0-9_$]{2}\\(a,\\d+\\))?/': 1,
  "\\bm=([a-zA-Z0-9$]{2,})\\(decodeURIComponent\\(h\\.s\\)\\)": 1,
  "\\bc&&\\(c=([a-zA-Z0-9$]{2,})\\(decodeURIComponent\\(c\\)\\)": 1,
  '(?:\\b|[^a-zA-Z0-9$])([a-zA-Z0-9$]{2,})\\s*=\\s*function\\(\\s*a\\s*\\)\\s*\\{\\s*a\\s*=\\s*a\\.split\\(\\s*""\\s*\\)': 1,
  '([\\w$]+)\\s*=\\s*function\\((\\w+)\\)\\{\\s*\\2=\\s*\\2\\.split\\(""\\)\\s*;': 1,
};

// LavaPlayer regexps - update to use the new VARIABLE_PART
const VARIABLE_PART_DEFINE = `\\"?${VARIABLE_PART}\\"?`;
const BEFORE_ACCESS = '(?:\\[\\"|\\.)';
const AFTER_ACCESS = '(?:\\"\\]|)';
const VARIABLE_PART_ACCESS = BEFORE_ACCESS + VARIABLE_PART + AFTER_ACCESS;
const REVERSE_PART = ":function\\(\\w\\)\\{(?:return )?\\w\\.reverse\\(\\)\\}";
const SLICE_PART = ":function\\(\\w,\\w\\)\\{return \\w\\.slice\\(\\w\\)\\}";
const SPLICE_PART = ":function\\(\\w,\\w\\)\\{\\w\\.splice\\(0,\\w\\)\\}";
const SWAP_PART =
  ":function\\(\\w,\\w\\)\\{var \\w=\\w\\[0\\];\\w\\[0\\]=\\w\\[\\w%\\w\\.length\\];\\w\\[\\w(?:%\\w.length|)\\]=\\w(?:;return \\w)?\\}";

const DECIPHER_REGEXP =
  `function(?: ${VARIABLE_PART})?\\(([a-zA-Z])\\)\\{` +
  '\\1=\\1\\.split\\(""\\);\\s*' +
  `((?:(?:\\1=)?${VARIABLE_PART}${VARIABLE_PART_ACCESS}\\(\\1,\\d+\\);)+)` +
  'return \\1\\.join\\(""\\)' +
  `\\}`;

const HELPER_REGEXP = `var (${VARIABLE_PART})=\\{((?:(?:${VARIABLE_PART_DEFINE}${REVERSE_PART}|${
  VARIABLE_PART_DEFINE
}${SLICE_PART}|${VARIABLE_PART_DEFINE}${SPLICE_PART}|${VARIABLE_PART_DEFINE}${SWAP_PART}),?\\n?)+)\\};`;

const SCVR = "[a-zA-Z0-9$_]";
const MCR = `${SCVR}+`;
const AAR = "\\[(\\d+)]";
const N_TRANSFORM_NAME_REGEXPS = {
  [`${SCVR}="nn"\\[\\+${MCR}\\.${MCR}],${MCR}\\(${MCR}\\),${MCR}=${MCR}\\.${MCR}\\[${MCR}]\\|\\|null\\).+\\|\\|(${MCR})\\(""\\)`]: 1,
  [`${SCVR}="nn"\\[\\+${MCR}\\.${MCR}],${MCR}\\(${MCR}\\),${MCR}=${MCR}\\.${MCR}\\[${MCR}]\\|\\|null\\)&&\\(${MCR}=(${MCR})${AAR}`]: 1,
  [`${SCVR}="nn"\\[\\+${MCR}\\.${MCR}],${MCR}=${MCR}\\.get\\(${MCR}\\)\\).+\\|\\|(${MCR})\\(""\\)`]: 1,
  [`${SCVR}="nn"\\[\\+${MCR}\\.${MCR}],${MCR}=${MCR}\\.get\\(${MCR}\\)\\)&&\\(${MCR}=(${MCR})\\[(\\d+)]`]: 1,
  [`\\(${SCVR}=String\\.fromCharCode\\(110\\),${SCVR}=${SCVR}\\.get\\(${SCVR}\\)\\)&&\\(${SCVR}=(${MCR})(?:${AAR})?\\(${SCVR}\\)`]: 1,
  [`\\.get\\("n"\\)\\)&&\\(${SCVR}=(${MCR})(?:${AAR})?\\(${SCVR}\\)`]: 1,
};

// LavaPlayer regexps
const N_TRANSFORM_REGEXP =
  "function\\(\\s*(\\w+)\\s*\\)\\s*\\{" +
  "var\\s*(\\w+)=(?:\\1\\.split\\(.*?\\)|String\\.prototype\\.split\\.call\\(\\1,.*?\\))," +
  "\\s*(\\w+)=(\\[.*?]);\\s*\\3\\[\\d+]" +
  "(.*?try)(\\{.*?})catch\\(\\s*(\\w+)\\s*\\)\\s*\\{" +
  '\\s*return"[\\w-]+([A-z0-9-]+)"\\s*\\+\\s*\\1\\s*}' +
  '\\s*return\\s*(\\2\\.join\\(""\\)|Array\\.prototype\\.join\\.call\\(\\2,.*?\\))};';

const DECIPHER_ARGUMENT = "sig";
const N_ARGUMENT = "ncode";

const matchRegex = (regex, str) => {
  const match = str.match(new RegExp(regex, "s"));
  if (!match) throw new Error(`Could not match ${regex}`);
  return match;
};

const matchGroup = (regex, str, idx = 0) => matchRegex(regex, str)[idx];

const getFuncName = (body, regexps) => {
  let fn;
  for (const [regex, idx] of Object.entries(regexps)) {
    try {
      fn = matchGroup(regex, body, idx);
      try {
        fn = matchGroup(`${fn.replace(/\$/g, "\\$")}=\\[([a-zA-Z0-9$\\[\\]]{2,})\\]`, body, 1);
      } catch (err) {
        // Function name is not inside an array
      }
      break;
    } catch (err) {
      continue;
    }
  }
  if (!fn || fn.includes("[")) throw Error("Could not match");
  return fn;
};

const DECIPHER_FUNC_NAME = "DisTubeDecipherFunc";
const extractDecipherFunc = (exports.d1 = body => {
  try {
    const helperObject = matchGroup(HELPER_REGEXP, body, 0);
    const decipherFunc = matchGroup(DECIPHER_REGEXP, body, 0);
    const resultFunc = `var ${DECIPHER_FUNC_NAME}=${decipherFunc};`;
    const callerFunc = `${DECIPHER_FUNC_NAME}(${DECIPHER_ARGUMENT});`;
    return helperObject + resultFunc + callerFunc;
  } catch (e) {
    return null;
  }
});

const extractDecipherWithName = (exports.d2 = body => {
  try {
    const decipherFuncName = getFuncName(body, DECIPHER_NAME_REGEXPS);
    const funcPattern = `(${decipherFuncName.replace(/\$/g, "\\$")}=function\\([a-zA-Z0-9_]+\\)\\{.+?\\})`;
    const decipherFunc = `var ${matchGroup(funcPattern, body, 1)};`;
    const helperObjectName = matchGroup(";([A-Za-z0-9_\\$]{2,})\\.\\w+\\(", decipherFunc, 1);
    const helperPattern = `(var ${helperObjectName.replace(/\$/g, "\\$")}=\\{[\\s\\S]+?\\}\\};)`;
    const helperObject = matchGroup(helperPattern, body, 1);
    const callerFunc = `${decipherFuncName}(${DECIPHER_ARGUMENT});`;
    return helperObject + decipherFunc + callerFunc;
  } catch (e) {
    return null;
  }
});

const getExtractFunctions = (extractFunctions, body, postProcess = null) => {
  for (const extractFunction of extractFunctions) {
    try {
      const func = extractFunction(body);
      if (!func) continue;
      return new vm.Script(postProcess ? postProcess(func) : func);
    } catch (err) {
      continue;
    }
  }
  return null;
};

let decipherWarning = false;
// This is required function to get the stream url, but we can continue if user doesn't need stream url.
const extractDecipher = body => {
  // Faster: extractDecipherFunc
  const decipherFunc = getExtractFunctions([extractDecipherFunc, extractDecipherWithName], body);
  if (!decipherFunc && !decipherWarning) {
    console.warn(
      "\x1b[33mWARNING:\x1B[0m Could not parse decipher function.\n" +
        "Stream URLs will be missing.\n" +
        `Please report this issue by uploading the "${utils.saveDebugFile(
          "base.js",
          body,
        )}" file on https://github.com/distubejs/ytdl-core/issues/144.`,
    );
    decipherWarning = true;
  }
  return decipherFunc;
};

const N_TRANSFORM_FUNC_NAME = "DisTubeNTransformFunc";
const extractNTransformFunc = (exports.n1 = body => {
  try {
    const nFunc = matchGroup(N_TRANSFORM_REGEXP, body, 0);
    const resultFunc = `var ${N_TRANSFORM_FUNC_NAME}=${nFunc}`;
    const callerFunc = `${N_TRANSFORM_FUNC_NAME}(${N_ARGUMENT});`;
    return resultFunc + callerFunc;
  } catch (e) {
    return null;
  }
});

const extractNTransformWithName = (exports.n2 = body => {
  try {
    const nFuncName = getFuncName(body, N_TRANSFORM_NAME_REGEXPS);
    const funcPattern = `(${nFuncName.replace(/\$/g, "\\$")}=function\\([a-zA-Z0-9_]+\\)\\{.+?\\})`;
    const nTransformFunc = `var ${matchGroup(funcPattern, body, 1)};`;
    const callerFunc = `${nFuncName}(${N_ARGUMENT});`;
    return nTransformFunc + callerFunc;
  } catch (e) {
    return null;
  }
});


let nTransformWarning = false;
const extractNTransform = body => {
  // Faster: extractNTransformFunc
  const nTransformFunc = getExtractFunctions([extractNTransformFunc, extractNTransformWithName], body, code =>
    code.replace(/if\s*\(\s*typeof\s*[\w$]+\s*===?.*?\)\s*return\s+[\w$]+\s*;?/, ""),
  );
  if (!nTransformFunc && !nTransformWarning) {
    // This is optional, so we can continue if it's not found, but it will bottleneck the download.
    console.warn(
      "\x1b[33mWARNING:\x1B[0m Could not parse n transform function.\n" +
        `Please report this issue by uploading the "${utils.saveDebugFile(
          "base.js",
          body,
        )}" file on https://github.com/distubejs/ytdl-core/issues/144.`,
    );
    nTransformWarning = true;
  }
  return nTransformFunc;
};
/**
 * Extracts the actions that should be taken to decipher a signature
 * and transform the n parameter
 *
 * @param {string} body
 * @returns {Array.<string>}
 */
exports.extractFunctions = body => [extractDecipher(body), extractNTransform(body)];

/**
 * Apply decipher and n-transform to individual format
 *
 * @param {Object} format
 * @param {vm.Script} decipherScript
 * @param {vm.Script} nTransformScript
 */
exports.setDownloadURL = (format, decipherScript, nTransformScript) => {
  if (!decipherScript) return;
  const decipher = url => {
    const args = querystring.parse(url);
    if (!args.s) return args.url;
    const components = new URL(decodeURIComponent(args.url));
    const context = {};
    context[DECIPHER_ARGUMENT] = decodeURIComponent(args.s);
    components.searchParams.set(args.sp || "sig", decipherScript.runInNewContext(context));
    return components.toString();
  };
  const nTransform = url => {
    const components = new URL(decodeURIComponent(url));
    const n = components.searchParams.get("n");
    if (!n || !nTransformScript) return url;
    const context = {};
    context[N_ARGUMENT] = n;
    components.searchParams.set("n", nTransformScript.runInNewContext(context));
    return components.toString();
  };
  const cipher = !format.url;
  const url = format.url || format.signatureCipher || format.cipher;
  format.url = nTransform(cipher ? decipher(url) : url);
  delete format.signatureCipher;
  delete format.cipher;
};

/**
 * Applies decipher and n parameter transforms to all format URL's.
 *
 * @param {Array.<Object>} formats
 * @param {string} html5player
 * @param {Object} options
 */
exports.decipherFormats = async (formats, html5player, options) => {
  const decipheredFormats = {};
  const [decipherScript, nTransformScript] = await exports.getFunctions(html5player, options);
  formats.forEach(format => {
    exports.setDownloadURL(format, decipherScript, nTransformScript);
    decipheredFormats[format.url] = format;
  });
  return decipheredFormats;
};

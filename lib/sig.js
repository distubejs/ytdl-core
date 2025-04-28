const querystring = require("querystring");
const Cache = require("./cache");
const utils = require("./utils");
const vm = require("vm");
const { URL } = require("url");  // Import URL for parsing addresses

exports.cache = new Cache(1);

const DEFAULT_YT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "*/*",
  "Referer": "https://www.youtube.com/",
  "Origin": "https://www.youtube.com",
  "sec-ch-ua": "\"Not/A)Brand\";v=\"8\", \"Chromium\";v=\"126\"",
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": "\"Windows\"",
  "sec-fetch-dest": "audio",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-site": "cross-site"
};

exports.getFunctions = (html5playerfile, options) =>
  exports.cache.getOrSet(html5playerfile, async () => {
    const mergedOptions = Object.assign({}, options, {
      headers: Object.assign({}, DEFAULT_YT_HEADERS, options?.headers),
    });

    const body = await utils.request(html5playerfile, mergedOptions);
    const functions = exports.extractFunctions(body);
    exports.cache.set(html5playerfile, functions);
    return functions;
  });

const VARIABLE_PART = "[a-zA-Z_\\$][a-zA-Z_0-9\\$]*";
const VARIABLE_PART_DEFINE = "\"?(" + VARIABLE_PART + ")\"?";
const BEFORE_ACCESS = "(?:\\[\"|\\.)";
const AFTER_ACCESS = "(?:\"\\]|)";
const VARIABLE_PART_ACCESS = BEFORE_ACCESS + VARIABLE_PART + AFTER_ACCESS;
const REVERSE_PART = ":function\\(\\w\\)\\{(?:return )?\\w\\.reverse\\(\\)\\}";
const SLICE_PART = ":function\\(\\w,\\w\\)\\{return \\w\\.slice\\(\\w\\)\\}";
const SPLICE_PART = ":function\\(\\w,\\w\\)\\{\\w\\.splice\\(0,\\w\\)\\}";
const SWAP_PART = ":function\\(a,b\\)\\{var c=a\\[0\\];a\\[0\\]=a\\[b%a\\.length\\];a\\[b(?:%a\\.length|)\\]=c(?:;return a)?\\}";
const DECIPHER_REGEXP = "function(?: [a-zA-Z_$]+)?\\(a\\)\\{a=a\\.split\\(\"\"\\);\\s*((?:a=)?[a-zA-Z_$]+\\.[a-zA-Z_$]+\\(a,\\d+\\);)+return a\\.join\\(\"\"\\)\\}";

const HELPER_REGEXP = "var (" + VARIABLE_PART + ")=\\{((?:(?:" +
  VARIABLE_PART_DEFINE + REVERSE_PART + "|" +
  VARIABLE_PART_DEFINE + SLICE_PART + "|" +
  VARIABLE_PART_DEFINE + SPLICE_PART + "|" +
  VARIABLE_PART_DEFINE + SWAP_PART +
  "),?\\n?)+)\\};";

const FUNCTION_TCE_REGEXP = "function(?:\\s+[a-zA-Z_\\$][a-zA-Z0-9_\\$]*)?\\(\\w\\)\\{" +
  "\\w=\\w\\.split\\((?:\"\"|[a-zA-Z0-9_$]*\\[\\d+\\])\\);" +
  "\\s*((?:(?:\\w=)?[a-zA-Z_\\$][a-zA-Z0-9_\\$]*(?:\\[\\\"|\\.)[a-zA-Z_\\$][a-zA-Z0-9_\\$]*(?:\\\"\\]|)\\(\\w,\\d+\\);)+)" +
  "return \\w\\.join\\((?:\"\"|[a-zA-Z0-9_$]*\\[\\d+\\])\\)}";

const N_TRANSFORM_REGEXP = "function\\s*\\((\\w+)\\)\\s*\\{(?:[^{}]*|\\{[^{}]*\\})*" +
  "try\\s*\\{(?:[^{}]*|\\{[^{}]*\\})*\\}\\s*catch\\s*\\((\\w+)\\)\\s*\\{" +
  "(?:[^{}]*|\\{[^{}]*\\})*return[^;]*;\\s*\\}" +
  "(?:[^{}]*|\\{[^{}]*\\})*return[^;]*;\\s*\\}";

const N_TRANSFORM_TCE_REGEXP =
  "function\\(\\s*(\\w+)\\s*\\)\\s*\\{" +
  "\\s*(var|const)\\s*(\\w+)=\\1\\.split\\(\\s*['\"]{2}\\s*\\)," +
  "\\s*(\\w+)=\\[.*?\\];.*?catch\\(\\s*(\\w+)\\s*\\)\\s*\\{" +
  "\\s*return[^}]+\\}" +
  "\\s*return\\s*\\3\\.join\\(\\s*['\"]{2}\\s*\\)\\s*\\};";

const TCE_GLOBAL_VARS_REGEXP =
  "(?:^|[;,])\\s*(var\\s+([\\w$]+)\\s*=\\s*" +
  "(?:" +
  "([\"'])(?:\\\\.|[^\\\\])*?\\3" +
  "\\s*\\.\\s*split\\((" +
  "([\"'])(?:\\\\.|[^\\\\])*?\\5" +
  "\\))" +
  "|" +
  "\\[\\s*(?:([\"'])(?:\\\\.|[^\\\\])*?\\6\\s*,?\\s*)+\\]" +
  "))(?=\\s*[,;])";

const NEW_TCE_GLOBAL_VARS_REGEXP =
  "('use\\s*strict';)?" +
  "(?<code>var\\s*" +
  "(?<varname>[a-zA-Z0-9_$]+)\\s*=\\s*" +
  "(?<value>" +
  "(?:\"[^\"\\\\]*(?:\\\\.[^\"\\\\]*)*\"|'[^'\\\\]*(?:\\\\.[^'\\\\]*)*')" +
  "\\.split\\(" +
  "(?:\"[^\"\\\\]*(?:\\\\.[^\"\\\\]*)*\"|'[^'\\\\]*(?:\\\\.[^'\\\\]*)*')" +
  "\\)" +
  "|" +
  "\\[" +
  "(?:(?:\"[^\"\\\\]*(?:\\\\.[^\"\\\\]*)*\"|'[^'\\\\]*(?:\\\\.[^'\\\\]*)*')" +
  "\\s*,?\\s*)*" +
  "\\]" +
  "|" +
  "\"[^\"]*\"\\.split\\(\"[^\"]*\"\\)" +
  ")" +
  ")";

const TCE_SIGN_FUNCTION_REGEXP = "function\\(\\s*([a-zA-Z0-9$])\\s*\\)\\s*\\{" +
  "\\s*\\1\\s*=\\s*\\1\\[(\\w+)\\[\\d+\\]\\]\\(\\w+\\[\\d+\\]\\);" +
  "([a-zA-Z0-9$]+)\\[\\2\\[\\d+\\]\\]\\(\\s*\\1\\s*,\\s*\\d+\\s*\\);" +
  "\\s*\\3\\[\\2\\[\\d+\\]\\]\\(\\s*\\1\\s*,\\s*\\d+\\s*\\);" +
  ".*?return\\s*\\1\\[\\2\\[\\d+\\]\\]\\(\\2\\[\\d+\\]\\)\\};";

const TCE_SIGN_FUNCTION_ACTION_REGEXP = "var\\s*[a-zA-Z0-9$_]+\\s*=\\s*\\{\\s*[a-zA-Z0-9$_]+\\s*:\\s*function\\((\\w+|\\s*\\w+\\s*,\\s*\\w+\\s*)\\)\\s*\\{\\s*(\\s*var\\s*\\w+=\\w+\\[\\d+\\];\\w+\\[\\w+\\s*%\\s*\\w+\\[\\w+\\[\\d+\\]\\]\\];\\s*\\w+\\[\\w+\\s*%\\s*\\w+\\[\\w+\\[\\d+\\]\\]\\]\\s*=\\s*\\w+;\\s*)\\},|\\w+\\[\\w+\\[\\d+\\]\\]\\(\\)\\},)\\s*[a-zA-Z0-9$_]+\\s*:\\s*function\\((\\s*\\w+\\w*,\\s*\\w+\\s*|\\w+)\\)\\s*\\{(\\w+\\[\\w+\\[\\d+\\]\\]\\(\\)|\\s*var\\s*\\w+\\s*=\\w+\\[\\d+\\];\\w+\\[\\d+\\]\\s*=\\w+\\[\\s*\\w+\\s*%\\s*\\w+\\[\\w+\\[\\d+\\]\\]\\]\\;\\w+\\[\\s*\\w+\\s*%\\s*\\w+\\[\\w+\\[\\d+\\]\\]\\]\\s*=\\s*\\w+;\\s*)\\},\\s*[a-zA-Z0-9$_]+\\s*:\\s*function\\s*\\(\\s*\\w+\\s*,\\s*\\w+\\s*\\)\\{\\w+\\[\\w+\\[\\d+\\]\\]\\(\\s*\\d+\\s*,\\s*\\w+\\s*\\)\\}\\};";

const TCE_N_FUNCTION_REGEXP = "function\\s*\\((\\w+)\\)\\s*\\{var\\s*\\w+\\s*=\\s*\\1\\[\\w+\\[\\d+\\]\\]\\(\\w+\\[\\d+\\]\\)\\s*,\\s*\\w+\\s*=\\s*\\[.*?\\]\\;.*?catch\\(\\s*(\\w+)\\s*\\)\\s*\\{return\\s*\\w+\\[\\d+\\](\\+\\1)?\\}\\s*return\\s*\\w+\\[\\w+\\[\\d+\\]\\]\\(\\w+\\[\\d+\\]\\)\\}\\;";

const PATTERN_PREFIX = "(?:^|,)\"?(" + VARIABLE_PART + ")\"?";
const REVERSE_PATTERN = new RegExp(PATTERN_PREFIX + REVERSE_PART, "m");
const SLICE_PATTERN = new RegExp(PATTERN_PREFIX + SLICE_PART, "m");
const SPLICE_PATTERN = new RegExp(PATTERN_PREFIX + SPLICE_PART, "m");
const SWAP_PATTERN = new RegExp(PATTERN_PREFIX + SWAP_PART, "m");

const DECIPHER_ARGUMENT = "sig";
const N_ARGUMENT = "ncode";
const DECIPHER_FUNC_NAME = "DisTubeDecipherFunc";
const N_TRANSFORM_FUNC_NAME = "DisTubeNTransformFunc";

const extractDollarEscapedFirstGroup = (pattern, text) => {
  const match = text.match(pattern);
  return match ? match[1].replace(/\\$/g, "\\$") : null;
};

const extractTceFunc = (body) => {
  try {
    const tceVariableMatcher = body.match(new RegExp(NEW_TCE_GLOBAL_VARS_REGEXP, 'm'));
    if (!tceVariableMatcher?.groups) {
      console.error("Failed in extractTceFunc - player script might be updated?");
      utils.saveDebugFile("player-error.js", body);
      return null;
    }
    const { code, varname } = tceVariableMatcher.groups;
    return { name: varname, code };
  } catch (e) {
    console.error("Error in extractTceFunc:", e);
    return null;
  }
};

const extractDecipherFunc = (body, name, code) => {
  try {
    const callerFunc = `${DECIPHER_FUNC_NAME}(${DECIPHER_ARGUMENT});`;
    let resultFunc;

    const sigFunctionMatcher = body.match(new RegExp(TCE_SIGN_FUNCTION_REGEXP, 's'));
    const sigFunctionActionsMatcher = body.match(new RegExp(TCE_SIGN_FUNCTION_ACTION_REGEXP, 's'));

    if (sigFunctionMatcher && sigFunctionActionsMatcher && code) {
      resultFunc = `var ${DECIPHER_FUNC_NAME}=${sigFunctionMatcher[0]}${sigFunctionActionsMatcher[0]}${code};\n`;
      return resultFunc + callerFunc;
    }

    const helperMatch = body.match(new RegExp(HELPER_REGEXP, "s"));
    if (!helperMatch) return null;

    const helperObject = helperMatch[0];
    const actionBody = helperMatch[2];
    const helperName = helperMatch[1];

    const reverseKey = extractDollarEscapedFirstGroup(REVERSE_PATTERN, actionBody);
    const sliceKey = extractDollarEscapedFirstGroup(SLICE_PATTERN, actionBody);
    const spliceKey = extractDollarEscapedFirstGroup(SPLICE_PATTERN, actionBody);
    const swapKey = extractDollarEscapedFirstGroup(SWAP_PATTERN, actionBody);

    const quotedFunctions = [reverseKey, sliceKey, spliceKey, swapKey]
      .filter(Boolean)
      .map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    if (quotedFunctions.length === 0) return null;

    let funcMatch = body.match(new RegExp(DECIPHER_REGEXP, "s"));
    let isTce = false;
    let decipherFunc;

    if (funcMatch) {
      decipherFunc = funcMatch[0];
    } else {
      const tceFuncMatch = body.match(new RegExp(FUNCTION_TCE_REGEXP, "s"));
      if (!tceFuncMatch) return null;
      decipherFunc = tceFuncMatch[0];
      isTce = true;
    }

    let tceVars = "";
    if (isTce) {
      const tceVarsMatch = body.match(new RegExp(TCE_GLOBAL_VARS_REGEXP, "m"));
      if (tceVarsMatch) tceVars = tceVarsMatch[1] + ";\n";
    }

    resultFunc = tceVars + helperObject + `\nvar ${DECIPHER_FUNC_NAME}=${decipherFunc};\n`;
    return resultFunc + callerFunc;
  } catch (e) {
    console.error("Error in extractDecipherFunc:", e);
    return null;
  }
};

const extractNTransformFunc = (body, name, code) => {
  try {
    const callerFunc = `${N_TRANSFORM_FUNC_NAME}(${N_ARGUMENT});`;
    let resultFunc;
    let nFunction;

    const nFunctionMatcher = body.match(new RegExp(TCE_N_FUNCTION_REGEXP, 's'));
    if (nFunctionMatcher && name && code) {
      nFunction = nFunctionMatcher[0];
      const tceEscapeName = name.replace("$", "\\\\$");
      const shortCircuitPattern = new RegExp(
        `;\\s*if\\s*\\(\\s*typeof\\s+[a-zA-Z0-9_$]+\\s*===?\\s*(?:"undefined"|'undefined'|${tceEscapeName}\\[\\d+\\])\\s*\\)\\s*return\\s+\\w+;`
      );
      const tceShortCircuitMatcher = nFunction.match(shortCircuitPattern);
      if (tceShortCircuitMatcher) {
        nFunction = nFunction.replaceAll(tceShortCircuitMatcher[0], ";");
      }
      resultFunc = `var ${N_TRANSFORM_FUNC_NAME}=${nFunction}${code};\n`;
      return resultFunc + callerFunc;
    }

    let nMatch = body.match(new RegExp(N_TRANSFORM_REGEXP, "s"));
    let isTce = false;
    if (nMatch) {
      nFunction = nMatch[0];
    } else {
      const nTceMatch = body.match(new RegExp(N_TRANSFORM_TCE_REGEXP, "s"));
      if (!nTceMatch) return null;
      nFunction = nTceMatch[0];
      isTce = true;
    }

    const paramMatch = nFunction.match(/function\\s*\\(\\s*(\\w+)\\s*\\)/);
    if (!paramMatch) return null;
    const paramName = paramMatch[1];
    const cleanedFunction = nFunction.replace(
      new RegExp(`if\\s*\\(typeof\\s*[^\\s()]+\\s*===?.*?\\)return ${paramName}\\s*;?`, "g"),
      ""
    );

    let tceVars = "";
    if (isTce) {
      const tceVarsMatch = body.match(new RegExp(TCE_GLOBAL_VARS_REGEXP, "m"));
      if (tceVarsMatch) tceVars = tceVarsMatch[1] + ";\n";
    }

    resultFunc = tceVars + `var ${N_TRANSFORM_FUNC_NAME}=${cleanedFunction};\n`;
    return resultFunc + callerFunc;
  } catch (e) {
    console.error("Error in extractNTransformFunc:", e);
    return null;
  }
};

let decipherWarning = false;
let nTransformWarning = false;

const getExtractFunction = (extractFunctions, body, name, code, postProcess = null) => {
  for (const extractFunction of extractFunctions) {
    try {
      const func = extractFunction(body, name, code);
      if (!func) continue;
      return new vm.Script(postProcess?.(func) ?? func);
    } catch (err) {
      console.error("Error extracting function:", err);
      continue;
    }
  }
  return null;
};

const extractDecipher = (body, name, code) => {
  const decipherFunc = getExtractFunction([extractDecipherFunc], body, name, code);
  if (!decipherFunc && !decipherWarning) {
    console.warn(
      "\x1b[33mWARNING:\x1B[0m Could not parse the decipher function.\n" +
      `Report this error by uploading the file: "${utils.saveDebugFile("player-script.js", body)}"`
    );
    decipherWarning = true;
  }
  return decipherFunc;
};

const extractNTransform = (body, name, code) => {
  const nTransformFunc = getExtractFunction([extractNTransformFunc], body, name, code);
  if (!nTransformFunc && !nTransformWarning) {
    console.warn(
      "\x1b[33mWARNING:\x1B[0m Could not parse the 'n' transformation function.\n" +
      `Report this error by uploading the file: "${utils.saveDebugFile("player-script.js", body)}"`
    );
    nTransformWarning = true;
  }
  return nTransformFunc;
};

exports.extractFunctions = body => {
  const tceData = extractTceFunc(body);
  if (!tceData) return [null, null];

  try {
    // Basic VM test
    new vm.Script('function test(){}').runInNewContext();
  } catch (e) {
    console.error("Error testing functions:", e);
  }

  return [
    extractDecipher(body, tceData.name, tceData.code),
    extractNTransform(body, tceData.name, tceData.code)
  ];
};

exports.setDownloadURL = (format, decipherScript, nTransformScript) => {
  if (!format) return;

  let originalUrl;
  let hasCipher = false;

  if (format.url) {
    originalUrl = format.url;
  } else if (format.signatureCipher || format.cipher) {
    hasCipher = true;
    originalUrl = format.signatureCipher || format.cipher;
  } else {
    return;
  }

  try {
    let finalUrl;

    if (hasCipher) {
      const args = querystring.parse(originalUrl);
      if (!args.url) return;

      finalUrl = decodeURIComponent(args.url);
      const urlObj = new URL(finalUrl);

      // --- Signature (sig) ---
      const sigParamName = args.sp || "sig";
      if (args.s) {
        let sigValue = decodeURIComponent(args.s);
        if (decipherScript) {
          try {
            const context = { [DECIPHER_ARGUMENT]: sigValue };
            const out = decipherScript.runInNewContext(context);
            if (out) sigValue = out;
          } catch (e) {
            console.error("Error deciphering signature:", e);
          }
        }
        urlObj.searchParams.set(sigParamName, sigValue);
      } else if (args.sig) {
        urlObj.searchParams.set(sigParamName, args.sig);
      }

      // --- n Parameter ---
      if (nTransformScript) {
        const nParam = urlObj.searchParams.get("n");
        if (nParam) {
          try {
            const context = { [N_ARGUMENT]: nParam };
            const transformedN = nTransformScript.runInNewContext(context);
            if (transformedN && transformedN !== nParam) {
              urlObj.searchParams.set("n", transformedN);
              console.log(`Transformed n parameter: ${nParam} -> ${transformedN}`);
            }
          } catch (e) {
            console.error("Error transforming n:", e);
          }
        }
      }

      finalUrl = urlObj.toString();
    } else {
      // Unencrypted URLs: only n parameter
      finalUrl = originalUrl;
      if (nTransformScript) {
        try {
          const urlObj = new URL(finalUrl);
          const nParam = urlObj.searchParams.get("n");
          if (nParam) {
            const context = { [N_ARGUMENT]: nParam };
            const transformedN = nTransformScript.runInNewContext(context);
            if (transformedN && transformedN !== nParam) {
              urlObj.searchParams.set("n", transformedN);
              finalUrl = urlObj.toString();
              console.log(`Transformed n parameter: ${nParam} -> ${transformedN}`);
            }
          }
        } catch (e) {
          console.error("Error transforming n on unencrypted URL:", e);
        }
      }
    }

    // Update and clean
    format.url = finalUrl;
    delete format.signatureCipher;
    delete format.cipher;
    console.log(`Processed URL: ${finalUrl.substring(0, 100)}...`);
  } catch (err) {
    console.error("Error processing URL:", err);
  }
};

exports.decipherFormats = async (formats, html5player, options) => {
  try {
    const decipheredFormats = {};
    const [decipherScript, nTransformScript] = await exports.getFunctions(html5player, options);

    formats.forEach(format => {
      exports.setDownloadURL(format, decipherScript, nTransformScript);
      if (format.url) {
        decipheredFormats[format.url] = format;
      }
    });

    return decipheredFormats;
  } catch (err) {
    console.error("Error deciphering formats:", err);
    return {};
  }
};

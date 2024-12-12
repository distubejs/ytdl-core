const { request: undiciRequest } = require("undici");
const { writeFileSync } = require("fs");
const AGENT = require("./agent");
const pkg = require("../package.json");
// Utility to extract string between two markers or regex patterns

/**
 * Extract string inbetween another.
 *
 * @param {string} haystack
 * @param {string} left
 * @param {string} right
 * @returns {string}
 */
const between = (exports.between = (haystack, left, right) => {
  let pos;
  if (left instanceof RegExp) {
    const match = haystack.match(left);
    if (!match) {
      return "";
    }
    pos = match.index + match[0].length;
  } else {
    pos = haystack.indexOf(left);
    if (pos === -1) {
      return "";
    }
    pos += left.length;
  }
  haystack = haystack.slice(pos);
  pos = haystack.indexOf(right);
  if (pos === -1) {
    return "";
  }
  haystack = haystack.slice(0, pos);
  return haystack;
});
exports.tryParseBetween = (body, left, right, prepend = "", append = "") => {
  try {
    const data = between(body, left, right);
    return data ? JSON.parse(`${prepend}${data}${append}`) : null;
  } catch {
    return null;
  }
};

// Parse abbreviated numbers directly using a regex
exports.parseAbbreviatedNumber = (str) => {
  const matched = str.replace(",", ".").trim().match(/^([\d,.]+)([MK]?)$/);
  if (!matched) return null;

  const [, numStr, multiplier] = matched;
  const num = parseFloat(numStr);
  switch (multiplier) {
    case 'M': return Math.round(num * 1_000_000);
    case 'K': return Math.round(num * 1_000);
    default: return Math.round(num);
  }
};

// Escape sequence definitions for parsing JS blocks
const ESCAPING_SEQUENCES = [
  { start: '"', end: '"' },
  { start: "'", end: "'" },
  { start: "`", end: "`" },
  { start: "/", end: "/", startPrefix: /(^|[[{:;,/])\s?$/ },
];

exports.cutAfterJS = (mixedJson) => {
  const isArray = mixedJson.startsWith("[");
  const isObject = mixedJson.startsWith("{");
  if (!isArray && !isObject) {
    throw new Error(`Unsupported JSON format: ${mixedJson[0]}`);
  }

  const open = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";
  let counter = 0; 
  let isEscaped = false; 
  let isEscapedObject = null;

  for (let i = 0; i < mixedJson.length; i++) {
    const char = mixedJson[i];

    // Handle escape sequences
    if (!isEscaped) {
      if (isEscapedObject && char === isEscapedObject.end) {
        isEscapedObject = null;
        continue;
      }

      if (!isEscapedObject) {
        for (const seq of ESCAPING_SEQUENCES) {
          if (char === seq.start && (!seq.startPrefix || mixedJson.slice(Math.max(0, i - 10), i).match(seq.startPrefix))) {
            isEscapedObject = seq;
            continue;
          }
        }
      }
    }
    
    isEscaped = char === "\\" ? !isEscaped : false;

    if (isEscapedObject) continue;

    if (char === open) counter++;
    else if (char === close) counter--;

    if (counter === 0) {
      return mixedJson.slice(0, i + 1);
    }
  }

  throw new Error("Unmatched brackets in JSON input.");
};

class UnrecoverableError extends Error {}

exports.playError = (player_response) => {
  const playability = player_response?.playabilityStatus;
  if (!playability) return null;

  const { status, reason, messages } = playability;
  if (["ERROR", "LOGIN_REQUIRED"].includes(status)) {
    return new UnrecoverableError(reason || messages?.[0]);
  }
  if (status === "LIVE_STREAM_OFFLINE") {
    return new UnrecoverableError(reason || "The live stream is offline.");
  }
  if (status === "UNPLAYABLE") {
    return new UnrecoverableError(reason || "This video is unavailable.");
  }
  return null;
};

// Abstracted request method using undici
exports.request = async (url, options = {}) => {
  const { requestOptions, rewriteRequest } = options;

  if (typeof rewriteRequest === "function") {
    const rewritten = rewriteRequest(url, requestOptions);
    url = rewritten.url;
    requestOptions = rewritten.requestOptions;
  }

  const req = await undiciRequest(url, requestOptions);
  const code = req.statusCode.toString();

  if (code.startsWith("2")) {
    return req.headers['content-type']?.includes("application/json") ? req.body.json() : req.body.text();
  }

  if (code.startsWith("3")) {
    return exports.request(req.headers.location, options);
  }

  throw new Error(`Status code: ${code}`);
};
/**
 * Temporary helper to help deprecating a few properties.
 *
 * @param {Object} obj
 * @param {string} prop
 * @param {Object} value
 * @param {string} oldPath
 * @param {string} newPath
 */

// Define the update interval in milliseconds (12 hours)
const UPDATE_INTERVAL = 1000 * 60 * 60 * 12;

// A variable to track the last update check timestamp
exports.lastUpdateCheck = 0;
// Keep track of update warning times
let updateWarnTimes = 0;

// Mark properties as deprecated with a warning
exports.deprecate = (obj, prop, value, oldPath, newPath) => {
  Object.defineProperty(obj, prop, {
    get: () => {
      console.warn(`"${oldPath}" will be removed in a near future release. Use "${newPath}" instead.`);
      return value;
    },
  });
};

// Check for updates
exports.checkForUpdates = async () => {
  if (
    process.env.YTDL_NO_UPDATE === undefined &&
    !pkg.version.startsWith("0.0.0-") &&
    Date.now() - exports.lastUpdateCheck >= UPDATE_INTERVAL
  ) {
    exports.lastUpdateCheck = Date.now();
    
    try {
      const response = await exports.request("https://api.github.com/repos/distubejs/ytdl-core/contents/package.json", {
        requestOptions: {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.3",
          },
        },
      });
      
      const pkgFile = JSON.parse(Buffer.from(response.content, response.encoding).toString("ascii"));
      if (pkgFile.version !== pkg.version && updateWarnTimes++ < 5) {
        console.warn('\x1b[33mWARNING:\x1B[0m @distube/ytdl-core is out of date! Update with "npm install @distube/ytdl-core@latest".');
      }
    } catch (err) {
      console.warn("Error checking for updates:", err.message);
      console.warn("You can disable this check by setting the `YTDL_NO_UPDATE` env variable.");
    }
  }
};

// Regex for validating IPv6 addresses
const IPV6_REGEX = /^(([0-9a-f]{1,4}:){1,7}([0-9a-f]{1,4}|:)|([0-9a-f]{1,4}:){1,6}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,5}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,6}|[0-9a-f]{1,4}:(([0-9a-f]{1,4})|:)|:((:[0-9a-f]{1,4}){1,7}|:))\/(1[0-1]\d|12[0-8]|\d{1,2})$/;

// Validate IPv6 format
exports.isIPv6 = ip => IPV6_REGEX.test(ip);

// Normalize an IPv6 address into an array of integers
exports.normalizeIP = ip => {
  const parts = ip.split("::").map(x => x.split(":"));
  const fullIP = new Array(8).fill(0);

  const partStart = parts[0] || [];
  const partEnd = (parts[1] || []).reverse();

  for (let i = 0; i < partStart.length; i++) {
    fullIP[i] = parseInt(partStart[i] || '0', 16);
  }
  
  for (let i = 0; i < partEnd.length; i++) {
    fullIP[7 - i] = parseInt(partEnd[i] || '0', 16);
  }

  return fullIP;
};

// Get a random IPv6 address from a specified block
exports.getRandomIPv6 = (ip) => {
  if (!exports.isIPv6(ip)) throw new Error("Invalid IPv6 format");
  
  const [rawAddr, rawMask] = ip.split("/");
  const base10Mask = parseInt(rawMask);
  
  if (!base10Mask || base10Mask < 24 || base10Mask > 128) throw new Error("Invalid IPv6 subnet");

  const base10Addr = exports.normalizeIP(rawAddr);
  const randomAddr = Array.from({ length: 8 }, () => Math.floor(Math.random() * 0xFFFF));

  return randomAddr.map((randomItem, idx) => {
    const staticBits = Math.min(base10Mask, 16);
    const mask = 0xFFFF << (16 - staticBits) >>> 0;  // Create mask
    const addrPart = (base10Addr[idx] & mask) + (randomItem & ~mask);
    return addrPart.toString(16);
  }).join(":");
};

// Save debug information to a file
exports.saveDebugFile = (name, body) => {
  const filename = `${Date.now()}-${name}`;
  writeFileSync(filename, body);
  return filename;
};
const findPropKeyInsensitive = (obj, prop) =>
  Object.keys(obj).find(p => p.toLowerCase() === prop.toLowerCase()) || null;

exports.getPropInsensitive = (obj, prop) => {
  const key = findPropKeyInsensitive(obj, prop);
  return key && obj[key];
};

exports.setPropInsensitive = (obj, prop, value) => {
  const key = findPropKeyInsensitive(obj, prop);
  obj[key || prop] = value;
  return key;
};

let oldCookieWarning = true;
let oldDispatcherWarning = true;
exports.applyDefaultAgent = options => {
  if (!options.agent) {
    const { jar } = AGENT.defaultAgent;
    const c = exports.getPropInsensitive(options.requestOptions.headers, "cookie");
    if (c) {
      jar.removeAllCookiesSync();
      AGENT.addCookiesFromString(jar, c);
      if (oldCookieWarning) {
        oldCookieWarning = false;
        console.warn(
          "\x1b[33mWARNING:\x1B[0m Using old cookie format, " +
            "please use the new one instead. (https://github.com/distubejs/ytdl-core#cookies-support)",
        );
      }
    }
    if (options.requestOptions.dispatcher && oldDispatcherWarning) {
      oldDispatcherWarning = false;
      console.warn(
        "\x1b[33mWARNING:\x1B[0m Your dispatcher is overridden by `ytdl.Agent`. " +
          "To implement your own, check out the documentation. " +
          "(https://github.com/distubejs/ytdl-core#how-to-implement-ytdlagent-with-your-own-dispatcher)",
      );
    }
    options.agent = AGENT.defaultAgent;
  }
};

let oldLocalAddressWarning = true;
exports.applyOldLocalAddress = options => {
  if (
    !options.requestOptions ||
    !options.requestOptions.localAddress ||
    options.requestOptions.localAddress === options.agent.localAddress
  )
    return;
  options.agent = AGENT.createAgent(undefined, { localAddress: options.requestOptions.localAddress });
  if (oldLocalAddressWarning) {
    oldLocalAddressWarning = false;
    console.warn(
      "\x1b[33mWARNING:\x1B[0m Using old localAddress option, " +
        "please add it to the agent options instead. (https://github.com/distubejs/ytdl-core#ip-rotation)",
    );
  }
};

let oldIpRotationsWarning = true;
exports.applyIPv6Rotations = options => {
  if (options.IPv6Block) {
    options.requestOptions = Object.assign({}, options.requestOptions, {
      localAddress: getRandomIPv6(options.IPv6Block),
    });
    if (oldIpRotationsWarning) {
      oldIpRotationsWarning = false;
      oldLocalAddressWarning = false;
      console.warn(
        "\x1b[33mWARNING:\x1B[0m IPv6Block option is deprecated, " +
          "please create your own ip rotation instead. (https://github.com/distubejs/ytdl-core#ip-rotation)",
      );
    }
  }
};

exports.applyDefaultHeaders = options => {
  options.requestOptions = Object.assign({}, options.requestOptions);
  options.requestOptions.headers = Object.assign(
    {},
    {
      // eslint-disable-next-line max-len
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.101 Safari/537.36",
    },
    options.requestOptions.headers,
  );
};

exports.generateClientPlaybackNonce = length => {
  const CPN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return Array.from({ length }, () => CPN_CHARS[Math.floor(Math.random() * CPN_CHARS.length)]).join("");
};

exports.applyPlayerClients = options => {
  if (!options.playerClients || options.playerClients.length === 0) {
    options.playerClients = ["WEB_CREATOR", "IOS"];
  }
};

const { request } = require("undici");
const { writeFileSync } = require("fs");
const AGENT = require("./agent");

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
    let data = between(body, left, right);
    if (!data) return null;
    return JSON.parse(`${prepend}${data}${append}`);
  } catch (e) {
    return null;
  }
};

/**
 * Get a number from an abbreviated number string.
 *
 * @param {string} string
 * @returns {number}
 */
exports.parseAbbreviatedNumber = string => {
  const match = string
    .replace(",", ".")
    .replace(" ", "")
    .match(/([\d,.]+)([MK]?)/);
  if (match) {
    let [, num, multi] = match;
    num = parseFloat(num);
    return Math.round(multi === "M" ? num * 1000000 : multi === "K" ? num * 1000 : num);
  }
  return null;
};

/**
 * Escape sequences for cutAfterJS
 * @param {string} start the character string the escape sequence
 * @param {string} end the character string to stop the escape seequence
 * @param {undefined|Regex} startPrefix a regex to check against the preceding 10 characters
 */
const ESCAPING_SEQUENZES = [
  // Strings
  { start: '"', end: '"' },
  { start: "'", end: "'" },
  { start: "`", end: "`" },
  // RegeEx
  { start: "/", end: "/", startPrefix: /(^|[[{:;,/])\s?$/ },
];

/**
 * Match begin and end braces of input JS, return only JS
 *
 * @param {string} mixedJson
 * @returns {string}
 */
exports.cutAfterJS = mixedJson => {
  // Define the general open and closing tag
  let open, close;
  if (mixedJson[0] === "[") {
    open = "[";
    close = "]";
  } else if (mixedJson[0] === "{") {
    open = "{";
    close = "}";
  }

  if (!open) {
    throw new Error(`Can't cut unsupported JSON (need to begin with [ or { ) but got: ${mixedJson[0]}`);
  }

  // States if the loop is currently inside an escaped js object
  let isEscapedObject = null;

  // States if the current character is treated as escaped or not
  let isEscaped = false;

  // Current open brackets to be closed
  let counter = 0;

  let i;
  // Go through all characters from the start
  for (i = 0; i < mixedJson.length; i++) {
    // End of current escaped object
    if (!isEscaped && isEscapedObject !== null && mixedJson[i] === isEscapedObject.end) {
      isEscapedObject = null;
      continue;
      // Might be the start of a new escaped object
    } else if (!isEscaped && isEscapedObject === null) {
      for (const escaped of ESCAPING_SEQUENZES) {
        if (mixedJson[i] !== escaped.start) continue;
        // Test startPrefix against last 10 characters
        if (!escaped.startPrefix || mixedJson.substring(i - 10, i).match(escaped.startPrefix)) {
          isEscapedObject = escaped;
          break;
        }
      }
      // Continue if we found a new escaped object
      if (isEscapedObject !== null) {
        continue;
      }
    }

    // Toggle the isEscaped boolean for every backslash
    // Reset for every regular character
    isEscaped = mixedJson[i] === "\\" && !isEscaped;

    if (isEscapedObject !== null) continue;

    if (mixedJson[i] === open) {
      counter++;
    } else if (mixedJson[i] === close) {
      counter--;
    }

    // All brackets have been closed, thus end of JSON is reached
    if (counter === 0) {
      // Return the cut JSON
      return mixedJson.substring(0, i + 1);
    }
  }

  // We ran through the whole string and ended up with an unclosed bracket
  throw Error("Can't cut unsupported JSON (no matching closing bracket found)");
};

class UnrecoverableError extends Error {}
/**
 * Checks if there is a playability error.
 *
 * @param {Object} player_response
 * @returns {!Error}
 */
exports.playError = player_response => {
  const playability = player_response?.playabilityStatus;
  if (!playability) return null;
  if (["ERROR", "LOGIN_REQUIRED"].includes(playability.status)) {
    return new UnrecoverableError(playability.reason || playability.messages?.[0]);
  }
  if (playability.status === "LIVE_STREAM_OFFLINE") {
    return new UnrecoverableError(playability.reason || "The live stream is offline.");
  }
  if (playability.status === "UNPLAYABLE") {
    return new UnrecoverableError(playability.reason || "This video is unavailable.");
  }
  return null;
};

// Undici request
const useFetch = async (fetch, url, requestOptions) => {
  // embed query to url
  const query = requestOptions.query;
  if (query) {
    const urlObject = new URL(url);
    for (const key in query) {
      urlObject.searchParams.append(key, query[key]);
    }
    url = urlObject.toString();
  }

  const response = await fetch(url, requestOptions);

  // convert webstandard response to undici request's response
  const statusCode = response.status;
  const body = Object.assign(response, response.body || {});
  const headers = Object.fromEntries(response.headers.entries());

  return { body, statusCode, headers };
};
exports.request = async (url, options = {}) => {
  let { requestOptions, rewriteRequest, fetch } = options;

  if (typeof rewriteRequest === "function") {
    const rewritten = rewriteRequest(url, requestOptions);
    requestOptions = rewritten.requestOptions || requestOptions;
    url = rewritten.url || url;
  }

  const req =
    typeof fetch === "function" ? await useFetch(fetch, url, requestOptions) : await request(url, requestOptions);
  const code = req.statusCode.toString();

  if (code.startsWith("2")) {
    if (req.headers["content-type"].includes("application/json")) return req.body.json();
    return req.body.text();
  }
  if (code.startsWith("3")) return exports.request(req.headers.location, options);

  const e = new Error(`Status code: ${code}`);
  e.statusCode = req.statusCode;
  throw e;
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
exports.deprecate = (obj, prop, value, oldPath, newPath) => {
  Object.defineProperty(obj, prop, {
    get: () => {
      console.warn(`\`${oldPath}\` will be removed in a near future release, ` + `use \`${newPath}\` instead.`);
      return value;
    },
  });
};

// Check for updates.
const pkg = require("../package.json");
const UPDATE_INTERVAL = 1000 * 60 * 60 * 12;
let updateWarnTimes = 0;
exports.lastUpdateCheck = 0;
exports.checkForUpdates = () => {
  if (
    !process.env.YTDL_NO_UPDATE &&
    !pkg.version.startsWith("0.0.0-") &&
    Date.now() - exports.lastUpdateCheck >= UPDATE_INTERVAL
  ) {
    exports.lastUpdateCheck = Date.now();
    return exports
      .request("https://api.github.com/repos/distubejs/ytdl-core/contents/package.json", {
        requestOptions: {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.3",
          },
        },
      })
      .then(
        response => {
          const buf = Buffer.from(response.content, response.encoding);
          const pkgFile = JSON.parse(buf.toString("ascii"));
          if (pkgFile.version !== pkg.version && updateWarnTimes++ < 5) {
            // eslint-disable-next-line max-len
            console.warn(
              '\x1b[33mWARNING:\x1B[0m @distube/ytdl-core is out of date! Update with "npm install @distube/ytdl-core@latest".',
            );
          }
        },
        err => {
          console.warn("Error checking for updates:", err.message);
          console.warn("You can disable this check by setting the `YTDL_NO_UPDATE` env variable.");
        },
      );
  }
  return null;
};

/**
 * Gets random IPv6 Address from a block
 *
 * @param {string} ip the IPv6 block in CIDR-Notation
 * @returns {string}
 */
const getRandomIPv6 = ip => {
  if (!isIPv6(ip)) {
    throw new Error("Invalid IPv6 format");
  }

  const [rawAddr, rawMask] = ip.split("/");
  const mask = parseInt(rawMask, 10);

  if (isNaN(mask) || mask > 128 || mask < 1) {
    throw new Error("Invalid IPv6 subnet mask (must be between 1 and 128)");
  }

  const base10addr = normalizeIP(rawAddr);

  const fullMaskGroups = Math.floor(mask / 16);
  const remainingBits = mask % 16;

  const result = new Array(8).fill(0);

  for (let i = 0; i < 8; i++) {
    if (i < fullMaskGroups) {
      result[i] = base10addr[i];
    } else if (i === fullMaskGroups && remainingBits > 0) {
      const groupMask = 0xffff << (16 - remainingBits);
      const randomPart = Math.floor(Math.random() * (1 << (16 - remainingBits)));
      result[i] = (base10addr[i] & groupMask) | randomPart;
    } else {
      result[i] = Math.floor(Math.random() * 0x10000);
    }
  }

  return result.map(x => x.toString(16).padStart(4, "0")).join(":");
};

const isIPv6 = ip => {
  const IPV6_REGEX =
    /^(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?:(?::[0-9a-fA-F]{1,4}){1,6})|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(?::[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(?:ffff(?::0{1,4}){0,1}:){0,1}(?:(?:25[0-5]|(?:2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(?:25[0-5]|(?:2[0-4]|1{0,1}[0-9]){0,1}[0-9])|(?:[0-9a-fA-F]{1,4}:){1,4}:(?:(?:25[0-5]|(?:2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(?:25[0-5]|(?:2[0-4]|1{0,1}[0-9]){0,1}[0-9]))(?:\/(?:1[0-1][0-9]|12[0-8]|[1-9][0-9]|[1-9]))?$/;
  return IPV6_REGEX.test(ip);
};

/**
 * Normalizes an IPv6 address into an array of 8 integers
 * @param {string} ip - IPv6 address
 * @returns {number[]} - Array of 8 integers representing the address
 */
const normalizeIP = ip => {
  const parts = ip.split("::");
  let start = parts[0] ? parts[0].split(":") : [];
  let end = parts[1] ? parts[1].split(":") : [];

  const missing = 8 - (start.length + end.length);
  const zeros = new Array(missing).fill("0");

  const full = [...start, ...zeros, ...end];

  return full.map(part => parseInt(part || "0", 16));
};

exports.saveDebugFile = (name, body) => {
  if (process.env.YTDL_NO_DEBUG_FILE) {
    console.warn(`\x1b[33mWARNING:\x1b[0m Debug file saving is disabled. "${name}"`);
    return body;
  }
  const filename = `${+new Date()}-${name}`;
  const debugPath = process.env.YTDL_DEBUG_PATH || '.';
  writeFileSync(`${debugPath}/${filename}`, body);
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
  if (!options?.requestOptions?.localAddress || options.requestOptions.localAddress === options.agent.localAddress)
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
    options.playerClients = ["WEB_EMBEDDED", "IOS", "ANDROID", "TV"];
  }
};

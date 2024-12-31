/* eslint-disable no-unused-vars */
const sax = require("sax");
const utils = require("./utils");
// Forces Node JS version of setTimeout for Electron based applications
const { setTimeout } = require("timers");
const formatUtils = require("./format-utils");
const urlUtils = require("./url-utils");
const extras = require("./info-extras");
const Cache = require("./cache");
const sig = require("./sig");

const BASE_URL = "https://www.youtube.com/watch?v=";

// Cached for storing basic/full info.
exports.cache = new Cache();
exports.watchPageCache = new Cache();

// List of URLs that show up in `notice_url` for age restricted videos.
const AGE_RESTRICTED_URLS = ["support.google.com/youtube/?p=age_restrictions", "youtube.com/t/community_guidelines"];

/**
 * Gets info from a video without getting additional formats.
 *
 * @param {string} id
 * @param {Object} options
 * @returns {Promise<Object>}
 */
exports.getBasicInfo = async (id, options) => {
  utils.applyIPv6Rotations(options);
  utils.applyDefaultHeaders(options);
  utils.applyDefaultAgent(options);
  utils.applyOldLocalAddress(options);
  const retryOptions = Object.assign({}, options.requestOptions);
  const { jar, dispatcher } = options.agent;
  utils.setPropInsensitive(
    options.requestOptions.headers,
    "cookie",
    jar.getCookieStringSync("https://www.youtube.com"),
  );
  options.requestOptions.dispatcher = dispatcher;
  const info = await retryFunc(getWatchHTMLPage, [id, options], retryOptions);

  const playErr = utils.playError(info.player_response);
  if (playErr) throw playErr;

  Object.assign(info, {
    // Replace with formats from iosPlayerResponse
    // formats: parseFormats(info.player_response),
    related_videos: extras.getRelatedVideos(info),
  });

  // Add additional properties to info.
  const media = extras.getMedia(info);
  const additional = {
    author: extras.getAuthor(info),
    media,
    likes: extras.getLikes(info),
    age_restricted: !!(
      media && AGE_RESTRICTED_URLS.some(url => Object.values(media).some(v => typeof v === "string" && v.includes(url)))
    ),

    // Give the standard link to the video.
    video_url: BASE_URL + id,
    storyboards: extras.getStoryboards(info),
    chapters: extras.getChapters(info),
  };

  info.videoDetails = extras.cleanVideoDetails(
    Object.assign(
      {},
      info.player_response &&
        info.player_response.microformat &&
        info.player_response.microformat.playerMicroformatRenderer,
      info.player_response && info.player_response.videoDetails,
      additional,
    ),
    info,
  );

  return info;
};

const getWatchHTMLURL = (id, options) =>
  `${BASE_URL + id}&hl=${options.lang || "en"}&bpctr=${Math.ceil(Date.now() / 1000)}&has_verified=1`;
const getWatchHTMLPageBody = (id, options) => {
  const url = getWatchHTMLURL(id, options);
  return exports.watchPageCache.getOrSet(url, () => utils.request(url, options));
};

const EMBED_URL = "https://www.youtube.com/embed/";
const getEmbedPageBody = (id, options) => {
  const embedUrl = `${EMBED_URL + id}?hl=${options.lang || "en"}`;
  return utils.request(embedUrl, options);
};

const getHTML5player = body => {
  let html5playerRes =
    /<script\s+src="([^"]+)"(?:\s+type="text\/javascript")?\s+name="player_ias\/base"\s*>|"jsUrl":"([^"]+)"/.exec(body);
  return html5playerRes ? html5playerRes[1] || html5playerRes[2] : null;
};

/**
 * Given a function, calls it with `args` until it's successful,
 * or until it encounters an unrecoverable error.
 * Currently, any error from miniget is considered unrecoverable. Errors such as
 * too many redirects, invalid URL, status code 404, status code 502.
 *
 * @param {Function} func
 * @param {Array.<Object>} args
 * @param {Object} options
 * @param {number} options.maxRetries
 * @param {Object} options.backoff
 * @param {number} options.backoff.inc
 */
const retryFunc = async (func, args, options) => {
  let currentTry = 0,
    result;
  if (!options.maxRetries) options.maxRetries = 3;
  if (!options.backoff) options.backoff = { inc: 500, max: 5000 };
  while (currentTry <= options.maxRetries) {
    try {
      result = await func(...args);
      break;
    } catch (err) {
      if ((err && err.statusCode < 500) || currentTry >= options.maxRetries) throw err;
      let wait = Math.min(++currentTry * options.backoff.inc, options.backoff.max);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  return result;
};

const jsonClosingChars = /^[)\]}'\s]+/;
const parseJSON = (source, varName, json) => {
  if (!json || typeof json === "object") {
    return json;
  } else {
    try {
      json = json.replace(jsonClosingChars, "");
      return JSON.parse(json);
    } catch (err) {
      throw Error(`Error parsing ${varName} in ${source}: ${err.message}`);
    }
  }
};

const findJSON = (source, varName, body, left, right, prependJSON) => {
  let jsonStr = utils.between(body, left, right);
  if (!jsonStr) {
    throw Error(`Could not find ${varName} in ${source}`);
  }
  return parseJSON(source, varName, utils.cutAfterJS(`${prependJSON}${jsonStr}`));
};

const findPlayerResponse = (source, info) => {
  const player_response =
    info &&
    ((info.args && info.args.player_response) ||
      info.player_response ||
      info.playerResponse ||
      info.embedded_player_response);
  return parseJSON(source, "player_response", player_response);
};

const getWatchHTMLPage = async (id, options) => {
  let body = await getWatchHTMLPageBody(id, options);
  let info = { page: "watch" };
  try {
    try {
      info.player_response =
        utils.tryParseBetween(body, "var ytInitialPlayerResponse = ", "}};", "", "}}") ||
        utils.tryParseBetween(body, "var ytInitialPlayerResponse = ", ";var") ||
        utils.tryParseBetween(body, "var ytInitialPlayerResponse = ", ";</script>") ||
        findJSON("watch.html", "player_response", body, /\bytInitialPlayerResponse\s*=\s*\{/i, "</script>", "{");
    } catch (_e) {
      let args = findJSON("watch.html", "player_response", body, /\bytplayer\.config\s*=\s*{/, "</script>", "{");
      info.player_response = findPlayerResponse("watch.html", args);
    }

    info.response =
      utils.tryParseBetween(body, "var ytInitialData = ", "}};", "", "}}") ||
      utils.tryParseBetween(body, "var ytInitialData = ", ";</script>") ||
      utils.tryParseBetween(body, 'window["ytInitialData"] = ', "}};", "", "}}") ||
      utils.tryParseBetween(body, 'window["ytInitialData"] = ', ";</script>") ||
      findJSON("watch.html", "response", body, /\bytInitialData("\])?\s*=\s*\{/i, "</script>", "{");
    info.html5player = getHTML5player(body);
  } catch (_) {
    throw Error(
      "Error when parsing watch.html, maybe YouTube made a change.\n" +
        `Please report this issue with the "${utils.saveDebugFile(
          "watch.html",
          body,
        )}" file on https://github.com/distubejs/ytdl-core/issues.`,
    );
  }
  return info;
};

/**
 * @param {Object} player_response
 * @returns {Array.<Object>}
 */
const parseFormats = player_response => {
  let formats = [];
  if (player_response && player_response.streamingData) {
    formats = formats
      .concat(player_response.streamingData.formats || [])
      .concat(player_response.streamingData.adaptiveFormats || []);
  }
  return formats;
};

const parseAdditionalManifests = (player_response, options) => {
  let streamingData = player_response && player_response.streamingData,
    manifests = [];
  if (streamingData) {
    if (streamingData.dashManifestUrl) {
      manifests.push(getDashManifest(streamingData.dashManifestUrl, options));
    }
    if (streamingData.hlsManifestUrl) {
      manifests.push(getM3U8(streamingData.hlsManifestUrl, options));
    }
  }
  return manifests;
};

// TODO: Clean up this function for readability and support more clients
/**
 * Gets info from a video additional formats and deciphered URLs.
 *
 * @param {string} id
 * @param {Object} options
 * @returns {Promise<Object>}
 */
exports.getInfo = async (id, options) => {
  utils.applyIPv6Rotations(options);
  utils.applyDefaultHeaders(options);
  utils.applyDefaultAgent(options);
  utils.applyOldLocalAddress(options);
  utils.applyPlayerClients(options);
  const info = await exports.getBasicInfo(id, options);
  let funcs = [];

  // Fill in HTML5 player URL
  info.html5player =
    info.html5player ||
    getHTML5player(await getWatchHTMLPageBody(id, options)) ||
    getHTML5player(await getEmbedPageBody(id, options));

  if (!info.html5player) {
    throw Error("Unable to find html5player file");
  }

  const html5player = new URL(info.html5player, BASE_URL).toString();

  try {
    if (options.playerClients.includes("WEB")) {
      funcs.push(sig.decipherFormats(parseFormats(info.player_response), html5player, options));
      funcs.push(...parseAdditionalManifests(info.player_response));
    }
    if (info.videoDetails.age_restricted) throw Error("Cannot download age restricted videos with mobile clients");
    const promises = [];
    if (options.playerClients.includes("WEB_CREATOR")) promises.push(fetchWebCreatorPlayer(id, html5player, options));
    if (options.playerClients.includes("IOS")) promises.push(fetchIosJsonPlayer(id, options));
    if (options.playerClients.includes("ANDROID")) promises.push(fetchAndroidJsonPlayer(id, options));
    const responses = await Promise.allSettled(promises);
    info.formats = [].concat(...responses.map(r => parseFormats(r.value)));
    if (info.formats.length === 0) throw new Error("Player JSON API failed");

    funcs.push(sig.decipherFormats(info.formats, html5player, options));

    for (let resp of responses) {
      if (resp.value) {
        funcs.push(...parseAdditionalManifests(resp.value, options));
      }
    }
  } catch (_) {}

  let results = await Promise.all(funcs);
  info.formats = Object.values(Object.assign({}, ...results));
  info.formats = info.formats.map(formatUtils.addFormatMeta);
  info.formats.sort(formatUtils.sortFormats);

  info.full = true;
  return info;
};

const getPlaybackContext = async (html5player, options) => {
  const body = await utils.request(html5player, options);
  let mo = body.match(/signatureTimestamp:(\d+)/);

  return {
    contentPlaybackContext: {
      html5Preference: "HTML5_PREF_WANTS",
      signatureTimestamp: mo ? mo[1] : undefined,
    },
  };
};

const LOCALE = { hl: "en", timeZone: "UTC", utcOffsetMinutes: 0 },
  CHECK_FLAGS = { contentCheckOk: true, racyCheckOk: true };

const WEB_CREATOR_CONTEXT = {
  client: {
    clientName: "WEB_CREATOR",
    clientVersion: "1.20241215.03.00",
    ...LOCALE,
  },
};

const fetchWebCreatorPlayer = async (videoId, html5player, options) => {
  const payload = {
    context: WEB_CREATOR_CONTEXT,
    videoId,
    playbackContext: await getPlaybackContext(html5player, options),
    ...CHECK_FLAGS,
  };

  return await playerAPI(videoId, payload, undefined, options);
};

const playerAPI = async (videoId, payload, userAgent, options) => {
  const { jar, dispatcher } = options.agent;
  const opts = {
    requestOptions: {
      method: "POST",
      dispatcher,
      query: {
        prettyPrint: false,
        t: utils.generateClientPlaybackNonce(12),
        id: videoId,
      },
      headers: {
        "Content-Type": "application/json",
        cookie: jar.getCookieStringSync("https://www.youtube.com"),
        "User-Agent": userAgent,
        "X-Goog-Api-Format-Version": "2",
      },
      body: JSON.stringify(payload),
    },
  };
  const response = await utils.request("https://youtubei.googleapis.com/youtubei/v1/player", opts);
  const playErr = utils.playError(response);
  if (playErr) throw playErr;
  if (!response.videoDetails || videoId !== response.videoDetails.videoId) {
    const err = new Error("Malformed response from YouTube");
    err.response = response;
    throw err;
  }
  return response;
};

const IOS_CLIENT_VERSION = "19.42.1",
  IOS_DEVICE_MODEL = "iPhone16,2",
  IOS_USER_AGENT_VERSION = "17_5_1",
  IOS_OS_VERSION = "17.5.1.21F90";

const fetchIosJsonPlayer = async (videoId, options) => {
  const payload = {
    videoId,
    cpn: utils.generateClientPlaybackNonce(16),
    contentCheckOk: true,
    racyCheckOk: true,
    context: {
      client: {
        clientName: "IOS",
        clientVersion: IOS_CLIENT_VERSION,
        deviceMake: "Apple",
        deviceModel: IOS_DEVICE_MODEL,
        platform: "MOBILE",
        osName: "iOS",
        osVersion: IOS_OS_VERSION,
        hl: "en",
        gl: "US",
        utcOffsetMinutes: -240,
      },
      request: {
        internalExperimentFlags: [],
        useSsl: true,
      },
      user: {
        lockedSafetyMode: false,
      },
    },
  };

  const { jar, dispatcher } = options.agent;
  const opts = {
    requestOptions: {
      method: "POST",
      dispatcher,
      query: {
        prettyPrint: false,
        t: utils.generateClientPlaybackNonce(12),
        id: videoId,
      },
      headers: {
        "Content-Type": "application/json",
        cookie: jar.getCookieStringSync("https://www.youtube.com"),
        "User-Agent": `com.google.ios.youtube/${IOS_CLIENT_VERSION}(${
          IOS_DEVICE_MODEL
        }; U; CPU iOS ${IOS_USER_AGENT_VERSION} like Mac OS X; en_US)`,
        "X-Goog-Api-Format-Version": "2",
      },
      body: JSON.stringify(payload),
    },
  };
  const response = await utils.request("https://youtubei.googleapis.com/youtubei/v1/player", opts);
  const playErr = utils.playError(response);
  if (playErr) throw playErr;
  if (!response.videoDetails || videoId !== response.videoDetails.videoId) {
    const err = new Error("Malformed response from YouTube");
    err.response = response;
    throw err;
  }
  return response;
};

const ANDROID_CLIENT_VERSION = "19.30.36",
  ANDROID_OS_VERSION = "14",
  ANDROID_SDK_VERSION = "34";

const fetchAndroidJsonPlayer = async (videoId, options) => {
  const payload = {
    videoId,
    cpn: utils.generateClientPlaybackNonce(16),
    contentCheckOk: true,
    racyCheckOk: true,
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: ANDROID_CLIENT_VERSION,
        platform: "MOBILE",
        osName: "Android",
        osVersion: ANDROID_OS_VERSION,
        androidSdkVersion: ANDROID_SDK_VERSION,
        hl: "en",
        gl: "US",
        utcOffsetMinutes: -240,
      },
      request: {
        internalExperimentFlags: [],
        useSsl: true,
      },
      user: {
        lockedSafetyMode: false,
      },
    },
  };

  const { jar, dispatcher } = options.agent;
  const opts = {
    requestOptions: {
      method: "POST",
      dispatcher,
      query: {
        prettyPrint: false,
        t: utils.generateClientPlaybackNonce(12),
        id: videoId,
      },
      headers: {
        "Content-Type": "application/json",
        cookie: jar.getCookieStringSync("https://www.youtube.com"),
        "User-Agent": `com.google.android.youtube/${
          ANDROID_CLIENT_VERSION
        } (Linux; U; Android ${ANDROID_OS_VERSION}; en_US) gzip`,
        "X-Goog-Api-Format-Version": "2",
      },
      body: JSON.stringify(payload),
    },
  };
  const response = await utils.request("https://youtubei.googleapis.com/youtubei/v1/player", opts);
  const playErr = utils.playError(response);
  if (playErr) throw playErr;
  if (!response.videoDetails || videoId !== response.videoDetails.videoId) {
    const err = new Error("Malformed response from YouTube");
    err.response = response;
    throw err;
  }
  return response;
};

/**
 * Gets additional DASH formats.
 *
 * @param {string} url
 * @param {Object} options
 * @returns {Promise<Array.<Object>>}
 */
const getDashManifest = (url, options) =>
  new Promise((resolve, reject) => {
    let formats = {};
    const parser = sax.parser(false);
    parser.onerror = reject;
    let adaptationSet;
    parser.onopentag = node => {
      if (node.name === "ADAPTATIONSET") {
        adaptationSet = node.attributes;
      } else if (node.name === "REPRESENTATION") {
        const itag = parseInt(node.attributes.ID);
        if (!isNaN(itag)) {
          formats[url] = Object.assign(
            {
              itag,
              url,
              bitrate: parseInt(node.attributes.BANDWIDTH),
              mimeType: `${adaptationSet.MIMETYPE}; codecs="${node.attributes.CODECS}"`,
            },
            node.attributes.HEIGHT
              ? {
                  width: parseInt(node.attributes.WIDTH),
                  height: parseInt(node.attributes.HEIGHT),
                  fps: parseInt(node.attributes.FRAMERATE),
                }
              : {
                  audioSampleRate: node.attributes.AUDIOSAMPLINGRATE,
                },
          );
        }
      }
    };
    parser.onend = () => {
      resolve(formats);
    };
    utils
      .request(new URL(url, BASE_URL).toString(), options)
      .then(res => {
        parser.write(res);
        parser.close();
      })
      .catch(reject);
  });

/**
 * Gets additional formats.
 *
 * @param {string} url
 * @param {Object} options
 * @returns {Promise<Array.<Object>>}
 */
const getM3U8 = async (url, options) => {
  url = new URL(url, BASE_URL);
  const body = await utils.request(url.toString(), options);
  let formats = {};
  body
    .split("\n")
    .filter(line => /^https?:\/\//.test(line))
    .forEach(line => {
      const itag = parseInt(line.match(/\/itag\/(\d+)\//)[1]);
      formats[line] = { itag, url: line };
    });
  return formats;
};

// Cache get info functions.
// In case a user wants to get a video's info before downloading.
for (let funcName of ["getBasicInfo", "getInfo"]) {
  /**
   * @param {string} link
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  const func = exports[funcName];
  exports[funcName] = async (link, options = {}) => {
    utils.checkForUpdates();
    let id = await urlUtils.getVideoID(link);
    const key = [funcName, id, options.lang].join("-");
    return exports.cache.getOrSet(key, () => func(id, options));
  };
}

// Export a few helpers.
exports.validateID = urlUtils.validateID;
exports.validateURL = urlUtils.validateURL;
exports.getURLVideoID = urlUtils.getURLVideoID;
exports.getVideoID = urlUtils.getVideoID;

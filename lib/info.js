/* eslint-disable no-unused-vars */
const sax = require("sax");
const utils = require("./utils");
const { setTimeout } = require("timers");
const formatUtils = require("./format-utils");
const urlUtils = require("./url-utils");
const extras = require("./info-extras");
const Cache = require("./cache");
const sig = require("./sig");

const BASE_URL = "https://www.youtube.com/watch?v=";
exports.cache = new Cache();
exports.watchPageCache = new Cache();

const AGE_RESTRICTED_URLS = [
  "support.google.com/youtube/?p=age_restrictions",
  "youtube.com/t/community_guidelines"
];

const LOCALE = { hl: "en", timeZone: "UTC", utcOffsetMinutes: 0 };
const CHECK_FLAGS = { contentCheckOk: true, racyCheckOk: true };

const WEB_CREATOR_CONTEXT = {
  client: {
    clientName: "WEB_CREATOR",
    clientVersion: "1.20241023.00.01",
    ...LOCALE,
  },
};

const IOS_CLIENT_VERSION = "19.42.1";
const IOS_DEVICE_MODEL = "iPhone16,2";
const IOS_USER_AGENT_VERSION = "17_5_1";
const IOS_OS_VERSION = "17.5.1.21F90";

const ANDROID_CLIENT_VERSION = "19.30.36";
const ANDROID_OS_VERSION = "14";
const ANDROID_SDK_VERSION = "34";


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

  const { jar, dispatcher } = options.agent;
  options.requestOptions.headers.cookie = jar.getCookieStringSync("https://www.youtube.com");
  options.requestOptions.dispatcher = dispatcher;

  const retryOptions = { ...options.requestOptions };

  try {
    const info = await retryFunc(getWatchHTMLPage, [id, options], retryOptions);
    validatePlayerResponse(info.player_response);
    
    const media = extras.getMedia(info);
    const additionalDetails = extractAdditionalDetails(media, id, info);
    
    info.videoDetails = extras.cleanVideoDetails({
      ...info.player_response?.microformat?.playerMicroformatRenderer,
      ...info.player_response?.videoDetails,
      ...additionalDetails,
    }, info);

    return info;
  } catch (error) {
    // Handle the error according to your application logic
    return { error: true, message: error.message };
  }
};

const extractAdditionalDetails = (media, id, info) => {
  return {
    author: extras.getAuthor(info),
    media,
    likes: extras.getLikes(info),
    age_restricted: isAgeRestricted(media),
    video_url: `${BASE_URL + id}`,
    storyboards: extras.getStoryboards(info),
    chapters: extras.getChapters(info),
  };
};

const isAgeRestricted = (media) => {
  return media && AGE_RESTRICTED_URLS.some(url => 
    Object.values(media).some(v => typeof v === "string" && v.includes(url))
  );
};
const validatePlayerResponse = (player_response) => {
  const playErr = utils.playError(player_response);
  if (playErr) throw playErr;
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
  const html5playerRes = /<script\s+src="([^"]+)"(?:\s+type="text\/javascript")?\s+name="player_ias\/base"\s*>|"jsUrl":"([^"]+)"/.exec(body);
  return html5playerRes ? html5playerRes[1] || html5playerRes[2] : null;
};

/**
 * Retries a function until it succeeds or hits an unrecoverable error.
 *
 * @param {Function} func
 * @param {Array.<Object>} args
 * @param {Object} options
 * @returns {Promise<Object>}
 */
const retryFunc = async (func, args, options) => {
  const maxRetries = options.maxRetries || 3;
  const backoffInc = options.backoff?.inc || 500;
  const backoffMax = options.backoff?.max || 5000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await func(...args);
    } catch (err) {
      if (err && err.statusCode < 500) throw err;
      if (attempt >= maxRetries) throw err;

      const waitDuration = Math.min((attempt + 1) * backoffInc, backoffMax);
      await new Promise(resolve => setTimeout(resolve, waitDuration));
    }
  }
};

const parseJSON = (source, varName, json) => {
  if (!json || typeof json === 'object') {
    return json;
  }

  try {
    return JSON.parse(json.replace(/^[)\]}'\s]+/, ''));
  } catch (err) {
    throw new Error(`Error parsing ${varName} in ${source}: ${err.message}`);
  }
};

const findJSON = (source, varName, body, left, right, prependJSON) => {
  const jsonStr = utils.between(body, left, right);
  if (!jsonStr) throw new Error(`Could not find ${varName} in ${source}`);
  return parseJSON(source, varName, utils.cutAfterJS(`${prependJSON}${jsonStr}`));
};

const findPlayerResponse = (source, info) => {
  const playerResponse = info?.args?.player_response || info.player_response || info.playerResponse || info.embedded_player_response;
  return parseJSON(source, 'player_response', playerResponse);
};

const getWatchHTMLPage = async (id, options) => {
  const body = await getWatchHTMLPageBody(id, options);
  const info = { page: 'watch' };

  try {
    info.player_response = findPlayerResponseFromBody(body);
    info.response = findResponseFromBody(body);
    info.html5player = getHTML5player(body);
  } catch (err) {
    throw new Error(
      `Error when parsing watch.html, maybe YouTube made a change.\n` +
      `Please report this issue with the "${utils.saveDebugFile('watch.html', body)}" file on https://github.com/distubejs/ytdl-core/issues.`
    );
  }

  return info;
};

const findPlayerResponseFromBody = (body) => {
  return utils.tryParseBetween(body, 'var ytInitialPlayerResponse = ', '}};', '', '}}')
      || utils.tryParseBetween(body, 'var ytInitialPlayerResponse = ', ';var')
      || utils.tryParseBetween(body, 'var ytInitialPlayerResponse = ', ';</script>')
      || findJSON('watch.html', 'player_response', body, /\bytInitialPlayerResponse\s*=\s*\{/i, '</script>', '{');
};

const findResponseFromBody = (body) => {
  return utils.tryParseBetween(body, 'var ytInitialData = ', '}};', '', '}}')
      || utils.tryParseBetween(body, 'var ytInitialData = ', ';</script>')
      || findJSON('watch.html', 'response', body, /\bytInitialData("\])?\s*=\s*\{/i, '</script>', '{');
};

const parseFormats = (player_response) => {
  return player_response?.streamingData ? [
    ...(player_response.streamingData.formats || []),
    ...(player_response.streamingData.adaptiveFormats || []),
  ] : [];
};

const parseAdditionalManifests = (player_response, options) => {
  const streamingData = player_response?.streamingData || {};
  const manifests = [];
  
  if (streamingData.dashManifestUrl) {
    manifests.push(getDashManifest(streamingData.dashManifestUrl, options));
  }
  if (streamingData.hlsManifestUrl) {
    manifests.push(getM3U8(streamingData.hlsManifestUrl, options));
  }
  
  return manifests;
};

exports.getInfo = async (id, options) => {
  utils.applyIPv6Rotations(options);
  utils.applyDefaultHeaders(options);
  utils.applyDefaultAgent(options);
  utils.applyOldLocalAddress(options);
  utils.applyPlayerClients(options);

  try {
    const info = await exports.getBasicInfo(id, options);
    console.log('Basic Info:', info);

    const html5playerBody = await getWatchHTMLPageBody(id, options);
    info.html5player = info.html5player || getHTML5player(html5playerBody) || getHTML5player(await getEmbedPageBody(id, options));

    if (!info.html5player) {
      throw new Error('Unable to find html5player file');
    }

    // Check for age restrictions before proceeding
    if (info.videoDetails.age_restricted) {
      throw new Error('Cannot download age-restricted videos with mobile clients');
    }

    await processPlayerClients(id, info, options);

    info.full = true;
    return info;

  } catch (error) {
    console.error('Error in getInfo:', error.message);
    throw error;
  }
};

const processPlayerClients = async (id, info, options) => {
  const html5player = new URL(info.html5player, BASE_URL).toString();
  const funcs = [];
  const promises = [];

  if (options.playerClients.includes('WEB_CREATOR')) {
    promises.push(fetchWebCreatorPlayer(id, html5player, options));
  }
  if (options.playerClients.includes('IOS')) {
    promises.push(fetchIosJsonPlayer(id, options));
  }
  if (options.playerClients.includes('ANDROID')) {
    promises.push(fetchAndroidJsonPlayer(id, options));
  }

  const responses = await Promise.allSettled(promises);
  console.log('Responses from player clients:', responses);

  // Handle case where no formats were fetched
  info.formats = responses.flatMap(r => parseFormats(r.value));
  if (info.formats.length === 0) {
    throw new Error('Player JSON API failed');
  }
  
  funcs.push(sig.decipherFormats(info.formats, html5player, options));
  for (const resp of responses) {
    if (resp.value) {
      funcs.push(...parseAdditionalManifests(resp.value, options));
    }
  }

  if (options.playerClients.includes('WEB')) {
    funcs.push(sig.decipherFormats(parseFormats(info.player_response), html5player, options));
    funcs.push(...parseAdditionalManifests(info.player_response));
  }

  const results = await Promise.all(funcs);
  info.formats = Object.values(Object.assign({}, ...results));
  info.formats = info.formats.map(formatUtils.addFormatMeta);
  info.formats.sort(formatUtils.sortFormats);
};

const getPlaybackContext = async (html5player, options) => {
  const body = await utils.request(html5player, options);
  const match = body.match(/signatureTimestamp:(\d+)/);
  return {
    contentPlaybackContext: {
      html5Preference: 'HTML5_PREF_WANTS',
      signatureTimestamp: match ? match[1] : undefined,
    },
  };
};

// Generic player API request
const playerAPI = async (videoId, payload, options) => {
  const { jar, dispatcher } = options.agent;
  const opts = {
    requestOptions: {
      method: 'POST',
      dispatcher,
      query: {
        prettyPrint: false,
        t: utils.generateClientPlaybackNonce(12),
        id: videoId,
      },
      headers: {
        'Content-Type': 'application/json',
        'cookie': jar.getCookieStringSync('https://www.youtube.com'),
        'User-Agent': options.userAgent,
        'X-Goog-Api-Format-Version': '2',
      },
      body: JSON.stringify(payload),
    },
  };

  const response = await utils.request('https://youtubei.googleapis.com/youtubei/v1/player', opts);
  const playErr = utils.playError(response);
  if (playErr) throw playErr;

  if (!response.videoDetails || videoId !== response.videoDetails.videoId) {
    throw new Error('Malformed response from YouTube');
  }
  return response;
};

// Function to fetch player based on client type
const fetchPlayer = async (clientType, videoId, options) => {
  const context = {
    client: {
      clientName: clientType,
      clientVersion: eval(`${clientType}_CLIENT_VERSION`), // Dynamically use correct version based on client type
      platform: 'MOBILE',
      osName: clientType === 'IOS' ? 'iOS' : 'Android',
      osVersion: eval(`${clientType}_OS_VERSION`),
      ...(clientType === 'IOS' ? {
        deviceMake: 'Apple',
        deviceModel: IOS_DEVICE_MODEL,
      } : {
        androidSdkVersion: ANDROID_SDK_VERSION,
      }),
      hl: 'en',
      gl: 'US',
      utcOffsetMinutes: -240,
    },
    request: {
      internalExperimentFlags: [],
      useSsl: true,
    },
    user: {
      lockedSafetyMode: false,
    },
  };

  const payload = {
    videoId,
    cpn: utils.generateClientPlaybackNonce(16),
    ...CHECK_FLAGS,
    context,
  };

  // Set user-agent for the specific client
  options.userAgent = `com.google.${clientType.toLowerCase()}.youtube/${context.client.clientVersion} (${options.userAgent})`;
  return playerAPI(videoId, payload, options);
};

// Fetch specific players
const fetchWebCreatorPlayer = async (videoId, html5player, options) => {
  const playbackContext = await getPlaybackContext(html5player, options);
  const payload = {
    context: WEB_CREATOR_CONTEXT,
    videoId,
    playbackContext,
    ...CHECK_FLAGS,
  };
  return playerAPI(videoId, payload, options);
};

// Fetch iOS player
const fetchIosJsonPlayer = (videoId, options) => fetchPlayer('IOS', videoId, options);

// Fetch Android player
const fetchAndroidJsonPlayer = (videoId, options) => fetchPlayer('ANDROID', videoId, options);

// Get DASH manifest
const getDashManifest = async (url, options) => {
  const formats = {};
  const response = await utils.request(new URL(url, BASE_URL).toString(), options);
  
  return new Promise((resolve, reject) => {
    const parser = sax.parser(false);
    parser.onerror = reject;
    parser.onopentag = (node) => {
      if (node.name === 'ADAPTATIONSET') {
        const adaptationSet = node.attributes;
        parser.onopentag = (representationNode) => {
          if (representationNode.name === 'REPRESENTATION') {
            const itag = parseInt(representationNode.attributes.ID);
            if (!isNaN(itag)) {
              formats[url] = {
                itag,
                url,
                bitrate: parseInt(representationNode.attributes.BANDWIDTH),
                mimeType: `${adaptationSet.MIMETYPE}; codecs="${representationNode.attributes.CODECS}"`,
                ...(representationNode.attributes.HEIGHT
                  ? {
                      width: parseInt(representationNode.attributes.WIDTH),
                      height: parseInt(representationNode.attributes.HEIGHT),
                      fps: parseInt(representationNode.attributes.FRAMERATE),
                    }
                  : {
                      audioSampleRate: representationNode.attributes.AUDIOSAMPLINGRATE,
                    }),
              };
            }
          }
        };
      }
    };
    parser.onend = () => resolve(formats);
    parser.write(response).close();
  });
};

// Get M3U8 manifest
const getM3U8 = async (url, options) => {
  const body = await utils.request(new URL(url, BASE_URL).toString(), options);
  return body.split('\n').reduce((formats, line) => {
    const match = line.match(/\/itag\/(\d+)\//);
    if (/^https?:\/\//.test(line) && match) {
      const itag = parseInt(match[1]);
      formats[line] = { itag, url: line };
    }
    return formats;
  }, {});
};

// Cache get info functions
for (const funcName of ['getBasicInfo', 'getInfo']) {
  const originalFunc = exports[funcName];
  exports[funcName] = async (link, options = {}) => {
    utils.checkForUpdates();
    const id = await urlUtils.getVideoID(link);
    const key = [funcName, id, options.lang].join('-');
    return exports.cache.getOrSet(key, () => originalFunc(id, options));
  };
}

// Export a few helpers
exports.validateID = urlUtils.validateID;
exports.validateURL = urlUtils.validateURL;
exports.getURLVideoID = urlUtils.getURLVideoID;
exports.getVideoID = urlUtils.getVideoID;

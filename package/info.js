"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVideoID = exports.getURLVideoID = exports.validateURL = exports.validateID = exports.WATCH_PAGE_CACHE = exports.CACHE = void 0;
exports.getBasicInfo = getBasicInfo;
exports.getInfo = getInfo;
const sax_1 = __importDefault(require("sax"));
const timers_1 = require("timers");
const youtube_po_token_generator_1 = require("youtube-po-token-generator");
const utils_1 = __importDefault(require("./utils"));
const format_utils_1 = __importDefault(require("./format-utils"));
const url_utils_1 = __importDefault(require("./url-utils"));
const info_extras_1 = __importDefault(require("./info-extras"));
const cache_1 = require("./cache");
const sig_1 = __importDefault(require("./sig"));
const clients_1 = require("./meta/clients");
const Log_1 = require("./utils/Log");
/* Private Constants */
const BASE_URL = 'https://www.youtube.com/watch?v=', BASE_EMBED_URL = 'https://www.youtube.com/embed/', AGE_RESTRICTED_URLS = ['support.google.com/youtube/?p=age_restrictions', 'youtube.com/t/community_guidelines'], JSON_CLOSING_CHARS = /^[)\]}'\s]+/, BASE_CLIENTS = ['web_creator', 'ios', 'android'];
/* ----------- */
/* Private Classes */
class PlayerRequestError extends Error {
    response;
    constructor(message) {
        super(message);
        this.response = null;
    }
}
async function retryFunc(func, args, options) {
    let currentTry = 0, result = null;
    options.maxRetries ??= 3;
    options.backoff ??= {
        inc: 500,
        max: 5000,
    };
    while (currentTry <= options.maxRetries) {
        try {
            result = await func(...args);
            break;
        }
        catch (err) {
            if ((err && err?.statusCode < 500) || currentTry >= options.maxRetries) {
                throw err;
            }
            let wait = Math.min(++currentTry * options.backoff.inc, options.backoff.max);
            await new Promise((resolve) => (0, timers_1.setTimeout)(resolve, wait));
        }
    }
    return result;
}
function parseJSON(source, varName, json) {
    if (!json || typeof json === 'object') {
        return json;
    }
    else {
        try {
            json = json.replace(JSON_CLOSING_CHARS, '');
            return JSON.parse(json);
        }
        catch (err) {
            throw Error(`Error parsing ${varName} in ${source}: ${err.message}`);
        }
    }
}
function findJSON(source, varName, body, left, right, prependJSON) {
    const JSON_STR = utils_1.default.between(body, left, right);
    if (!JSON_STR) {
        throw Error(`Could not find ${varName} in ${source}`);
    }
    return parseJSON(source, varName, utils_1.default.cutAfterJS(`${prependJSON}${JSON_STR}`));
}
function findPlayerResponse(source, info) {
    const PLAYER_RESPONSE = info && ((info.args && info.args.player_response) || info.player_response || info.playerResponse || info.embedded_player_response);
    return parseJSON(source, 'player_response', PLAYER_RESPONSE);
}
function getWatchHTMLURL(id, options) {
    return `${BASE_URL + id}&hl=${options.lang || 'en'}&bpctr=${Math.ceil(Date.now() / 1000)}&has_verified=1`;
}
function getEmbedPageBody(id, options) {
    const EMBED_PAGE_URL = `${BASE_EMBED_URL + id}?hl=${options.lang || 'en'}`;
    return utils_1.default.request(EMBED_PAGE_URL, options);
}
async function getWatchHTMLPageBody(id, options) {
    const WATCH_PAGE_URL = getWatchHTMLURL(id, options);
    return WATCH_PAGE_CACHE.getOrSet(WATCH_PAGE_URL, () => utils_1.default.request(WATCH_PAGE_URL, options)) || '';
}
function getHTML5Player(body) {
    const HTML5_PLAYER_RES = /<script\s+src="([^"]+)"(?:\s+type="text\/javascript")?\s+name="player_ias\/base"\s*>|"jsUrl":"([^"]+)"/.exec(body);
    return HTML5_PLAYER_RES ? HTML5_PLAYER_RES[1] || HTML5_PLAYER_RES[2] : null;
}
async function getWatchHTMLPage(id, options) {
    const BODY = await getWatchHTMLPageBody(id, options), INFO = { page: 'watch' };
    try {
        try {
            INFO.player_response = utils_1.default.tryParseBetween(BODY, 'var ytInitialPlayerResponse = ', '}};', '', '}}') || utils_1.default.tryParseBetween(BODY, 'var ytInitialPlayerResponse = ', ';var') || utils_1.default.tryParseBetween(BODY, 'var ytInitialPlayerResponse = ', ';</script>') || findJSON('watch.html', 'player_response', BODY, /\bytInitialPlayerResponse\s*=\s*\{/i, '</script>', '{') || null;
        }
        catch (err) {
            const ARGS = findJSON('watch.html', 'player_response', BODY, /\bytplayer\.config\s*=\s*{/, '</script>', '{');
            INFO.player_response = findPlayerResponse('watch.html', ARGS);
        }
        INFO.response = utils_1.default.tryParseBetween(BODY, 'var ytInitialData = ', '}};', '', '}}') || utils_1.default.tryParseBetween(BODY, 'var ytInitialData = ', ';</script>') || utils_1.default.tryParseBetween(BODY, 'window["ytInitialData"] = ', '}};', '', '}}') || utils_1.default.tryParseBetween(BODY, 'window["ytInitialData"] = ', ';</script>') || findJSON('watch.html', 'response', BODY, /\bytInitialData("\])?\s*=\s*\{/i, '</script>', '{');
        INFO.html5Player = getHTML5Player(BODY);
    }
    catch (err) {
        throw Error('Error when parsing watch.html, maybe YouTube made a change.\n' + `Please report this issue with the "${utils_1.default.saveDebugFile('watch.html', BODY)}" file on https://github.com/ybd-project/ytdl-core/issues.`);
    }
    return INFO;
}
/* ----------- */
/* Get Info Function */
function parseFormats(playerResponse) {
    let formats = [];
    if (playerResponse && playerResponse.streamingData) {
        formats = formats.concat(playerResponse.streamingData.formats).concat(playerResponse.streamingData.adaptiveFormats);
    }
    return formats;
}
async function getM3U8(url, options) {
    const _URL = new URL(url, BASE_URL), BODY = await utils_1.default.request(_URL.toString(), options), FORMATS = {};
    BODY.split('\n')
        .filter((line) => /^https?:\/\//.test(line))
        .forEach((line) => {
        const MATCH = line.match(/\/itag\/(\d+)\//) || [], ITAG = parseInt(MATCH[1]);
        FORMATS[line] = { itag: ITAG, url: line };
    });
    return FORMATS;
}
function getDashManifest(url, options) {
    return new Promise((resolve, reject) => {
        const PARSER = sax_1.default.parser(false), FORMATS = {};
        PARSER.onerror = reject;
        let adaptationSet = null;
        PARSER.onopentag = (node) => {
            const ATTRIBUTES = node.attributes;
            if (node.name === 'ADAPTATIONSET') {
                adaptationSet = ATTRIBUTES;
            }
            else if (node.name === 'REPRESENTATION') {
                const ITAG = parseInt(ATTRIBUTES.ID);
                if (!isNaN(ITAG)) {
                    const SOURCE = (() => {
                        if (node.attributes.HEIGHT) {
                            return {
                                width: parseInt(ATTRIBUTES.WIDTH),
                                height: parseInt(ATTRIBUTES.HEIGHT),
                                fps: parseInt(ATTRIBUTES.FRAMERATE),
                            };
                        }
                        else {
                            return {
                                audioSampleRate: ATTRIBUTES.AUDIOSAMPLINGRATE,
                            };
                        }
                    })();
                    FORMATS[url] = Object.assign({
                        itag: ITAG,
                        url,
                        bitrate: parseInt(ATTRIBUTES.BANDWIDTH),
                        mimeType: `${adaptationSet.MIMETYPE}; codecs="${ATTRIBUTES.CODECS}"`,
                    }, SOURCE);
                    Object.assign;
                }
            }
        };
        PARSER.onend = () => {
            resolve(FORMATS);
        };
        utils_1.default
            .request(new URL(url, BASE_URL).toString(), options)
            .then((res) => {
            PARSER.write(res);
            PARSER.close();
        })
            .catch(reject);
    });
}
function parseAdditionalManifests(playerResponse, options) {
    const STREAMING_DATA = playerResponse && playerResponse.streamingData, MANIFESTS = [];
    if (STREAMING_DATA) {
        if (STREAMING_DATA.dashManifestUrl) {
            MANIFESTS.push(getDashManifest(STREAMING_DATA.dashManifestUrl, options));
        }
        if (STREAMING_DATA.hlsManifestUrl) {
            MANIFESTS.push(getM3U8(STREAMING_DATA.hlsManifestUrl, options));
        }
    }
    return MANIFESTS;
}
async function playerAPI(videoId, payload, headers, options, apiUrl) {
    const { jar, dispatcher } = options.agent || {}, HEADERS = {
        'Content-Type': 'application/json',
        cookie: jar?.getCookieStringSync('https://www.youtube.com'),
        'X-Goog-Visitor-Id': options.visitorData,
        ...headers,
    }, OPTS = {
        requestOptions: {
            method: 'POST',
            dispatcher,
            query: {
                prettyPrint: false,
                t: apiUrl ? utils_1.default.generateClientPlaybackNonce(12) : undefined,
                id: videoId,
            },
            headers: HEADERS,
            body: JSON.stringify(payload),
        },
    }, RESPONSE = await utils_1.default.request(apiUrl || 'https://www.youtube.com/youtubei/v1/player', OPTS), PLAY_ERROR = utils_1.default.playError(RESPONSE);
    if (PLAY_ERROR) {
        throw PLAY_ERROR;
    }
    if (!RESPONSE.videoDetails || videoId !== RESPONSE.videoDetails.videoId) {
        const ERROR = new PlayerRequestError('Malformed response from YouTube');
        ERROR.response = RESPONSE;
        throw ERROR;
    }
    return RESPONSE;
}
async function getSignatureTimestamp(html5player, options) {
    const BODY = await utils_1.default.request(html5player, options), MO = BODY.match(/signatureTimestamp:(\d+)/);
    return MO ? MO[1] : undefined;
}
async function fetchSpecifiedPlayer(playerType, videoId, options, other = {}) {
    const CLIENT = clients_1.INNERTUBE_CLIENTS[playerType], SERVICE_INTEGRITY_DIMENSIONS = options.poToken ? { poToken: options.poToken } : undefined, PAYLOAD = {
        videoId,
        cpn: utils_1.default.generateClientPlaybackNonce(16),
        contentCheckOk: true,
        racyCheckOk: true,
        params: 'QAA%3D' || other.params,
        serviceIntegrityDimensions: SERVICE_INTEGRITY_DIMENSIONS,
        playbackContext: {
            contentPlaybackContext: {
                vis: 0,
                splay: false,
                referer: BASE_URL + videoId,
                currentUrl: BASE_URL + videoId + '&pp=QAA%3D',
                autonavState: 'STATE_ON',
                autoCaptionsDefaultOn: false,
                html5Preference: 'HTML5_PREF_WANTS',
                lactMilliseconds: '-1',
                signatureTimestamp: other.signatureTimestamp,
            },
        },
        attestationRequest: {
            omitBotguardData: true,
        },
        context: {
            client: CLIENT.INNERTUBE_CONTEXT.client,
            request: {
                internalExperimentFlags: [],
                useSsl: true,
            },
            user: {
                lockedSafetyMode: false,
            },
            thirdParty: { embedUrl: 'https://www.youtube.com' },
        },
    }, USER_AGENT = CLIENT.INNERTUBE_CONTEXT.client.userAgent || `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36`, HEADERS = {
        'X-Goog-Api-Format-Version': '2',
        'X-YouTube-Client-Name': CLIENT.INNERTUBE_CONTEXT_CLIENT_NAME,
        'X-Youtube-Client-Version': CLIENT.INNERTUBE_CONTEXT.client.clientVersion,
        'User-Agent': USER_AGENT,
    };
    PAYLOAD.context.client.visitorData = options.visitorData;
    PAYLOAD.context.client.originalUrl = `https://www.youtube.com/watch?v=${videoId}&pp=QAA%3D`;
    return await playerAPI(videoId, PAYLOAD, HEADERS, options);
}
/* ----------- */
/* Public Constants */
const CACHE = new cache_1.Cache(), WATCH_PAGE_CACHE = new cache_1.Cache();
exports.CACHE = CACHE;
exports.WATCH_PAGE_CACHE = WATCH_PAGE_CACHE;
async function _getBasicInfo(id, options, isFromGetInfo) {
    utils_1.default.applyIPv6Rotations(options);
    utils_1.default.applyDefaultHeaders(options);
    utils_1.default.applyDefaultAgent(options);
    utils_1.default.applyOldLocalAddress(options);
    options.requestOptions ??= {};
    const { jar, dispatcher } = options.agent || {}, RETRY_OPTIONS = Object.assign({}, options.requestOptions);
    utils_1.default.setPropInsensitive(options.requestOptions?.headers, 'cookie', jar?.getCookieStringSync('https://www.youtube.com'));
    options.requestOptions.dispatcher ??= dispatcher;
    if (!options.poToken) {
        Log_1.Logger.warning('Specify poToken for stable and fast operation. See README for details.');
        Log_1.Logger.info('Automatically generates poToken, but stable operation cannot be guaranteed.');
        try {
            const { poToken, visitorData } = await (0, youtube_po_token_generator_1.generate)();
            options.poToken = poToken;
            options.visitorData = visitorData;
        }
        catch (err) {
            Log_1.Logger.error('Failed to generate a poToken.');
        }
    }
    if (options.poToken && !options.visitorData) {
        Log_1.Logger.warning('If you specify a poToken, you must also specify the visitorData.');
    }
    options.clients ??= BASE_CLIENTS;
    if (options.clients && options.clients.length === 0) {
        Log_1.Logger.warning('At least one client must be specified.');
        options.clients = BASE_CLIENTS;
    }
    if (options.clients.some((client) => client.includes('creator'))) {
        options.clients = options.clients.filter((client) => client !== 'web_creator');
    }
    /* Promises */
    const RETRY_FUNC_PROMISE = retryFunc(getWatchHTMLPage, [id, options], RETRY_OPTIONS), WATCH_PAGE_BODY_PROMISE = getWatchHTMLPageBody(id, options), EMBED_PAGE_BODY_PROMISE = getEmbedPageBody(id, options), WEB_CREATOR_PROMISE = Promise.allSettled([fetchSpecifiedPlayer('web_creator', id, options)]);
    /* HTML5 Player and Signature Timestamp */
    const HTML5_PLAYER = getHTML5Player(await WATCH_PAGE_BODY_PROMISE) || getHTML5Player(await EMBED_PAGE_BODY_PROMISE), HTML5_PLAYER_URL = HTML5_PLAYER ? new URL(HTML5_PLAYER, BASE_URL).toString() : '', SIGNATURE_TIMESTAMP = (await getSignatureTimestamp(HTML5_PLAYER_URL, options)) || '', WEB_CREATOR_RESPONSE = (await WEB_CREATOR_PROMISE)[0];
    if (!HTML5_PLAYER) {
        throw new Error('Unable to find html5player file');
    }
    if (WEB_CREATOR_RESPONSE.status === 'rejected' && WEB_CREATOR_RESPONSE.reason.message.includes('Sign in to confirm your age')) {
        Log_1.Logger.info('Due to age restrictions on this video, the available clients are limited to “tv_embedded”.');
        options.clients = ['tv_embedded'];
    }
    /* Player Promises and Video Info */
    const PLAYER_FETCH_PROMISE = Promise.allSettled([...options.clients.map((client) => fetchSpecifiedPlayer(client, id, options, { signatureTimestamp: parseInt(SIGNATURE_TIMESTAMP) }))]), WATCH_PAGE_INFO = await RETRY_FUNC_PROMISE, VIDEO_INFO = {
        _watchPageInfo: WATCH_PAGE_INFO,
        related_videos: [],
        videoDetails: {},
        formats: [],
        html5Player: null,
        clients: options.clients,
    };
    options.clients.push('web_creator');
    const PLAYER_API_RESPONSES = await PLAYER_FETCH_PROMISE, PLAYER_RESPONSES = {}, PLAYER_RESPONSE_ARRAY = [];
    options.clients.forEach((client, i) => {
        if (client === 'web_creator' && WEB_CREATOR_RESPONSE.status === 'fulfilled') {
            PLAYER_RESPONSES[client] = WEB_CREATOR_RESPONSE.value;
            PLAYER_RESPONSE_ARRAY.push(WEB_CREATOR_RESPONSE.value);
            Log_1.Logger.debug(`[ ${client} ]: Success`);
            return;
        }
        if (PLAYER_API_RESPONSES[i].status === 'fulfilled') {
            PLAYER_RESPONSES[client] = PLAYER_API_RESPONSES[i].value;
            PLAYER_RESPONSE_ARRAY.push(PLAYER_API_RESPONSES[i].value);
            Log_1.Logger.debug(`[ ${client} ]: Success`);
        }
        else {
            Log_1.Logger.debug(`[ ${client} ]: Error\nReason: ${PLAYER_API_RESPONSES[i].reason}`);
        }
    });
    if (PLAYER_API_RESPONSES.every((r) => r.status === 'rejected')) {
        throw new Error(`All player APIs responded with an error. (Clients: ${options.clients.join(', ')})`);
    }
    VIDEO_INFO.html5Player = HTML5_PLAYER_URL;
    if (isFromGetInfo) {
        VIDEO_INFO._playerResponses = PLAYER_RESPONSES;
    }
    /* Filtered */
    const INCLUDE_STORYBOARDS = PLAYER_RESPONSE_ARRAY.filter((p) => p.storyboards)[0], VIDEO_DETAILS = PLAYER_RESPONSE_ARRAY.filter((p) => p.videoDetails)[0]?.videoDetails || {}, MICROFORMAT = PLAYER_RESPONSE_ARRAY.filter((p) => p.microformat)[0]?.microformat || null;
    const STORYBOARDS = info_extras_1.default.getStoryboards(INCLUDE_STORYBOARDS), MEDIA = info_extras_1.default.getMedia(WATCH_PAGE_INFO), AGE_RESTRICTED = !!MEDIA && AGE_RESTRICTED_URLS.some((url) => Object.values(MEDIA || {}).some((v) => typeof v === 'string' && v.includes(url))), ADDITIONAL_DATA = {
        video_url: BASE_URL + id,
        author: info_extras_1.default.getAuthor(WATCH_PAGE_INFO),
        media: MEDIA,
        likes: info_extras_1.default.getLikes(WATCH_PAGE_INFO),
        age_restricted: AGE_RESTRICTED,
        storyboards: STORYBOARDS,
        chapters: info_extras_1.default.getChapters(WATCH_PAGE_INFO),
    };
    VIDEO_INFO.related_videos = info_extras_1.default.getRelatedVideos(WATCH_PAGE_INFO);
    VIDEO_INFO.videoDetails = info_extras_1.default.cleanVideoDetails(Object.assign({}, VIDEO_DETAILS, ADDITIONAL_DATA), MICROFORMAT);
    VIDEO_INFO.formats = PLAYER_RESPONSE_ARRAY.reduce((items, playerResponse) => {
        return [...items, ...parseFormats(playerResponse)];
    }, []);
    return VIDEO_INFO;
}
async function getBasicInfo(link, options = {}) {
    utils_1.default.checkForUpdates();
    const ID = url_utils_1.default.getVideoID(link), CACHE_KEY = ['getBasicInfo', ID, options.lang].join('-');
    return CACHE.getOrSet(CACHE_KEY, () => _getBasicInfo(ID, options));
}
// TODO: Clean up this function for readability and support more clients
/** Gets info from a video additional formats and deciphered URLs. */
async function _getInfo(id, options) {
    utils_1.default.applyIPv6Rotations(options);
    utils_1.default.applyDefaultHeaders(options);
    utils_1.default.applyDefaultAgent(options);
    utils_1.default.applyOldLocalAddress(options);
    const INFO = await _getBasicInfo(id, options, true), FUNCTIONS = [];
    try {
        const FORMATS = INFO.formats;
        FUNCTIONS.push(sig_1.default.decipherFormats(FORMATS, INFO.html5Player, options));
        for (const RESPONSE of FORMATS) {
            FUNCTIONS.push(...parseAdditionalManifests(RESPONSE, options));
        }
    }
    catch (err) {
        Log_1.Logger.warning('Error in player API; falling back to web-scraping');
        FUNCTIONS.push(sig_1.default.decipherFormats(parseFormats(INFO._watchPageInfo.player_response), INFO.html5Player, options));
        FUNCTIONS.push(...parseAdditionalManifests(INFO._watchPageInfo.player_response, options));
    }
    const RESULTS = await Promise.all(FUNCTIONS);
    INFO.formats = Object.values(Object.assign({}, ...RESULTS));
    INFO.formats = INFO.formats.map(format_utils_1.default.addFormatMeta);
    INFO.formats.sort(format_utils_1.default.sortFormats);
    INFO.full = true;
    if (!options.includesWatchPageInfo) {
        delete INFO._watchPageInfo;
    }
    if (!options.includesPlayerAPIResponse) {
        delete INFO._playerResponses;
    }
    return INFO;
}
async function getInfo(link, options = {}) {
    utils_1.default.checkForUpdates();
    const ID = url_utils_1.default.getVideoID(link), CACHE_KEY = ['getInfo', ID, options.lang].join('-');
    return CACHE.getOrSet(CACHE_KEY, () => _getInfo(ID, options));
}
const validateID = url_utils_1.default.validateID, validateURL = url_utils_1.default.validateURL, getURLVideoID = url_utils_1.default.getURLVideoID, getVideoID = url_utils_1.default.getVideoID;
exports.validateID = validateID;
exports.validateURL = validateURL;
exports.getURLVideoID = getURLVideoID;
exports.getVideoID = getVideoID;
exports.default = { CACHE, WATCH_PAGE_CACHE, getBasicInfo, getInfo, validateID, validateURL, getURLVideoID, getVideoID };
//# sourceMappingURL=info.js.map
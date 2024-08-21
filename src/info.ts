import sax from 'sax';
import { setTimeout } from 'timers';
import { generate } from 'youtube-po-token-generator';
import utils from './utils';
import formatUtils from './format-utils';
import urlUtils from './url-utils';
import extras from './info-extras';
import { Cache } from './cache';
import sig from './sig';
import { INNERTUBE_CLIENTS, YTDL_ClientTypes } from './meta/clients';
import { Logger } from './utils/Log';

import { YTDL_GetInfoOptions, YTDL_RequestOptions } from '@/types/options';
import { YT_StreamingFormat, YT_YTInitialPlayerResponse, YTDL_MoreVideoDetailsAdditions, YTDL_VideoInfo, YTDL_WatchPageInfo } from '@/types/youtube';

/* Private Constants */
const BASE_URL = 'https://www.youtube.com/watch?v=',
    BASE_EMBED_URL = 'https://www.youtube.com/embed/',
    AGE_RESTRICTED_URLS = ['support.google.com/youtube/?p=age_restrictions', 'youtube.com/t/community_guidelines'],
    JSON_CLOSING_CHARS = /^[)\]}'\s]+/,
    BASE_CLIENTS: Array<YTDL_ClientTypes> = ['web_creator', 'ios', 'android'];

/* ----------- */

/* Private Classes */
class PlayerRequestError<T = unknown> extends Error {
    public response: T | null;

    constructor(message: string) {
        super(message);
        this.response = null;
    }
}

/* Private Functions */

/* ----------- */
/* Basic Info Function */

/* Given a function, calls it with `args` until it's successful,
 * or until it encounters an unrecoverable error.
 * Currently, any error from miniget is considered unrecoverable. Errors such as
 * too many redirects, invalid URL, status code 404, status code 502. */
type YTDL_RetryFuncOptions = YTDL_GetInfoOptions['requestOptions'] & {
    maxRetries?: number;
    backoff?: {
        inc: number;
        max: number;
    };
};
async function retryFunc<T = unknown>(func: Function, args: Array<any>, options: YTDL_RetryFuncOptions): Promise<T> {
    let currentTry = 0,
        result: T | null = null;

    options.maxRetries ??= 3;
    options.backoff ??= {
        inc: 500,
        max: 5000,
    };

    while (currentTry <= options.maxRetries) {
        try {
            result = await func(...args);
            break;
        } catch (err: any) {
            if ((err && err?.statusCode < 500) || currentTry >= options.maxRetries) {
                throw err;
            }

            let wait = Math.min(++currentTry * options.backoff.inc, options.backoff.max);

            await new Promise((resolve) => setTimeout(resolve, wait));
        }
    }

    return result as T;
}

function parseJSON<T = unknown>(source: string, varName: string, json: string): T {
    if (!json || typeof json === 'object') {
        return json as T;
    } else {
        try {
            json = json.replace(JSON_CLOSING_CHARS, '');
            return JSON.parse(json);
        } catch (err: any) {
            throw Error(`Error parsing ${varName} in ${source}: ${err.message}`);
        }
    }
}

function findJSON<T = unknown>(source: string, varName: string, body: string, left: RegExp, right: string, prependJSON: string): T {
    const JSON_STR = utils.between(body, left, right);

    if (!JSON_STR) {
        throw Error(`Could not find ${varName} in ${source}`);
    }

    return parseJSON<T>(source, varName, utils.cutAfterJS(`${prependJSON}${JSON_STR}`));
}

function findPlayerResponse(source: string, info: any): YT_YTInitialPlayerResponse | null {
    const PLAYER_RESPONSE = info && ((info.args && info.args.player_response) || info.player_response || info.playerResponse || info.embedded_player_response);

    return parseJSON(source, 'player_response', PLAYER_RESPONSE);
}

function getWatchHTMLURL(id: string, options: YTDL_GetInfoOptions): string {
    return `${BASE_URL + id}&hl=${options.lang || 'en'}&bpctr=${Math.ceil(Date.now() / 1000)}&has_verified=1`;
}

function getEmbedPageBody(id: string, options: YTDL_GetInfoOptions): Promise<string> {
    const EMBED_PAGE_URL = `${BASE_EMBED_URL + id}?hl=${options.lang || 'en'}`;
    return utils.request(EMBED_PAGE_URL, options);
}

async function getWatchHTMLPageBody(id: string, options: YTDL_GetInfoOptions): Promise<string> {
    const WATCH_PAGE_URL = getWatchHTMLURL(id, options);
    return WATCH_PAGE_CACHE.getOrSet(WATCH_PAGE_URL, () => utils.request(WATCH_PAGE_URL, options)) || '';
}

function getHTML5Player(body: string): string | null {
    const HTML5_PLAYER_RES = /<script\s+src="([^"]+)"(?:\s+type="text\/javascript")?\s+name="player_ias\/base"\s*>|"jsUrl":"([^"]+)"/.exec(body);

    return HTML5_PLAYER_RES ? HTML5_PLAYER_RES[1] || HTML5_PLAYER_RES[2] : null;
}

async function getWatchHTMLPage(id: string, options: YTDL_GetInfoOptions): Promise<YTDL_WatchPageInfo> {
    const BODY = await getWatchHTMLPageBody(id, options),
        INFO: YTDL_WatchPageInfo = { page: 'watch' } as any;

    try {
        try {
            INFO.player_response = utils.tryParseBetween(BODY, 'var ytInitialPlayerResponse = ', '}};', '', '}}') || utils.tryParseBetween(BODY, 'var ytInitialPlayerResponse = ', ';var') || utils.tryParseBetween(BODY, 'var ytInitialPlayerResponse = ', ';</script>') || findJSON<YT_YTInitialPlayerResponse>('watch.html', 'player_response', BODY, /\bytInitialPlayerResponse\s*=\s*\{/i, '</script>', '{') || null;
        } catch (err) {
            const ARGS = findJSON<Object>('watch.html', 'player_response', BODY, /\bytplayer\.config\s*=\s*{/, '</script>', '{');
            INFO.player_response = findPlayerResponse('watch.html', ARGS) as any;
        }

        INFO.response = utils.tryParseBetween(BODY, 'var ytInitialData = ', '}};', '', '}}') || utils.tryParseBetween(BODY, 'var ytInitialData = ', ';</script>') || utils.tryParseBetween(BODY, 'window["ytInitialData"] = ', '}};', '', '}}') || utils.tryParseBetween(BODY, 'window["ytInitialData"] = ', ';</script>') || findJSON('watch.html', 'response', BODY, /\bytInitialData("\])?\s*=\s*\{/i, '</script>', '{');
        INFO.html5Player = getHTML5Player(BODY);
    } catch (err) {
        throw Error('Error when parsing watch.html, maybe YouTube made a change.\n' + `Please report this issue with the "${utils.saveDebugFile('watch.html', BODY)}" file on https://github.com/ybd-project/ytdl-core/issues.`);
    }

    return INFO;
}
/* ----------- */

/* Get Info Function */
function parseFormats(playerResponse: YT_YTInitialPlayerResponse | null): Array<YT_StreamingFormat> {
    let formats: Array<YT_StreamingFormat> = [];

    if (playerResponse && playerResponse.streamingData) {
        formats = formats.concat(playerResponse.streamingData.formats).concat(playerResponse.streamingData.adaptiveFormats);
    }

    return formats;
}

type YTDL_M3U8Data = { itag: number; url: string };
async function getM3U8(url: string, options: YTDL_RequestOptions): Promise<Record<string, YTDL_M3U8Data>> {
    const _URL = new URL(url, BASE_URL),
        BODY = await utils.request<string>(_URL.toString(), options),
        FORMATS: Record<string, YTDL_M3U8Data> = {};

    BODY.split('\n')
        .filter((line) => /^https?:\/\//.test(line))
        .forEach((line) => {
            const MATCH = line.match(/\/itag\/(\d+)\//) || [],
                ITAG = parseInt(MATCH[1]);

            FORMATS[line] = { itag: ITAG, url: line };
        });

    return FORMATS;
}

type YTDL_DashManifestData = {
    itag: number;
    url: string;
    bitrate: number;
    mimeType: string;
    audioSampleRate?: number;
    width?: number;
    height?: number;
    fps?: number;
};
function getDashManifest(url: string, options: YTDL_RequestOptions): Promise<Record<string, YTDL_DashManifestData>> {
    return new Promise((resolve, reject) => {
        const PARSER = sax.parser(false),
            FORMATS: Record<string, YTDL_DashManifestData> = {};

        PARSER.onerror = reject;
        let adaptationSet: any = null;

        PARSER.onopentag = (node) => {
            const ATTRIBUTES = node.attributes as any;

            if (node.name === 'ADAPTATIONSET') {
                adaptationSet = ATTRIBUTES;
            } else if (node.name === 'REPRESENTATION') {
                const ITAG = parseInt(ATTRIBUTES.ID);
                if (!isNaN(ITAG)) {
                    const SOURCE = (() => {
                        if (node.attributes.HEIGHT) {
                            return {
                                width: parseInt(ATTRIBUTES.WIDTH),
                                height: parseInt(ATTRIBUTES.HEIGHT),
                                fps: parseInt(ATTRIBUTES.FRAMERATE),
                            };
                        } else {
                            return {
                                audioSampleRate: ATTRIBUTES.AUDIOSAMPLINGRATE,
                            };
                        }
                    })();

                    FORMATS[url] = Object.assign(
                        {
                            itag: ITAG,
                            url,
                            bitrate: parseInt(ATTRIBUTES.BANDWIDTH),
                            mimeType: `${adaptationSet.MIMETYPE}; codecs="${ATTRIBUTES.CODECS}"`,
                        },
                        SOURCE,
                    );

                    Object.assign;
                }
            }
        };

        PARSER.onend = () => {
            resolve(FORMATS);
        };

        utils
            .request(new URL(url, BASE_URL).toString(), options)
            .then((res: any) => {
                PARSER.write(res);
                PARSER.close();
            })
            .catch(reject);
    });
}

function parseAdditionalManifests(playerResponse: YT_YTInitialPlayerResponse | null, options: YTDL_RequestOptions): Array<Promise<Record<string, YTDL_M3U8Data | YTDL_DashManifestData>>> {
    const STREAMING_DATA = playerResponse && playerResponse.streamingData,
        MANIFESTS: Array<Promise<Record<string, YTDL_M3U8Data | YTDL_DashManifestData>>> = [];

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

async function playerAPI(videoId: string, payload: any, headers: Record<string, any>, options: YTDL_GetInfoOptions & { visitorId?: string }, apiUrl?: string): Promise<YT_YTInitialPlayerResponse> {
    const { jar, dispatcher } = options.agent || {},
        HEADERS = {
            'Content-Type': 'application/json',
            cookie: jar?.getCookieStringSync('https://www.youtube.com'),
            'X-Goog-Visitor-Id': options.visitorData,
            ...headers,
        },
        OPTS: YTDL_GetInfoOptions = {
            requestOptions: {
                method: 'POST',
                dispatcher,
                query: {
                    prettyPrint: false,
                    t: apiUrl ? utils.generateClientPlaybackNonce(12) : undefined,
                    id: videoId,
                },
                headers: HEADERS,
                body: JSON.stringify(payload),
            },
        },
        RESPONSE = await utils.request<YT_YTInitialPlayerResponse>(apiUrl || 'https://www.youtube.com/youtubei/v1/player', OPTS),
        PLAY_ERROR = utils.playError(RESPONSE);

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

async function getSignatureTimestamp(html5player: string, options: YTDL_GetInfoOptions) {
    const BODY = await utils.request<string>(html5player, options),
        MO = BODY.match(/signatureTimestamp:(\d+)/);

    return MO ? MO[1] : undefined;
}

type YTDL_OtherPlayerPayload = { signatureTimestamp?: number; params?: string };
async function fetchSpecifiedPlayer(playerType: YTDL_ClientTypes, videoId: string, options: YTDL_GetInfoOptions, other: YTDL_OtherPlayerPayload = {}): Promise<YT_YTInitialPlayerResponse> {
    const CLIENT = INNERTUBE_CLIENTS[playerType],
        SERVICE_INTEGRITY_DIMENSIONS = options.poToken ? { poToken: options.poToken } : undefined,
        PAYLOAD = {
            videoId,
            cpn: utils.generateClientPlaybackNonce(16),
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
        },
        USER_AGENT = CLIENT.INNERTUBE_CONTEXT.client.userAgent || `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36`,
        HEADERS = {
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
const CACHE = new Cache(),
    WATCH_PAGE_CACHE = new Cache();

/* ----------- */

/* Public Functions */

/** Gets info from a video without getting additional formats. */
type YTDL_PlayerResponses = {
    [key in YTDL_ClientTypes]?: YT_YTInitialPlayerResponse | null;
};
async function _getBasicInfo(id: string, options: YTDL_GetInfoOptions, isFromGetInfo?: boolean): Promise<YTDL_VideoInfo> {
    utils.applyIPv6Rotations(options);
    utils.applyDefaultHeaders(options);
    utils.applyDefaultAgent(options);
    utils.applyOldLocalAddress(options);

    options.requestOptions ??= {};

    const { jar, dispatcher } = options.agent || {},
        RETRY_OPTIONS = Object.assign({}, options.requestOptions);

    utils.setPropInsensitive(options.requestOptions?.headers, 'cookie', jar?.getCookieStringSync('https://www.youtube.com'));
    options.requestOptions.dispatcher ??= dispatcher;

    if (!options.poToken) {
        Logger.warning('Specify poToken for stable and fast operation. See README for details.');
        Logger.info('Automatically generates poToken, but stable operation cannot be guaranteed.');

        try {
            const { poToken, visitorData } = await generate();
            options.poToken = poToken;
            options.visitorData = visitorData;
        } catch (err) {
            Logger.error('Failed to generate a poToken.');
        }
    }

    if (options.poToken && !options.visitorData) {
        Logger.warning('If you specify a poToken, you must also specify the visitorData.');
    }

    options.clients ??= BASE_CLIENTS;

    if (options.clients && options.clients.length === 0) {
        Logger.warning('At least one client must be specified.');
        options.clients = BASE_CLIENTS;
    }

    if (options.clients.some((client) => client.includes('creator'))) {
        options.clients = options.clients.filter((client) => client !== 'web_creator');
    }

    /* Promises */
    const RETRY_FUNC_PROMISE = retryFunc<YTDL_WatchPageInfo>(getWatchHTMLPage, [id, options], RETRY_OPTIONS),
        WATCH_PAGE_BODY_PROMISE = getWatchHTMLPageBody(id, options),
        EMBED_PAGE_BODY_PROMISE = getEmbedPageBody(id, options),
        WEB_CREATOR_PROMISE = Promise.allSettled([fetchSpecifiedPlayer('web_creator', id, options)]);

    /* HTML5 Player and Signature Timestamp */
    const HTML5_PLAYER = getHTML5Player(await WATCH_PAGE_BODY_PROMISE) || getHTML5Player(await EMBED_PAGE_BODY_PROMISE),
        HTML5_PLAYER_URL = HTML5_PLAYER ? new URL(HTML5_PLAYER, BASE_URL).toString() : '',
        SIGNATURE_TIMESTAMP = (await getSignatureTimestamp(HTML5_PLAYER_URL, options)) || '',
        WEB_CREATOR_RESPONSE = (await WEB_CREATOR_PROMISE)[0];

    if (!HTML5_PLAYER) {
        throw new Error('Unable to find html5player file');
    }

    if (WEB_CREATOR_RESPONSE.status === 'rejected' && WEB_CREATOR_RESPONSE.reason.message.includes('Sign in to confirm your age')) {
        Logger.info('Due to age restrictions on this video, the available clients are limited to “tv_embedded”.');
        options.clients = ['tv_embedded'];
    }

    /* Player Promises and Video Info */
    const PLAYER_FETCH_PROMISE = Promise.allSettled(options.clients.map((client) => fetchSpecifiedPlayer(client, id, options, { signatureTimestamp: parseInt(SIGNATURE_TIMESTAMP) }))),
        WATCH_PAGE_INFO = await RETRY_FUNC_PROMISE,
        VIDEO_INFO: YTDL_VideoInfo = {
            _watchPageInfo: WATCH_PAGE_INFO,
            related_videos: [],
            videoDetails: {},
            formats: [],
            html5Player: null,
            clients: options.clients,
        } as any;

    const PLAYER_API_RESPONSES = await PLAYER_FETCH_PROMISE,
        PLAYER_RESPONSES: YTDL_PlayerResponses = {},
        PLAYER_RESPONSE_ARRAY: Array<YT_YTInitialPlayerResponse> = [];

    options.clients.forEach((client, i) => {
        if (PLAYER_API_RESPONSES[i].status === 'fulfilled') {
            PLAYER_RESPONSES[client] = PLAYER_API_RESPONSES[i].value;
            PLAYER_RESPONSE_ARRAY.push(PLAYER_API_RESPONSES[i].value);

            Logger.debug(`[ ${client} ]: Success`);
        } else {
            Logger.debug(`[ ${client} ]: Error\nReason: ${PLAYER_API_RESPONSES[i].reason}`);
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
    const INCLUDE_STORYBOARDS = PLAYER_RESPONSE_ARRAY.filter((p) => p.storyboards)[0],
        VIDEO_DETAILS = (PLAYER_RESPONSE_ARRAY.filter((p) => p.videoDetails)[0]?.videoDetails as any) || {},
        MICROFORMAT = PLAYER_RESPONSE_ARRAY.filter((p) => p.microformat)[0]?.microformat || null;

    const STORYBOARDS = extras.getStoryboards(INCLUDE_STORYBOARDS),
        MEDIA = extras.getMedia(WATCH_PAGE_INFO),
        AGE_RESTRICTED = !!MEDIA && AGE_RESTRICTED_URLS.some((url) => Object.values(MEDIA || {}).some((v) => typeof v === 'string' && v.includes(url))),
        ADDITIONAL_DATA: YTDL_MoreVideoDetailsAdditions = {
            video_url: BASE_URL + id,
            author: extras.getAuthor(WATCH_PAGE_INFO),
            media: MEDIA,
            likes: extras.getLikes(WATCH_PAGE_INFO),
            age_restricted: AGE_RESTRICTED,
            storyboards: STORYBOARDS,
            chapters: extras.getChapters(WATCH_PAGE_INFO),
        };

    VIDEO_INFO.related_videos = extras.getRelatedVideos(WATCH_PAGE_INFO);
    VIDEO_INFO.videoDetails = extras.cleanVideoDetails(Object.assign({}, VIDEO_DETAILS, ADDITIONAL_DATA), MICROFORMAT);
    VIDEO_INFO.formats = PLAYER_RESPONSE_ARRAY.reduce((items: Array<YT_StreamingFormat>, playerResponse) => {
        return [...items, ...parseFormats(playerResponse)];
    }, []) as any;

    return VIDEO_INFO;
}

async function getBasicInfo(link: string, options: YTDL_GetInfoOptions = {}): Promise<YTDL_VideoInfo> {
    utils.checkForUpdates();
    const ID = urlUtils.getVideoID(link),
        CACHE_KEY = ['getBasicInfo', ID, options.lang].join('-');

    return CACHE.getOrSet(CACHE_KEY, () => _getBasicInfo(ID, options)) as Promise<YTDL_VideoInfo>;
}

// TODO: Clean up this function for readability and support more clients
/** Gets info from a video additional formats and deciphered URLs. */
async function _getInfo(id: string, options: YTDL_GetInfoOptions): Promise<YTDL_VideoInfo> {
    utils.applyIPv6Rotations(options);
    utils.applyDefaultHeaders(options);
    utils.applyDefaultAgent(options);
    utils.applyOldLocalAddress(options);

    const INFO: YTDL_VideoInfo = await _getBasicInfo(id, options, true),
        FUNCTIONS = [];

    try {
        const FORMATS = INFO.formats as any as Array<YT_YTInitialPlayerResponse>;
        FUNCTIONS.push(sig.decipherFormats(FORMATS, INFO.html5Player, options));

        for (const RESPONSE of FORMATS) {
            FUNCTIONS.push(...parseAdditionalManifests(RESPONSE, options));
        }
    } catch (err) {
        Logger.warning('Error in player API; falling back to web-scraping');

        FUNCTIONS.push(sig.decipherFormats(parseFormats(INFO._watchPageInfo.player_response), INFO.html5Player, options));
        FUNCTIONS.push(...parseAdditionalManifests(INFO._watchPageInfo.player_response, options));
    }

    const RESULTS = await Promise.all(FUNCTIONS);

    INFO.formats = Object.values(Object.assign({}, ...RESULTS));
    INFO.formats = INFO.formats.map(formatUtils.addFormatMeta);
    INFO.formats.sort(formatUtils.sortFormats);

    INFO.full = true;

    if (!options.includesWatchPageInfo) {
        delete (INFO as any)._watchPageInfo;
    }

    if (!options.includesPlayerAPIResponse) {
        delete (INFO as any)._playerResponses;
    }

    return INFO;
}

async function getInfo(link: string, options: YTDL_GetInfoOptions = {}): Promise<YTDL_VideoInfo> {
    utils.checkForUpdates();
    const ID = urlUtils.getVideoID(link),
        CACHE_KEY = ['getInfo', ID, options.lang].join('-');

    return CACHE.getOrSet(CACHE_KEY, () => _getInfo(ID, options)) as Promise<YTDL_VideoInfo>;
}

const validateID = urlUtils.validateID,
    validateURL = urlUtils.validateURL,
    getURLVideoID = urlUtils.getURLVideoID,
    getVideoID = urlUtils.getVideoID;

export { CACHE, WATCH_PAGE_CACHE, getBasicInfo, getInfo, validateID, validateURL, getURLVideoID, getVideoID };
export default { CACHE, WATCH_PAGE_CACHE, getBasicInfo, getInfo, validateID, validateURL, getURLVideoID, getVideoID };

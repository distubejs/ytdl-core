const { PassThrough } = require("stream");
const getInfo = require("./info");
const utils = require("./utils");
const formatUtils = require("./format-utils");
const urlUtils = require("./url-utils");
const miniget = require("miniget");
const m3u8stream = require("m3u8stream");
const { parseTimestamp } = require("m3u8stream");
const agent = require("./agent");

/**
 * Main ytdl function to create a readable stream from a given link
 * @param {string} link 
 * @param {!Object} options 
 * @returns {ReadableStream}
 */
const ytdl = (link, options = {}) => {
  const stream = createStream(options);
  
  ytdl.getInfo(link, options)
  .then(info => downloadFromInfoCallback(stream, info, options))
  .catch(error => stream.emit("error", error));

  return stream;
};

module.exports = ytdl;

// Exporting functions to the ytdl module
Object.assign(ytdl, {
  getBasicInfo: getInfo.getBasicInfo,
  getInfo: getInfo.getInfo,
  chooseFormat: formatUtils.chooseFormat,
  filterFormats: formatUtils.filterFormats,
  validateID: urlUtils.validateID,
  validateURL: urlUtils.validateURL,
  getURLVideoID: urlUtils.getURLVideoID,
  getVideoID: urlUtils.getVideoID,
  createAgent: agent.createAgent,
  createProxyAgent: agent.createProxyAgent,
  cache: {
    info: getInfo.cache,
    watch: getInfo.watchPageCache,
  },
  version: require("../package.json").version,
});

/**
 * Creates a PassThrough stream with a specified highWaterMark 
 * @param {Object} options 
 * @returns {PassThrough}
 */
const createStream = ({ highWaterMark = 512 * 1024 } = {}) => {
  const stream = new PassThrough({ highWaterMark });
  stream._destroy = () => { stream.destroyed = true; };
  return stream;
};

/**
 * Pipes the request and sets up event listeners for error handling
 * @param {stream.Readable} req 
 * @param {stream.PassThrough} stream 
 * @param {boolean} end 
 */
const pipeAndSetEvents = (req, stream, end) => {
  // Forward events from the request to the stream
  const events = ["abort", "request", "response", "error", "redirect", "retry", "reconnect"];
  events.forEach(event => req.prependListener(event, stream.emit.bind(stream, event)));
  req.pipe(stream, { end });
};

/**
 * Download data based on the information callback
 * @param {stream.Readable} stream 
 * @param {Object} info 
 * @param {Object} options 
 */
const downloadFromInfoCallback = (stream, info, options) => {
  const error = utils.playError(info.player_response);
  if (error) return stream.emit("error", error);
  
  if (!info.formats.length) return stream.emit("error", Error("This video is unavailable"));
  
  let format;
  try {
    format = formatUtils.chooseFormat(info.formats, options);
    stream.emit("info", info, format);
  } catch (e) {
    return stream.emit("error", e);
  }

  if (stream.destroyed) return;

  let downloaded = 0;
  const onData = chunk => {
    downloaded += chunk.length;
    stream.emit("progress", chunk.length, downloaded);
  };

  utils.applyDefaultHeaders(options);
  setupRequestOptions(options, format);
  
  if (format.isHLS || format.isDashMPD) {
    setupM3U8Stream(options, format, stream);
  } else {
    setupDownloadStream(options, format, stream, onData);
  }

  stream._destroy = () => {
    stream.destroyed = true;
    if (stream.req) {
      stream.req.destroy();
    }
  };
};

// Formation of m3u8/Dash stream handling
const setupM3U8Stream = (options, format, stream) => {
  const req = m3u8stream(format.url, {
    chunkReadahead: +info.live_chunk_readahead,
    begin: options.begin || (format.isLive && Date.now()),
    liveBuffer: options.liveBuffer,
    requestOptions: options.requestOptions,
    parser: format.isDashMPD ? "dash-mpd" : "m3u8",
    id: format.itag,
  });

  req.on("progress", (segment) => {
    stream.emit("progress", segment.size);
  });
  pipeAndSetEvents(req, stream, true);
};

// Setup download stream functionality
const setupDownloadStream = (options, format, stream, onData) => {
  const requestOptions = {
    ...options.requestOptions,
    maxReconnects: 6,
    maxRetries: 3,
    backoff: { inc: 500, max: 10000 },
  };

  let shouldBeChunked = !format.hasAudio || !format.hasVideo;
  
  if (shouldBeChunked) {
    handleChunkedDownload(options, format, stream, requestOptions, onData);
  } else {
    handleFullDownload(options, format, stream, requestOptions, onData);
  }
};

const handleChunkedDownload = (options, format, stream, requestOptions, onData) => {
  let start = options.range?.start || 0;
  const dlChunkSize = options.dlChunkSize || 1024 * 1024 * 10;

  const getNextChunk = () => {
    if (stream.destroyed) return;

    requestOptions.headers = { Range: `bytes=${start}-${start + dlChunkSize - 1}` };
    stream.req = miniget(format.url, requestOptions);
    
    stream.req.on("data", onData);
    stream.req.on("end", () => {
      if (stream.destroyed) return;
      start += dlChunkSize;
      getNextChunk();
    });
    pipeAndSetEvents(stream.req, stream, true);
  };
  getNextChunk();
};

const handleFullDownload = (options, format, stream, requestOptions, onData) => {
  if (options.begin) {
    format.url += `&begin=${parseTimestamp(options.begin)}`;
  }

  stream.req = miniget(format.url, requestOptions);
  stream.req.on("data", onData);
  pipeAndSetEvents(stream.req, stream, true);
};

// Function for usage directly from info object
ytdl.downloadFromInfo = (info, options) => {
  const stream = createStream(options);
  if (!info.full) {
    throw new Error("Cannot use `ytdl.downloadFromInfo()` with info from `ytdl.getBasicInfo()`");
  }
  setImmediate(() => downloadFromInfoCallback(stream, info, options));
  return stream;
};

// Helper for setting up request options
const setupRequestOptions = (options, format) => {
  if (options.IPv6Block) {
    options.requestOptions = {
      ...options.requestOptions,
      localAddress: utils.getRandomIPv6(options.IPv6Block),
    };
  }
  if (options.agent) {
    if (options.agent.jar) {
      utils.setPropInsensitive(options.requestOptions.headers, "cookie", options.agent.jar.getCookieStringSync("https://www.youtube.com"));
    }
    if (options.agent.localAddress) {
      options.requestOptions.localAddress = options.agent.localAddress;
    }
  }
};

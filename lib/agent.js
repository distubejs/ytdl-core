const { ProxyAgent } = require("undici");
const { Cookie, CookieJar, canonicalDomain } = require("tough-cookie");
const { CookieAgent, CookieClient } = require("http-cookie-agent/undici");

const convertSameSite = (sameSite) => {
  switch (sameSite) {
    case "strict":
      return "Strict";
    case "lax":
      return "Lax";
    case "no_restriction":
    case "unspecified":
    default:
      return "None";
  }
};

const convertCookie = (cookie) => {
  // Avoid unnecessary object allocation
  if (cookie instanceof Cookie) return cookie;

  return new Cookie({
    key: cookie.name,
    value: cookie.value,
    expires: typeof cookie.expirationDate === "number" ? new Date(cookie.expirationDate * 1000) : "Infinity",
    domain: canonicalDomain(cookie.domain),
    path: cookie.path || '/',
    secure: cookie.secure || false,
    httpOnly: cookie.httpOnly || false,
    sameSite: convertSameSite(cookie.sameSite),
    hostOnly: cookie.hostOnly || false,
  });
};

const addCookies = (jar, cookies) => {
  if (!Array.isArray(cookies)) {
    throw new Error("cookies must be an array");
  }
  
  // Use a Set to prevent duplicates
  const cookieNames = new Set(cookies.map(c => c.name));

  if (!cookieNames.has("SOCS")) {
    cookies.push({
      domain: ".youtube.com",
      hostOnly: false,
      httpOnly: false,
      name: "SOCS",
      path: "/",
      sameSite: "lax",
      secure: true,
      session: false,
      value: "CAI",
    });
  }

  // Destructure and map cookies to avoid repetitive processing
  cookies.forEach(cookie => 
    jar.setCookieSync(convertCookie(cookie), "https://www.youtube.com")
  );
};

const addCookiesFromString = (jar, cookies) => {
  if (typeof cookies !== "string") {
    throw new Error("cookies must be a string");
  }

  const cookieArray = cookies.split(";").map(c => Cookie.parse(c)).filter(Boolean);
  addCookies(jar, cookieArray);
};

const createAgent = (cookies = [], opts = {}) => {
  const options = { ...opts };
  if (!options.cookies) {
    const jar = new CookieJar();
    addCookies(jar, cookies);
    options.cookies = { jar };
  }
  return {
    dispatcher: new CookieAgent(options),
    localAddress: options.localAddress,
    jar: options.cookies.jar,
  };
};

const createProxyAgent = (options, cookies = []) => {
  if (typeof options === "string") options = { uri: options };
  if (options.factory) throw new Error("Cannot use factory with createProxyAgent");

  const jar = new CookieJar();
  addCookies(jar, cookies);
  
  const proxyOptions = {
    factory: (origin, opts) => new CookieClient(origin, { ...opts, cookies: { jar } }),
    ...options,
  };

  return { dispatcher: new ProxyAgent(proxyOptions), jar, localAddress: options.localAddress };
};

// Default agent
const defaultAgent = createAgent();

module.exports = {
  addCookies,
  addCookiesFromString,
  createAgent,
  createProxyAgent,
  defaultAgent,
};

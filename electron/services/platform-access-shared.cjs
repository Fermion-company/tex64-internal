const crypto = require("crypto");

const FEATURE_CACHE_TTL_MS = 60_000;
const USAGE_CACHE_TTL_MS = 60_000;
const TOKEN_REFRESH_LEEWAY_MS = 60_000;
const OAUTH_PENDING_TTL_MS = 10 * 60_000;
const SESSION_TOKEN_ENCRYPTION_KIND = "electron-safe-storage-v1";
const PRODUCTION_PLATFORM_API_BASE_URL = "https://tex64.com/api/v2";
const PRODUCTION_PLATFORM_WEB_BASE_URL = "https://tex64.com";
const PRODUCTION_PLATFORM_OAUTH_REDIRECT_URI = "tex64://oauth/callback";

const DEFAULT_STATE = {
  deviceId: null,
  session: null,
  oauthPending: null,
  aiAccessCache: null,
  aiAccessFetchedAt: 0,
  aiUsageCache: null,
  aiUsageFetchedAt: 0,
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

const parseNumber = (value, fallback = 0) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const sanitizeBaseUrl = (value, fallback) => {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return raw.replace(/\/+$/, "");
};

const parseDate = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const parseInteger = (value, fallback = 0) => {
  const numeric = parseNumber(value, fallback);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.round(numeric);
};

const resolveModelLabel = (payload) => {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const candidates = [
    payload.resolvedModel,
    payload.modelVersion,
    payload.model,
    payload.output?.model,
    payload.usage?.model,
    payload.usageMetadata?.model,
    payload.usage_metadata?.model,
    payload.token_usage?.model,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

const sanitizeHttpUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const url = value.trim();
  if (!/^https?:\/\//i.test(url)) {
    return null;
  }
  return url;
};

const sanitizeDigestText = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const digest = value.trim();
  if (digest.length > 512) {
    return null;
  }
  return digest;
};

const normalizePathname = (value) => {
  const pathname = typeof value === "string" && value ? value : "/";
  if (pathname === "/") {
    return "/";
  }
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
};

const normalizeOAuthCallbackEndpoint = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = new URL(value.trim());
    const protocol = parsed.protocol.toLowerCase();
    let hostname = parsed.hostname.toLowerCase();
    let pathname = normalizePathname(parsed.pathname || "/");
    if (protocol === "tex64:") {
      const endpoint = `${hostname}${pathname}`;
      if (
        endpoint === "account/oauth/callback" ||
        (!hostname &&
          (pathname === "/account/oauth/callback" || pathname === "/oauth/callback"))
      ) {
        hostname = "oauth";
        pathname = "/callback";
      }
    }
    return { protocol, hostname, pathname };
  } catch {
    return null;
  }
};

const isDirectOAuthCallbackUrl = (value) => {
  const endpoint = normalizeOAuthCallbackEndpoint(value);
  return Boolean(
    endpoint &&
      endpoint.protocol === "tex64:" &&
      endpoint.hostname === "oauth" &&
      endpoint.pathname === "/callback"
  );
};

const sanitizeOAuthAuthUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const url = value.trim();
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  if (isDirectOAuthCallbackUrl(url)) {
    return url;
  }
  return null;
};

const isMatchingOAuthCallbackUrl = (actualUrl, expectedRedirectUri) => {
  const expected = normalizeOAuthCallbackEndpoint(expectedRedirectUri);
  const actual = normalizeOAuthCallbackEndpoint(actualUrl);
  if (!expected || !actual) {
    return false;
  }
  return (
    expected.protocol === actual.protocol &&
    expected.hostname === actual.hostname &&
    expected.pathname === actual.pathname
  );
};

const parseOAuthParamsFromHash = (hash) => {
  if (typeof hash !== "string" || !hash) {
    return new URLSearchParams();
  }
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!trimmed) {
    return new URLSearchParams();
  }
  const raw = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
  return new URLSearchParams(raw);
};

const pickOAuthParam = (url, hashParams, key) => {
  const searchValue = url.searchParams.get(key);
  if (typeof searchValue === "string" && searchValue.trim()) {
    return searchValue;
  }
  const hashValue = hashParams.get(key);
  if (typeof hashValue === "string" && hashValue.trim()) {
    return hashValue;
  }
  return null;
};

const extractOAuthCallbackParams = (url) => {
  const hashParams = parseOAuthParamsFromHash(url.hash);
  return {
    error: pickOAuthParam(url, hashParams, "error"),
    errorDescription: pickOAuthParam(url, hashParams, "error_description"),
    code: pickOAuthParam(url, hashParams, "code"),
    state: pickOAuthParam(url, hashParams, "state"),
  };
};

const parseVersionTokens = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  return value
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      if (/^\d+$/.test(token)) {
        return Number.parseInt(token, 10);
      }
      return token.toLowerCase();
    });
};

const compareVersionValues = (left, right) => {
  const leftTokens = parseVersionTokens(left);
  const rightTokens = parseVersionTokens(right);
  const maxLength = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 0; index < maxLength; index += 1) {
    const a = leftTokens[index];
    const b = rightTokens[index];
    if (a === undefined && b === undefined) {
      return 0;
    }
    if (a === undefined) {
      if (typeof b === "number") {
        if (b === 0) {
          continue;
        }
        return -1;
      }
      return 1;
    }
    if (b === undefined) {
      if (typeof a === "number") {
        if (a === 0) {
          continue;
        }
        return 1;
      }
      return -1;
    }
    if (a === b) {
      continue;
    }
    if (typeof a === "number" && typeof b === "number") {
      return a > b ? 1 : -1;
    }
    if (typeof a === "number") {
      return 1;
    }
    if (typeof b === "number") {
      return -1;
    }
    return a > b ? 1 : -1;
  }
  return 0;
};

const toBase64Url = (buffer) =>
  buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

class PlatformApiError extends Error {
  constructor(code, message, status = 0, details = null) {
    super(message || code || "Platform API error");
    this.name = "PlatformApiError";
    this.code = typeof code === "string" && code ? code : "PLATFORM_ERROR";
    this.status = Number.isFinite(status) ? status : 0;
    this.details = details;
  }
}

module.exports = {
  FEATURE_CACHE_TTL_MS,
  USAGE_CACHE_TTL_MS,
  TOKEN_REFRESH_LEEWAY_MS,
  OAUTH_PENDING_TTL_MS,
  SESSION_TOKEN_ENCRYPTION_KIND,
  PRODUCTION_PLATFORM_API_BASE_URL,
  PRODUCTION_PLATFORM_WEB_BASE_URL,
  PRODUCTION_PLATFORM_OAUTH_REDIRECT_URI,
  DEFAULT_STATE,
  clone,
  isObject,
  parseNumber,
  sanitizeBaseUrl,
  parseDate,
  parseInteger,
  resolveModelLabel,
  sanitizeHttpUrl,
  sanitizeDigestText,
  normalizePathname,
  normalizeOAuthCallbackEndpoint,
  isDirectOAuthCallbackUrl,
  sanitizeOAuthAuthUrl,
  isMatchingOAuthCallbackUrl,
  parseOAuthParamsFromHash,
  pickOAuthParam,
  extractOAuthCallbackParams,
  parseVersionTokens,
  compareVersionValues,
  toBase64Url,
  PlatformApiError,
};

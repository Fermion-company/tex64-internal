import path from "node:path";

export const PLAN_VALUES = Object.freeze(["free", "basic", "pro"]);
export const STATUS_VALUES = Object.freeze(["active", "grace", "past_due", "canceled"]);

const parseNumber = (value, fallback) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const parseInteger = (value, fallback) => {
  const parsed = parseNumber(value, Number.NaN);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.round(parsed);
};

const parseBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};

const parseUrl = (value, fallback = "") => {
  if (typeof value === "string" && value.trim()) {
    return value.trim().replace(/\/+$/, "");
  }
  return fallback;
};

const resolveJwtSecret = () => {
  if (typeof process.env.TEX64_PLATFORM_JWT_SECRET === "string") {
    const trimmed = process.env.TEX64_PLATFORM_JWT_SECRET.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if ((process.env.NODE_ENV || "").toLowerCase() === "production") {
    return "";
  }
  return "tex64-dev-insecure-secret";
};

const parsePlanValue = (value, fallback) => {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return PLAN_VALUES.includes(normalized) ? normalized : fallback;
};

const parseStatusValue = (value, fallback) => {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return STATUS_VALUES.includes(normalized) ? normalized : fallback;
};

const resolveStateFilePath = () => {
  if (typeof process.env.TEX64_PLATFORM_STATE_FILE === "string") {
    const trimmed = process.env.TEX64_PLATFORM_STATE_FILE.trim();
    if (trimmed) {
      return path.resolve(trimmed);
    }
  }
  return "/tmp/tex64-platform-v2-state.json";
};

const sanitizeHttpUrl = (value, fallback) => {
  const candidate =
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!candidate) {
    return fallback;
  }
  return candidate.replace(/\/+$/, "");
};

let runtimeConfigCache = null;

export const getRuntimeConfig = () => {
  if (runtimeConfigCache) {
    return runtimeConfigCache;
  }
  const blendedCostPerTokenUsd = Math.max(
    0.000000001,
    parseNumber(process.env.TEX64_PLATFORM_BLEND_COST_PER_TOKEN_USD, 0.000002)
  );
  runtimeConfigCache = {
    jwtSecret: resolveJwtSecret(),
    allowDevAuth: parseBoolean(process.env.TEX64_PLATFORM_ALLOW_DEV_AUTH, false),
    adminSecret:
      typeof process.env.TEX64_PLATFORM_ADMIN_SECRET === "string" &&
      process.env.TEX64_PLATFORM_ADMIN_SECRET.trim()
        ? process.env.TEX64_PLATFORM_ADMIN_SECRET.trim()
        : "",
    stateFilePath: resolveStateFilePath(),
    accessTokenTtlSec: Math.max(
      60,
      parseInteger(process.env.TEX64_PLATFORM_ACCESS_TOKEN_TTL_SEC, 900)
    ),
    refreshTokenTtlSec: Math.max(
      60,
      parseInteger(process.env.TEX64_PLATFORM_REFRESH_TOKEN_TTL_SEC, 30 * 24 * 60 * 60)
    ),
    graceDays: Math.max(0, parseInteger(process.env.TEX64_PLATFORM_GRACE_DAYS, 3)),
    blendedCostPerTokenUsd,
    freeMonthlyTokens: Math.max(
      0,
      parseInteger(process.env.TEX64_PLATFORM_FREE_MONTHLY_TOKENS, 0)
    ),
    basicBudgetUsd: 10,
    proBudgetUsd: 20,
    requestLimitFree: Math.max(
      0,
      parseInteger(process.env.TEX64_PLATFORM_REQUEST_LIMIT_FREE, 100)
    ),
    requestLimitBasic: Math.max(
      0,
      parseInteger(process.env.TEX64_PLATFORM_REQUEST_LIMIT_BASIC, 10000)
    ),
    requestLimitPro: Math.max(
      0,
      parseInteger(process.env.TEX64_PLATFORM_REQUEST_LIMIT_PRO, 100000)
    ),
    defaultPlan: parsePlanValue(process.env.TEX64_PLATFORM_DEFAULT_PLAN, "free"),
    defaultStatus: parseStatusValue(process.env.TEX64_PLATFORM_DEFAULT_STATUS, "active"),
    stateFallbackEnabled: parseBoolean(
      process.env.TEX64_PLATFORM_STATE_FALLBACK,
      (process.env.NODE_ENV || "").toLowerCase() !== "production"
    ),
    databaseUrl:
      typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim()
        ? process.env.DATABASE_URL.trim()
        : typeof process.env.TEX64_DATABASE_URL === "string" && process.env.TEX64_DATABASE_URL.trim()
        ? process.env.TEX64_DATABASE_URL.trim()
        : "",
    databaseSsl: parseBoolean(process.env.TEX64_DATABASE_SSL, false),
    baseWebUrl: parseUrl(
      process.env.TEX64_PLATFORM_WEB_BASE_URL,
      "https://tex64.com"
    ),
    oauthStateTtlSec: Math.max(
      60,
      parseInteger(process.env.TEX64_PLATFORM_OAUTH_STATE_TTL_SEC, 600)
    ),
    subscriptionEventTtlSec: Math.max(
      3600,
      parseInteger(
        process.env.TEX64_PLATFORM_SUBSCRIPTION_EVENT_TTL_SEC,
        90 * 24 * 60 * 60
      )
    ),
    mockOAuthEnabled: parseBoolean(process.env.TEX64_PLATFORM_MOCK_OAUTH, false),
    mockOAuthEmail:
      typeof process.env.TEX64_PLATFORM_MOCK_OAUTH_EMAIL === "string" &&
      process.env.TEX64_PLATFORM_MOCK_OAUTH_EMAIL.trim()
        ? process.env.TEX64_PLATFORM_MOCK_OAUTH_EMAIL.trim().toLowerCase()
        : "dev@tex64.com",
    googleClientId:
      typeof process.env.GOOGLE_OAUTH_CLIENT_ID === "string" &&
      process.env.GOOGLE_OAUTH_CLIENT_ID.trim()
        ? process.env.GOOGLE_OAUTH_CLIENT_ID.trim()
        : "",
    googleClientSecret:
      typeof process.env.GOOGLE_OAUTH_CLIENT_SECRET === "string" &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET.trim()
        ? process.env.GOOGLE_OAUTH_CLIENT_SECRET.trim()
        : "",
    pricingUrl: sanitizeHttpUrl(
      process.env.TEX64_PLATFORM_PRICING_URL,
      "https://tex64.com/pricing"
    ),
    openaiApiKey:
      typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim()
        ? process.env.OPENAI_API_KEY.trim()
        : "",
    openaiBaseUrl: sanitizeHttpUrl(
      process.env.TEX64_OPENAI_BASE_URL,
      "https://api.openai.com/v1"
    ),
  };
  return runtimeConfigCache;
};

export const clearRuntimeConfigCache = () => {
  runtimeConfigCache = null;
};

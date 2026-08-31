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

const sanitizeHeaderName = (value) => {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,100}$/.test(normalized)) {
    return "";
  }
  return normalized;
};

let runtimeConfigCache = null;

export const getRuntimeConfig = () => {
  if (runtimeConfigCache) {
    return runtimeConfigCache;
  }
  // Internal budget conversion. Dollar values stay server-side; clients only
  // receive the resulting token allowance and token consumption.
  const blendedCostPerTokenUsd = 0.000005;
  runtimeConfigCache = {
    jwtSecret: resolveJwtSecret(),
    runtimeEnvironment: (process.env.NODE_ENV || "development").trim().toLowerCase(),
    vercelRuntime: process.env.VERCEL === "1",
    // Non-Vercel production deployments may opt into a custom header only
    // when their trusted proxy overwrites it and direct origin access is
    // blocked. Ordinary forwarded headers are never implicitly trusted.
    trustedClientIpHeader: sanitizeHeaderName(
      process.env.TEX64_PLATFORM_TRUSTED_CLIENT_IP_HEADER
    ),
    anonymousDeviceWindowSec: Math.max(
      60,
      parseInteger(process.env.TEX64_ANONYMOUS_DEVICE_WINDOW_SEC, 24 * 60 * 60)
    ),
    anonymousDevicesPerIp: Math.max(
      1,
      parseInteger(process.env.TEX64_ANONYMOUS_DEVICES_PER_IP, 24)
    ),
    anonymousAiWindowSec: Math.max(
      60,
      parseInteger(process.env.TEX64_ANONYMOUS_AI_WINDOW_SEC, 60 * 60)
    ),
    anonymousAiRequestsPerIp: Math.max(
      1,
      parseInteger(process.env.TEX64_ANONYMOUS_AI_REQUESTS_PER_IP, 120)
    ),
    anonymousAiReservedTokensPerIp: Math.max(
      1,
      parseInteger(
        process.env.TEX64_ANONYMOUS_AI_RESERVED_TOKENS_PER_IP,
        400_000
      )
    ),
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
      parseInteger(process.env.TEX64_PLATFORM_FREE_MONTHLY_TOKENS, 200_000)
    ),
    basicBudgetUsd: 4,
    proBudgetUsd: 15,
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
    subscriptionBridgeSource:
      typeof process.env.TEX64_PLATFORM_SUBSCRIPTION_BRIDGE_SOURCE === "string" &&
      process.env.TEX64_PLATFORM_SUBSCRIPTION_BRIDGE_SOURCE.trim()
        ? process.env.TEX64_PLATFORM_SUBSCRIPTION_BRIDGE_SOURCE.trim()
        : "tex64.com",
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
    // These ids are deliberately server-only. Deployments may override them
    // without changing the two public Axiom aliases used by desktop clients.
    axiomStandardModel:
      typeof process.env.TEX64_LLM_AXIOM_100_UPSTREAM === "string" &&
      process.env.TEX64_LLM_AXIOM_100_UPSTREAM.trim()
        ? process.env.TEX64_LLM_AXIOM_100_UPSTREAM.trim()
        : "gpt-5.6-luna",
    axiomStandardInputUsdPerMillion: Math.max(
      0.000001,
      parseNumber(
        process.env.TEX64_LLM_AXIOM_100_INPUT_USD_PER_MILLION,
        0.2,
      ),
    ),
    axiomStandardCachedInputUsdPerMillion: Math.max(
      0.000001,
      parseNumber(
        process.env.TEX64_LLM_AXIOM_100_CACHED_INPUT_USD_PER_MILLION,
        parseNumber(
          process.env.TEX64_LLM_AXIOM_100_INPUT_USD_PER_MILLION,
          0.2,
        ) * 0.1,
      ),
    ),
    axiomStandardCacheWriteUsdPerMillion: Math.max(
      0.000001,
      parseNumber(
        process.env.TEX64_LLM_AXIOM_100_CACHE_WRITE_USD_PER_MILLION,
        parseNumber(
          process.env.TEX64_LLM_AXIOM_100_INPUT_USD_PER_MILLION,
          0.2,
        ) * 1.25,
      ),
    ),
    axiomStandardOutputUsdPerMillion: Math.max(
      0.000001,
      parseNumber(
        process.env.TEX64_LLM_AXIOM_100_OUTPUT_USD_PER_MILLION,
        1.2,
      ),
    ),
    axiomProModel:
      typeof process.env.TEX64_LLM_AXIOM_100_PRO_UPSTREAM === "string" &&
      process.env.TEX64_LLM_AXIOM_100_PRO_UPSTREAM.trim()
        ? process.env.TEX64_LLM_AXIOM_100_PRO_UPSTREAM.trim()
        : "gpt-5.6-terra",
    axiomProInputUsdPerMillion: Math.max(
      0.000001,
      parseNumber(
        process.env.TEX64_LLM_AXIOM_100_PRO_INPUT_USD_PER_MILLION,
        2,
      ),
    ),
    axiomProCachedInputUsdPerMillion: Math.max(
      0.000001,
      parseNumber(
        process.env.TEX64_LLM_AXIOM_100_PRO_CACHED_INPUT_USD_PER_MILLION,
        parseNumber(
          process.env.TEX64_LLM_AXIOM_100_PRO_INPUT_USD_PER_MILLION,
          2,
        ) * 0.1,
      ),
    ),
    axiomProCacheWriteUsdPerMillion: Math.max(
      0.000001,
      parseNumber(
        process.env.TEX64_LLM_AXIOM_100_PRO_CACHE_WRITE_USD_PER_MILLION,
        parseNumber(
          process.env.TEX64_LLM_AXIOM_100_PRO_INPUT_USD_PER_MILLION,
          2,
        ) * 1.25,
      ),
    ),
    axiomProOutputUsdPerMillion: Math.max(
      0.000001,
      parseNumber(
        process.env.TEX64_LLM_AXIOM_100_PRO_OUTPUT_USD_PER_MILLION,
        12,
      ),
    ),
  };
  return runtimeConfigCache;
};

export const clearRuntimeConfigCache = () => {
  runtimeConfigCache = null;
};

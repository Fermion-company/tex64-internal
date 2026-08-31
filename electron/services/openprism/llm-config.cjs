/**
 * LLM Configuration — OpenPrism style.
 *
 * The LLM is accessed through the tex64.com Vercel server, which proxies
 * requests to a configurable OpenAI-compatible LLM provider.  The desktop
 * app authenticates via JWT (from platformAccess) — no user-supplied API key.
 *
 * An OpenAI-compatible endpoint lives at:
 *   https://tex64.com/api/v2/ai/openai/chat/completions
 *
 * Adapted from OpenPrism's llmService.js.
 */

"use strict";

const { PRODUCTION_PLATFORM_API_BASE_URL } = require("../platform-access-shared.cjs");

/**
 * Default base URL for the OpenAI-compat proxy on tex64.com.
 * The run-loop uses this as the base for fetch calls.
 */
const DEFAULT_BASE_URL = `${PRODUCTION_PLATFORM_API_BASE_URL}/ai/openai`;
const OFFICIAL_PLATFORM_CHAT_ENDPOINT = `${DEFAULT_BASE_URL}/chat/completions`;

const LEGACY_AXIOM_MODELS = Object.freeze({
  "axiom0.9.1": "Axiom1.0",
  "axiom0.9.1-pro": "Axiom1.0-pro",
});

/**
 * Canonicalize model ids persisted by TeX64 0.1.18 and earlier.
 * Unknown/provider-specific ids are returned unchanged.
 */
const migrateLegacyAxiomModel = (model) => {
  if (typeof model !== "string") return model;
  return LEGACY_AXIOM_MODELS[model.trim().toLowerCase()] || model;
};

/**
 * Ensure `endpoint` ends with `/chat/completions`.
 *
 * Mirrors OpenPrism's `normalizeChatEndpoint()`.
 */
const normalizeChatEndpoint = (endpoint) => {
  if (!endpoint) return OFFICIAL_PLATFORM_CHAT_ENDPOINT;
  let url = endpoint.trim();
  if (!url) return OFFICIAL_PLATFORM_CHAT_ENDPOINT;
  url = url.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v1$/i.test(url)) return `${url}/chat/completions`;
  if (/\/v1\//i.test(url)) return url;
  return `${url}/v1/chat/completions`;
};

/**
 * Platform credentials are valid for exactly one production endpoint.  Keep
 * this as a strict post-normalization string comparison: host suffix checks or
 * path-only checks would let a custom server receive the TeX64 JWT/device id.
 */
const isOfficialPlatformProxyUrl = (endpoint) =>
  normalizeChatEndpoint(endpoint) === OFFICIAL_PLATFORM_CHAT_ENDPOINT;

/**
 * A custom OpenAI-compatible endpoint must use credentials supplied by the
 * user/developer.  Never fall back to the TeX64 platform identity here.
 */
const resolveOwnApiKey = (settings) => {
  const settingsKey =
    typeof settings?.apiKey === "string" ? settings.apiKey.trim() : "";
  if (settingsKey) return settingsKey;
  const envKey =
    typeof process.env.TEX64_LLM_API_KEY === "string"
      ? process.env.TEX64_LLM_API_KEY.trim()
      : "";
  return envKey || null;
};

/**
 * Resolve LLM configuration.
 *
 * The endpoint defaults to tex64.com's OpenAI-compat proxy.
 * API key is intentionally omitted — the JWT access token is used
 * instead (passed at call time by the run-loop).
 */
const resolveLLMConfig = (settings) => {
  const agentSettings =
    settings && typeof settings === "object" ? settings : {};

  const endpoint = (
    (typeof agentSettings.endpoint === "string" && agentSettings.endpoint.trim()) ||
    (typeof process.env.TEX64_LLM_ENDPOINT === "string" && process.env.TEX64_LLM_ENDPOINT.trim()) ||
    `${DEFAULT_BASE_URL}/chat/completions`
  ).trim();

  const configuredModel = (
    (typeof agentSettings.model === "string" && agentSettings.model.trim()) ||
    (typeof process.env.TEX64_LLM_MODEL === "string" && process.env.TEX64_LLM_MODEL.trim()) ||
    "Axiom1.0"
  ).trim();
  const model = migrateLegacyAxiomModel(configuredModel);

  const rawTemp = agentSettings.temperature;
  const parsedTemp = typeof rawTemp === "number" ? rawTemp : Number(rawTemp);
  const temperature = Number.isFinite(parsedTemp)
    ? Math.min(2, Math.max(0, parsedTemp))
    : undefined; // omit → use model default

  return { endpoint, model, temperature };
};

module.exports = {
  DEFAULT_BASE_URL,
  OFFICIAL_PLATFORM_CHAT_ENDPOINT,
  isOfficialPlatformProxyUrl,
  migrateLegacyAxiomModel,
  normalizeChatEndpoint,
  resolveOwnApiKey,
  resolveLLMConfig,
};

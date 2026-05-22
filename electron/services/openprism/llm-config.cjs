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

/**
 * Ensure `endpoint` ends with `/chat/completions`.
 *
 * Mirrors OpenPrism's `normalizeChatEndpoint()`.
 */
const normalizeChatEndpoint = (endpoint) => {
  if (!endpoint) return `${DEFAULT_BASE_URL}/chat/completions`;
  let url = endpoint.trim();
  if (!url) return `${DEFAULT_BASE_URL}/chat/completions`;
  url = url.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v1$/i.test(url)) return `${url}/chat/completions`;
  if (/\/v1\//i.test(url)) return url;
  return `${url}/v1/chat/completions`;
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

  const model = (
    (typeof agentSettings.model === "string" && agentSettings.model.trim()) ||
    (typeof process.env.TEX64_LLM_MODEL === "string" && process.env.TEX64_LLM_MODEL.trim()) ||
    "Axiom0.9.1"
  ).trim();

  const rawTemp = agentSettings.temperature;
  const parsedTemp = typeof rawTemp === "number" ? rawTemp : Number(rawTemp);
  const temperature = Number.isFinite(parsedTemp)
    ? Math.min(2, Math.max(0, parsedTemp))
    : undefined; // omit → use model default

  return { endpoint, model, temperature };
};

module.exports = {
  DEFAULT_BASE_URL,
  normalizeChatEndpoint,
  resolveLLMConfig,
};

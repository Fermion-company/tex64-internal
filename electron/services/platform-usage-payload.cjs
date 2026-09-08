/**
 * The usage the renderer shows, built from an AI-access snapshot. Shared by
 * the agent handlers (access checks) and the run loop (after a turn), so the
 * settings page and the chat read the same numbers.
 */

"use strict";

const parseNumber = (value, fallback = 0) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const normalizeQuotaSummary = (quota, periodOverrides = {}) => {
  if (!quota || typeof quota !== "object") return null;
  const limitTokens = Math.max(0, Math.round(parseNumber(quota.limitTokens, 0)));
  const usedTokens = Math.max(0, Math.round(parseNumber(quota.usedTokens, 0)));
  const maxRemainingTokens = Math.max(0, limitTokens - usedTokens);
  const rawRemainingTokens = parseNumber(quota.remainingTokens, Number.NaN);
  const normalizedRemainingTokens = Number.isFinite(rawRemainingTokens)
    ? Math.max(0, Math.round(rawRemainingTokens))
    : maxRemainingTokens;
  return {
    limitTokens,
    usedTokens,
    remainingTokens: Math.min(normalizedRemainingTokens, maxRemainingTokens),
    usedRequests: Math.max(0, Math.round(parseNumber(quota.usedRequests, 0))),
    remainingRequests: Math.max(0, Math.round(parseNumber(quota.remainingRequests, 0))),
    periodStart:
      typeof periodOverrides.periodStart === "string"
        ? periodOverrides.periodStart
        : typeof quota.periodStart === "string"
          ? quota.periodStart
          : null,
    periodEnd:
      typeof periodOverrides.periodEnd === "string"
        ? periodOverrides.periodEnd
        : typeof quota.periodEnd === "string"
          ? quota.periodEnd
          : null,
  };
};

const buildUsageFromAccess = (access) => {
  if (!access || typeof access !== "object") return null;
  const quota = access.quota && typeof access.quota === "object" ? access.quota : null;
  return {
    authenticated: Boolean(access.authenticated),
    plan: typeof access.plan === "string" ? access.plan : null,
    period: null,
    summary: normalizeQuotaSummary(quota, {
      periodStart: typeof access.periodStart === "string" ? access.periodStart : null,
      periodEnd: typeof access.periodEnd === "string" ? access.periodEnd : null,
    }),
    byFeature: null,
    errorCode: access.allowed ? null : access.reason ?? "FEATURE_NOT_ENABLED",
    message: typeof access.message === "string" ? access.message : null,
    fetchedAt:
      typeof access.fetchedAt === "number" && Number.isFinite(access.fetchedAt)
        ? access.fetchedAt
        : Date.now(),
  };
};

module.exports = { buildUsageFromAccess, normalizeQuotaSummary, parseNumber };

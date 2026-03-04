const { parseInteger, parseNumber } = require("./agent-core-utils.cjs");

const buildProgressMessage = (label) => {
  if (!label) {
    return "思考中...";
  }
  return `思考中: ${label}`;
};

const buildPlatformUsageFromQuota = (quota, plan, source = "chat") => {
  if (!quota || typeof quota !== "object") {
    return null;
  }
  const limitTokens = Math.max(0, parseInteger(quota.limitTokens, 0));
  const usedTokens = Math.max(0, parseInteger(quota.usedTokens, 0));
  const maxRemainingTokens = Math.max(0, limitTokens - usedTokens);
  const rawRemainingTokens = parseNumber(quota.remainingTokens, Number.NaN);
  const normalizedRemainingTokens = Number.isFinite(rawRemainingTokens)
    ? Math.max(0, Math.round(rawRemainingTokens))
    : maxRemainingTokens;
  return {
    source,
    usage: {
      authenticated: true,
      plan: typeof plan === "string" && plan ? plan : null,
      period: null,
      summary: {
        limitTokens,
        usedTokens,
        remainingTokens: Math.min(normalizedRemainingTokens, maxRemainingTokens),
        usedRequests: Math.max(0, parseInteger(quota.usedRequests, 0)),
        remainingRequests: Math.max(0, parseInteger(quota.remainingRequests, 0)),
        periodStart: typeof quota.periodStart === "string" ? quota.periodStart : null,
        periodEnd: typeof quota.periodEnd === "string" ? quota.periodEnd : null,
      },
      byFeature: null,
      errorCode: null,
      message: null,
      fetchedAt: Date.now(),
    },
  };
};

const extractUsageMetadata = (response) => {
  if (!response || typeof response !== "object") {
    return null;
  }
  const usage = response.usageMetadata ?? response.usage ?? null;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const promptTokenCount = parseInteger(
    usage.promptTokenCount ??
      usage.promptTokens ??
      usage.inputTokenCount ??
      usage.inputTokens ??
      usage.input_tokens,
    0
  );
  const candidatesTokenCount = parseInteger(
    usage.candidatesTokenCount ??
      usage.outputTokenCount ??
      usage.outputTokens ??
      usage.output_tokens,
    0
  );
  const totalTokenCount = parseInteger(
    usage.totalTokenCount ??
      usage.totalTokens ??
      usage.quotaConsumedTokens ??
      promptTokenCount + candidatesTokenCount,
    promptTokenCount + candidatesTokenCount
  );
  return {
    promptTokenCount: Math.max(0, promptTokenCount),
    candidatesTokenCount: Math.max(0, candidatesTokenCount),
    totalTokenCount: Math.max(0, totalTokenCount),
  };
};

const normalizeModelCandidate = (response) => {
  if (!response || typeof response !== "object") {
    return null;
  }
  const directCandidate = response?.candidates?.[0]?.content ?? null;
  if (directCandidate && Array.isArray(directCandidate.parts)) {
    return directCandidate;
  }
  const output = response.output && typeof response.output === "object" ? response.output : {};
  if (Array.isArray(output.parts) && output.parts.length > 0) {
    return { role: "model", parts: output.parts };
  }
  const text =
    typeof output.text === "string"
      ? output.text
      : typeof response.text === "string"
      ? response.text
      : "";
  if (text.trim()) {
    return { role: "model", parts: [{ text }] };
  }
  return null;
};

module.exports = {
  buildProgressMessage,
  buildPlatformUsageFromQuota,
  extractUsageMetadata,
  normalizeModelCandidate,
};

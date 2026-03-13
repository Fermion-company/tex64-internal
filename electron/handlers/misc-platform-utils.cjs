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

const normalizeOAuthPathname = (value) => {
  const pathname = typeof value === "string" && value ? value : "/";
  if (pathname === "/") {
    return "/";
  }
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
};

const isTex64OAuthCallbackUrl = (value) => {
  if (typeof value !== "string") {
    return false;
  }
  const raw = value.trim();
  if (!/^tex64:\/\//i.test(raw)) {
    return false;
  }
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = normalizeOAuthPathname(parsed.pathname || "/");
    if (hostname === "oauth" && pathname === "/callback") {
      return true;
    }
    if (!hostname && pathname === "/oauth/callback") {
      return true;
    }
    if (hostname === "account" && pathname === "/oauth/callback") {
      return true;
    }
    if (!hostname && pathname === "/account/oauth/callback") {
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

const normalizeQuotaSummary = (quota, periodOverrides = {}) => {
  if (!quota || typeof quota !== "object") {
    return null;
  }
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
  if (!access || typeof access !== "object") {
    return null;
  }
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

const buildUsageFromQuota = (quota, plan, source = "completion") => {
  if (!quota || typeof quota !== "object") {
    return null;
  }
  const summary = normalizeQuotaSummary(quota);
  return {
    source,
    usage: {
      authenticated: true,
      plan: typeof plan === "string" ? plan : null,
      period: null,
      summary,
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
  const promptTokens = parseNumber(
    usage.promptTokenCount ??
      usage.promptTokens ??
      usage.inputTokenCount ??
      usage.inputTokens ??
      usage.input_tokens,
    0
  );
  const outputTokens = parseNumber(
    usage.candidatesTokenCount ??
      usage.outputTokenCount ??
      usage.outputTokens ??
      usage.output_tokens,
    0
  );
  const totalTokens = parseNumber(
    usage.totalTokenCount ??
      usage.totalTokens ??
      usage.quotaConsumedTokens ??
      promptTokens + outputTokens,
    promptTokens + outputTokens
  );
  return {
    promptTokens,
    outputTokens,
    totalTokens,
  };
};

const buildAiBlockedMessage = (access) => {
  const reason = typeof access?.reason === "string" ? access.reason : "";
  const pricingUrl =
    typeof access?.pricingUrl === "string" && access.pricingUrl.trim()
      ? access.pricingUrl.trim()
      : "https://tex64.com/pricing";
  if (!access?.authenticated || reason === "AUTH_REQUIRED" || reason === "TOKEN_EXPIRED") {
    return "AI補完を使うには Google ログインが必要です。";
  }
  if (reason === "QUOTA_EXCEEDED") {
    return `今月のAIトークン上限に達しました。プラン変更: ${pricingUrl}`;
  }
  if (
    reason === "PLAN_REQUIRED" ||
    reason === "FEATURE_NOT_ENABLED" ||
    reason === "PAYMENT_PAST_DUE"
  ) {
    return `現在の契約状態ではAI機能を利用できません。プラン確認: ${pricingUrl}`;
  }
  return "AI補完を利用できません。";
};

const toErrorPayload = (error, fallbackCode = "PLATFORM_ERROR") => ({
  code: typeof error?.code === "string" && error.code ? error.code : fallbackCode,
  message:
    typeof error?.message === "string" && error.message
      ? error.message
      : "リクエスト処理に失敗しました。",
});

module.exports = {
  parseNumber,
  normalizeOAuthPathname,
  isTex64OAuthCallbackUrl,
  normalizeQuotaSummary,
  buildUsageFromAccess,
  buildUsageFromQuota,
  extractUsageMetadata,
  buildAiBlockedMessage,
  toErrorPayload,
};

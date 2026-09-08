const REQUEST_TOKEN_OVERHEAD = 2048;
const IMAGE_TOKEN_RESERVE = 32_000;
const MAX_COMPLETION_TOKENS_PER_REQUEST = 32_000;
const MIN_COMPLETION_TOKENS_PER_REQUEST = 256;
const DEFAULT_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;
const DEFAULT_LONG_CONTEXT_INPUT_MULTIPLIER = 2;
const DEFAULT_LONG_CONTEXT_OUTPUT_MULTIPLIER = 1.5;

const positiveNumber = (value, fallback) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const normalizeAiCostRates = (rates = {}) => {
  const blendedCostPerTokenUsd = positiveNumber(
    rates.blendedCostPerTokenUsd,
    0.000005,
  );
  const blendedUsdPerMillion = blendedCostPerTokenUsd * 1_000_000;
  const inputUsdPerMillion = positiveNumber(
    rates.inputUsdPerMillion,
    blendedUsdPerMillion,
  );
  return {
    blendedCostPerTokenUsd,
    inputUsdPerMillion,
    cachedInputUsdPerMillion: positiveNumber(
      rates.cachedInputUsdPerMillion,
      inputUsdPerMillion,
    ),
    cacheWriteUsdPerMillion: positiveNumber(
      rates.cacheWriteUsdPerMillion,
      inputUsdPerMillion * 1.25,
    ),
    outputUsdPerMillion: positiveNumber(
      rates.outputUsdPerMillion,
      blendedUsdPerMillion,
    ),
    longContextThresholdTokens: Math.floor(positiveNumber(
      rates.longContextThresholdTokens,
      DEFAULT_LONG_CONTEXT_THRESHOLD_TOKENS,
    )),
    longContextInputMultiplier: positiveNumber(
      rates.longContextInputMultiplier,
      DEFAULT_LONG_CONTEXT_INPUT_MULTIPLIER,
    ),
    longContextOutputMultiplier: positiveNumber(
      rates.longContextOutputMultiplier,
      DEFAULT_LONG_CONTEXT_OUTPUT_MULTIPLIER,
    ),
  };
};

export const costToDisplayedQuotaTokens = (costUsd, rawRates = {}) => {
  const rates = normalizeAiCostRates(rawRates);
  const normalizedCost = Number(costUsd);
  const ratio =
    (Number.isFinite(normalizedCost) && normalizedCost > 0
      ? normalizedCost
      : 0) / rates.blendedCostPerTokenUsd;
  // Fallback-state accounting uses IEEE-754 numbers. Remove only the tiny
  // arithmetic noise around an exact integer boundary so repeated additions
  // do not spuriously consume one extra visible token. PostgreSQL uses NUMERIC
  // and therefore reaches the same exact cumulative ceiling without this shim.
  const roundingNoise = Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8;
  return Math.max(
    0,
    Math.ceil(ratio - roundingNoise),
  );
};

/**
 * Convert real provider cost into the blended token units shown to users.
 * Dollar values and the input/output price split never leave this server.
 */
export const usageToCostUsd = (usage, rawRates = {}) => {
  const rates = normalizeAiCostRates(rawRates);
  const promptTokens =
    nonNegativeInteger(usage?.prompt_tokens) ??
    nonNegativeInteger(usage?.input_tokens) ??
    0;
  const completionTokens =
    nonNegativeInteger(usage?.completion_tokens) ??
    nonNegativeInteger(usage?.output_tokens) ??
    0;
  const promptDetails =
    usage?.prompt_tokens_details ?? usage?.input_tokens_details ?? {};
  const cachedTokens = Math.min(
    promptTokens,
    nonNegativeInteger(promptDetails?.cached_tokens) ?? 0,
  );
  const reportedCacheWriteTokens = nonNegativeInteger(
    promptDetails?.cache_write_tokens,
  );
  // Current provider usage distinguishes cache writes. Older/partial usage
  // payloads may not; in that case price every non-cached input token at the
  // higher cache-write rate so missing detail can never understate cost.
  const cacheWriteTokens = Math.min(
    promptTokens - cachedTokens,
    reportedCacheWriteTokens ?? promptTokens - cachedTokens,
  );
  const uncachedTokens = promptTokens - cachedTokens - cacheWriteTokens;
  const usesLongContext = promptTokens > rates.longContextThresholdTokens;
  const inputMultiplier = usesLongContext
    ? rates.longContextInputMultiplier
    : 1;
  const outputMultiplier = usesLongContext
    ? rates.longContextOutputMultiplier
    : 1;
  return (
    (inputMultiplier *
      (uncachedTokens * rates.inputUsdPerMillion +
        cachedTokens * rates.cachedInputUsdPerMillion +
        cacheWriteTokens * rates.cacheWriteUsdPerMillion) +
      outputMultiplier * completionTokens * rates.outputUsdPerMillion) /
    1_000_000
  );
};

/**
 * Convert one provider usage payload for admission/network-abuse accounting.
 * Persistent account usage stores cumulative cost and performs the ceiling once
 * over that cumulative value; callers must not add this request-level ceiling
 * to an account counter.
 */
export const usageToQuotaTokens = (usage, rawRates = {}) =>
  costToDisplayedQuotaTokens(usageToCostUsd(usage, rawRates), rawRates);

const nonNegativeInteger = (value) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
};

export const hasCompleteProviderUsage = (usage) => {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return false;
  }
  const promptTokens =
    nonNegativeInteger(usage.prompt_tokens) ??
    nonNegativeInteger(usage.input_tokens);
  const completionTokens =
    nonNegativeInteger(usage.completion_tokens) ??
    nonNegativeInteger(usage.output_tokens);
  return promptTokens !== null && completionTokens !== null;
};

const sanitizeForEstimate = (value, state) => {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForEstimate(entry, state));
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^data:image\//i.test(value)) {
      state.images += 1;
      return "[image data]";
    }
    return value;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      key === "model" ||
      key === "max_tokens" ||
      key === "max_completion_tokens" ||
      key === "stream_options"
    ) {
      continue;
    }
    result[key] = sanitizeForEstimate(entry, state);
  }
  return result;
};

/**
 * Tokenizer-independent request-input ceiling. Each text token consumes at
 * least one UTF-8 byte; the fixed reserve covers provider message/tool framing.
 * Image data bytes are replaced by a conservative vision-token reserve.
 */
export const estimateChatInputTokenUpperBound = (body) => {
  const state = { images: 0 };
  const sanitized = sanitizeForEstimate(body, state);
  return (
    Buffer.byteLength(JSON.stringify(sanitized), "utf8") +
    REQUEST_TOKEN_OVERHEAD +
    state.images * IMAGE_TOKEN_RESERVE
  );
};

/**
 * Bound the provider's completion before any paid request. Since the input
 * ceiling plus max_completion_tokens cannot exceed the current allowance, one
 * call cannot knowingly cross the account budget. Actual usage is reconciled
 * after the response; reservedTokens is the fail-closed charge if a provider
 * omits usage metadata.
 */
export const buildQuotaBoundedChatRequest = ({
  body,
  upstreamModel,
  remainingTokens,
  costRates,
}) => {
  const rates = normalizeAiCostRates(costRates);
  const remaining = nonNegativeInteger(remainingTokens) ?? 0;
  const rawInputTokenUpperBound = estimateChatInputTokenUpperBound(body);
  const usesLongContext =
    rawInputTokenUpperBound > rates.longContextThresholdTokens;
  const inputPriceUpperBound =
    rates.cacheWriteUsdPerMillion *
    (usesLongContext ? rates.longContextInputMultiplier : 1);
  const outputPriceUpperBound =
    rates.outputUsdPerMillion *
    (usesLongContext ? rates.longContextOutputMultiplier : 1);
  const inputTokenUpperBound = costToDisplayedQuotaTokens(
    (rawInputTokenUpperBound * inputPriceUpperBound) / 1_000_000,
    rates,
  );
  const availableOutputQuota = remaining - inputTokenUpperBound;
  const availableForCompletion = Math.floor(
    (availableOutputQuota * rates.blendedCostPerTokenUsd * 1_000_000) /
      outputPriceUpperBound,
  );
  if (availableForCompletion < MIN_COMPLETION_TOKENS_PER_REQUEST) {
    return {
      allowed: false,
      inputTokenUpperBound,
      maxCompletionTokens: 0,
      reservedTokens: 0,
      body: null,
    };
  }

  const requested =
    nonNegativeInteger(body?.max_completion_tokens) ??
    nonNegativeInteger(body?.max_tokens) ??
    MAX_COMPLETION_TOKENS_PER_REQUEST;
  const maxCompletionTokens = Math.max(
    MIN_COMPLETION_TOKENS_PER_REQUEST,
    Math.min(
      requested || MIN_COMPLETION_TOKENS_PER_REQUEST,
      MAX_COMPLETION_TOKENS_PER_REQUEST,
      availableForCompletion,
    ),
  );
  const upstreamBody = {
    ...body,
    model: upstreamModel,
    // This proxy serves one product-agent continuation. Multiple choices and
    // paid hosted tools/service tiers have different cost dimensions that are
    // not part of the product's token-only quota contract.
    n: 1,
    max_completion_tokens: maxCompletionTokens,
    ...(body?.stream === true
      ? {
          stream_options: {
            ...(body?.stream_options && typeof body.stream_options === "object"
              ? body.stream_options
              : {}),
            include_usage: true,
          },
        }
      : {}),
  };
  delete upstreamBody.max_tokens;
  delete upstreamBody.service_tier;
  delete upstreamBody.web_search_options;
  delete upstreamBody.modalities;
  delete upstreamBody.audio;
  delete upstreamBody.prompt_cache_retention;
  if (Array.isArray(upstreamBody.tools)) {
    upstreamBody.tools = upstreamBody.tools.filter(
      (tool) => tool?.type === "function",
    );
  }

  return {
    allowed: true,
    inputTokenUpperBound,
    maxCompletionTokens,
    reservedTokens:
      inputTokenUpperBound +
      costToDisplayedQuotaTokens(
        (maxCompletionTokens * outputPriceUpperBound) / 1_000_000,
        rates,
      ),
    body: upstreamBody,
  };
};

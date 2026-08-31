import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQuotaBoundedChatRequest,
  costToDisplayedQuotaTokens,
  estimateChatInputTokenUpperBound,
  hasCompleteProviderUsage,
  usageToCostUsd,
  usageToQuotaTokens,
} from "../api/v2/_lib/ai-request-budget.js";

test("proxy request forces usage reporting and cannot reserve beyond remaining quota", () => {
  const body = {
    model: "Axiom1.0",
    messages: [{ role: "user", content: "write a theorem" }],
    tools: [],
    stream: true,
    stream_options: { include_usage: false },
    max_tokens: 1_000_000,
    n: 9,
    service_tier: "priority",
    web_search_options: { search_context_size: "high" },
    modalities: ["text", "audio"],
    audio: { format: "wav", voice: "alloy" },
  };
  const inputUpperBound = estimateChatInputTokenUpperBound(body);
  const bounded = buildQuotaBoundedChatRequest({
    body,
    upstreamModel: "provider/private-model",
    remainingTokens: inputUpperBound + 2_000,
    costRates: {
      blendedCostPerTokenUsd: 0.000005,
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 5,
      cacheWriteUsdPerMillion: 5,
      outputUsdPerMillion: 5,
    },
  });

  assert.equal(bounded.allowed, true);
  assert.equal(bounded.maxCompletionTokens, 2_000);
  assert.equal(bounded.body.model, "provider/private-model");
  assert.equal(bounded.body.stream_options.include_usage, true);
  assert.equal(Object.hasOwn(bounded.body, "max_tokens"), false);
  assert.equal(bounded.body.max_completion_tokens, 2_000);
  assert.equal(bounded.body.n, 1);
  assert.equal(Object.hasOwn(bounded.body, "service_tier"), false);
  assert.equal(Object.hasOwn(bounded.body, "web_search_options"), false);
  assert.equal(Object.hasOwn(bounded.body, "modalities"), false);
  assert.equal(Object.hasOwn(bounded.body, "audio"), false);
  assert.ok(bounded.reservedTokens <= inputUpperBound + 2_000);
});

test("proxy rejects before provider when request input cannot fit", () => {
  const body = {
    messages: [{ role: "user", content: "x".repeat(10_000) }],
    stream: true,
  };
  const inputUpperBound = estimateChatInputTokenUpperBound(body);
  const bounded = buildQuotaBoundedChatRequest({
    body,
    upstreamModel: "provider/private-model",
    remainingTokens: inputUpperBound,
  });
  assert.equal(bounded.allowed, false);
  assert.equal(bounded.body, null);
});

test("real input/output cost is converted to user-facing blended token units", () => {
  const quotaTokens = usageToQuotaTokens(
    {
      prompt_tokens: 1_000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 },
    },
    {
      blendedCostPerTokenUsd: 0.000005,
      inputUsdPerMillion: 10,
      cachedInputUsdPerMillion: 2,
      outputUsdPerMillion: 30,
    },
  );
  // (800*10 + 200*2 + 500*30) / 1e6 = $0.0234; / $0.000005 = 4,680.
  assert.equal(quotaTokens, 4_680);

  assert.equal(
    usageToQuotaTokens(
      { prompt_tokens: 1_000, completion_tokens: 0 },
      {
        blendedCostPerTokenUsd: 0.000005,
        inputUsdPerMillion: 10,
        cacheWriteUsdPerMillion: 12.5,
        outputUsdPerMillion: 30,
      },
    ),
    2_500,
    "missing cache-write detail is priced at the conservative input rate",
  );

  const body = {
    messages: [{ role: "user", content: "short" }],
    stream: true,
  };
  const bounded = buildQuotaBoundedChatRequest({
    body,
    upstreamModel: "provider/private-model",
    remainingTokens: 20_000,
    costRates: {
      blendedCostPerTokenUsd: 0.000005,
      inputUsdPerMillion: 10,
      outputUsdPerMillion: 20,
    },
  });
  assert.equal(bounded.allowed, true);
  assert.ok(bounded.reservedTokens <= 20_000);
});

test("cache writes and long-context multipliers are charged at provider cost", () => {
  const quotaTokens = usageToQuotaTokens(
    {
      prompt_tokens: 300_000,
      completion_tokens: 1_000,
      prompt_tokens_details: {
        cached_tokens: 100_000,
        cache_write_tokens: 50_000,
      },
    },
    {
      blendedCostPerTokenUsd: 0.000005,
      inputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 0.2,
      cacheWriteUsdPerMillion: 2.5,
      outputUsdPerMillion: 12,
      longContextThresholdTokens: 272_000,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
    },
  );
  // Input: (150k*2 + 100k*0.2 + 50k*2.5) * 2 = $0.89.
  // Output: 1k*12*1.5 = $0.018. Total $0.908 / $0.000005.
  assert.equal(quotaTokens, 181_600);
});

test("provider usage exposes an unrounded internal cost for cumulative accounting", () => {
  const rates = {
    blendedCostPerTokenUsd: 0.000005,
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    cacheWriteUsdPerMillion: 0.25,
    outputUsdPerMillion: 1,
  };
  const usage = {
    prompt_tokens: 1,
    completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  };
  const cost = usageToCostUsd(usage, rates);
  assert.ok(cost > 0);
  assert.ok(cost < rates.blendedCostPerTokenUsd);
  assert.equal(usageToQuotaTokens(usage, rates), 1);
  assert.equal(
    Math.ceil((cost + cost) / rates.blendedCostPerTokenUsd),
    1,
    "two sub-token costs must be ceiled once after accumulation",
  );
  const repeatedBoundary = Array.from({ length: 10 }, () =>
    rates.blendedCostPerTokenUsd / 10,
  ).reduce((sum, entry) => sum + entry, 0);
  assert.equal(
    costToDisplayedQuotaTokens(repeatedBoundary, rates),
    1,
    "floating-point accumulation at an exact boundary must not add a token",
  );
});

test("only complete provider usage is eligible for measured-cost reconciliation", () => {
  assert.equal(
    hasCompleteProviderUsage({ prompt_tokens: 0, completion_tokens: 0 }),
    true,
  );
  assert.equal(hasCompleteProviderUsage({}), false);
  assert.equal(hasCompleteProviderUsage({ prompt_tokens: 10 }), false);
  assert.equal(
    hasCompleteProviderUsage({ input_tokens: 10, output_tokens: 2 }),
    true,
  );
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getAnonymousAppUser,
  isValidDeviceId,
} from "../api/v2/_lib/auth.js";
import {
  ensurePlatformSchema,
  incrementUsageRecordForUserPeriod,
  reconcileUsageReservationForUserPeriod,
  reserveUsageRecordForUserPeriod,
  upsertUsageRecordForUserPeriod,
} from "../api/v2/_lib/db-adapter.js";
import {
  clearRuntimeConfigCache,
  getRuntimeConfig,
} from "../api/v2/_lib/runtime-config.js";
import {
  buildUsageBreakdown,
  consumeQuota,
  ensureUsageRecord,
  reconcileQuotaReservation,
  tryReserveQuota,
} from "../api/v2/_lib/subscription-domain.js";
import completionsHandler from "../api/v2/ai/openai/chat/completions.js";
import featuresHandler from "../api/v2/me/features.js";
import usageHandler from "../api/v2/me/usage/ai.js";

const DEVICE_ID = "550e8400-e29b-41d4-a716-446655440000";

const withEnvironment = async (values, callback) => {
  const names = Object.keys(values);
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearRuntimeConfigCache();
  try {
    return await callback();
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    clearRuntimeConfigCache();
  }
};

const createResponseRecorder = () => {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    write(value) {
      chunks.push(Buffer.from(value));
    },
    end(value) {
      if (value !== undefined) chunks.push(Buffer.from(value));
      this.ended = true;
    },
    json() {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    },
  };
};

const callGet = async (handler, url, headers) => {
  const response = createResponseRecorder();
  await handler({ method: "GET", url, headers }, response);
  return response;
};

test("unexpected provider overage is still recorded in full", () => {
  const usage = {
    limitTokens: 100,
    usedTokens: 90,
    limitRequests: 10,
    usedRequests: 2,
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    byFeature: {
      chat: { usedTokens: 90, usedRequests: 2 },
      completion: { usedTokens: 0, usedRequests: 0 },
    },
  };

  const quota = consumeQuota(usage, "chat", 100, 1);

  assert.equal(quota.usedTokens, 190);
  assert.equal(quota.remainingTokens, 0);
  assert.equal(quota.usedRequests, 3);
  assert.deepEqual(usage.byFeature.chat, {
    usedTokens: 190,
    usedRequests: 3,
    legacyUsedTokens: 190,
    usedCostUsd: 0,
  });
});

test("quota reservation is fail-before-mutation and reconciles to actual usage", () => {
  const usage = {
    limitTokens: 100,
    usedTokens: 0,
    limitRequests: 10,
    usedRequests: 0,
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    byFeature: {
      chat: { usedTokens: 0, usedRequests: 0 },
      completion: { usedTokens: 0, usedRequests: 0 },
    },
  };
  assert.ok(tryReserveQuota(usage, "chat", 70, 1));
  assert.equal(tryReserveQuota(usage, "chat", 40, 1), null);
  assert.equal(usage.usedTokens, 70, "a refused reservation does not mutate counters");
  const reconciled = reconcileQuotaReservation(usage, "chat", 70, 20);
  assert.equal(reconciled.usedTokens, 20);
  assert.equal(reconciled.usedRequests, 1);
  assert.equal(usage.byFeature.chat.usedTokens, 20);
  assert.equal(usage.byFeature.chat.usedRequests, 1);
});

test("legacy floor migration preserves mixed raw-token and cumulative-cost usage", () => {
  const rate = 0.000005;
  const state = {
    usage: {
      usr_mixed: {
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        limitTokens: 1_000,
        limitRequests: 100,
        usedTokens: 100,
        usedRequests: 3,
        usedCostUsd: rate * 20,
        byFeature: {
          chat: {
            usedTokens: 100,
            usedRequests: 3,
            usedCostUsd: rate * 20,
          },
          completion: { usedTokens: 0, usedRequests: 0 },
        },
      },
    },
  };
  const subscription = {
    quotaPeriodStart: "2026-08-01T00:00:00.000Z",
    quotaPeriodEnd: "2026-09-01T00:00:00.000Z",
    quotaLimitTokens: 1_000,
    quotaLimitRequests: 100,
  };

  const first = ensureUsageRecord(state, "usr_mixed", subscription, {
    blendedCostPerTokenUsd: rate,
  }).usage;
  assert.equal(first.costAccountingVersion, 1);
  assert.equal(first.legacyUsedTokens, 80);
  assert.equal(first.usedTokens, 100, "first GET/ensure cannot lower old usage");
  assert.equal(first.byFeature.chat.legacyUsedTokens, 80);

  const second = ensureUsageRecord(state, "usr_mixed", subscription, {
    blendedCostPerTokenUsd: rate,
  }).usage;
  assert.equal(second.legacyUsedTokens, 80);
  assert.equal(second.usedTokens, 100);
  assert.deepEqual(buildUsageBreakdown(second).chat, {
    usedTokens: 100,
    usedRequests: 3,
  });
  assert.equal("usedCostUsd" in buildUsageBreakdown(second).chat, false);
  assert.equal("legacyUsedTokens" in buildUsageBreakdown(second).chat, false);
});

test("parallel measured reconciliations ceil cumulative cost once and retain reservations", () => {
  const rate = 0.000005;
  const usage = {
    limitTokens: 1_000,
    usedTokens: 100,
    limitRequests: 100,
    usedRequests: 0,
    costAccountingVersion: 1,
    legacyUsedTokens: 100,
    usedCostUsd: 0,
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    byFeature: {
      chat: {
        usedTokens: 100,
        usedRequests: 0,
        legacyUsedTokens: 100,
        usedCostUsd: 0,
      },
      completion: {
        usedTokens: 0,
        usedRequests: 0,
        legacyUsedTokens: 0,
        usedCostUsd: 0,
      },
    },
  };
  assert.ok(tryReserveQuota(usage, "chat", 10, 1));
  assert.ok(tryReserveQuota(usage, "chat", 10, 1));
  assert.equal(usage.usedTokens, 120);

  reconcileQuotaReservation(usage, "chat", 10, 1, {
    actualCostUsd: rate * 0.4,
    blendedCostPerTokenUsd: rate,
  });
  assert.equal(usage.usedTokens, 111, "the other reservation remains admitted");

  reconcileQuotaReservation(usage, "chat", 10, 1, {
    actualCostUsd: rate * 0.4,
    blendedCostPerTokenUsd: rate,
  });
  assert.equal(usage.usedTokens, 101);
  assert.equal(usage.byFeature.chat.usedTokens, 101);
  assert.equal(usage.legacyUsedTokens, 100);
  assert.equal(usage.byFeature.chat.legacyUsedTokens, 100);
  assert.equal(usage.usedRequests, 2);
  assert.equal(usage.byFeature.chat.usedRequests, 2);
});

test("unmeasured fail-closed reconciliation commits raw units into the legacy floor", () => {
  const usage = {
    limitTokens: 1_000,
    usedTokens: 40,
    limitRequests: 10,
    usedRequests: 0,
    costAccountingVersion: 1,
    legacyUsedTokens: 40,
    usedCostUsd: 0,
    byFeature: {
      chat: {
        usedTokens: 40,
        usedRequests: 0,
        legacyUsedTokens: 40,
        usedCostUsd: 0,
      },
      completion: { usedTokens: 0, usedRequests: 0 },
    },
  };
  assert.ok(tryReserveQuota(usage, "chat", 30, 1));
  reconcileQuotaReservation(usage, "chat", 30, 30);
  assert.equal(usage.usedTokens, 70);
  assert.equal(usage.legacyUsedTokens, 70);
  assert.equal(usage.byFeature.chat.legacyUsedTokens, 70);
});

test("anonymous app ids are validated and mapped to server-secret pseudonyms", () => {
  assert.equal(isValidDeviceId(DEVICE_ID), true);
  assert.equal(isValidDeviceId("../../etc/passwd"), false);
  const req = { headers: { "x-tex64-device-id": DEVICE_ID } };
  const first = getAnonymousAppUser(req, { jwtSecret: "server-secret-a" });
  const repeat = getAnonymousAppUser(req, { jwtSecret: "server-secret-a" });
  const otherSecret = getAnonymousAppUser(req, { jwtSecret: "server-secret-b" });

  assert.equal(first.ok, true);
  assert.equal(first.user.id, repeat.user.id);
  assert.match(first.user.id, /^anon_[a-f0-9]{40}$/);
  assert.notEqual(first.user.id, DEVICE_ID);
  assert.notEqual(first.user.id, otherSecret.user.id);
  assert.equal(
    getAnonymousAppUser({ headers: {} }, { jwtSecret: "server-secret-a" }).reason,
    "MISSING_DEVICE_ID"
  );
});

test("anonymous endpoints fail closed without a canonical valid device identity", async () => {
  await withEnvironment(
    {
      NODE_ENV: "development",
      TEX64_PLATFORM_ALLOW_DEV_AUTH: "false",
      TEX64_PLATFORM_JWT_SECRET: "anonymous-validation-secret",
    },
    async () => {
      const missing = await callGet(
        featuresHandler,
        "/api/v2/me/features?names=ai",
        {}
      );
      assert.equal(missing.statusCode, 401);
      assert.equal(missing.json().error.code, "AUTH_REQUIRED");

      const invalid = await callGet(
        featuresHandler,
        "/api/v2/me/features?names=ai",
        { "X-Tex64-Device-Id": "../../etc/passwd" }
      );
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
    }
  );
});

test("chat proxy rejects an unaffordable request before contacting the provider", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-preflight-quota-"));
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("provider must not be contacted");
  };
  try {
    await withEnvironment(
      {
        NODE_ENV: "development",
        TEX64_PLATFORM_ALLOW_DEV_AUTH: "false",
        TEX64_PLATFORM_STATE_FALLBACK: "true",
        TEX64_PLATFORM_STATE_FILE: path.join(temporaryDirectory, "state.json"),
        TEX64_PLATFORM_JWT_SECRET: "preflight-integration-secret",
        TEX64_PLATFORM_FREE_MONTHLY_TOKENS: "100",
        TEX64_PLATFORM_REQUEST_LIMIT_FREE: "10",
        OPENAI_API_KEY: "test-only-key",
      },
      async () => {
        const response = createResponseRecorder();
        await completionsHandler(
          {
            method: "POST",
            headers: { "x-tex64-device-id": DEVICE_ID },
            body: {
              model: "Axiom1.0",
              messages: [{ role: "user", content: "hello" }],
              stream: true,
            },
          },
          response,
        );
        assert.equal(response.statusCode, 429);
        assert.equal(response.json().error.code, "QUOTA_EXCEEDED");
        assert.equal(providerCalls, 0);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("anonymous desktop feature and chat requests share a lifetime quota", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-anon-quota-"));
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(
      [
        'data: {"id":"chatcmpl_anonymous","model":"provider/private-standard","choices":[{"delta":{"content":"ok"}}]}',
        "",
        'data: {"id":"chatcmpl_anonymous","model":"provider/private-standard","choices":[],"usage":{"prompt_tokens":60,"completion_tokens":40,"total_tokens":100,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0}}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  };
  try {
    await withEnvironment(
      {
        NODE_ENV: "development",
        TEX64_PLATFORM_ALLOW_DEV_AUTH: "false",
        TEX64_PLATFORM_STATE_FALLBACK: "true",
        TEX64_PLATFORM_STATE_FILE: path.join(temporaryDirectory, "state.json"),
        TEX64_PLATFORM_JWT_SECRET: "anonymous-integration-secret",
        TEX64_PLATFORM_FREE_MONTHLY_TOKENS: "10000",
        TEX64_PLATFORM_REQUEST_LIMIT_FREE: "10",
        OPENAI_API_KEY: "test-only-key",
        TEX64_LLM_AXIOM_100_UPSTREAM: "provider/private-standard",
      },
      async () => {
        const headers = { "x-tex64-device-id": DEVICE_ID };
        const before = await callGet(
          featuresHandler,
          "/api/v2/me/features?names=ai",
          headers
        );
        assert.equal(before.statusCode, 200);
        const beforePayload = before.json();
        assert.equal(beforePayload.user.anonymous, true);
        assert.equal(beforePayload.user.email, null);
        assert.equal(beforePayload.features.ai.enabled, true);
        assert.equal(beforePayload.features.ai.quota.remainingTokens, 10000);
        assert.equal(beforePayload.features.ai.periodStart, "1970-01-01T00:00:00.000Z");

        const chatResponse = createResponseRecorder();
        await completionsHandler(
          {
            method: "POST",
            headers,
            body: {
              model: "Axiom1.0",
              messages: [{ role: "user", content: "hello" }],
              stream: true,
              stream_options: { include_usage: true },
            },
          },
          chatResponse
        );
        assert.equal(chatResponse.statusCode, 200);
        assert.equal(providerCalls, 1);

        const after = await callGet(
          featuresHandler,
          "/api/v2/me/features?names=ai",
          headers
        );
        assert.equal(after.statusCode, 200);
        const afterPayload = after.json();
        assert.equal(afterPayload.features.ai.enabled, true);
        assert.equal(afterPayload.features.ai.reason, "active");
        assert.equal(afterPayload.features.ai.quota.usedTokens, 12);
        assert.equal(afterPayload.features.ai.quota.remainingTokens, 9988);
        assert.equal(afterPayload.features.ai.quota.usedRequests, 1);

        const usage = await callGet(
          usageHandler,
          "/api/v2/me/usage/ai?period=current_month",
          headers
        );
        assert.equal(usage.statusCode, 200);
        const usagePayload = usage.json();
        assert.equal(usagePayload.period, "anonymous_lifetime");
        assert.equal(usagePayload.summary.usedTokens, 12);
        assert.equal(usagePayload.summary.remainingTokens, 9988);
        assert.deepEqual(usagePayload.byFeature.chat, {
          usedTokens: 12,
          usedRequests: 1,
        });
        assert.doesNotMatch(
          JSON.stringify(usagePayload),
          /(?:cost|legacyUsedTokens|costAccountingVersion)/i,
          "internal accounting fields never enter the token-only API",
        );
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("streaming without provider usage consumes the reserved amount instead of becoming free", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-missing-usage-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      [
        'data: {"id":"chatcmpl_missing_usage","choices":[{"delta":{"content":"ok"}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  try {
    await withEnvironment(
      {
        NODE_ENV: "development",
        TEX64_PLATFORM_ALLOW_DEV_AUTH: "false",
        TEX64_PLATFORM_STATE_FALLBACK: "true",
        TEX64_PLATFORM_STATE_FILE: path.join(temporaryDirectory, "state.json"),
        TEX64_PLATFORM_JWT_SECRET: "missing-usage-integration-secret",
        TEX64_PLATFORM_FREE_MONTHLY_TOKENS: "10000",
        TEX64_PLATFORM_REQUEST_LIMIT_FREE: "10",
        OPENAI_API_KEY: "test-only-key",
      },
      async () => {
        const headers = { "x-tex64-device-id": DEVICE_ID };
        const response = createResponseRecorder();
        await completionsHandler(
          {
            method: "POST",
            headers,
            body: {
              model: "Axiom1.0",
              messages: [{ role: "user", content: "hello" }],
              stream: true,
              stream_options: { include_usage: false },
            },
          },
          response,
        );
        assert.equal(response.statusCode, 200);

        const usage = await callGet(
          usageHandler,
          "/api/v2/me/usage/ai?period=current_month",
          headers,
        );
        const summary = usage.json().summary;
        assert.ok(summary.usedTokens > 0);
        assert.ok(summary.remainingTokens < 10000);
        assert.equal(summary.usedTokens + summary.remainingTokens, 10000);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("parallel requests cannot reserve the same remaining allowance twice", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-parallel-reserve-"));
  const originalFetch = globalThis.fetch;
  let releaseProvider;
  const providerReleasePromise = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  let markProviderStarted;
  const providerStartedPromise = new Promise((resolve) => {
    markProviderStarted = resolve;
  });
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    markProviderStarted();
    await providerReleasePromise;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_reserved",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 100,
          total_tokens: 200,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    await withEnvironment(
      {
        NODE_ENV: "development",
        TEX64_PLATFORM_ALLOW_DEV_AUTH: "false",
        TEX64_PLATFORM_STATE_FALLBACK: "true",
        TEX64_PLATFORM_STATE_FILE: path.join(temporaryDirectory, "state.json"),
        TEX64_PLATFORM_JWT_SECRET: "parallel-reserve-secret",
        // One 256-token completion reservation is 168 blended quota tokens
        // for this fixture. Keep the allowance above one reservation but
        // below two so the concurrent request must fail before fetch.
        TEX64_PLATFORM_FREE_MONTHLY_TOKENS: "300",
        TEX64_PLATFORM_REQUEST_LIMIT_FREE: "10",
        OPENAI_API_KEY: "test-only-key",
      },
      async () => {
        const headers = { "x-tex64-device-id": DEVICE_ID };
        const invoke = async (content) => {
          const response = createResponseRecorder();
          await completionsHandler(
            {
              method: "POST",
              headers,
              body: {
                model: "Axiom1.0",
                messages: [{ role: "user", content }],
                stream: false,
                max_completion_tokens: 256,
              },
            },
            response,
          );
          return response;
        };

        let firstPromise = null;
        try {
          firstPromise = invoke("first");
          let providerTimeout = null;
          try {
            await Promise.race([
              providerStartedPromise,
              new Promise((_, reject) => {
                providerTimeout = setTimeout(
                  () => reject(new Error("provider admission timed out")),
                  2_000,
                );
              }),
            ]);
          } finally {
            if (providerTimeout) clearTimeout(providerTimeout);
          }
          assert.equal(providerCalls, 1, "the first reserved request reaches the provider");
          const second = await invoke("second");
          assert.equal(second.statusCode, 429);
          assert.equal(second.json().error.code, "QUOTA_EXCEEDED");
          assert.equal(providerCalls, 1);
          releaseProvider();
          const first = await firstPromise;
          firstPromise = null;
          assert.equal(first.statusCode, 200);
        } finally {
          releaseProvider();
          if (firstPromise) await firstPromise.catch(() => null);
        }
      },
    );
  } finally {
    releaseProvider?.();
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

test("parallel fallback chat commits retain both usage deltas", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-parallel-quota-"));
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    const callNumber = call;
    const tokens = callNumber === 1 ? 100 : 200;
    await new Promise((resolve) => setImmediate(resolve));
    return new Response(
      JSON.stringify({
        id: `chatcmpl_${callNumber}`,
        model: "provider/private-standard",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: {
          prompt_tokens: tokens,
          completion_tokens: 0,
          total_tokens: tokens,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    await withEnvironment(
      {
        NODE_ENV: "development",
        TEX64_PLATFORM_ALLOW_DEV_AUTH: "false",
        TEX64_PLATFORM_STATE_FALLBACK: "true",
        TEX64_PLATFORM_STATE_FILE: path.join(temporaryDirectory, "state.json"),
        TEX64_PLATFORM_JWT_SECRET: "parallel-integration-secret",
        TEX64_PLATFORM_FREE_MONTHLY_TOKENS: "10000",
        TEX64_PLATFORM_REQUEST_LIMIT_FREE: "10",
        OPENAI_API_KEY: "test-only-key",
        TEX64_LLM_AXIOM_100_UPSTREAM: "provider/private-standard",
      },
      async () => {
        const headers = { "x-tex64-device-id": DEVICE_ID };
        const invoke = async (content) => {
          const response = createResponseRecorder();
          await completionsHandler(
            {
              method: "POST",
              headers,
              body: {
                model: "Axiom1.0",
                messages: [{ role: "user", content }],
                stream: false,
                max_completion_tokens: 100,
              },
            },
            response
          );
          assert.equal(response.statusCode, 200);
        };
        await Promise.all([invoke("first"), invoke("second")]);

        const usage = await callGet(
          usageHandler,
          "/api/v2/me/usage/ai?period=current_month",
          headers
        );
        assert.equal(usage.statusCode, 200);
        const payload = usage.json();
        assert.equal(payload.summary.usedTokens, 12);
        assert.equal(payload.summary.usedRequests, 2);
        assert.equal(payload.byFeature.chat.usedTokens, 12);
        assert.equal(payload.byFeature.chat.usedRequests, 2);
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("database usage writes add concurrent deltas and initialization cannot overwrite counters", async () => {
  const databaseUrl = "postgres://tex64.test/atomic-usage";
  const config = { databaseUrl, databaseSsl: false };
  const poolKey = JSON.stringify({ databaseUrl, databaseSsl: false });
  const periodStart = "2026-08-01T00:00:00.000Z";
  const periodEnd = "2026-09-01T00:00:00.000Z";
  const row = {
    user_id: "usr_atomic",
    period_start: periodStart,
    period_end: periodEnd,
    limit_tokens: 1_000,
    limit_requests: 100,
    used_tokens: 0,
    used_requests: 0,
    cost_accounting_version: 1,
    legacy_used_tokens: 0,
    used_cost_usd: 0,
    chat_used_tokens: 0,
    chat_used_requests: 0,
    chat_legacy_used_tokens: 0,
    chat_used_cost_usd: 0,
    completion_used_tokens: 0,
    completion_used_requests: 0,
    completion_legacy_used_tokens: 0,
    completion_used_cost_usd: 0,
    created_at: periodStart,
    updated_at: periodStart,
  };
  const statements = [];
  const fakePool = {
    async query(sql, values) {
      statements.push(sql);
      await new Promise((resolve) => setImmediate(resolve));
      if (sql.includes("tex64_usage.used_tokens + EXCLUDED.used_tokens")) {
        row.used_tokens += values[5];
        row.used_requests += values[6];
        row.legacy_used_tokens += values[5];
        row.chat_used_tokens += values[7];
        row.chat_used_requests += values[8];
        row.chat_legacy_used_tokens += values[7];
        row.completion_used_tokens += values[9];
        row.completion_used_requests += values[10];
        row.completion_legacy_used_tokens += values[9];
      } else {
        assert.doesNotMatch(
          sql,
          /DO UPDATE SET[\s\S]*used_tokens\s*=\s*EXCLUDED\.used_tokens/
        );
        row.limit_tokens = values[3];
        row.limit_requests = values[4];
      }
      return { rows: [{ ...row }], rowCount: 1 };
    },
  };
  globalThis.__TEX64_V2_PG_POOL_MAP__ = new Map([[poolKey, fakePool]]);
  globalThis.__TEX64_V2_PG_SCHEMA_MAP__ = new Map([[poolKey, Promise.resolve(true)]]);
  try {
    await upsertUsageRecordForUserPeriod(config, {
      userId: row.user_id,
      periodStart,
      periodEnd,
      limitTokens: 1_000,
      limitRequests: 100,
      usedTokens: 999,
      usedRequests: 99,
      byFeature: { chat: { usedTokens: 999, usedRequests: 99 } },
    });
    assert.equal(row.used_tokens, 0);
    assert.equal(row.used_requests, 0);

    await Promise.all([
      incrementUsageRecordForUserPeriod(config, {
        userId: row.user_id,
        periodStart,
        periodEnd,
        limitTokens: 1_000,
        limitRequests: 100,
        featureName: "chat",
        consumedTokens: 100,
        consumedRequests: 1,
      }),
      incrementUsageRecordForUserPeriod(config, {
        userId: row.user_id,
        periodStart,
        periodEnd,
        limitTokens: 1_000,
        limitRequests: 100,
        featureName: "chat",
        consumedTokens: 200,
        consumedRequests: 1,
      }),
    ]);

    assert.equal(row.used_tokens, 300);
    assert.equal(row.used_requests, 2);
    assert.equal(row.chat_used_tokens, 300);
    assert.equal(row.chat_used_requests, 2);
    assert.equal(row.legacy_used_tokens, 300);
    assert.equal(row.chat_legacy_used_tokens, 300);
    await upsertUsageRecordForUserPeriod(config, {
      userId: row.user_id,
      periodStart,
      periodEnd,
      limitTokens: 100,
      limitRequests: 3,
      usedTokens: 0,
      usedRequests: 0,
      byFeature: { chat: { usedTokens: 0, usedRequests: 0 } },
    });
    assert.equal(row.limit_tokens, 100, "an entitlement downgrade syncs only the limit");
    assert.equal(row.limit_requests, 3);
    assert.equal(row.used_tokens, 300, "the current-period usage survives a limit downgrade");
    assert.equal(row.used_requests, 2);
    assert.equal(row.chat_used_tokens, 300);
    assert.equal(row.chat_used_requests, 2);
    assert.equal(
      statements.filter((sql) =>
        sql.includes("tex64_usage.used_tokens + EXCLUDED.used_tokens")
      ).length,
      2
    );
  } finally {
    delete globalThis.__TEX64_V2_PG_POOL_MAP__;
    delete globalThis.__TEX64_V2_PG_SCHEMA_MAP__;
  }
});

test("database schema migrates old mixed counters into a nondecreasing legacy floor", async () => {
  const databaseUrl = "postgres://tex64.test/cost-accounting-schema";
  const config = {
    databaseUrl,
    databaseSsl: false,
    blendedCostPerTokenUsd: 0.000005,
  };
  const poolKey = JSON.stringify({ databaseUrl, databaseSsl: false });
  const statements = [];
  const fakePool = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  };
  globalThis.__TEX64_V2_PG_POOL_MAP__ = new Map([[poolKey, fakePool]]);
  globalThis.__TEX64_V2_PG_SCHEMA_MAP__ = new Map();
  try {
    assert.equal(await ensurePlatformSchema(config), true);
    const sql = statements.map((entry) => entry.sql).join("\n");
    assert.match(sql, /legacy_used_tokens BIGINT NOT NULL DEFAULT 0/);
    assert.match(sql, /used_cost_usd NUMERIC\(30, 18\) NOT NULL DEFAULT 0/);
    assert.match(
      sql,
      /used_tokens - CEIL\(used_cost_usd \/ NULLIF\(\$1::numeric, 0\)\)::bigint/,
    );
    assert.match(sql, /WHERE cost_accounting_version < 1/);
    assert.match(sql, /ALTER COLUMN cost_accounting_version SET DEFAULT 1/);
    const migration = statements.find((entry) =>
      entry.sql.includes("WHERE cost_accounting_version < 1"),
    );
    assert.deepEqual(migration.values, [0.000005]);
  } finally {
    delete globalThis.__TEX64_V2_PG_POOL_MAP__;
    delete globalThis.__TEX64_V2_PG_SCHEMA_MAP__;
  }
});

test("database quota reservation is conditional and reconciliation preserves request count", async () => {
  const databaseUrl = "postgres://tex64.test/atomic-reservation";
  const config = { databaseUrl, databaseSsl: false };
  const poolKey = JSON.stringify({ databaseUrl, databaseSsl: false });
  const periodStart = "2026-08-01T00:00:00.000Z";
  const periodEnd = "2026-09-01T00:00:00.000Z";
  const row = {
    user_id: "usr_reservation",
    period_start: periodStart,
    period_end: periodEnd,
    limit_tokens: 1_000,
    limit_requests: 2,
    used_tokens: 100,
    used_requests: 0,
    cost_accounting_version: 1,
    legacy_used_tokens: 100,
    used_cost_usd: 0,
    chat_used_tokens: 100,
    chat_used_requests: 0,
    chat_legacy_used_tokens: 100,
    chat_used_cost_usd: 0,
    completion_used_tokens: 0,
    completion_used_requests: 0,
    completion_legacy_used_tokens: 0,
    completion_used_cost_usd: 0,
    created_at: periodStart,
    updated_at: periodStart,
  };
  const statements = [];
  const fakePool = {
    async query(sql, values) {
      statements.push(sql);
      if (
        sql.includes("used_tokens = GREATEST(") &&
        sql.includes("used_requests = used_requests + $5")
      ) {
        const canReserve =
          row.used_tokens + values[3] <= row.limit_tokens &&
          row.used_requests + values[4] <= row.limit_requests;
        if (!canReserve) return { rows: [], rowCount: 0 };
        row.used_tokens += values[3];
        row.used_requests += values[4];
        row.chat_used_tokens += values[5];
        row.chat_used_requests += values[6];
        row.completion_used_tokens += values[7];
        row.completion_used_requests += values[8];
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (sql.includes("legacy_used_tokens = legacy_used_tokens + $5")) {
        row.legacy_used_tokens += values[4];
        row.used_tokens = Math.max(
          row.legacy_used_tokens,
          row.used_tokens - values[3] + values[4],
        );
        row.chat_legacy_used_tokens += values[6];
        row.chat_used_tokens = Math.max(
          row.chat_legacy_used_tokens,
          row.chat_used_tokens - values[5] + values[6],
        );
        row.completion_legacy_used_tokens += values[8];
        row.completion_used_tokens = Math.max(
          row.completion_legacy_used_tokens,
          row.completion_used_tokens - values[7] + values[8],
        );
        return { rows: [{ ...row }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in reservation test: ${sql}`);
    },
  };
  globalThis.__TEX64_V2_PG_POOL_MAP__ = new Map([[poolKey, fakePool]]);
  globalThis.__TEX64_V2_PG_SCHEMA_MAP__ = new Map([[poolKey, Promise.resolve(true)]]);
  try {
    const first = await reserveUsageRecordForUserPeriod(config, {
      userId: row.user_id,
      periodStart,
      periodEnd,
      featureName: "chat",
      reservedTokens: 700,
      reservedRequests: 1,
    });
    assert.equal(first.usedTokens, 800);
    assert.equal(first.usedRequests, 1);

    const refused = await reserveUsageRecordForUserPeriod(config, {
      userId: row.user_id,
      periodStart,
      periodEnd,
      featureName: "chat",
      reservedTokens: 300,
      reservedRequests: 1,
    });
    assert.equal(refused, null);
    assert.equal(row.used_tokens, 800);
    assert.equal(row.used_requests, 1);

    const reconciled = await reconcileUsageReservationForUserPeriod(config, {
      userId: row.user_id,
      periodStart,
      periodEnd,
      featureName: "chat",
      reservedTokens: 700,
      actualTokens: 50,
    });
    assert.equal(reconciled.usedTokens, 150);
    assert.equal(reconciled.usedRequests, 1);
    assert.equal(reconciled.byFeature.chat.usedTokens, 150);
    assert.equal(reconciled.byFeature.chat.usedRequests, 1);
    assert.match(
      statements[0],
      /GREATEST\([\s\S]*\) \+ \$4 <= limit_tokens[\s\S]*used_requests \+ \$5 <= limit_requests/,
    );
  } finally {
    delete globalThis.__TEX64_V2_PG_POOL_MAP__;
    delete globalThis.__TEX64_V2_PG_SCHEMA_MAP__;
  }
});

test("database measured reconciliation uses cumulative-cost absolute tokens under parallel reservations", async () => {
  const databaseUrl = "postgres://tex64.test/cumulative-cost-reservation";
  const config = {
    databaseUrl,
    databaseSsl: false,
    blendedCostPerTokenUsd: 0.000005,
  };
  const poolKey = JSON.stringify({ databaseUrl, databaseSsl: false });
  const periodStart = "2026-08-01T00:00:00.000Z";
  const periodEnd = "2026-09-01T00:00:00.000Z";
  const row = {
    user_id: "usr_cumulative",
    period_start: periodStart,
    period_end: periodEnd,
    limit_tokens: 1_000,
    limit_requests: 10,
    used_tokens: 100,
    used_requests: 0,
    cost_accounting_version: 1,
    legacy_used_tokens: 100,
    used_cost_usd: 0,
    chat_used_tokens: 100,
    chat_used_requests: 0,
    chat_legacy_used_tokens: 100,
    chat_used_cost_usd: 0,
    completion_used_tokens: 0,
    completion_used_requests: 0,
    completion_legacy_used_tokens: 0,
    completion_used_cost_usd: 0,
    created_at: periodStart,
    updated_at: periodStart,
  };
  const fakePool = {
    async query(sql, values) {
      if (sql.includes("used_requests = used_requests + $5")) {
        const rate = values[9];
        const committed =
          row.legacy_used_tokens + Math.ceil(row.used_cost_usd / rate);
        if (
          Math.max(row.used_tokens, committed) + values[3] > row.limit_tokens ||
          row.used_requests + values[4] > row.limit_requests
        ) {
          return { rows: [], rowCount: 0 };
        }
        row.used_tokens = Math.max(row.used_tokens, committed) + values[3];
        row.used_requests += values[4];
        row.chat_used_tokens += values[5];
        row.chat_used_requests += values[6];
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (sql.includes("WITH current AS") && sql.includes("new_cost_tokens")) {
        const rate = values[9];
        const oldTokens = Math.ceil(row.used_cost_usd / rate);
        const oldChatTokens = Math.ceil(row.chat_used_cost_usd / rate);
        const nextCost = row.used_cost_usd + values[3];
        const nextChatCost = row.chat_used_cost_usd + values[5];
        const nextTokens = Math.ceil(nextCost / rate);
        const nextChatTokens = Math.ceil(nextChatCost / rate);
        row.used_tokens = Math.max(
          row.legacy_used_tokens + nextTokens,
          row.used_tokens - values[4] + nextTokens - oldTokens,
        );
        row.chat_used_tokens = Math.max(
          row.chat_legacy_used_tokens + nextChatTokens,
          row.chat_used_tokens - values[6] + nextChatTokens - oldChatTokens,
        );
        row.used_cost_usd = nextCost;
        row.chat_used_cost_usd = nextChatCost;
        return { rows: [{ ...row }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in cumulative cost test: ${sql}`);
    },
  };
  globalThis.__TEX64_V2_PG_POOL_MAP__ = new Map([[poolKey, fakePool]]);
  globalThis.__TEX64_V2_PG_SCHEMA_MAP__ = new Map([[poolKey, Promise.resolve(true)]]);
  try {
    await reserveUsageRecordForUserPeriod(config, {
      userId: row.user_id,
      periodStart,
      periodEnd,
      featureName: "chat",
      reservedTokens: 10,
      reservedRequests: 1,
    });
    await reserveUsageRecordForUserPeriod(config, {
      userId: row.user_id,
      periodStart,
      periodEnd,
      featureName: "chat",
      reservedTokens: 10,
      reservedRequests: 1,
    });
    assert.equal(row.used_tokens, 120);

    for (let index = 0; index < 2; index += 1) {
      await reconcileUsageReservationForUserPeriod(config, {
        userId: row.user_id,
        periodStart,
        periodEnd,
        featureName: "chat",
        reservedTokens: 10,
        actualTokens: 1,
        actualCostUsd: config.blendedCostPerTokenUsd * 0.4,
        blendedCostPerTokenUsd: config.blendedCostPerTokenUsd,
      });
    }
    assert.equal(row.used_tokens, 101);
    assert.equal(row.chat_used_tokens, 101);
    assert.equal(row.legacy_used_tokens, 100);
    assert.equal(row.used_requests, 2);
  } finally {
    delete globalThis.__TEX64_V2_PG_POOL_MAP__;
    delete globalThis.__TEX64_V2_PG_SCHEMA_MAP__;
  }
});

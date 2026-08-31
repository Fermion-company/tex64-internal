import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach } from "node:test";

import { issueAccessToken } from "../api/v2/_lib/auth.js";
import {
  loadAuthorizedAiContext,
  reserveQuotaConsumption,
} from "../api/v2/_lib/ai-access.js";
import {
  clearRuntimeConfigCache,
  getRuntimeConfig,
} from "../api/v2/_lib/runtime-config.js";
import {
  classifySubscriptionBridgeCommerce,
  stripeEventRankForSubscriptionStatus,
} from "../api/v2/_lib/subscription-bridge-routing.js";
import { resolveEffectiveSubscription } from "../api/v2/_lib/subscription-domain.js";
import { getUserContext } from "../api/v2/_lib/user-context.js";
import subscriptionHandler from "../api/v2/internal/subscription.js";
import featuresHandler from "../api/v2/me/features.js";
import usageHandler from "../api/v2/me/usage/ai.js";

const ENV_KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "TEX64_DATABASE_URL",
  "TEX64_PLATFORM_ADMIN_SECRET",
  "TEX64_PLATFORM_STATE_FALLBACK",
  "TEX64_PLATFORM_STATE_FILE",
  "TEX64_PLATFORM_SUBSCRIPTION_BRIDGE_SOURCE",
  "TEX64_PLATFORM_JWT_SECRET",
  "TEX64_PLATFORM_FREE_MONTHLY_TOKENS",
  "TEX64_PLATFORM_REQUEST_LIMIT_FREE",
];
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]])
);
const temporaryDirectories = new Set();

afterEach(async () => {
  clearRuntimeConfigCache();
  await Promise.all(
    [...temporaryDirectories].map((directoryPath) =>
      fsp.rm(directoryPath, { recursive: true, force: true })
    )
  );
  temporaryDirectories.clear();
});

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  clearRuntimeConfigCache();
});

const configureFallback = async () => {
  const directoryPath = await fsp.mkdtemp(
    path.join(os.tmpdir(), "tex64-subscription-bridge-")
  );
  temporaryDirectories.add(directoryPath);
  const stateFilePath = path.join(directoryPath, "state.json");
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "";
  process.env.TEX64_DATABASE_URL = "";
  process.env.TEX64_PLATFORM_ADMIN_SECRET = "bridge-test-secret";
  process.env.TEX64_PLATFORM_STATE_FALLBACK = "true";
  process.env.TEX64_PLATFORM_STATE_FILE = stateFilePath;
  process.env.TEX64_PLATFORM_SUBSCRIPTION_BRIDGE_SOURCE = "tex64.com";
  process.env.TEX64_PLATFORM_JWT_SECRET = "subscription-bridge-test-jwt";
  process.env.TEX64_PLATFORM_FREE_MONTHLY_TOKENS = "100";
  process.env.TEX64_PLATFORM_REQUEST_LIMIT_FREE = "3";
  clearRuntimeConfigCache();
  return stateFilePath;
};

const createResponse = () => {
  const headers = new Map();
  return {
    statusCode: 200,
    payload: "",
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    end(payload = "") {
      this.payload = String(payload);
    },
  };
};

const invokeSubscriptionBridge = async (body, headers = {}) => {
  const req = {
    method: "POST",
    headers: {
      "x-tex64-admin-secret": "bridge-test-secret",
      ...headers,
    },
    body,
  };
  const res = createResponse();
  await subscriptionHandler(req, res);
  return {
    statusCode: res.statusCode,
    body: res.payload ? JSON.parse(res.payload) : null,
  };
};

const invokeGet = async (handler, url, headers = {}) => {
  const res = createResponse();
  await handler({ method: "GET", url, headers }, res);
  return {
    statusCode: res.statusCode,
    body: res.payload ? JSON.parse(res.payload) : null,
  };
};

const canonicalBody = ({
  productId = "basic",
  eventId = "evt_canonical123",
  userId = "user-123",
  status = "active",
  eventCreated = 1_800_000_000,
  eventType = "customer.subscription.updated",
} = {}) => ({
  commerce_namespace: "tex64",
  commerce_schema_version: "1",
  product_id: productId,
  userId,
  email: `${userId}@example.com`,
  name: "TeX64 Member",
  plan: productId,
  status,
  billingPeriodStart: "2026-08-01T00:00:00.000Z",
  billingPeriodEnd: "2026-09-01T00:00:00.000Z",
  graceEndsAt: null,
  source: "tex64.com",
  eventId,
  stripeEventType: eventType,
  stripeEventCreated: eventCreated,
  stripeEventRank: stripeEventRankForSubscriptionStatus(status),
});

test("only terminal Basic and Pro cancellations resolve to an effective Free plan", () => {
  const config = {
    freeMonthlyTokens: 100,
    requestLimitFree: 3,
  };
  for (const plan of ["basic", "pro"]) {
    const raw = {
      plan,
      status: "canceled",
      billingPeriodStart: "2026-08-01T00:00:00.000Z",
      billingPeriodEnd: "2026-09-01T00:00:00.000Z",
      quotaPeriodStart: "2026-08-01T00:00:00.000Z",
      quotaPeriodEnd: "2026-09-01T00:00:00.000Z",
      quotaLimitTokens: 999_999,
      quotaLimitRequests: 999,
    };
    const effective = resolveEffectiveSubscription(raw, config);
    assert.notStrictEqual(effective, raw);
    assert.equal(raw.plan, plan);
    assert.equal(raw.status, "canceled");
    assert.equal(effective.plan, "free");
    assert.equal(effective.status, "active");
    assert.equal(effective.quotaLimitTokens, 100);
    assert.equal(effective.quotaLimitRequests, 3);
    assert.equal(effective.quotaPeriodStart, raw.quotaPeriodStart);
    assert.equal(effective.quotaPeriodEnd, raw.quotaPeriodEnd);
  }

  const scheduled = { plan: "pro", status: "active" };
  assert.strictEqual(
    resolveEffectiveSubscription(scheduled, config),
    scheduled,
    "a scheduled period-end cancellation remains paid while Stripe says active",
  );
});

test("explicit foreign namespace wins over spoofed TeX64 legacy fields", () => {
  assert.deepEqual(
    classifySubscriptionBridgeCommerce({
      commerce_namespace: "sansu",
      commerce_schema_version: "1",
      product_id: "basic",
      plan: "basic",
      userId: "user-123",
    }),
    {
      action: "ignore",
      reason: "FOREIGN_NAMESPACE",
      namespace: "sansu",
      productId: "basic",
      legacy: false,
    }
  );
});

test("canonical TeX64 envelopes require exact schema, product, and plan", () => {
  assert.equal(
    classifySubscriptionBridgeCommerce({
      commerce_namespace: "tex64",
      commerce_schema_version: "2",
      product_id: "basic",
      plan: "basic",
    }).reason,
    "SCHEMA_VERSION_INVALID"
  );
  assert.equal(
    classifySubscriptionBridgeCommerce({
      commerce_namespace: "tex64",
      commerce_schema_version: "1",
      product_id: "enterprise",
      plan: "enterprise",
    }).reason,
    "PRODUCT_ID_INVALID"
  );
  assert.equal(
    classifySubscriptionBridgeCommerce({
      commerce_namespace: "tex64",
      commerce_schema_version: "1",
      product_id: "basic",
      plan: "pro",
    }).reason,
    "PRODUCT_PLAN_MISMATCH"
  );
});

test("foreign commerce returns 200 ignored without touching entitlement storage", async () => {
  const stateFilePath = await configureFallback();
  const response = await invokeSubscriptionBridge({
    commerce_namespace: "actuaryproof",
    commerce_schema_version: "1",
    product_id: "exam-p",
    plan: "basic",
    quotaLimitTokens: 999_999_999,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.received, true);
  assert.equal(response.body.ignored, true);
  assert.equal(response.body.reason, "FOREIGN_NAMESPACE");
  await assert.rejects(fsp.access(stateFilePath), { code: "ENOENT" });
});

test("unknown own schema fails closed before storage", async () => {
  const stateFilePath = await configureFallback();
  const response = await invokeSubscriptionBridge({
    ...canonicalBody(),
    commerce_schema_version: "2",
  });

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error.code, "COMMERCE_ROUTING_INVALID");
  assert.equal(response.body.error.details.reason, "SCHEMA_VERSION_INVALID");
  await assert.rejects(fsp.access(stateFilePath), { code: "ENOENT" });
});

test("canonical delivery requires authenticated Stripe ordering identity", async () => {
  const stateFilePath = await configureFallback();
  const body = canonicalBody();
  delete body.stripeEventCreated;
  const response = await invokeSubscriptionBridge(body);
  assert.equal(response.statusCode, 500);
  assert.equal(
    response.body.error.details.reason,
    "STRIPE_EVENT_CREATED_INVALID"
  );
  await assert.rejects(fsp.access(stateFilePath), { code: "ENOENT" });
});

test("canonical delivery cannot spoof a lower state rank", async () => {
  const stateFilePath = await configureFallback();
  const response = await invokeSubscriptionBridge({
    ...canonicalBody({ status: "canceled" }),
    stripeEventRank: 10,
  });
  assert.equal(response.statusCode, 500);
  assert.equal(
    response.body.error.details.reason,
    "STRIPE_EVENT_RANK_INVALID"
  );
  await assert.rejects(fsp.access(stateFilePath), { code: "ENOENT" });
});

test("canonical delivery applies once and duplicate delivery cannot change product", async () => {
  const stateFilePath = await configureFallback();
  const first = await invokeSubscriptionBridge(canonicalBody());
  const duplicate = await invokeSubscriptionBridge(
    canonicalBody({ productId: "pro" })
  );

  assert.equal(first.statusCode, 200);
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.subscription.plan, "basic");
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.duplicate, true);
  const state = JSON.parse(await fsp.readFile(stateFilePath, "utf8"));
  assert.equal(state.subscriptions["user-123"].plan, "basic");
  assert.equal(
    state.processedSubscriptionEvents["tex64.com:evt_canonical123"].payload
      .commerce_namespace,
    "tex64"
  );
});

test("concurrent duplicate deliveries are serialized in the fallback runtime", async () => {
  await configureFallback();
  const [first, second] = await Promise.all([
    invokeSubscriptionBridge(canonicalBody({ eventId: "evt_concurrent123" })),
    invokeSubscriptionBridge(canonicalBody({ eventId: "evt_concurrent123" })),
  ]);

  assert.deepEqual(
    [first.body.duplicate, second.body.duplicate].sort(),
    [false, true]
  );
});

test("older bridge arrival cannot overwrite a newer user entitlement", async () => {
  const stateFilePath = await configureFallback();
  const newer = await invokeSubscriptionBridge(
    canonicalBody({
      productId: "pro",
      status: "canceled",
      eventId: "evt_newer123",
      eventCreated: 1_800_000_200,
      eventType: "customer.subscription.deleted",
    })
  );
  const older = await invokeSubscriptionBridge(
    canonicalBody({
      productId: "basic",
      status: "active",
      eventId: "evt_older123",
      eventCreated: 1_800_000_100,
    })
  );
  assert.equal(newer.statusCode, 200);
  assert.equal(older.statusCode, 200);
  assert.equal(older.body.ignored, true);
  assert.equal(older.body.reason, "STALE_EVENT");
  assert.equal(older.body.subscription.plan, "pro");
  assert.equal(older.body.subscription.status, "canceled");
  const state = JSON.parse(await fsp.readFile(stateFilePath, "utf8"));
  assert.equal(state.subscriptions["user-123"].plan, "pro");
  assert.equal(
    state.subscriptionEventOrders["tex64.com:user-123"].eventId,
    "evt_newer123"
  );
});

test("terminal paid cancellation keeps raw ordering state but exposes one effective Free quota", async () => {
  const stateFilePath = await configureFallback();
  const user = {
    id: "user-123",
    email: "user-123@example.com",
    name: "TeX64 Member",
  };
  const active = await invokeSubscriptionBridge(
    canonicalBody({
      productId: "pro",
      status: "active",
      eventId: "evt_active_paid123",
      eventCreated: 1_800_000_100,
      eventType: "customer.subscription.updated",
    }),
  );
  assert.equal(active.statusCode, 200);
  assert.equal(active.body.subscription.plan, "pro");
  assert.equal(active.body.subscription.status, "active");
  assert.equal(active.body.effectiveSubscription.plan, "pro");
  assert.equal(active.body.effectiveSubscription.status, "active");

  const config = getRuntimeConfig();
  const paidContext = await getUserContext(config, user);
  assert.equal(paidContext.subscription.plan, "pro");
  await paidContext.consumeUsage({
    featureName: "ai_chat",
    consumedTokens: 60,
    consumedRequests: 1,
  });

  const canceled = await invokeSubscriptionBridge(
    canonicalBody({
      productId: "pro",
      status: "canceled",
      eventId: "evt_deleted_paid123",
      eventCreated: 1_800_000_200,
      eventType: "customer.subscription.deleted",
    }),
  );
  assert.equal(canceled.statusCode, 200);
  assert.equal(canceled.body.subscription.plan, "pro");
  assert.equal(canceled.body.subscription.status, "canceled");
  assert.equal(canceled.body.effectiveSubscription.plan, "free");
  assert.equal(canceled.body.effectiveSubscription.status, "active");
  assert.equal(canceled.body.summary.limitTokens, 100);
  assert.equal(canceled.body.summary.usedTokens, 60);
  assert.equal(canceled.body.summary.remainingTokens, 40);
  assert.equal(canceled.body.summary.periodStart, "2026-08-01T00:00:00.000Z");
  assert.equal(canceled.body.summary.periodEnd, "2026-09-01T00:00:00.000Z");

  const stateAfterCancellation = JSON.parse(
    await fsp.readFile(stateFilePath, "utf8"),
  );
  assert.equal(stateAfterCancellation.subscriptions[user.id].plan, "pro");
  assert.equal(stateAfterCancellation.subscriptions[user.id].status, "canceled");
  assert.equal(
    stateAfterCancellation.subscriptions[user.id].billingPeriodStart,
    "2026-08-01T00:00:00.000Z",
  );
  assert.equal(
    stateAfterCancellation.subscriptions[user.id].billingPeriodEnd,
    "2026-09-01T00:00:00.000Z",
  );
  assert.equal(stateAfterCancellation.usage[user.id].limitTokens, 100);
  assert.equal(stateAfterCancellation.usage[user.id].limitRequests, 3);
  assert.equal(stateAfterCancellation.usage[user.id].usedTokens, 60);
  assert.equal(
    stateAfterCancellation.usage[user.id].byFeature.chat.usedTokens,
    60,
  );

  const token = issueAccessToken({ user, plan: "pro" }, config);
  const authHeaders = { authorization: `Bearer ${token}` };
  const features = await invokeGet(
    featuresHandler,
    "/api/v2/me/features?names=ai",
    authHeaders,
  );
  assert.equal(features.statusCode, 200);
  assert.equal(features.body.user.plan, "free");
  assert.equal(features.body.features.ai.enabled, true);
  assert.equal(features.body.features.ai.reason, "active");
  assert.equal(features.body.features.ai.status, "active");
  assert.equal(features.body.features.ai.quota.limitTokens, 100);
  assert.equal(features.body.features.ai.quota.usedTokens, 60);

  const usage = await invokeGet(
    usageHandler,
    "/api/v2/me/usage/ai?period=current_month",
    authHeaders,
  );
  assert.equal(usage.statusCode, 200);
  assert.equal(usage.body.plan, "free");
  assert.equal(usage.body.summary.limitTokens, 100);
  assert.equal(usage.body.summary.usedTokens, 60);
  assert.equal(usage.body.summary.usedRequests, 1);
  assert.equal(usage.body.summary.remainingRequests, 2);
  assert.equal(usage.body.summary.periodStart, "2026-08-01T00:00:00.000Z");
  assert.equal(usage.body.summary.periodEnd, "2026-09-01T00:00:00.000Z");

  const aiContext = await loadAuthorizedAiContext(
    { headers: authHeaders },
    config,
  );
  assert.equal(aiContext.subscription.plan, "free");
  assert.equal(aiContext.subscription.status, "active");
  assert.equal(aiContext.feature.quota.remainingTokens, 40);
  const denied = await reserveQuotaConsumption({
    usage: aiContext.usage,
    featureName: "ai_chat",
    reservedTokens: 41,
    reservedRequests: 1,
    reserveUsage: aiContext.reserveUsage,
  });
  assert.equal(denied.reserved, false);
  assert.equal(denied.quota.usedTokens, 60);
  const admitted = await reserveQuotaConsumption({
    usage: aiContext.usage,
    featureName: "ai_chat",
    reservedTokens: 40,
    reservedRequests: 1,
    reserveUsage: aiContext.reserveUsage,
  });
  assert.equal(admitted.reserved, true);
  assert.equal(admitted.quota.limitTokens, 100);
  assert.equal(admitted.quota.usedTokens, 100);
  assert.equal(admitted.quota.remainingTokens, 0);

  const exhaustedFeatures = await invokeGet(
    featuresHandler,
    "/api/v2/me/features?names=ai",
    authHeaders,
  );
  assert.equal(exhaustedFeatures.body.user.plan, "free");
  assert.equal(exhaustedFeatures.body.features.ai.enabled, false);
  assert.equal(exhaustedFeatures.body.features.ai.reason, "QUOTA_EXCEEDED");
  assert.equal(exhaustedFeatures.body.features.ai.quota.usedTokens, 100);

  const staleActive = await invokeSubscriptionBridge(
    canonicalBody({
      productId: "pro",
      status: "active",
      eventId: "evt_stale_active_paid123",
      eventCreated: 1_800_000_150,
      eventType: "customer.subscription.updated",
    }),
  );
  assert.equal(staleActive.statusCode, 200);
  assert.equal(staleActive.body.ignored, true);
  assert.equal(staleActive.body.subscription.plan, "pro");
  assert.equal(staleActive.body.subscription.status, "canceled");
  assert.equal(staleActive.body.effectiveSubscription.plan, "free");
  assert.equal(staleActive.body.effectiveSubscription.status, "active");
});

test("equal-created lower-rank bridge arrival cannot reverse deletion", async () => {
  await configureFallback();
  await invokeSubscriptionBridge(
    canonicalBody({
      productId: "pro",
      status: "canceled",
      eventId: "evt_deleted123",
      eventCreated: 1_800_000_300,
      eventType: "customer.subscription.deleted",
    })
  );
  const active = await invokeSubscriptionBridge(
    canonicalBody({
      productId: "basic",
      status: "active",
      eventId: "evt_active123",
      eventCreated: 1_800_000_300,
    })
  );
  assert.equal(active.statusCode, 200);
  assert.equal(active.body.ignored, true);
  assert.equal(active.body.subscription.plan, "pro");
  assert.equal(active.body.subscription.status, "canceled");
});

test("legacy sender compatibility requires exact source, Stripe event ID, user, and product", async () => {
  await configureFallback();
  const legacy = {
    userId: "legacy-user",
    email: "legacy@example.com",
    plan: "pro",
    status: "active",
    billingPeriodStart: "2026-08-01T00:00:00.000Z",
    billingPeriodEnd: "2026-09-01T00:00:00.000Z",
    source: "tex64.com",
    eventId: "evt_legacy123",
  };
  const accepted = await invokeSubscriptionBridge(legacy);
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body.commerce.legacy, true);
  assert.equal(accepted.body.commerce.productId, "pro");

  const canceledLegacy = await invokeSubscriptionBridge({
    ...legacy,
    status: "canceled",
    eventId: "evt_legacy456",
  });
  assert.equal(canceledLegacy.statusCode, 200);
  assert.equal(canceledLegacy.body.ignored, false);
  assert.equal(canceledLegacy.body.subscription.status, "canceled");

  const recoveredLegacy = await invokeSubscriptionBridge({
    ...legacy,
    plan: "basic",
    eventId: "evt_legacy789",
  });
  assert.equal(recoveredLegacy.statusCode, 200);
  assert.equal(recoveredLegacy.body.ignored, true);
  assert.equal(recoveredLegacy.body.subscription.plan, "pro");
  assert.equal(recoveredLegacy.body.subscription.status, "canceled");

  const rejected = await invokeSubscriptionBridge({
    ...legacy,
    eventId: "manual-event",
  });
  assert.equal(rejected.statusCode, 500);
  assert.equal(
    rejected.body.error.details.reason,
    "LEGACY_EVENT_ID_UNVERIFIED"
  );
});

test("commerce bridge cannot override computed quota or reset usage", async () => {
  const stateFilePath = await configureFallback();
  const response = await invokeSubscriptionBridge({
    ...canonicalBody(),
    quotaLimitTokens: 999_999_999,
  });

  assert.equal(response.statusCode, 500);
  assert.equal(
    response.body.error.details.reason,
    "ENTITLEMENT_OVERRIDE_FORBIDDEN"
  );
  await assert.rejects(fsp.access(stateFilePath), { code: "ENOENT" });
});

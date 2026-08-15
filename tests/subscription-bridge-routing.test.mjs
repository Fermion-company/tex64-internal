import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach } from "node:test";

import { clearRuntimeConfigCache } from "../api/v2/_lib/runtime-config.js";
import {
  classifySubscriptionBridgeCommerce,
  stripeEventRankForSubscriptionStatus,
} from "../api/v2/_lib/subscription-bridge-routing.js";
import subscriptionHandler from "../api/v2/internal/subscription.js";

const ENV_KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "TEX64_DATABASE_URL",
  "TEX64_PLATFORM_ADMIN_SECRET",
  "TEX64_PLATFORM_STATE_FALLBACK",
  "TEX64_PLATFORM_STATE_FILE",
  "TEX64_PLATFORM_SUBSCRIPTION_BRIDGE_SOURCE",
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

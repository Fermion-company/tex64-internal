import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAnonymousAiUsageGuard,
  hashAnonymousNetworkAddress,
  loadAdmittedAnonymousAppUser,
  resolveTrustedAnonymousClientAddress,
} from "../api/v2/_lib/anonymous-abuse.js";
import { loadAuthorizedAiContext } from "../api/v2/_lib/ai-access.js";
import {
  admitAnonymousDeviceForNetwork,
  reconcileAnonymousNetworkUsage,
  reserveAnonymousNetworkUsage,
} from "../api/v2/_lib/db-adapter.js";

const DEVICE_IDS = [
  "550e8400-e29b-41d4-a716-446655440000",
  "550e8400-e29b-41d4-a716-446655440001",
  "550e8400-e29b-41d4-a716-446655440002",
];

const baseConfig = (overrides = {}) => ({
  jwtSecret: "anonymous-abuse-test-secret",
  runtimeEnvironment: "development",
  vercelRuntime: false,
  trustedClientIpHeader: "",
  stateFallbackEnabled: true,
  stateFilePath: "",
  anonymousDeviceWindowSec: 86_400,
  anonymousDevicesPerIp: 24,
  anonymousAiWindowSec: 3_600,
  anonymousAiRequestsPerIp: 120,
  anonymousAiReservedTokensPerIp: 400_000,
  allowDevAuth: false,
  defaultPlan: "free",
  defaultStatus: "active",
  freeMonthlyTokens: 200_000,
  requestLimitFree: 100,
  requestLimitBasic: 10_000,
  requestLimitPro: 100_000,
  blendedCostPerTokenUsd: 0.000005,
  basicBudgetUsd: 4,
  proBudgetUsd: 15,
  graceDays: 3,
  pricingUrl: "https://tex64.com/pricing",
  ...overrides,
});

const requestFor = (deviceId, address = "203.0.113.7") => ({
  headers: { "x-tex64-device-id": deviceId },
  socket: { remoteAddress: address },
});

test("production trusts only a deployment-controlled client address source", () => {
  const spoofed = {
    headers: {
      "x-forwarded-for": "198.51.100.9",
      "x-vercel-forwarded-for": "203.0.113.8",
    },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal(
    resolveTrustedAnonymousClientAddress(
      spoofed,
      baseConfig({ runtimeEnvironment: "production" })
    ),
    null,
    "ordinary forwarded and socket addresses fail closed in production"
  );
  assert.equal(
    resolveTrustedAnonymousClientAddress(
      spoofed,
      baseConfig({ runtimeEnvironment: "production", vercelRuntime: true })
    ),
    "203.0.113.8"
  );
  assert.equal(
    resolveTrustedAnonymousClientAddress(
      {
        headers: {
          "x-forwarded-for": "198.51.100.9",
          "x-company-connecting-ip": "192.0.2.44",
        },
      },
      baseConfig({
        runtimeEnvironment: "production",
        trustedClientIpHeader: "x-company-connecting-ip",
      })
    ),
    "192.0.2.44"
  );
});

test("anonymous production access fails closed without trusted IP while authenticated access is unchanged", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-anon-prod-ip-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = baseConfig({
    runtimeEnvironment: "production",
    stateFilePath: path.join(directory, "state.json"),
    allowDevAuth: true,
  });

  await assert.rejects(
    loadAuthorizedAiContext(
      { headers: { "x-tex64-device-id": DEVICE_IDS[0] } },
      config
    ),
    (error) =>
      error?.code === "ANONYMOUS_NETWORK_UNAVAILABLE" &&
      error?.statusCode === 503
  );
  await assert.rejects(
    loadAuthorizedAiContext(
      {
        headers: {
          "x-tex64-device-id": DEVICE_IDS[0],
          "x-vercel-forwarded-for": "203.0.113.29",
        },
      },
      { ...config, vercelRuntime: true }
    ),
    (error) =>
      error?.code === "STATE_BACKEND_UNAVAILABLE" &&
      error?.statusCode === 503,
    "production fallback cannot pretend to be atomic across serverless instances"
  );

  const authenticated = await loadAuthorizedAiContext(
    { headers: { "x-tex64-dev-user": "signed-in@example.test" } },
    config
  );
  assert.equal(authenticated.anonymous, false);
  assert.equal(authenticated.user.email, "signed-in@example.test");
});

test("fallback device issuance is unique, parallel-safe, and persists no raw IP or UUID", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-anon-devices-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const stateFilePath = path.join(directory, "state.json");
  const config = baseConfig({ stateFilePath, anonymousDevicesPerIp: 2 });

  const settled = await Promise.allSettled(
    DEVICE_IDS.map((deviceId) =>
      loadAdmittedAnonymousAppUser(requestFor(deviceId), config)
    )
  );
  assert.equal(
    settled.filter((result) => result.status === "fulfilled").length,
    2
  );
  const denied = settled.find((result) => result.status === "rejected");
  assert.equal(denied?.reason?.code, "ANONYMOUS_ACCESS_LIMITED");

  const admittedId = settled.findIndex((result) => result.status === "fulfilled");
  const repeated = await loadAdmittedAnonymousAppUser(
    requestFor(DEVICE_IDS[admittedId]),
    config
  );
  assert.match(repeated.user.id, /^anon_[0-9a-f]{40}$/);

  const rawState = await fs.readFile(stateFilePath, "utf8");
  assert.equal(rawState.includes("203.0.113.7"), false);
  for (const deviceId of DEVICE_IDS) assert.equal(rawState.includes(deviceId), false);
  const state = JSON.parse(rawState);
  const windows = Object.values(state.anonymousAbuseWindows);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].deviceHashes.length, 2);
  assert.ok(windows[0].deviceHashes.every((value) => /^[0-9a-f]{64}$/.test(value)));
});

test("fallback AI reservation remains atomic across rotated anonymous UUIDs", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-anon-reserve-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = baseConfig({
    stateFilePath: path.join(directory, "state.json"),
    anonymousDevicesPerIp: 4,
    anonymousAiReservedTokensPerIp: 10,
    anonymousAiRequestsPerIp: 5,
  });
  const identities = await Promise.all(
    DEVICE_IDS.slice(0, 2).map((deviceId) =>
      loadAdmittedAnonymousAppUser(requestFor(deviceId), config)
    )
  );
  assert.equal(identities[0].networkHash, identities[1].networkHash);
  const guards = identities.map(({ networkHash }) =>
    createAnonymousAiUsageGuard({ config, networkHash })
  );

  const firstRound = await Promise.allSettled(
    guards.map((guard) => guard.reserve({ reservedTokens: 7, reservedRequests: 1 }))
  );
  assert.equal(firstRound.filter((result) => result.status === "fulfilled").length, 1);
  const winner = firstRound.findIndex((result) => result.status === "fulfilled");
  const loser = winner === 0 ? 1 : 0;
  assert.equal(firstRound[loser].reason.code, "ANONYMOUS_ACCESS_LIMITED");

  await guards[winner].reconcile({ reservedTokens: 7, actualTokens: 2 });
  const retry = await guards[loser].reserve({ reservedTokens: 7, reservedRequests: 1 });
  assert.equal(retry.reservedTokens, 9);
  assert.equal(retry.usedRequests, 2, "denied reservations do not consume requests");
});

test("database windows use conditional upserts for parallel device and token admission", async () => {
  const databaseUrl = "postgres://tex64.test/anonymous-abuse";
  const config = { databaseUrl, databaseSsl: false };
  const poolKey = JSON.stringify({ databaseUrl, databaseSsl: false });
  const networkHash = "a".repeat(64);
  const deviceHashes = ["b".repeat(64), "c".repeat(64)];
  const state = {
    devices: new Set(),
    reservedTokens: 0,
    usedRequests: 0,
    windowStart: "2026-08-29T00:00:00.000Z",
    windowEnd: "2026-08-29T01:00:00.000Z",
  };
  const statements = [];
  const fakePool = {
    async query(sql, values = []) {
      statements.push(sql);
      if (
        sql.includes("CREATE TABLE") ||
        sql.includes("CREATE INDEX") ||
        sql.includes("ALTER TABLE tex64_usage") ||
        sql.includes("WHERE cost_accounting_version < 1")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH expired AS")) return { rows: [], rowCount: 0 };
      await new Promise((resolve) => setImmediate(resolve));
      if (sql.includes("'devices'")) {
        const deviceHash = values[1];
        const maxDevices = values[3];
        if (!state.devices.has(deviceHash) && state.devices.size >= maxDevices) {
          return { rows: [], rowCount: 0 };
        }
        state.devices.add(deviceHash);
        return {
          rows: [{
            window_start: state.windowStart,
            window_end: state.windowEnd,
            device_count: state.devices.size,
            reserved_tokens: state.reservedTokens,
            used_requests: state.usedRequests,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO tex64_anonymous_abuse_windows")) {
        const nextTokens = state.reservedTokens + values[2];
        const nextRequests = state.usedRequests + values[3];
        if (nextTokens > values[4] || nextRequests > values[5]) {
          return { rows: [], rowCount: 0 };
        }
        state.reservedTokens = nextTokens;
        state.usedRequests = nextRequests;
      } else if (sql.includes("GREATEST(0, reserved_tokens + $3)")) {
        state.reservedTokens = Math.max(0, state.reservedTokens + values[2]);
      } else {
        throw new Error(`Unexpected SQL: ${sql}`);
      }
      return {
        rows: [{
          window_start: state.windowStart,
          window_end: state.windowEnd,
          device_count: state.devices.size,
          reserved_tokens: state.reservedTokens,
          used_requests: state.usedRequests,
        }],
        rowCount: 1,
      };
    },
  };
  globalThis.__TEX64_V2_PG_POOL_MAP__ = new Map([[poolKey, fakePool]]);
  globalThis.__TEX64_V2_PG_SCHEMA_MAP__ = new Map();
  try {
    const deviceResults = await Promise.all(
      deviceHashes.map((deviceHash) =>
        admitAnonymousDeviceForNetwork(config, {
          networkHash,
          deviceHash,
          windowSec: 3_600,
          maxDevices: 1,
        })
      )
    );
    assert.equal(deviceResults.filter(Boolean).length, 1);

    const reservations = await Promise.all(
      [7, 7].map((reservedTokens) =>
        reserveAnonymousNetworkUsage(config, {
          networkHash,
          windowSec: 3_600,
          reservedTokens,
          reservedRequests: 1,
          maxTokens: 10,
          maxRequests: 5,
        })
      )
    );
    assert.equal(reservations.filter(Boolean).length, 1);
    await reconcileAnonymousNetworkUsage(config, {
      networkHash,
      windowStart: state.windowStart,
      reservedTokens: 7,
      actualTokens: 2,
    });
    assert.equal(state.reservedTokens, 2);
    assert.ok(
      statements.some((sql) => sql.includes("jsonb_array_length") && sql.includes("ON CONFLICT"))
    );
    assert.ok(
      statements.some((sql) =>
        sql.includes("reserved_tokens + $3 <= $5") &&
        sql.includes("used_requests + $4 <= $6")
      )
    );
    assert.ok(
      statements.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS tex64_anonymous_abuse_windows"))
    );
  } finally {
    delete globalThis.__TEX64_V2_PG_POOL_MAP__;
    delete globalThis.__TEX64_V2_PG_SCHEMA_MAP__;
  }
});

test("network HMAC is stable but secret-scoped and never equals the raw address", () => {
  const rawAddress = "203.0.113.19";
  const first = hashAnonymousNetworkAddress(rawAddress, baseConfig());
  const repeat = hashAnonymousNetworkAddress(rawAddress, baseConfig());
  const rotated = hashAnonymousNetworkAddress(
    rawAddress,
    baseConfig({ jwtSecret: "different-secret" })
  );
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, repeat);
  assert.notEqual(first, rawAddress);
  assert.notEqual(first, rotated);
});

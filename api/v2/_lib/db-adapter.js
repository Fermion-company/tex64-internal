import crypto from "node:crypto";
import { Pool } from "pg";

import { ApiError } from "./http.js";
import { isSubscriptionBridgeOrderStale } from "./subscription-bridge-routing.js";
import {
  computeRequestLimitForPlan,
  computeTokenLimitForPlan,
  normalizePlan,
  normalizeStatus,
} from "./subscription-domain.js";

const GLOBAL_POOL_MAP_KEY = "__TEX64_V2_PG_POOL_MAP__";
const GLOBAL_SCHEMA_MAP_KEY = "__TEX64_V2_PG_SCHEMA_MAP__";

const parseInteger = (value, fallback = 0) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const toIsoDate = (value) => {
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      return date.toISOString();
    }
    return null;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return null;
};

const normalizeObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token || "")).digest("hex");

const buildSyntheticEmailFromUserId = (userId) => {
  const normalized = typeof userId === "string" ? userId.trim().toLowerCase() : "";
  if (!normalized) {
    return "";
  }
  const safeLocalPart = normalized.replace(/[^a-z0-9._-]/g, "_").slice(0, 96);
  return `${safeLocalPart || "user"}@users.tex64.local`;
};

const normalizeUserRow = (row) => {
  if (!row || typeof row !== "object") {
    return null;
  }
  return {
    id: typeof row.id === "string" ? row.id : "",
    email: typeof row.email === "string" ? row.email : "",
    name:
      typeof row.name === "string" && row.name.trim() ? row.name.trim() : null,
    createdAt: toIsoDate(row.created_at),
    updatedAt: toIsoDate(row.updated_at),
  };
};

const normalizeSubscriptionRow = (row, config) => {
  if (!row || typeof row !== "object") {
    return null;
  }
  const plan = normalizePlan(row.plan, normalizePlan(config.defaultPlan, "free"));
  const status = normalizeStatus(
    row.status,
    normalizeStatus(config.defaultStatus, "active")
  );
  return {
    plan,
    status,
    billingPeriodStart: toIsoDate(row.billing_period_start),
    billingPeriodEnd: toIsoDate(row.billing_period_end),
    graceEndsAt: toIsoDate(row.grace_ends_at),
    quotaPeriodStart: toIsoDate(row.quota_period_start),
    quotaPeriodEnd: toIsoDate(row.quota_period_end),
    quotaLimitTokens: Math.max(
      0,
      parseInteger(
        row.quota_limit_tokens,
        computeTokenLimitForPlan(plan, config)
      )
    ),
    quotaLimitRequests: Math.max(
      0,
      parseInteger(
        row.quota_limit_requests,
        computeRequestLimitForPlan(plan, config)
      )
    ),
    metadata: normalizeObject(row.metadata),
    createdAt: toIsoDate(row.created_at),
    updatedAt: toIsoDate(row.updated_at),
  };
};

const normalizeUsageRow = (row) => {
  if (!row || typeof row !== "object") {
    return null;
  }
  return {
    periodStart: toIsoDate(row.period_start),
    periodEnd: toIsoDate(row.period_end),
    limitTokens: Math.max(0, parseInteger(row.limit_tokens, 0)),
    limitRequests: Math.max(0, parseInteger(row.limit_requests, 0)),
    usedTokens: Math.max(0, parseInteger(row.used_tokens, 0)),
    usedRequests: Math.max(0, parseInteger(row.used_requests, 0)),
    byFeature: {
      chat: {
        usedTokens: Math.max(0, parseInteger(row.chat_used_tokens, 0)),
        usedRequests: Math.max(0, parseInteger(row.chat_used_requests, 0)),
      },
      completion: {
        usedTokens: Math.max(0, parseInteger(row.completion_used_tokens, 0)),
        usedRequests: Math.max(0, parseInteger(row.completion_used_requests, 0)),
      },
    },
    createdAt: toIsoDate(row.created_at),
    updatedAt: toIsoDate(row.updated_at),
  };
};

const normalizeRefreshTokenRow = (row) => {
  if (!row || typeof row !== "object") {
    return null;
  }
  return {
    tokenHash: typeof row.token_hash === "string" ? row.token_hash : "",
    userId: typeof row.user_id === "string" ? row.user_id : "",
    deviceId:
      typeof row.device_id === "string" && row.device_id.trim()
        ? row.device_id.trim()
        : null,
    expiresAt: toIsoDate(row.expires_at),
    revokedAt: toIsoDate(row.revoked_at),
    replacedByHash:
      typeof row.replaced_by_hash === "string" && row.replaced_by_hash.trim()
        ? row.replaced_by_hash.trim()
        : null,
    metadata: normalizeObject(row.metadata),
    createdAt: toIsoDate(row.created_at),
    updatedAt: toIsoDate(row.updated_at),
  };
};

const getPoolMap = () => {
  if (!globalThis[GLOBAL_POOL_MAP_KEY]) {
    globalThis[GLOBAL_POOL_MAP_KEY] = new Map();
  }
  return globalThis[GLOBAL_POOL_MAP_KEY];
};

const getSchemaMap = () => {
  if (!globalThis[GLOBAL_SCHEMA_MAP_KEY]) {
    globalThis[GLOBAL_SCHEMA_MAP_KEY] = new Map();
  }
  return globalThis[GLOBAL_SCHEMA_MAP_KEY];
};

const getPoolKey = (config) =>
  JSON.stringify({
    databaseUrl: config?.databaseUrl || "",
    databaseSsl: Boolean(config?.databaseSsl),
  });

const getPool = (config) => {
  const databaseUrl =
    typeof config?.databaseUrl === "string" ? config.databaseUrl.trim() : "";
  if (!databaseUrl) {
    return null;
  }
  const key = getPoolKey(config);
  const map = getPoolMap();
  if (!map.has(key)) {
    map.set(
      key,
      new Pool({
        connectionString: databaseUrl,
        ...(config?.databaseSsl
          ? { ssl: { rejectUnauthorized: false } }
          : {}),
      })
    );
  }
  return map.get(key);
};

export const isDatabaseConfigured = (config) =>
  Boolean(typeof config?.databaseUrl === "string" && config.databaseUrl.trim());

export const ensurePlatformSchema = async (config) => {
  if (!isDatabaseConfigured(config)) {
    return false;
  }
  const key = getPoolKey(config);
  const schemaMap = getSchemaMap();
  if (schemaMap.has(key)) {
    return schemaMap.get(key);
  }
  const promise = (async () => {
    const pool = getPool(config);
    if (!pool) {
      return false;
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tex64_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tex64_subscriptions (
        user_id TEXT PRIMARY KEY REFERENCES tex64_users(id) ON DELETE CASCADE,
        plan TEXT NOT NULL DEFAULT 'free',
        status TEXT NOT NULL DEFAULT 'active',
        billing_period_start TIMESTAMPTZ NOT NULL,
        billing_period_end TIMESTAMPTZ NOT NULL,
        grace_ends_at TIMESTAMPTZ,
        quota_period_start TIMESTAMPTZ NOT NULL,
        quota_period_end TIMESTAMPTZ NOT NULL,
        quota_limit_tokens BIGINT NOT NULL DEFAULT 0,
        quota_limit_requests BIGINT NOT NULL DEFAULT 0,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tex64_usage (
        user_id TEXT NOT NULL REFERENCES tex64_users(id) ON DELETE CASCADE,
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,
        limit_tokens BIGINT NOT NULL DEFAULT 0,
        limit_requests BIGINT NOT NULL DEFAULT 0,
        used_tokens BIGINT NOT NULL DEFAULT 0,
        used_requests BIGINT NOT NULL DEFAULT 0,
        chat_used_tokens BIGINT NOT NULL DEFAULT 0,
        chat_used_requests BIGINT NOT NULL DEFAULT 0,
        completion_used_tokens BIGINT NOT NULL DEFAULT 0,
        completion_used_requests BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, period_start, period_end)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tex64_auth_requests (
        oauth_state TEXT PRIMARY KEY,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tex64_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES tex64_users(id) ON DELETE CASCADE,
        device_id TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        replaced_by_hash TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS tex64_refresh_tokens_user_idx
      ON tex64_refresh_tokens (user_id);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS tex64_refresh_tokens_device_idx
      ON tex64_refresh_tokens (device_id);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tex64_processed_subscription_events (
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        user_id TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, event_id)
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS tex64_processed_subscription_events_created_idx
      ON tex64_processed_subscription_events (created_at DESC);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tex64_subscription_event_orders (
        source TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES tex64_users(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_created BIGINT NOT NULL,
        event_rank INTEGER NOT NULL,
        legacy BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, user_id)
      );
    `);
    return true;
  })().catch((error) => {
    schemaMap.delete(key);
    throw error;
  });
  schemaMap.set(key, promise);
  return promise;
};

const requireDb = async (config) => {
  if (!isDatabaseConfigured(config)) {
    throw new ApiError("STATE_BACKEND_UNAVAILABLE", "DATABASE_URL is not configured.", 503);
  }
  await ensurePlatformSchema(config);
  const pool = getPool(config);
  if (!pool) {
    throw new ApiError("STATE_BACKEND_UNAVAILABLE", "Database pool is unavailable.", 503);
  }
  return pool;
};

export const upsertUserRecord = async (config, user) => {
  const userId = typeof user?.id === "string" ? user.id.trim() : "";
  const emailInput =
    typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
  const email = emailInput || buildSyntheticEmailFromUserId(userId);
  const name =
    typeof user?.name === "string" && user.name.trim() ? user.name.trim() : null;
  if (!userId || !email) {
    return null;
  }
  const pool = await requireDb(config);
  const existingByEmail = await pool.query(
    `
      SELECT id, email, name, created_at, updated_at
      FROM tex64_users
      WHERE email = $1
      LIMIT 1;
    `,
    [email]
  );
  if (existingByEmail.rows[0]?.id) {
    const updated = await pool.query(
      `
        UPDATE tex64_users
        SET name = $2, updated_at = NOW()
        WHERE email = $1
        RETURNING id, email, name, created_at, updated_at;
      `,
      [email, name]
    );
    return normalizeUserRow(updated.rows[0] ?? existingByEmail.rows[0]);
  }
  const result = await pool.query(
    `
      INSERT INTO tex64_users (id, email, name, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        updated_at = NOW()
      RETURNING id, email, name, created_at, updated_at;
    `,
    [userId, email, name]
  );
  return normalizeUserRow(result.rows[0] ?? null);
};

export const getUserRecordById = async (config, userId) => {
  const normalized = typeof userId === "string" ? userId.trim() : "";
  if (!normalized) {
    return null;
  }
  const pool = await requireDb(config);
  const result = await pool.query(
    `
      SELECT id, email, name, created_at, updated_at
      FROM tex64_users
      WHERE id = $1
      LIMIT 1;
    `,
    [normalized]
  );
  return normalizeUserRow(result.rows[0] ?? null);
};

export const getSubscriptionRecordByUserId = async (config, userId) => {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  if (!normalizedUserId) {
    return null;
  }
  const pool = await requireDb(config);
  const result = await pool.query(
    `
      SELECT *
      FROM tex64_subscriptions
      WHERE user_id = $1
      LIMIT 1;
    `,
    [normalizedUserId]
  );
  return normalizeSubscriptionRow(result.rows[0] ?? null, config);
};

const normalizeSubscriptionUpsert = (config, payload) => {
  const userId = typeof payload?.userId === "string" ? payload.userId.trim() : "";
  if (!userId) {
    return null;
  }
  const plan = normalizePlan(payload?.plan, normalizePlan(config.defaultPlan, "free"));
  const status = normalizeStatus(
    payload?.status,
    normalizeStatus(config.defaultStatus, "active")
  );
  const billingPeriodStart = toIsoDate(payload?.billingPeriodStart);
  const billingPeriodEnd = toIsoDate(payload?.billingPeriodEnd);
  const graceEndsAt = toIsoDate(payload?.graceEndsAt);
  const quotaPeriodStart = toIsoDate(payload?.quotaPeriodStart);
  const quotaPeriodEnd = toIsoDate(payload?.quotaPeriodEnd);
  const quotaLimitTokens = Math.max(
    0,
    parseInteger(payload?.quotaLimitTokens, computeTokenLimitForPlan(plan, config))
  );
  const quotaLimitRequests = Math.max(
    0,
    parseInteger(payload?.quotaLimitRequests, computeRequestLimitForPlan(plan, config))
  );
  const metadata = normalizeObject(payload?.metadata);
  if (
    !billingPeriodStart ||
    !billingPeriodEnd ||
    !quotaPeriodStart ||
    !quotaPeriodEnd
  ) {
    throw new ApiError(
      "VALIDATION_ERROR",
      "billingPeriodStart, billingPeriodEnd, quotaPeriodStart, quotaPeriodEnd are required.",
      400
    );
  }
  return {
    userId,
    plan,
    status,
    billingPeriodStart,
    billingPeriodEnd,
    graceEndsAt,
    quotaPeriodStart,
    quotaPeriodEnd,
    quotaLimitTokens,
    quotaLimitRequests,
    metadata,
  };
};

const executeSubscriptionUpsert = async (
  queryable,
  normalized,
  { bypassEventOrderGuard = false } = {}
) => {
  const result = await queryable.query(
    `
      INSERT INTO tex64_subscriptions (
        user_id,
        plan,
        status,
        billing_period_start,
        billing_period_end,
        grace_ends_at,
        quota_period_start,
        quota_period_end,
        quota_limit_tokens,
        quota_limit_requests,
        metadata,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        plan = EXCLUDED.plan,
        status = EXCLUDED.status,
        billing_period_start = EXCLUDED.billing_period_start,
        billing_period_end = EXCLUDED.billing_period_end,
        grace_ends_at = EXCLUDED.grace_ends_at,
        quota_period_start = EXCLUDED.quota_period_start,
        quota_period_end = EXCLUDED.quota_period_end,
        quota_limit_tokens = EXCLUDED.quota_limit_tokens,
        quota_limit_requests = EXCLUDED.quota_limit_requests,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      WHERE $12::boolean
        OR tex64_subscriptions.metadata -> 'subscriptionEventOrder' IS NULL
        OR EXCLUDED.metadata -> 'subscriptionEventOrder'
          = tex64_subscriptions.metadata -> 'subscriptionEventOrder'
      RETURNING *;
    `,
    [
      normalized.userId,
      normalized.plan,
      normalized.status,
      normalized.billingPeriodStart,
      normalized.billingPeriodEnd,
      normalized.graceEndsAt,
      normalized.quotaPeriodStart,
      normalized.quotaPeriodEnd,
      normalized.quotaLimitTokens,
      normalized.quotaLimitRequests,
      JSON.stringify(normalized.metadata),
      bypassEventOrderGuard,
    ]
  );
  return result.rows[0] ?? null;
};

export const upsertSubscriptionRecordForUser = async (config, payload) => {
  const normalized = normalizeSubscriptionUpsert(config, payload);
  if (!normalized) {
    return null;
  }
  const pool = await requireDb(config);
  const row = await executeSubscriptionUpsert(pool, normalized);
  return normalizeSubscriptionRow(row, config);
};

export const upsertOrderedSubscriptionRecordForUser = async (
  config,
  payload,
  ordering
) => {
  const normalized = normalizeSubscriptionUpsert(config, payload);
  if (!normalized) {
    return { applied: false, stale: false, subscription: null };
  }
  const source = typeof ordering?.source === "string" ? ordering.source.trim() : "";
  const eventId = typeof ordering?.eventId === "string" ? ordering.eventId.trim() : "";
  const eventType =
    typeof ordering?.eventType === "string" ? ordering.eventType.trim() : "";
  const eventCreated = parseInteger(ordering?.eventCreated, -1);
  const eventRank = parseInteger(ordering?.eventRank, -1);
  const legacy = ordering?.legacy === true;
  if (
    !source ||
    !eventId ||
    !eventType ||
    eventCreated < 0 ||
    eventRank <= 0 ||
    (!legacy && eventCreated === 0)
  ) {
    throw new ApiError(
      "VALIDATION_ERROR",
      "Subscription event ordering is invalid.",
      500
    );
  }
  const pool = await requireDb(config);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(141594, hashtext($1));",
      [`${source}:${normalized.userId}`]
    );
    const currentResult = await client.query(
      `
        SELECT source, user_id, event_id, event_type, event_created, event_rank, legacy
        FROM tex64_subscription_event_orders
        WHERE source = $1 AND user_id = $2
        LIMIT 1
        FOR UPDATE;
      `,
      [source, normalized.userId]
    );
    const currentRow = currentResult.rows[0] ?? null;
    const current = currentRow
      ? {
          source: currentRow.source,
          userId: currentRow.user_id,
          eventId: currentRow.event_id,
          eventType: currentRow.event_type,
          eventCreated: Number(currentRow.event_created || 0),
          eventRank: Number(currentRow.event_rank || 0),
          legacy: currentRow.legacy === true,
        }
      : null;
    const incoming = {
      source,
      userId: normalized.userId,
      eventId,
      eventType,
      eventCreated,
      eventRank,
      legacy,
    };
    if (isSubscriptionBridgeOrderStale(current, incoming)) {
      const subscriptionResult = await client.query(
        "SELECT * FROM tex64_subscriptions WHERE user_id = $1 LIMIT 1;",
        [normalized.userId]
      );
      await client.query("COMMIT");
      return {
        applied: false,
        stale: true,
        subscription: normalizeSubscriptionRow(
          subscriptionResult.rows[0] ?? null,
          config
        ),
        current,
      };
    }

    normalized.metadata = {
      ...normalized.metadata,
      subscriptionEventOrder: incoming,
    };
    const subscriptionRow = await executeSubscriptionUpsert(client, normalized, {
      bypassEventOrderGuard: true,
    });
    await client.query(
      `
        INSERT INTO tex64_subscription_event_orders (
          source,
          user_id,
          event_id,
          event_type,
          event_created,
          event_rank,
          legacy,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (source, user_id)
        DO UPDATE SET
          event_id = EXCLUDED.event_id,
          event_type = EXCLUDED.event_type,
          event_created = EXCLUDED.event_created,
          event_rank = EXCLUDED.event_rank,
          legacy = EXCLUDED.legacy,
          updated_at = NOW();
      `,
      [
        source,
        normalized.userId,
        eventId,
        eventType,
        eventCreated,
        eventRank,
        legacy,
      ]
    );
    await client.query("COMMIT");
    return {
      applied: true,
      stale: false,
      subscription: normalizeSubscriptionRow(subscriptionRow, config),
      current: incoming,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getUsageRecordForUserPeriod = async (config, payload) => {
  const userId = typeof payload?.userId === "string" ? payload.userId.trim() : "";
  const periodStart = toIsoDate(payload?.periodStart);
  const periodEnd = toIsoDate(payload?.periodEnd);
  if (!userId || !periodStart || !periodEnd) {
    return null;
  }
  const pool = await requireDb(config);
  const result = await pool.query(
    `
      SELECT *
      FROM tex64_usage
      WHERE user_id = $1
        AND period_start = $2::timestamptz
        AND period_end = $3::timestamptz
      LIMIT 1;
    `,
    [userId, periodStart, periodEnd]
  );
  return normalizeUsageRow(result.rows[0] ?? null);
};

export const upsertUsageRecordForUserPeriod = async (config, payload) => {
  const userId = typeof payload?.userId === "string" ? payload.userId.trim() : "";
  const periodStart = toIsoDate(payload?.periodStart);
  const periodEnd = toIsoDate(payload?.periodEnd);
  if (!userId || !periodStart || !periodEnd) {
    return null;
  }
  const pool = await requireDb(config);
  const byFeature = normalizeObject(payload?.byFeature);
  const result = await pool.query(
    `
      INSERT INTO tex64_usage (
        user_id,
        period_start,
        period_end,
        limit_tokens,
        limit_requests,
        used_tokens,
        used_requests,
        chat_used_tokens,
        chat_used_requests,
        completion_used_tokens,
        completion_used_requests,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (user_id, period_start, period_end)
      DO UPDATE SET
        limit_tokens = EXCLUDED.limit_tokens,
        limit_requests = EXCLUDED.limit_requests,
        used_tokens = EXCLUDED.used_tokens,
        used_requests = EXCLUDED.used_requests,
        chat_used_tokens = EXCLUDED.chat_used_tokens,
        chat_used_requests = EXCLUDED.chat_used_requests,
        completion_used_tokens = EXCLUDED.completion_used_tokens,
        completion_used_requests = EXCLUDED.completion_used_requests,
        updated_at = NOW()
      RETURNING *;
    `,
    [
      userId,
      periodStart,
      periodEnd,
      Math.max(0, parseInteger(payload?.limitTokens, 0)),
      Math.max(0, parseInteger(payload?.limitRequests, 0)),
      Math.max(0, parseInteger(payload?.usedTokens, 0)),
      Math.max(0, parseInteger(payload?.usedRequests, 0)),
      Math.max(0, parseInteger(byFeature.chat?.usedTokens, 0)),
      Math.max(0, parseInteger(byFeature.chat?.usedRequests, 0)),
      Math.max(0, parseInteger(byFeature.completion?.usedTokens, 0)),
      Math.max(0, parseInteger(byFeature.completion?.usedRequests, 0)),
    ]
  );
  return normalizeUsageRow(result.rows[0] ?? null);
};

export const deleteUsageRecordsForUser = async (config, userId) => {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  if (!normalizedUserId) {
    return 0;
  }
  const pool = await requireDb(config);
  const result = await pool.query(
    `
      DELETE FROM tex64_usage
      WHERE user_id = $1;
    `,
    [normalizedUserId]
  );
  return Math.max(0, parseInteger(result.rowCount, 0));
};

export const setAuthRequestRecord = async (config, oauthState, payload) => {
  const normalizedState = typeof oauthState === "string" ? oauthState.trim() : "";
  if (!normalizedState) {
    return false;
  }
  const pool = await requireDb(config);
  await pool.query(
    `
      INSERT INTO tex64_auth_requests (oauth_state, payload, created_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (oauth_state)
      DO UPDATE SET
        payload = EXCLUDED.payload,
        created_at = NOW();
    `,
    [normalizedState, JSON.stringify(payload ?? {})]
  );
  return true;
};

export const takeAuthRequestRecord = async (config, oauthState) => {
  const normalizedState = typeof oauthState === "string" ? oauthState.trim() : "";
  if (!normalizedState) {
    return null;
  }
  const pool = await requireDb(config);
  const result = await pool.query(
    `
      DELETE FROM tex64_auth_requests
      WHERE oauth_state = $1
      RETURNING payload;
    `,
    [normalizedState]
  );
  const payload = result.rows[0]?.payload;
  return payload && typeof payload === "object" ? payload : null;
};

export const pruneAuthRequestRecords = async (config, maxAgeMs) => {
  const ttlMs = Math.max(0, parseInteger(maxAgeMs, 0));
  if (ttlMs <= 0) {
    return 0;
  }
  const pool = await requireDb(config);
  const result = await pool.query(
    `
      DELETE FROM tex64_auth_requests
      WHERE created_at < NOW() - ($1 * INTERVAL '1 millisecond');
    `,
    [ttlMs]
  );
  return Math.max(0, parseInteger(result.rowCount, 0));
};

export const persistRefreshTokenRecord = async (config, payload) => {
  const refreshToken =
    typeof payload?.refreshToken === "string" ? payload.refreshToken.trim() : "";
  const userId = typeof payload?.userId === "string" ? payload.userId.trim() : "";
  if (!refreshToken || !userId) {
    return { ok: false, reason: "INVALID" };
  }
  const expiresAtEpochSec = parseInteger(payload?.expiresAtEpochSec, 0);
  if (!Number.isFinite(expiresAtEpochSec) || expiresAtEpochSec <= 0) {
    return { ok: false, reason: "INVALID_EXPIRY" };
  }
  const tokenHash = hashToken(refreshToken);
  const deviceId =
    typeof payload?.deviceId === "string" && payload.deviceId.trim()
      ? payload.deviceId.trim()
      : null;
  const metadata = normalizeObject(payload?.metadata);
  const pool = await requireDb(config);
  await pool.query(
    `
      INSERT INTO tex64_refresh_tokens (
        token_hash,
        user_id,
        device_id,
        expires_at,
        revoked_at,
        replaced_by_hash,
        metadata,
        updated_at
      )
      VALUES ($1, $2, $3, to_timestamp($4), NULL, NULL, $5::jsonb, NOW())
      ON CONFLICT (token_hash)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        device_id = EXCLUDED.device_id,
        expires_at = EXCLUDED.expires_at,
        revoked_at = NULL,
        replaced_by_hash = NULL,
        metadata = EXCLUDED.metadata,
        updated_at = NOW();
    `,
    [tokenHash, userId, deviceId, expiresAtEpochSec, JSON.stringify(metadata)]
  );
  return { ok: true };
};

export const getRefreshTokenRecord = async (config, refreshToken) => {
  const normalizedToken =
    typeof refreshToken === "string" ? refreshToken.trim() : "";
  if (!normalizedToken) {
    return null;
  }
  const pool = await requireDb(config);
  const tokenHash = hashToken(normalizedToken);
  const result = await pool.query(
    `
      SELECT *
      FROM tex64_refresh_tokens
      WHERE token_hash = $1
      LIMIT 1;
    `,
    [tokenHash]
  );
  return normalizeRefreshTokenRow(result.rows[0] ?? null);
};

export const rotateRefreshTokenRecord = async (config, payload) => {
  const oldRefreshToken =
    typeof payload?.oldRefreshToken === "string" ? payload.oldRefreshToken.trim() : "";
  const newRefreshToken =
    typeof payload?.newRefreshToken === "string" ? payload.newRefreshToken.trim() : "";
  const userId = typeof payload?.userId === "string" ? payload.userId.trim() : "";
  const deviceId =
    typeof payload?.deviceId === "string" && payload.deviceId.trim()
      ? payload.deviceId.trim()
      : null;
  const newExpiresAtEpochSec = parseInteger(payload?.newExpiresAtEpochSec, 0);
  if (!oldRefreshToken || !newRefreshToken || !userId || newExpiresAtEpochSec <= 0) {
    return { ok: false, reason: "INVALID" };
  }
  const oldHash = hashToken(oldRefreshToken);
  const newHash = hashToken(newRefreshToken);
  const metadata = normalizeObject(payload?.metadata);
  const pool = await requireDb(config);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1));`, [oldHash]);
    const existingResult = await client.query(
      `
        SELECT *
        FROM tex64_refresh_tokens
        WHERE token_hash = $1
        LIMIT 1;
      `,
      [oldHash]
    );
    const existing = normalizeRefreshTokenRow(existingResult.rows[0] ?? null);
    if (!existing) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "NOT_FOUND" };
    }
    if (existing.userId !== userId) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "MISMATCH" };
    }
    if (deviceId && existing.deviceId && existing.deviceId !== deviceId) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "MISMATCH" };
    }
    const expiresAtMs = Date.parse(existing.expiresAt || "");
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "EXPIRED" };
    }
    if (existing.revokedAt || existing.replacedByHash) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "REVOKED" };
    }
    await client.query(
      `
        UPDATE tex64_refresh_tokens
        SET revoked_at = NOW(), replaced_by_hash = $2, updated_at = NOW()
        WHERE token_hash = $1;
      `,
      [oldHash, newHash]
    );
    await client.query(
      `
        INSERT INTO tex64_refresh_tokens (
          token_hash,
          user_id,
          device_id,
          expires_at,
          revoked_at,
          replaced_by_hash,
          metadata,
          updated_at
        )
        VALUES ($1, $2, $3, to_timestamp($4), NULL, NULL, $5::jsonb, NOW())
        ON CONFLICT (token_hash)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          device_id = EXCLUDED.device_id,
          expires_at = EXCLUDED.expires_at,
          revoked_at = NULL,
          replaced_by_hash = NULL,
          metadata = EXCLUDED.metadata,
          updated_at = NOW();
      `,
      [newHash, userId, deviceId, newExpiresAtEpochSec, JSON.stringify(metadata)]
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

export const revokeRefreshTokensForUserDevice = async (
  config,
  payload = {}
) => {
  const userId = typeof payload?.userId === "string" ? payload.userId.trim() : "";
  if (!userId) {
    return 0;
  }
  const deviceId =
    typeof payload?.deviceId === "string" && payload.deviceId.trim()
      ? payload.deviceId.trim()
      : null;
  const allDevices = payload?.allDevices === true;
  const pool = await requireDb(config);
  const result = allDevices
    ? await pool.query(
        `
          UPDATE tex64_refresh_tokens
          SET revoked_at = NOW(), updated_at = NOW()
          WHERE user_id = $1
            AND revoked_at IS NULL;
        `,
        [userId]
      )
    : await pool.query(
        `
          UPDATE tex64_refresh_tokens
          SET revoked_at = NOW(), updated_at = NOW()
          WHERE user_id = $1
            AND (device_id = $2 OR $2 IS NULL)
            AND revoked_at IS NULL;
        `,
        [userId, deviceId]
      );
  return Math.max(0, parseInteger(result.rowCount, 0));
};

export const hasProcessedSubscriptionEventRecord = async (
  config,
  source,
  eventId
) => {
  const normalizedSource = typeof source === "string" ? source.trim() : "";
  const normalizedEventId =
    typeof eventId === "string" ? eventId.trim() : "";
  if (!normalizedSource || !normalizedEventId) {
    return false;
  }
  const pool = await requireDb(config);
  const result = await pool.query(
    `
      SELECT 1
      FROM tex64_processed_subscription_events
      WHERE source = $1
        AND event_id = $2
      LIMIT 1;
    `,
    [normalizedSource, normalizedEventId]
  );
  return Boolean(result.rows[0]);
};

export const recordProcessedSubscriptionEvent = async (
  config,
  payload = {}
) => {
  const source = typeof payload?.source === "string" ? payload.source.trim() : "";
  const eventId =
    typeof payload?.eventId === "string" ? payload.eventId.trim() : "";
  if (!source || !eventId) {
    return { tracked: false, duplicate: false };
  }
  const userId =
    typeof payload?.userId === "string" && payload.userId.trim()
      ? payload.userId.trim()
      : null;
  const metadata = normalizeObject(payload?.payload);
  const pool = await requireDb(config);
  const result = await pool.query(
    `
      INSERT INTO tex64_processed_subscription_events (
        source,
        event_id,
        user_id,
        payload,
        created_at
      )
      VALUES ($1, $2, $3, $4::jsonb, NOW())
      ON CONFLICT (source, event_id)
      DO NOTHING
      RETURNING source;
    `,
    [source, eventId, userId, JSON.stringify(metadata)]
  );
  return {
    tracked: true,
    duplicate: !result.rows[0],
  };
};

export const pruneProcessedSubscriptionEventRecords = async (
  config,
  maxAgeMs
) => {
  const ttlMs = Math.max(0, parseInteger(maxAgeMs, 0));
  if (ttlMs <= 0) {
    return 0;
  }
  const pool = await requireDb(config);
  const result = await pool.query(
    `
      DELETE FROM tex64_processed_subscription_events
      WHERE created_at < NOW() - ($1 * INTERVAL '1 millisecond');
    `,
    [ttlMs]
  );
  return Math.max(0, parseInteger(result.rowCount, 0));
};

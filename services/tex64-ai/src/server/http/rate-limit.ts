import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { Pool, type PoolClient } from "pg";
import type { AgentRunQuotaConfiguration } from "@/server/config/production";
import { ProductionConfigurationError } from "@/server/config/production";
import {
  hasVercelRuntimeSignal,
  isProductionRuntime,
  type RuntimeEnvironment,
} from "@/server/config/runtime-environment";

type Bucket = {
  count: number;
  resetsAt: number;
};

type Reservation = {
  expiresAt: number;
  fingerprint: string;
};

export type RateLimitPolicy = {
  action: string;
  kind: "identity" | "network" | "global" | "mutation";
  key: string;
  limit: number;
  windowMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

const localGlobal = globalThis as typeof globalThis & {
  __tex64RateLimitBuckets?: Map<string, Bucket>;
  __tex64RateLimitReservations?: Map<string, Reservation>;
  __tex64RateLimitPool?: { connectionString: string; pool: Pool };
};

const localBuckets = (localGlobal.__tex64RateLimitBuckets ??= new Map());
const localReservations = (localGlobal.__tex64RateLimitReservations ??= new Map());
const MAX_LOCAL_ENTRIES = 10_000;
const RESERVATION_TTL_MS = 48 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

export async function takeRateLimit(input: {
  key: string;
  limit: number;
  windowMs: number;
  now?: number;
  environment?: RuntimeEnvironment;
}): Promise<RateLimitResult> {
  return takeRateLimits({
    policies: [
      {
        action: "mutation",
        kind: "mutation",
        key: input.key,
        limit: input.limit,
        windowMs: input.windowMs,
      },
    ],
    now: input.now,
    environment: input.environment,
  });
}

export async function takeRateLimits(input: {
  policies: readonly RateLimitPolicy[];
  reservationKey?: string;
  now?: number;
  environment?: RuntimeEnvironment;
}): Promise<RateLimitResult> {
  const environment = input.environment ?? process.env;
  const policies = validatePolicies(input.policies);
  if (isProductionRuntime(environment)) {
    return takeSharedRateLimits({
      policies,
      reservationKey: input.reservationKey,
      environment,
    });
  }
  return takeLocalRateLimits({
    policies,
    reservationKey: input.reservationKey,
    now: input.now ?? Date.now(),
  });
}

export function agentRunRateLimitInput(input: {
  request: Request;
  userId: string;
  documentId: string;
  idempotencyKey: string;
  quota: AgentRunQuotaConfiguration;
  environment?: RuntimeEnvironment;
}): { policies: RateLimitPolicy[]; reservationKey: string } {
  const environment = input.environment ?? process.env;
  const network = trustedClientAddress(input.request, environment);
  return {
    policies: [
      {
        action: "agent:start",
        kind: "identity",
        key: input.userId,
        limit: input.quota.identityRunsPerHour,
        windowMs: HOUR_MS,
      },
      {
        action: "agent:start",
        kind: "network",
        key: network,
        limit: input.quota.networkRunsPerHour,
        windowMs: HOUR_MS,
      },
      {
        action: "agent:start",
        kind: "global",
        key: "tex64-ai",
        limit: input.quota.globalRunsPerHour,
        windowMs: HOUR_MS,
      },
    ],
    reservationKey: `${input.userId}:${input.documentId}:${input.idempotencyKey}`,
  };
}

export function documentMutationRateLimitInput(input: {
  request: Request;
  userId: string;
  action: "create" | "patch";
  reservationKey?: string;
  environment?: RuntimeEnvironment;
}): { policies: RateLimitPolicy[]; reservationKey?: string } {
  const environment = input.environment ?? process.env;
  const network = trustedClientAddress(input.request, environment);
  const configuration =
    input.action === "create"
      ? { identity: 30, network: 60, global: 1_000, windowMs: HOUR_MS }
      : {
          identity: 120,
          network: 240,
          global: 5_000,
          windowMs: 60 * 1_000,
        };
  const action = `document:${input.action}`;
  return {
    policies: [
      {
        action,
        kind: "identity",
        key: input.userId,
        limit: configuration.identity,
        windowMs: configuration.windowMs,
      },
      {
        action,
        kind: "network",
        key: network,
        limit: configuration.network,
        windowMs: configuration.windowMs,
      },
      {
        action,
        kind: "global",
        key: "tex64-ai",
        limit: configuration.global,
        windowMs: configuration.windowMs,
      },
    ],
    ...(input.reservationKey
      ? { reservationKey: `${input.userId}:${input.reservationKey}` }
      : {}),
  };
}

export function trustedClientAddress(
  request: Request,
  environment: RuntimeEnvironment = process.env,
): string {
  if (!isProductionRuntime(environment)) {
    return firstValidAddress(
      request.headers.get("x-vercel-forwarded-for") ??
        request.headers.get("x-forwarded-for"),
    ) ?? "local-development";
  }

  const headerName = hasVercelRuntimeSignal(environment)
    ? "x-vercel-forwarded-for"
    : environment.TEX64_TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (!headerName || !/^[a-z0-9-]{1,100}$/.test(headerName)) {
    throw new ProductionConfigurationError(
      "A trusted client IP header is required for anonymous production quota.",
    );
  }
  const address = firstValidAddress(request.headers.get(headerName));
  if (!address) {
    throw new ProductionConfigurationError(
      "The trusted client network identity is unavailable.",
    );
  }
  return address;
}

function takeLocalRateLimits(input: {
  policies: readonly RateLimitPolicy[];
  reservationKey?: string;
  now: number;
}): RateLimitResult {
  pruneLocalEntries(input.now);
  const fingerprint = policyFingerprint(input.policies);
  if (input.reservationKey) {
    const reservation = localReservations.get(input.reservationKey);
    if (reservation && reservation.expiresAt > input.now) {
      if (reservation.fingerprint !== fingerprint) {
        throw new Error("Rate limit reservation was reused with different policies.");
      }
      return {
        allowed: true,
        remaining: Math.min(...input.policies.map((policy) => policy.limit)),
        retryAfterSeconds: 0,
      };
    }
  }

  const candidates = input.policies.map((policy) => {
    const windowStart = Math.floor(input.now / policy.windowMs) * policy.windowMs;
    const bucketKey = `${policy.action}:${policy.kind}:${policy.key}:${policy.windowMs}:${windowStart}`;
    const existing = localBuckets.get(bucketKey);
    return {
      policy,
      bucketKey,
      bucket: existing ?? { count: 0, resetsAt: windowStart + policy.windowMs },
    };
  });
  const denied = candidates.find(({ policy, bucket }) => bucket.count >= policy.limit);
  if (denied) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((denied.bucket.resetsAt - input.now) / 1_000),
      ),
    };
  }

  for (const candidate of candidates) {
    candidate.bucket.count += 1;
    localBuckets.set(candidate.bucketKey, candidate.bucket);
  }
  if (input.reservationKey) {
    localReservations.set(input.reservationKey, {
      expiresAt: input.now + RESERVATION_TTL_MS,
      fingerprint,
    });
  }
  boundLocalMap(localBuckets);
  boundLocalMap(localReservations);

  return {
    allowed: true,
    remaining: Math.min(
      ...candidates.map(({ policy, bucket }) => policy.limit - bucket.count),
    ),
    retryAfterSeconds: Math.max(
      1,
      Math.ceil(
        (Math.min(...candidates.map(({ bucket }) => bucket.resetsAt)) - input.now) /
          1_000,
      ),
    ),
  };
}

async function takeSharedRateLimits(input: {
  policies: readonly RateLimitPolicy[];
  reservationKey?: string;
  environment: RuntimeEnvironment;
}): Promise<RateLimitResult> {
  const pool = sharedPool(input.environment);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const secret = rateLimitSecret(input.environment);
    const fingerprint = policyFingerprint(input.policies);
    if (input.reservationKey) {
      const replay = await reserveRequest(
        client,
        input.policies[0]?.action ?? "mutation",
        scopeDigest(input.reservationKey, secret),
        scopeDigest(fingerprint, secret),
      );
      if (replay) {
        await client.query("COMMIT");
        return {
          allowed: true,
          remaining: Math.min(...input.policies.map((policy) => policy.limit)),
          retryAfterSeconds: 0,
        };
      }
    }

    const clock = await client.query<{ now_ms: string }>(
      "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms",
    );
    const now = Number(clock.rows[0]?.now_ms);
    if (!Number.isSafeInteger(now)) throw new Error("Database clock is unavailable.");

    const counters: Array<{ count: number; resetsAt: number; limit: number }> = [];
    const sortedPolicies = [...input.policies].sort((left, right) =>
      `${left.action}:${left.kind}:${left.key}`.localeCompare(
        `${right.action}:${right.kind}:${right.key}`,
      ),
    );
    for (const policy of sortedPolicies) {
      const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
      const resetsAt = windowStart + policy.windowMs;
      const result = await client.query<{ count: number }>(
        `INSERT INTO public.tex64_rate_limit_buckets
          (action, scope_kind, scope_hash, window_start, resets_at, count)
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (action, scope_kind, scope_hash, window_start)
         DO UPDATE SET count = public.tex64_rate_limit_buckets.count + 1
         WHERE public.tex64_rate_limit_buckets.count < $6
         RETURNING count`,
        [
          policy.action,
          policy.kind,
          scopeDigest(policy.key, secret),
          new Date(windowStart),
          new Date(resetsAt),
          policy.limit,
        ],
      );
      if (!result.rows[0]) throw new SharedRateLimitDenied(resetsAt, now);
      counters.push({ count: result.rows[0].count, resetsAt, limit: policy.limit });
    }

    await pruneSharedEntries(client);
    await client.query("COMMIT");
    return {
      allowed: true,
      remaining: Math.min(...counters.map((counter) => counter.limit - counter.count)),
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((Math.min(...counters.map((counter) => counter.resetsAt)) - now) / 1_000),
      ),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof SharedRateLimitDenied) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((error.resetsAt - error.now) / 1_000),
        ),
      };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function reserveRequest(
  client: PoolClient,
  action: string,
  reservationHash: string,
  policyHash: string,
): Promise<boolean> {
  const existing = await client.query<{ policy_hash: string }>(
    `SELECT policy_hash FROM public.tex64_rate_limit_reservations
     WHERE action = $1 AND reservation_hash = $2 AND expires_at > clock_timestamp()
     FOR UPDATE`,
    [action, reservationHash],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].policy_hash !== policyHash) {
      throw new Error("Rate limit reservation was reused with different policies.");
    }
    return true;
  }

  await client.query(
    `DELETE FROM public.tex64_rate_limit_reservations
     WHERE action = $1 AND reservation_hash = $2 AND expires_at <= clock_timestamp()`,
    [action, reservationHash],
  );
  const inserted = await client.query(
    `INSERT INTO public.tex64_rate_limit_reservations
      (action, reservation_hash, policy_hash, expires_at)
     VALUES ($1, $2, $3, clock_timestamp() + interval '48 hours')
     ON CONFLICT DO NOTHING
     RETURNING reservation_hash`,
    [action, reservationHash, policyHash],
  );
  if (inserted.rowCount === 1) return false;

  const raced = await client.query<{ policy_hash: string }>(
    `SELECT policy_hash FROM public.tex64_rate_limit_reservations
     WHERE action = $1 AND reservation_hash = $2 AND expires_at > clock_timestamp()
     FOR UPDATE`,
    [action, reservationHash],
  );
  if (!raced.rows[0] || raced.rows[0].policy_hash !== policyHash) {
    throw new Error("Rate limit reservation conflict could not be resolved.");
  }
  return true;
}

async function pruneSharedEntries(client: PoolClient): Promise<void> {
  await client.query(
    `WITH expired AS (
       SELECT ctid FROM public.tex64_rate_limit_buckets
       WHERE resets_at <= clock_timestamp()
       LIMIT 100
     )
     DELETE FROM public.tex64_rate_limit_buckets
     WHERE ctid IN (SELECT ctid FROM expired)`,
  );
  await client.query(
    `WITH expired AS (
       SELECT ctid FROM public.tex64_rate_limit_reservations
       WHERE expires_at <= clock_timestamp()
       LIMIT 100
     )
     DELETE FROM public.tex64_rate_limit_reservations
     WHERE ctid IN (SELECT ctid FROM expired)`,
  );
}

function sharedPool(environment: RuntimeEnvironment): Pool {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new ProductionConfigurationError(
      "DATABASE_URL is required for shared production quota.",
    );
  }
  const existing = localGlobal.__tex64RateLimitPool;
  if (existing?.connectionString === connectionString) return existing.pool;
  const pool = new Pool({ connectionString, max: 5 });
  localGlobal.__tex64RateLimitPool = { connectionString, pool };
  return pool;
}

function rateLimitSecret(environment: RuntimeEnvironment): string {
  const secret = environment.TEX64_SESSION_SECRET?.trim();
  if (!secret) {
    throw new ProductionConfigurationError(
      "TEX64_SESSION_SECRET is required for private quota keys.",
    );
  }
  return secret;
}

function scopeDigest(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function policyFingerprint(policies: readonly RateLimitPolicy[]): string {
  return [...policies]
    .sort((left, right) =>
      `${left.action}:${left.kind}:${left.key}`.localeCompare(
        `${right.action}:${right.kind}:${right.key}`,
      ),
    )
    .map(
      (policy) =>
        `${policy.action}:${policy.kind}:${policy.key}:${policy.limit}:${policy.windowMs}`,
    )
    .join("|");
}

function validatePolicies(policies: readonly RateLimitPolicy[]): RateLimitPolicy[] {
  if (policies.length < 1 || policies.length > 10) {
    throw new Error("Rate limit policy count is invalid.");
  }
  return policies.map((policy) => {
    if (
      !policy.action ||
      !policy.key ||
      !Number.isSafeInteger(policy.limit) ||
      policy.limit < 1 ||
      !Number.isSafeInteger(policy.windowMs) ||
      policy.windowMs < 1
    ) {
      throw new Error("Rate limit policy is invalid.");
    }
    return policy;
  });
}

function firstValidAddress(value: string | null): string | null {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 100 || candidate.includes(",")) return null;
  return isIP(candidate) ? candidate.toLowerCase() : null;
}

function pruneLocalEntries(now: number): void {
  for (const [key, bucket] of localBuckets) {
    if (bucket.resetsAt <= now) localBuckets.delete(key);
  }
  for (const [key, reservation] of localReservations) {
    if (reservation.expiresAt <= now) localReservations.delete(key);
  }
}

function boundLocalMap<T>(map: Map<string, T>): void {
  while (map.size > MAX_LOCAL_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

class SharedRateLimitDenied extends Error {
  constructor(
    readonly resetsAt: number,
    readonly now: number,
  ) {
    super("Shared rate limit exceeded.");
    this.name = "SharedRateLimitDenied";
  }
}

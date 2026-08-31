import crypto from "node:crypto";
import { isIP } from "node:net";

import { getAnonymousAppUser } from "./auth.js";
import {
  admitAnonymousDeviceForNetwork,
  isDatabaseConfigured,
  reconcileAnonymousNetworkUsage,
  reserveAnonymousNetworkUsage,
} from "./db-adapter.js";
import { ApiError } from "./http.js";
import { isStateFallbackEnabled } from "./state-backend.js";
import {
  loadPlatformState,
  savePlatformState,
  withPlatformStateLock,
} from "./state-store.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

const readHeader = (req, name) => {
  const headers = req?.headers;
  if (!headers) return null;
  const lowerName = String(name || "").toLowerCase();
  if (typeof headers.get === "function") {
    const value = headers.get(lowerName);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  if (typeof headers !== "object") return null;
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === lowerName
  );
  const value = key ? headers[key] : null;
  if (Array.isArray(value)) return value.length === 1 ? String(value[0]).trim() : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const normalizeAddress = (value) => {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  // A trusted proxy must produce one canonical address. Accepting a list and
  // selecting one element would reintroduce client-controlled XFF semantics.
  if (!candidate || candidate.length > 100 || candidate.includes(",")) return null;
  return isIP(candidate) ? candidate.toLowerCase() : null;
};

const productionRuntime = (config) =>
  String(config?.runtimeEnvironment || process.env.NODE_ENV || "")
    .trim()
    .toLowerCase() === "production";

/**
 * Resolve a network identity only from a source the deployment controls.
 * Vercel documents x-vercel-forwarded-for as its platform copy of the client
 * address, so it is trusted only when the non-request VERCEL runtime signal is
 * present. We intentionally never consume x-forwarded-for implicitly. A
 * custom production header requires explicit configuration plus an upstream
 * guarantee that the proxy overwrites it and the origin cannot be reached.
 */
export const resolveTrustedAnonymousClientAddress = (req, config) => {
  if (config?.vercelRuntime === true) {
    return normalizeAddress(readHeader(req, "x-vercel-forwarded-for"));
  }

  if (productionRuntime(config)) {
    const configuredHeader =
      typeof config?.trustedClientIpHeader === "string"
        ? config.trustedClientIpHeader.trim().toLowerCase()
        : "";
    if (!/^[a-z0-9-]{1,100}$/.test(configuredHeader)) return null;
    return normalizeAddress(readHeader(req, configuredHeader));
  }

  const socketAddress =
    req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? null;
  // Unit handlers and local Electron development do not always expose a
  // socket. A loopback sentinel keeps fallback behavior deterministic without
  // trusting caller-supplied forwarding headers.
  return normalizeAddress(socketAddress) || "127.0.0.1";
};

const keyedDigest = (config, purpose, value) => {
  const secret =
    typeof config?.jwtSecret === "string" ? config.jwtSecret.trim() : "";
  if (!secret) {
    throw new ApiError(
      "INTERNAL_ERROR",
      "Anonymous AI access is not configured.",
      500
    );
  }
  return crypto
    .createHmac("sha256", secret)
    .update(`tex64-anonymous-abuse-v1\0${purpose}\0${value}`)
    .digest("hex");
};

export const hashAnonymousNetworkAddress = (address, config) =>
  keyedDigest(config, "network", address);

const hashAnonymousDevice = (deviceUserId, config) =>
  keyedDigest(config, "device", deviceUserId);

const integerAtLeast = (value, fallback, minimum = 1) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
};

const abusePolicy = (config) => ({
  deviceWindowSec: integerAtLeast(config?.anonymousDeviceWindowSec, 24 * 60 * 60, 60),
  maxDevices: integerAtLeast(config?.anonymousDevicesPerIp, 24),
  aiWindowSec: integerAtLeast(config?.anonymousAiWindowSec, 60 * 60, 60),
  maxRequests: integerAtLeast(config?.anonymousAiRequestsPerIp, 120),
  maxTokens: integerAtLeast(config?.anonymousAiReservedTokensPerIp, 400_000),
});

const windowBounds = (nowMs, windowSec) => {
  const windowMs = windowSec * 1_000;
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  return {
    startMs,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + windowMs).toISOString(),
  };
};

const ensureAbuseWindows = (state) => {
  if (
    !state.anonymousAbuseWindows ||
    typeof state.anonymousAbuseWindows !== "object" ||
    Array.isArray(state.anonymousAbuseWindows)
  ) {
    state.anonymousAbuseWindows = {};
  }
  return state.anonymousAbuseWindows;
};

const pruneFallbackWindows = (windows, nowMs) => {
  for (const [key, value] of Object.entries(windows)) {
    const endMs = Date.parse(value?.windowEnd || "");
    if (!Number.isFinite(endMs) || endMs <= nowMs) delete windows[key];
  }
};

const fallbackDeviceAdmission = async ({
  config,
  networkHash,
  deviceHash,
  policy,
  nowMs = Date.now(),
}) =>
  withPlatformStateLock(config, async () => {
    const state = await loadPlatformState(config);
    const windows = ensureAbuseWindows(state);
    pruneFallbackWindows(windows, nowMs);
    const bounds = windowBounds(nowMs, policy.deviceWindowSec);
    const key = `devices:${networkHash}:${bounds.startMs}`;
    const current = windows[key] || {
      windowKind: "devices",
      windowStart: bounds.start,
      windowEnd: bounds.end,
      deviceHashes: [],
      reservedTokens: 0,
      usedRequests: 0,
    };
    const hashes = Array.isArray(current.deviceHashes)
      ? current.deviceHashes.filter((value) => HASH_PATTERN.test(value))
      : [];
    if (!hashes.includes(deviceHash)) {
      if (hashes.length >= policy.maxDevices) return null;
      hashes.push(deviceHash);
    }
    current.deviceHashes = hashes;
    windows[key] = current;
    await savePlatformState(config, state);
    return {
      windowStart: current.windowStart,
      windowEnd: current.windowEnd,
      deviceCount: hashes.length,
    };
  });

const fallbackNetworkReservation = async ({
  config,
  networkHash,
  reservedTokens,
  reservedRequests,
  policy,
  nowMs = Date.now(),
}) =>
  withPlatformStateLock(config, async () => {
    const state = await loadPlatformState(config);
    const windows = ensureAbuseWindows(state);
    pruneFallbackWindows(windows, nowMs);
    const bounds = windowBounds(nowMs, policy.aiWindowSec);
    const key = `ai:${networkHash}:${bounds.startMs}`;
    const current = windows[key] || {
      windowKind: "ai",
      windowStart: bounds.start,
      windowEnd: bounds.end,
      deviceHashes: [],
      reservedTokens: 0,
      usedRequests: 0,
    };
    const nextTokens = Math.max(0, Number(current.reservedTokens) || 0) + reservedTokens;
    const nextRequests = Math.max(0, Number(current.usedRequests) || 0) + reservedRequests;
    if (nextTokens > policy.maxTokens || nextRequests > policy.maxRequests) return null;
    current.reservedTokens = nextTokens;
    current.usedRequests = nextRequests;
    windows[key] = current;
    await savePlatformState(config, state);
    return {
      windowStart: current.windowStart,
      windowEnd: current.windowEnd,
      reservedTokens: nextTokens,
      usedRequests: nextRequests,
    };
  });

const fallbackNetworkReconciliation = async ({
  config,
  networkHash,
  windowStart,
  reservedTokens,
  actualTokens,
}) =>
  withPlatformStateLock(config, async () => {
    const state = await loadPlatformState(config);
    const windows = ensureAbuseWindows(state);
    const startMs = Date.parse(windowStart);
    if (!Number.isFinite(startMs)) return null;
    const key = `ai:${networkHash}:${startMs}`;
    const current = windows[key];
    if (!current) return null;
    current.reservedTokens = Math.max(
      0,
      (Number(current.reservedTokens) || 0) + actualTokens - reservedTokens
    );
    await savePlatformState(config, state);
    return {
      windowStart: current.windowStart,
      windowEnd: current.windowEnd,
      reservedTokens: current.reservedTokens,
      usedRequests: Math.max(0, Number(current.usedRequests) || 0),
    };
  });

const requireAbuseBackend = (config) => {
  if (isDatabaseConfigured(config)) return "database";
  // A process-local fallback lock cannot coordinate separate serverless
  // instances. Production anonymous traffic therefore requires the shared DB
  // even if an operator enabled the general development fallback.
  if (productionRuntime(config)) {
    throw new ApiError(
      "STATE_BACKEND_UNAVAILABLE",
      "Anonymous AI access is temporarily unavailable.",
      503
    );
  }
  if (isStateFallbackEnabled(config)) return "fallback";
  throw new ApiError(
    "STATE_BACKEND_UNAVAILABLE",
    "Anonymous AI access is temporarily unavailable.",
    503
  );
};

const admitDevice = async ({ config, networkHash, deviceHash, policy }) => {
  if (requireAbuseBackend(config) === "database") {
    return admitAnonymousDeviceForNetwork(config, {
      networkHash,
      deviceHash,
      windowSec: policy.deviceWindowSec,
      maxDevices: policy.maxDevices,
    });
  }
  return fallbackDeviceAdmission({ config, networkHash, deviceHash, policy });
};

/**
 * Validate and admit an anonymous device before any user/subscription rows are
 * created. The returned network hash is internal only and must never be added
 * to an API payload.
 */
export const loadAdmittedAnonymousAppUser = async (req, config) => {
  const anonymous = getAnonymousAppUser(req, config);
  if (anonymous.reason === "INVALID_DEVICE_ID") {
    throw new ApiError(
      "VALIDATION_ERROR",
      "Anonymous app identity is invalid.",
      400
    );
  }
  if (!anonymous.ok) {
    throw new ApiError(
      "AUTH_REQUIRED",
      "Authorization token or anonymous app identity is required.",
      401
    );
  }
  const address = resolveTrustedAnonymousClientAddress(req, config);
  if (!address) {
    throw new ApiError(
      "ANONYMOUS_NETWORK_UNAVAILABLE",
      "Anonymous AI access is temporarily unavailable.",
      503
    );
  }
  const networkHash = hashAnonymousNetworkAddress(address, config);
  const deviceHash = hashAnonymousDevice(anonymous.user.id, config);
  const policy = abusePolicy(config);
  const admitted = await admitDevice({ config, networkHash, deviceHash, policy });
  if (!admitted) {
    throw new ApiError(
      "ANONYMOUS_ACCESS_LIMITED",
      "Anonymous AI access is temporarily limited.",
      429
    );
  }
  return { user: anonymous.user, networkHash };
};

export const createAnonymousAiUsageGuard = ({ config, networkHash }) => {
  const policy = abusePolicy(config);
  let activeReservation = null;
  return {
    reserve: async ({ reservedTokens, reservedRequests = 1 }) => {
      const tokens = Math.max(0, Math.round(Number(reservedTokens) || 0));
      const requests = Math.max(1, Math.round(Number(reservedRequests) || 1));
      const result =
        requireAbuseBackend(config) === "database"
          ? await reserveAnonymousNetworkUsage(config, {
              networkHash,
              windowSec: policy.aiWindowSec,
              reservedTokens: tokens,
              reservedRequests: requests,
              maxTokens: policy.maxTokens,
              maxRequests: policy.maxRequests,
            })
          : await fallbackNetworkReservation({
              config,
              networkHash,
              reservedTokens: tokens,
              reservedRequests: requests,
              policy,
            });
      if (!result) {
        throw new ApiError(
          "ANONYMOUS_ACCESS_LIMITED",
          "Anonymous AI access is temporarily limited.",
          429
        );
      }
      activeReservation = {
        windowStart: result.windowStart,
        reservedTokens: tokens,
      };
      return result;
    },
    reconcile: async ({ reservedTokens, actualTokens }) => {
      if (!activeReservation) return null;
      const reserved = Math.max(0, Math.round(Number(reservedTokens) || 0));
      const actual = Math.max(0, Math.round(Number(actualTokens) || 0));
      const input = {
        config,
        networkHash,
        windowStart: activeReservation.windowStart,
        reservedTokens: reserved,
        actualTokens: actual,
      };
      const result =
        requireAbuseBackend(config) === "database"
          ? await reconcileAnonymousNetworkUsage(config, input)
          : await fallbackNetworkReconciliation(input);
      activeReservation = null;
      return result;
    },
  };
};

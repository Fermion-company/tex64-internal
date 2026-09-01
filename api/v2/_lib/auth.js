import crypto from "node:crypto";
import { ApiError, parseBearerToken } from "./http.js";

const toBase64Url = (value) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromBase64Url = (value) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64");
};

const decodeJsonSegment = (segment) => {
  try {
    return JSON.parse(fromBase64Url(segment).toString("utf8"));
  } catch {
    return null;
  }
};

const signHs256 = (headerSegment, payloadSegment, secret) => {
  const body = `${headerSegment}.${payloadSegment}`;
  return toBase64Url(crypto.createHmac("sha256", secret).update(body).digest());
};

const sanitizeString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const sanitizeUserId = (value) => {
  const raw = sanitizeString(value);
  if (!raw) {
    return null;
  }
  return raw.slice(0, 128);
};

const deriveUserIdFromEmail = (email) => {
  const normalized = sanitizeString(email)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return `usr_${digest}`;
};

const buildTokenId = () => {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return crypto.randomBytes(18).toString("hex");
};

const extractUserClaims = (payload) => {
  const sub = sanitizeUserId(payload?.sub ?? payload?.uid ?? payload?.userId ?? null);
  const email = sanitizeString(payload?.email);
  const name = sanitizeString(payload?.name ?? payload?.displayName);
  const userId = sub || deriveUserIdFromEmail(email);
  if (!userId) {
    throw new ApiError("AUTH_REQUIRED", "Token payload is missing a user identifier.", 401);
  }
  return {
    id: userId,
    email,
    name,
    plan: sanitizeString(payload?.plan)?.toLowerCase() ?? null,
    deviceId: sanitizeString(payload?.deviceId) ?? "",
  };
};

const decodeAndVerifyJwt = (token, config, expectedType = null) => {
  if (!token || typeof token !== "string") {
    throw new ApiError("AUTH_REQUIRED", "Token is missing.", 401);
  }
  if (!config?.jwtSecret) {
    throw new ApiError("INTERNAL_ERROR", "JWT verification secret is not configured.", 500);
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new ApiError("AUTH_REQUIRED", "Invalid token format.", 401);
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = decodeJsonSegment(headerSegment);
  const payload = decodeJsonSegment(payloadSegment);
  if (!header || !payload || header.alg !== "HS256" || header.typ !== "JWT") {
    throw new ApiError("AUTH_REQUIRED", "Invalid token header.", 401);
  }
  const expectedSignature = signHs256(headerSegment, payloadSegment, config.jwtSecret);
  const actualBuffer = Buffer.from(signatureSegment);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new ApiError("AUTH_REQUIRED", "Invalid token signature.", 401);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp);
  if (Number.isFinite(exp) && nowSec >= exp) {
    throw new ApiError("TOKEN_EXPIRED", "Token has expired.", 401);
  }
  if (
    expectedType &&
    sanitizeString(payload.typ) &&
    sanitizeString(payload.typ) !== expectedType
  ) {
    throw new ApiError("AUTH_REQUIRED", "Token type is invalid.", 401);
  }
  return payload;
};

const signJwt = (payload, config, expiresInSec) => {
  if (!config?.jwtSecret) {
    throw new ApiError("INTERNAL_ERROR", "JWT signing secret is not configured.", 500);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body = {
    ...payload,
    iat: nowSec,
    exp: nowSec + Math.max(1, Math.round(expiresInSec)),
  };
  const headerSegment = toBase64Url(JSON.stringify(header));
  const payloadSegment = toBase64Url(JSON.stringify(body));
  const signatureSegment = signHs256(headerSegment, payloadSegment, config.jwtSecret);
  return `${headerSegment}.${payloadSegment}.${signatureSegment}`;
};

export const verifyAccessToken = (token, config) => {
  const payload = decodeAndVerifyJwt(token, config, "access");
  return extractUserClaims(payload);
};

export const verifyRefreshToken = (token, config) =>
  decodeAndVerifyJwt(token, config, "refresh");

export const requireAuthenticatedUser = (req, config) => {
  const token = parseBearerToken(req.headers?.authorization);
  if (token) {
    return verifyAccessToken(token, config);
  }
  if (config?.allowDevAuth) {
    const devHeader = sanitizeString(req.headers?.["x-tex64-dev-user"]);
    if (devHeader) {
      const [rawEmail] = devHeader.split(",");
      const email = sanitizeString(rawEmail);
      const id = deriveUserIdFromEmail(email || devHeader);
      return {
        id: id || sanitizeUserId(devHeader) || "usr_dev",
        email: email || null,
        name: "Dev User",
        plan: null,
        deviceId: "",
      };
    }
  }
  throw new ApiError("AUTH_REQUIRED", "Google sign-in is required.", 401);
};

export const issueAccessToken = ({ user, plan, deviceId = "" }, config) =>
  signJwt(
    {
      typ: "access",
      sub: user.id,
      email: user.email ?? undefined,
      name: user.name ?? undefined,
      plan: plan ?? undefined,
      deviceId: sanitizeString(deviceId) || "",
    },
    config,
    Math.max(60, Math.round(config.accessTokenTtlSec || 900))
  );

export const issueRefreshToken = (
  { user, plan, deviceId = "", tokenId = null },
  config
) =>
  signJwt(
    {
      typ: "refresh",
      sub: user.id,
      email: user.email ?? undefined,
      name: user.name ?? undefined,
      plan: plan ?? undefined,
      deviceId: sanitizeString(deviceId) || "",
      jti:
        typeof tokenId === "string" && tokenId.trim()
          ? tokenId.trim()
          : `rt_${buildTokenId()}`,
    },
    config,
    Math.max(60, Math.round(config.refreshTokenTtlSec || 30 * 24 * 60 * 60))
  );

export const issueSessionTokens = ({ user, plan, deviceId = "" }, config) => {
  const refreshTokenId = `rt_${buildTokenId()}`;
  const accessToken = issueAccessToken({ user, plan, deviceId }, config);
  const refreshToken = issueRefreshToken(
    { user, plan, deviceId, tokenId: refreshTokenId },
    config
  );
  return {
    accessToken,
    refreshToken,
    refreshTokenId,
    expiresInSec: Math.max(60, Math.round(config.accessTokenTtlSec || 900)),
    user: {
      id: user.id,
      email: user.email ?? null,
      name: user.name ?? null,
    },
  };
};

export const getRefreshPayload = (refreshToken, config) =>
  verifyRefreshToken(refreshToken, config);

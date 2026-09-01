import crypto from "node:crypto";

export class ApiError extends Error {
  constructor(code, message, statusCode = 500, options = {}) {
    super(message || code || "INTERNAL_ERROR");
    this.name = "ApiError";
    this.code = typeof code === "string" && code ? code : "INTERNAL_ERROR";
    this.statusCode = Number.isFinite(statusCode) ? statusCode : 500;
    this.retryAfterSec = Number.isFinite(options.retryAfterSec)
      ? Math.max(0, Math.round(options.retryAfterSec))
      : null;
    this.details = options.details ?? null;
  }
}

const DEFAULT_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Tex64-Admin-Secret",
  "X-Tex64-Dev-User",
].join(", ");

const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

export const createRequestId = () => {
  if (typeof crypto.randomUUID === "function") {
    return `req_${crypto.randomUUID()}`;
  }
  return `req_${crypto.randomBytes(12).toString("hex")}`;
};

export const setCorsHeaders = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", DEFAULT_ALLOWED_HEADERS);
};

export const handleOptionsRequest = (req, res) => {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
};

export const sendJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
};

const normalizeError = (error) => {
  if (error instanceof ApiError) {
    return error;
  }
  if (error && typeof error === "object") {
    const code =
      typeof error.code === "string" && error.code ? error.code : "INTERNAL_ERROR";
    const message =
      typeof error.message === "string" && error.message ? error.message : code;
    const statusCode = Number.isFinite(error.statusCode) ? error.statusCode : 500;
    return new ApiError(code, message, statusCode, {
      retryAfterSec: error.retryAfterSec,
      details: error.details,
    });
  }
  return new ApiError("INTERNAL_ERROR", "Internal server error.", 500);
};

export const sendApiError = (res, requestId, error) => {
  const normalized = normalizeError(error);
  if (Number.isFinite(normalized.retryAfterSec)) {
    res.setHeader("Retry-After", normalized.retryAfterSec);
  }
  const payload = {
    requestId,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(Number.isFinite(normalized.retryAfterSec)
        ? { retryAfterSec: normalized.retryAfterSec }
        : {}),
      ...(isObject(normalized.details) ? { details: normalized.details } : {}),
    },
  };
  sendJson(res, normalized.statusCode, payload);
};

export const readJsonBody = async (req) => {
  if (isObject(req.body)) {
    return req.body;
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("VALIDATION_ERROR", "Invalid JSON body.", 400);
  }
};

export const parseBearerToken = (authorizationHeader) => {
  if (typeof authorizationHeader !== "string") {
    return null;
  }
  const token = authorizationHeader.trim();
  if (!token) {
    return null;
  }
  const match = token.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const value = match[1].trim();
  return value || null;
};

export const parseUrl = (req) => {
  const host = typeof req.headers?.host === "string" ? req.headers.host : "localhost";
  return new URL(req.url || "/", `http://${host}`);
};

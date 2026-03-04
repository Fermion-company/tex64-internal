const crypto = require("crypto");
const path = require("path");
const fsp = require("fs/promises");
const {
  TOKEN_REFRESH_LEEWAY_MS,
  OAUTH_PENDING_TTL_MS,
  SESSION_TOKEN_ENCRYPTION_KIND,
  DEFAULT_STATE,
  clone,
  isObject,
  parseNumber,
  parseDate,
  parseInteger,
  sanitizeOAuthAuthUrl,
  toBase64Url,
  PlatformApiError,
} = require("./platform-access-shared.cjs");

const coreMethods = {
  canEncryptSession() {
    if (!this.encryptString || !this.decryptString || !this.isEncryptionAvailable) {
      return false;
    }
    try {
      return this.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  },

  encryptSessionToken(value) {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    if (!this.canEncryptSession()) {
      return value;
    }
    try {
      const encrypted = this.encryptString(value);
      if (!encrypted || (typeof encrypted !== "string" && !Buffer.isBuffer(encrypted))) {
        return value;
      }
      const encoded = Buffer.isBuffer(encrypted)
        ? encrypted.toString("base64")
        : Buffer.from(encrypted, "utf8").toString("base64");
      return {
        kind: SESSION_TOKEN_ENCRYPTION_KIND,
        data: encoded,
      };
    } catch {
      return value;
    }
  },

  decryptSessionToken(value) {
    if (typeof value === "string") {
      return value.trim() ? value.trim() : null;
    }
    if (!isObject(value)) {
      return null;
    }
    if (value.kind !== SESSION_TOKEN_ENCRYPTION_KIND || typeof value.data !== "string") {
      return null;
    }
    if (!this.canEncryptSession()) {
      return null;
    }
    try {
      const decrypted = this.decryptString(Buffer.from(value.data, "base64"));
      return typeof decrypted === "string" && decrypted.trim() ? decrypted.trim() : null;
    } catch {
      return null;
    }
  },

  serializeSession(session) {
    if (!isObject(session)) {
      return null;
    }
    const next = { ...session };
    next.accessToken = this.encryptSessionToken(session.accessToken);
    next.refreshToken = this.encryptSessionToken(session.refreshToken);
    return next;
  },

  deserializeSession(session) {
    if (!isObject(session)) {
      return null;
    }
    const accessToken = this.decryptSessionToken(session.accessToken);
    if (!accessToken) {
      return null;
    }
    return {
      ...session,
      accessToken,
      refreshToken: this.decryptSessionToken(session.refreshToken),
    };
  },

  serializeState(state) {
    if (!isObject(state)) {
      return clone(DEFAULT_STATE);
    }
    return {
      ...state,
      session: this.serializeSession(state.session),
    };
  },

  deserializeState(rawState) {
    const stored = isObject(rawState) ? rawState : {};
    const oauthPendingRaw = isObject(stored.oauthPending) ? stored.oauthPending : null;
    const oauthPending =
      oauthPendingRaw &&
      typeof oauthPendingRaw.state === "string" &&
      oauthPendingRaw.state.trim() &&
      typeof oauthPendingRaw.codeVerifier === "string" &&
      oauthPendingRaw.codeVerifier.trim()
        ? {
            state: oauthPendingRaw.state.trim(),
            codeVerifier: oauthPendingRaw.codeVerifier.trim(),
            createdAt: Math.max(0, parseInteger(oauthPendingRaw.createdAt, 0)),
            authUrl: sanitizeOAuthAuthUrl(oauthPendingRaw.authUrl),
          }
        : null;
    return {
      ...clone(DEFAULT_STATE),
      ...stored,
      oauthPending,
      session: this.deserializeSession(stored.session),
    };
  },

  async load() {
    if (this.state) {
      return clone(this.state);
    }
    const stored = await fsp
      .readFile(this.filePath, "utf8")
      .then((content) => JSON.parse(content))
      .catch(() => null);
    this.state = this.deserializeState(stored);
    return clone(this.state);
  },

  async save() {
    if (!this.state) {
      return;
    }
    const serializedState = this.serializeState(this.state);
    const dirPath = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const payload = JSON.stringify(serializedState, null, 2);
    await fsp.mkdir(dirPath, { recursive: true });
    try {
      await fsp.writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(tempPath, this.filePath);
      await fsp.chmod(this.filePath, 0o600).catch(() => {});
    } catch (error) {
      await fsp.unlink(tempPath).catch(() => {});
      throw error;
    }
  },

  async ensureLoadedState() {
    if (!this.state) {
      await this.load();
    }
    return this.state;
  },

  async ensureDeviceId() {
    const state = await this.ensureLoadedState();
    if (typeof state.deviceId === "string" && state.deviceId.trim()) {
      return state.deviceId;
    }
    state.deviceId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : toBase64Url(crypto.randomBytes(18));
    this.state = state;
    await this.save();
    return state.deviceId;
  },

  resolveOAuthPendingState(state, options = {}) {
    if (!isObject(state)) {
      return {
        pending: null,
        changed: false,
        expired: false,
      };
    }
    const now = Date.now();
    const pending = isObject(state.oauthPending) ? state.oauthPending : null;
    if (!pending) {
      if (state.oauthPending !== null) {
        state.oauthPending = null;
        return { pending: null, changed: true, expired: false };
      }
      return { pending: null, changed: false, expired: false };
    }
    const normalized =
      typeof pending.state === "string" &&
      pending.state.trim() &&
      typeof pending.codeVerifier === "string" &&
      pending.codeVerifier.trim()
        ? {
            state: pending.state.trim(),
            codeVerifier: pending.codeVerifier.trim(),
            createdAt: Math.max(0, parseInteger(pending.createdAt, 0)),
            authUrl: sanitizeOAuthAuthUrl(pending.authUrl),
          }
        : null;
    if (!normalized) {
      state.oauthPending = null;
      return { pending: null, changed: true, expired: false };
    }
    if (!normalized.createdAt) {
      normalized.createdAt = now;
    }
    const expired = now - normalized.createdAt > OAUTH_PENDING_TTL_MS;
    if (expired && options.allowExpired !== true) {
      state.oauthPending = null;
      return { pending: null, changed: true, expired: true };
    }
    const changed =
      !pending ||
      pending.state !== normalized.state ||
      pending.codeVerifier !== normalized.codeVerifier ||
      pending.createdAt !== normalized.createdAt ||
      pending.authUrl !== normalized.authUrl;
    if (changed) {
      state.oauthPending = normalized;
    }
    return { pending: normalized, changed, expired: false };
  },

  buildAuthSnapshot() {
    const session = this.state?.session ?? null;
    const user = session?.user && typeof session.user === "object" ? session.user : null;
    const authenticated =
      Boolean(session?.accessToken) ||
      (this.bypassEntitlement && !session?.accessToken);
    return {
      authenticated,
      pending: Boolean(this.state?.oauthPending),
      user: user
        ? {
            id: typeof user.id === "string" ? user.id : null,
            email: typeof user.email === "string" ? user.email : null,
            name: typeof user.name === "string" ? user.name : null,
          }
        : null,
      plan: typeof session?.plan === "string" ? session.plan : null,
      pricingUrl: this.getPricingUrl(),
    };
  },

  async getAuthSnapshot() {
    const state = await this.ensureLoadedState();
    const resolved = this.resolveOAuthPendingState(state);
    if (resolved.changed) {
      this.state = state;
      await this.save();
    }
    return this.buildAuthSnapshot();
  },

  getPricingUrl() {
    return `${this.webBaseUrl}/pricing`;
  },

  clearCaches() {
    if (!this.state) {
      return;
    }
    this.state.aiAccessCache = null;
    this.state.aiAccessFetchedAt = 0;
    this.state.aiUsageCache = null;
    this.state.aiUsageFetchedAt = 0;
  },

  normalizeSessionPayload(payload, fallbackSession = null) {
    const accessToken =
      typeof payload?.accessToken === "string" && payload.accessToken.trim()
        ? payload.accessToken.trim()
        : null;
    if (!accessToken) {
      throw new PlatformApiError("AUTH_INVALID_RESPONSE", "Missing access token.", 0, payload);
    }
    const refreshToken =
      typeof payload?.refreshToken === "string" && payload.refreshToken.trim()
        ? payload.refreshToken.trim()
        : fallbackSession?.refreshToken ?? null;
    const expiresInSec = parseNumber(payload?.expiresInSec, 900);
    const expiresAt = Date.now() + Math.max(60, Math.round(expiresInSec)) * 1000;
    const currentUser =
      payload?.user && typeof payload.user === "object" ? payload.user : fallbackSession?.user;
    const user =
      currentUser && typeof currentUser === "object"
        ? {
            id: typeof currentUser.id === "string" ? currentUser.id : null,
            email: typeof currentUser.email === "string" ? currentUser.email : null,
            name: typeof currentUser.name === "string" ? currentUser.name : null,
          }
        : null;
    const plan =
      typeof payload?.plan === "string"
        ? payload.plan
        : typeof payload?.user?.plan === "string"
        ? payload.user.plan
        : fallbackSession?.plan ?? null;
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: expiresAt,
      user,
      plan,
      updatedAt: Date.now(),
    };
  },

  async requestJson(url, options = {}) {
    if (typeof fetch !== "function") {
      throw new PlatformApiError(
        "PLATFORM_FETCH_UNAVAILABLE",
        "fetch is not available in this runtime."
      );
    }
    const method = options.method || "GET";
    const headers = {
      Accept: "application/json",
      ...(options.headers && typeof options.headers === "object" ? options.headers : {}),
    };
    const init = {
      method,
      headers,
    };
    if (options.signal) {
      init.signal = options.signal;
    }
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }
      throw new PlatformApiError(
        "NETWORK_ERROR",
        error?.message || "Network error while contacting platform API."
      );
    }
    const raw = await response.text().catch(() => "");
    let json = null;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
    }
    if (!response.ok) {
      const code =
        (json && typeof json === "object" && (json.error?.code || json.code)) ||
        `HTTP_${response.status}`;
      const message =
        (json && typeof json === "object" && (json.error?.message || json.message)) ||
        `HTTP ${response.status}`;
      throw new PlatformApiError(code, message, response.status, json);
    }
    return json && typeof json === "object" ? json : {};
  },

  async refreshAccessToken(force = false) {
    const state = await this.ensureLoadedState();
    const session = state.session;
    if (!session || !session.accessToken) {
      throw new PlatformApiError("AUTH_REQUIRED", "Sign in is required.");
    }
    const expiresAt = parseNumber(session.accessTokenExpiresAt, 0);
    if (!force && expiresAt - Date.now() > TOKEN_REFRESH_LEEWAY_MS) {
      return session.accessToken;
    }
    if (!session.refreshToken) {
      return session.accessToken;
    }
    const refreshed = await this.requestJson(`${this.apiBaseUrl}/auth/refresh`, {
      method: "POST",
      body: {
        refreshToken: session.refreshToken,
        deviceId: await this.ensureDeviceId(),
      },
    });
    state.session = this.normalizeSessionPayload(refreshed, session);
    this.clearCaches();
    this.state = state;
    await this.save();
    return state.session.accessToken;
  },

  async authorizedRequest(pathname, options = {}) {
    const run = async (forceRefresh = false) => {
      const token = await this.refreshAccessToken(forceRefresh);
      return this.requestJson(`${this.apiBaseUrl}${pathname}`, {
        ...options,
        headers: {
          ...(options.headers && typeof options.headers === "object" ? options.headers : {}),
          Authorization: `Bearer ${token}`,
        },
      });
    };
    try {
      return await run(false);
    } catch (error) {
      if (
        error instanceof PlatformApiError &&
        (error.status === 401 || error.code === "TOKEN_EXPIRED")
      ) {
        return run(true);
      }
      throw error;
    }
  },

  buildQuotaSnapshot(quota) {
    if (!quota || typeof quota !== "object") {
      return null;
    }
    const limitTokens = Math.max(0, Math.round(parseNumber(quota.limitTokens, 0)));
    const usedTokens = Math.max(0, Math.round(parseNumber(quota.usedTokens, 0)));
    const maxRemainingTokens = Math.max(0, limitTokens - usedTokens);
    const rawRemainingTokens = parseNumber(quota.remainingTokens, Number.NaN);
    const normalizedRemainingTokens = Number.isFinite(rawRemainingTokens)
      ? Math.max(0, Math.round(rawRemainingTokens))
      : maxRemainingTokens;
    return {
      limitTokens,
      usedTokens,
      remainingTokens: Math.min(normalizedRemainingTokens, maxRemainingTokens),
      usedRequests: Math.max(0, Math.round(parseNumber(quota.usedRequests, 0))),
      remainingRequests: Math.max(0, Math.round(parseNumber(quota.remainingRequests, 0))),
      periodStart: parseDate(quota.periodStart),
      periodEnd: parseDate(quota.periodEnd),
    };
  },

  buildUsageSnapshotFromQuota(quota, plan, options = {}) {
    const normalized = this.buildQuotaSnapshot(quota);
    return {
      authenticated:
        typeof options.authenticated === "boolean" ? options.authenticated : true,
      plan: typeof plan === "string" && plan ? plan : null,
      period: typeof options.period === "string" ? options.period : null,
      summary: normalized,
      byFeature:
        options.byFeature && typeof options.byFeature === "object"
          ? options.byFeature
          : null,
      errorCode:
        typeof options.errorCode === "string" && options.errorCode
          ? options.errorCode
          : null,
      message: typeof options.message === "string" && options.message ? options.message : null,
      fetchedAt: Date.now(),
    };
  },

  normalizeUsageMetadata(usage) {
    if (!usage || typeof usage !== "object") {
      return null;
    }
    const promptTokenCount = parseInteger(
      usage.promptTokenCount ??
        usage.promptTokens ??
        usage.inputTokenCount ??
        usage.inputTokens ??
        usage.input_tokens,
      0
    );
    const candidatesTokenCount = parseInteger(
      usage.candidatesTokenCount ??
        usage.outputTokenCount ??
        usage.outputTokens ??
        usage.output_tokens,
      0
    );
    const totalTokenCount = parseInteger(
      usage.totalTokenCount ??
        usage.totalTokens ??
        usage.quotaConsumedTokens ??
        promptTokenCount + candidatesTokenCount,
      promptTokenCount + candidatesTokenCount
    );
    return {
      promptTokenCount: Math.max(0, promptTokenCount),
      candidatesTokenCount: Math.max(0, candidatesTokenCount),
      totalTokenCount: Math.max(0, totalTokenCount),
    };
  },
};

module.exports = {
  coreMethods,
};

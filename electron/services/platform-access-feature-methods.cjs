const crypto = require("crypto");
const {
  FEATURE_CACHE_TTL_MS,
  USAGE_CACHE_TTL_MS,
  clone,
  parseDate,
  compareVersionValues,
  sanitizeHttpUrl,
  sanitizeDigestText,
  sanitizeOAuthAuthUrl,
  extractOAuthCallbackParams,
  isMatchingOAuthCallbackUrl,
  isDirectOAuthCallbackUrl,
  toBase64Url,
  PlatformApiError,
} = require("./platform-access-shared.cjs");

const featureMethods = {
  async submitFeedback(payload, options = {}) {
    const body = payload && typeof payload === "object" ? { ...payload } : {};
    body.category =
      typeof body.category === "string" && body.category.trim()
        ? body.category.trim()
        : "general";
    body.message =
      typeof body.message === "string" && body.message.trim()
        ? body.message.trim()
        : "";
    if (!body.message) {
      throw new PlatformApiError(
        "VALIDATION_ERROR",
        "Feedback message is required.",
        400
      );
    }
    if (!body.app || typeof body.app !== "object") {
      body.app = null;
    }
    const state = await this.ensureLoadedState();
    const requestUrl = `${this.apiBaseUrl}/feedback`;
    const headers = {};
    if (state?.session?.accessToken) {
      try {
        const token = await this.refreshAccessToken(false);
        if (typeof token === "string" && token) {
          headers.Authorization = `Bearer ${token}`;
        }
      } catch {
        // Ignore auth refresh failures and submit anonymously as fallback.
      }
    }
    const response = await this.requestJson(requestUrl, {
      method: "POST",
      headers,
      body,
      signal: options.signal,
    });
    return {
      requestId: typeof response?.requestId === "string" ? response.requestId : null,
      feedbackId: typeof response?.feedbackId === "string" ? response.feedbackId : null,
      status: typeof response?.status === "string" ? response.status : "accepted",
    };
  },

  async submitErrorReport(payload, options = {}) {
    const reportBody = payload && typeof payload === "object" ? { ...payload } : {};
    const requestBody = { report: reportBody };
    const state = await this.ensureLoadedState();
    const requestUrl = `${this.apiBaseUrl}/internal/error-report`;
    const headers = {};
    if (state?.session?.accessToken) {
      try {
        const token = await this.refreshAccessToken(false);
        if (typeof token === "string" && token) {
          headers.Authorization = `Bearer ${token}`;
        }
      } catch {
        // Ignore auth refresh failures and submit anonymously as fallback.
      }
    }
    const response = await this.requestJson(requestUrl, {
      method: "POST",
      headers,
      body: requestBody,
      signal: options.signal,
    });
    return {
      requestId: typeof response?.requestId === "string" ? response.requestId : null,
      feedbackId: typeof response?.feedbackId === "string" ? response.feedbackId : null,
      status: typeof response?.status === "string" ? response.status : "accepted",
      storage: typeof response?.storage === "string" ? response.storage : null,
    };
  },

  async fetchUpdateManifest(options = {}) {
    const normalizePlatform = (value) => {
      const raw = typeof value === "string" && value.trim() ? value.trim() : process.platform;
      if (raw === "darwin") return "darwin";
      if (raw === "win32") return "win32";
      if (raw === "linux") return "linux";
      return raw;
    };
    const platform = normalizePlatform(options.platform);
    const arch =
      typeof options.arch === "string" && options.arch.trim() ? options.arch.trim() : process.arch;
    const channel =
      typeof options.channel === "string" && options.channel.trim()
        ? options.channel.trim()
        : "stable";
    const kindRaw =
      typeof options.kind === "string" && options.kind.trim()
        ? options.kind.trim()
        : platform === "darwin"
        ? "zip"
        : "";
    const kind = String(kindRaw).trim().toLowerCase();
    const currentVersion =
      typeof options.currentVersion === "string" && options.currentVersion.trim()
        ? options.currentVersion.trim()
        : null;
    const params = new URLSearchParams();
    params.set("platform", platform);
    params.set("arch", arch);
    params.set("channel", channel);
    if (kind) {
      params.set("kind", kind);
    }
    const response = await this.requestJson(
      `${this.apiBaseUrl}/updates/manifest?${params.toString()}`
    );
    const latestVersion =
      typeof response?.latestVersion === "string" && response.latestVersion.trim()
        ? response.latestVersion.trim()
        : null;
    const required = Boolean(response?.required);
    const hasUpdate =
      latestVersion && currentVersion
        ? compareVersionValues(latestVersion, currentVersion) > 0
        : Boolean(latestVersion);
    return {
      platform,
      arch,
      channel,
      currentVersion,
      latestVersion,
      hasUpdate,
      required,
      notesUrl: sanitizeHttpUrl(response?.notesUrl),
      artifactUrl: sanitizeHttpUrl(response?.artifactUrl),
      artifactSha256: sanitizeDigestText(
        response?.artifactSha256 ?? response?.sha256 ?? response?.checksum
      ),
      sha256: sanitizeDigestText(response?.sha256),
      checksum: sanitizeDigestText(response?.checksum),
      signature: sanitizeDigestText(response?.signature),
      checkedAt: Date.now(),
    };
  },

  buildBlockedAccess(code, message, authenticated = true) {
    return {
      authenticated,
      allowed: false,
      reason: code,
      status: null,
      plan: typeof this.state?.session?.plan === "string" ? this.state.session.plan : null,
      user: this.state?.session?.user ?? null,
      quota: null,
      periodStart: null,
      periodEnd: null,
      graceEndsAt: null,
      message,
      pricingUrl: this.getPricingUrl(),
      fetchedAt: Date.now(),
    };
  },

  async fetchAiAccess(options = {}) {
    const state = await this.ensureLoadedState();
    if (this.bypassEntitlement) {
      return {
        authenticated: true,
        allowed: true,
        reason: "BYPASS",
        status: "active",
        plan: state?.session?.plan ?? "pro",
        user: state?.session?.user ?? null,
        quota: null,
        periodStart: null,
        periodEnd: null,
        graceEndsAt: null,
        message: null,
        pricingUrl: this.getPricingUrl(),
        fetchedAt: Date.now(),
      };
    }
    const force = options.force === true;
    if (!force && state.aiAccessCache && Date.now() - state.aiAccessFetchedAt < FEATURE_CACHE_TTL_MS) {
      return clone(state.aiAccessCache);
    }
    if (!state.session?.accessToken) {
      const blocked = this.buildBlockedAccess("AUTH_REQUIRED", "Google login is required.", false);
      state.aiAccessCache = blocked;
      state.aiAccessFetchedAt = Date.now();
      this.state = state;
      await this.save();
      return clone(blocked);
    }
    try {
      const payload = await this.authorizedRequest("/me/features?names=ai");
      const feature = payload?.features?.ai ?? null;
      const quota = this.buildQuotaSnapshot(feature?.quota ?? null);
      const user = payload?.user && typeof payload.user === "object" ? payload.user : null;
      const access = {
        authenticated: true,
        allowed: Boolean(feature?.enabled),
        reason:
          typeof feature?.reason === "string" && feature.reason
            ? feature.reason
            : feature?.enabled
            ? "active"
            : "FEATURE_NOT_ENABLED",
        status: typeof feature?.status === "string" ? feature.status : null,
        plan:
          (typeof user?.plan === "string" && user.plan) ||
          (typeof state.session.plan === "string" ? state.session.plan : null),
        user: {
          id:
            (typeof user?.id === "string" && user.id) ||
            (typeof state.session.user?.id === "string" ? state.session.user.id : null),
          email:
            (typeof user?.email === "string" && user.email) ||
            (typeof state.session.user?.email === "string" ? state.session.user.email : null),
          name:
            (typeof user?.name === "string" && user.name) ||
            (typeof state.session.user?.name === "string" ? state.session.user.name : null),
        },
        quota,
        periodStart: parseDate(feature?.periodStart) || quota?.periodStart || null,
        periodEnd: parseDate(feature?.periodEnd) || quota?.periodEnd || null,
        graceEndsAt: parseDate(feature?.graceEndsAt),
        message: null,
        pricingUrl: this.getPricingUrl(),
        fetchedAt: Date.now(),
      };
      state.session = {
        ...(state.session || {}),
        plan: access.plan,
        user: access.user,
      };
      state.aiAccessCache = access;
      state.aiAccessFetchedAt = Date.now();
      this.state = state;
      await this.save();
      return clone(access);
    } catch (error) {
      const code = error instanceof PlatformApiError ? error.code : "PLATFORM_ERROR";
      const status = error instanceof PlatformApiError ? error.status : 0;
      if (code === "AUTH_REQUIRED" || code === "TOKEN_EXPIRED" || status === 401) {
        state.session = null;
      }
      const blocked = this.buildBlockedAccess(
        code,
        error instanceof Error ? error.message : "AI access check failed.",
        code !== "AUTH_REQUIRED" && code !== "TOKEN_EXPIRED" && status !== 401
      );
      state.aiAccessCache = blocked;
      state.aiAccessFetchedAt = Date.now();
      this.state = state;
      await this.save();
      return clone(blocked);
    }
  },

  async fetchAiUsage(options = {}) {
    const state = await this.ensureLoadedState();
    if (this.bypassEntitlement) {
      return {
        authenticated: true,
        plan: state?.session?.plan ?? "pro",
        period: null,
        summary: null,
        byFeature: null,
        errorCode: null,
        message: null,
        fetchedAt: Date.now(),
      };
    }
    const force = options.force === true;
    if (!force && state.aiUsageCache && Date.now() - state.aiUsageFetchedAt < USAGE_CACHE_TTL_MS) {
      return clone(state.aiUsageCache);
    }
    if (!state.session?.accessToken) {
      const payload = {
        authenticated: false,
        plan: null,
        period: null,
        summary: null,
        byFeature: null,
        errorCode: "AUTH_REQUIRED",
        message: "Google login is required.",
        fetchedAt: Date.now(),
      };
      state.aiUsageCache = payload;
      state.aiUsageFetchedAt = Date.now();
      this.state = state;
      await this.save();
      return clone(payload);
    }
    try {
      const response = await this.authorizedRequest("/me/usage/ai?period=current_month");
      const summary = this.buildQuotaSnapshot(response?.summary ?? null);
      const usage = {
        authenticated: true,
        plan:
          typeof response?.plan === "string"
            ? response.plan
            : typeof state.session.plan === "string"
            ? state.session.plan
            : null,
        period: typeof response?.period === "string" ? response.period : null,
        summary,
        byFeature:
          response?.byFeature && typeof response.byFeature === "object"
            ? response.byFeature
            : null,
        errorCode: null,
        message: null,
        fetchedAt: Date.now(),
      };
      state.session = {
        ...(state.session || {}),
        plan: usage.plan,
      };
      state.aiUsageCache = usage;
      state.aiUsageFetchedAt = Date.now();
      this.state = state;
      await this.save();
      return clone(usage);
    } catch (error) {
      const code = error instanceof PlatformApiError ? error.code : "PLATFORM_ERROR";
      const status = error instanceof PlatformApiError ? error.status : 0;
      if (code === "AUTH_REQUIRED" || code === "TOKEN_EXPIRED" || status === 401) {
        state.session = null;
      }
      const failed = {
        authenticated: Boolean(state.session?.accessToken),
        plan: typeof state.session?.plan === "string" ? state.session.plan : null,
        period: null,
        summary: null,
        byFeature: null,
        errorCode: code,
        message: error instanceof Error ? error.message : "AI usage check failed.",
        fetchedAt: Date.now(),
      };
      state.aiUsageCache = failed;
      state.aiUsageFetchedAt = Date.now();
      this.state = state;
      await this.save();
      return clone(failed);
    }
  },

  async checkAiAccess(options = {}) {
    return this.fetchAiAccess(options);
  },

  async startGoogleAuth() {
    const state = await this.ensureLoadedState();
    if (this.bypassEntitlement) {
      return {
        bypassed: true,
        authUrl: null,
        state: null,
      };
    }
    const resolvedPending = this.resolveOAuthPendingState(state);
    if (resolvedPending.changed) {
      this.state = state;
      await this.save();
    }
    if (resolvedPending.pending?.authUrl) {
      return {
        bypassed: false,
        authUrl: resolvedPending.pending.authUrl,
        state: resolvedPending.pending.state,
        reused: true,
      };
    }
    const deviceId = await this.ensureDeviceId();
    const verifier = toBase64Url(crypto.randomBytes(48));
    const challenge = toBase64Url(crypto.createHash("sha256").update(verifier).digest());
    const payload = await this.requestJson(`${this.apiBaseUrl}/auth/google/start`, {
      method: "POST",
      body: {
        deviceId,
        redirectUri: this.redirectUri,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      },
    });
    const authUrl = sanitizeOAuthAuthUrl(payload?.authUrl);
    const oauthState =
      typeof payload?.state === "string" && payload.state.trim() ? payload.state.trim() : null;
    if (authUrl && isDirectOAuthCallbackUrl(authUrl) && !this.allowDirectOAuthCallbackAuthUrl) {
      throw new PlatformApiError(
        "AUTH_INVALID_RESPONSE",
        "OAuth start response contains an invalid authorization URL."
      );
    }
    if (!authUrl || !oauthState) {
      throw new PlatformApiError("AUTH_INVALID_RESPONSE", "OAuth start response is invalid.");
    }
    state.oauthPending = {
      state: oauthState,
      codeVerifier: verifier,
      createdAt: Date.now(),
      authUrl,
    };
    this.state = state;
    await this.save();
    return {
      bypassed: false,
      authUrl,
      state: oauthState,
      reused: false,
    };
  },

  async completeGoogleAuthFromCallback(callbackUrl) {
    if (!callbackUrl || typeof callbackUrl !== "string") {
      throw new PlatformApiError("OAUTH_INVALID_CALLBACK", "Invalid OAuth callback URL.");
    }
    const state = await this.ensureLoadedState();
    const resolvedPending = this.resolveOAuthPendingState(state);
    if (resolvedPending.changed) {
      this.state = state;
      await this.save();
    }
    const pending = resolvedPending.pending;
    if (!pending) {
      if (resolvedPending.expired) {
        throw new PlatformApiError(
          "OAUTH_PENDING_EXPIRED",
          "OAuth request expired. Start sign-in again."
        );
      }
      throw new PlatformApiError("OAUTH_NO_PENDING", "OAuth request was not started.");
    }
    let url;
    try {
      url = new URL(callbackUrl);
    } catch {
      throw new PlatformApiError("OAUTH_INVALID_CALLBACK", "Invalid OAuth callback URL.");
    }
    if (!isMatchingOAuthCallbackUrl(callbackUrl, this.redirectUri)) {
      throw new PlatformApiError(
        "OAUTH_CALLBACK_MISMATCH",
        "OAuth callback URL does not match the configured redirect URI."
      );
    }
    const callbackParams = extractOAuthCallbackParams(url);
    const errorParam = callbackParams.error;
    if (errorParam) {
      state.oauthPending = null;
      this.state = state;
      await this.save();
      const message = callbackParams.errorDescription || errorParam;
      throw new PlatformApiError("OAUTH_DENIED", message);
    }
    const code = callbackParams.code;
    const oauthState = callbackParams.state;
    if (!code || !oauthState) {
      state.oauthPending = null;
      this.state = state;
      await this.save();
      throw new PlatformApiError("OAUTH_INVALID_CALLBACK", "Missing OAuth code/state.");
    }
    if (oauthState !== pending.state) {
      state.oauthPending = null;
      this.state = state;
      await this.save();
      throw new PlatformApiError("OAUTH_STATE_MISMATCH", "OAuth state does not match.");
    }
    const exchanged = await this.requestJson(`${this.apiBaseUrl}/auth/google/exchange`, {
      method: "POST",
      body: {
        code,
        state: oauthState,
        redirectUri: this.redirectUri,
        codeVerifier: pending.codeVerifier,
        deviceId: await this.ensureDeviceId(),
      },
    });
    state.session = this.normalizeSessionPayload(exchanged, state.session);
    state.oauthPending = null;
    this.clearCaches();
    this.state = state;
    await this.save();
    return this.buildAuthSnapshot();
  },

  async cancelGoogleAuthPending() {
    const state = await this.ensureLoadedState();
    const resolved = this.resolveOAuthPendingState(state, { allowExpired: true });
    if (resolved.changed || state.oauthPending) {
      state.oauthPending = null;
      this.state = state;
      await this.save();
    }
    return this.buildAuthSnapshot();
  },

  async signOut() {
    const state = await this.ensureLoadedState();
    if (state.session?.accessToken) {
      try {
        await this.authorizedRequest("/auth/logout", {
          method: "POST",
          body: {
            deviceId: await this.ensureDeviceId(),
            allDevices: false,
          },
        });
      } catch {
        // Ignore remote sign-out failures and clear local session anyway.
      }
    }
    state.session = null;
    state.oauthPending = null;
    this.clearCaches();
    this.state = state;
    await this.save();
    return this.buildAuthSnapshot();
  },
};

module.exports = {
  featureMethods,
};

const {
  isTex64OAuthCallbackUrl,
  buildUsageFromAccess,
  toErrorPayload,
} = require("./misc-platform-utils.cjs");

const createPlatformHandlers = ({
  platformService,
  shell,
  sendToRenderer,
  ensureProtocolClient,
  appVersion,
  appPlatform,
  appArch,
}) => {
  const emitPlatformAuth = async () => {
    if (!platformService) {
      return;
    }
    const auth = await platformService.getAuthSnapshot();
    sendToRenderer("platform:auth", { auth });
  };

  const clearOAuthPendingAndEmitAuth = async () => {
    if (!platformService || typeof platformService.cancelGoogleAuthPending !== "function") {
      return;
    }
    try {
      await platformService.cancelGoogleAuthPending();
    } catch {
      // ignore pending-clear errors
    }
    try {
      await emitPlatformAuth();
    } catch {
      // ignore auth snapshot errors after pending clear
    }
  };

  const emitPlatformAiAccess = async (force = false, source = "check") => {
    if (!platformService) {
      return null;
    }
    const access = await platformService.checkAiAccess({ force });
    sendToRenderer("platform:aiAccess", { source, access });
    const usage = buildUsageFromAccess(access);
    if (usage) {
      sendToRenderer("platform:usage", { source, usage });
    }
    return access;
  };

  const emitPlatformUsage = async (force = false, source = "usage") => {
    if (!platformService) {
      return null;
    }
    const usage = await platformService.fetchAiUsage({ force });
    sendToRenderer("platform:usage", { source, usage });
    return usage;
  };

  const handlePlatformStateGet = async () => {
    if (!platformService) {
      return;
    }
    try {
      await emitPlatformAuth();
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", { auth, error: toErrorPayload(error) });
    }
  };

  const handleFeatureCheck = async (payload) => {
    if (!platformService) {
      return;
    }
    try {
      const names = Array.isArray(payload?.names) ? payload.names : [];
      const force = payload?.force === true;
      if (names.includes("ai")) {
        await emitPlatformAiAccess(force, "manual");
      }
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", { auth, error: toErrorPayload(error) });
    }
  };

  const handlePlatformUsageGet = async (payload) => {
    if (!platformService) {
      return;
    }
    try {
      await emitPlatformUsage(payload?.force === true, "manual");
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", { auth, error: toErrorPayload(error) });
    }
  };

  const handleAuthGoogleStart = async () => {
    if (!platformService) {
      return;
    }
    try {
      if (typeof ensureProtocolClient === "function") {
        try {
          ensureProtocolClient();
        } catch {
          // continue even if protocol registration fails in this runtime
        }
      }
      await emitPlatformAuth();
      const started = await platformService.startGoogleAuth();
      await emitPlatformAuth();
      if (started?.bypassed) {
        return;
      }
      const authUrl =
        typeof started?.authUrl === "string" && started.authUrl.trim()
          ? started.authUrl.trim()
          : null;
      if (!authUrl) {
        throw {
          code: "AUTH_START_INVALID_URL",
          message: "OAuth authorization URL is missing.",
        };
      }
      if (isTex64OAuthCallbackUrl(authUrl)) {
        await handleAuthGoogleCallback(authUrl);
        return;
      }
      if (!shell?.openExternal) {
        await clearOAuthPendingAndEmitAuth();
        throw {
          code: "AUTH_BROWSER_UNAVAILABLE",
          message: "External browser is unavailable in this runtime.",
        };
      }
      try {
        await shell.openExternal(authUrl);
      } catch (error) {
        await clearOAuthPendingAndEmitAuth();
        throw {
          code: "AUTH_BROWSER_OPEN_FAILED",
          message:
            typeof error?.message === "string" && error.message
              ? error.message
              : "Failed to open OAuth page in external browser.",
        };
      }
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", {
        auth,
        error: toErrorPayload(error, "AUTH_START_FAILED"),
      });
    }
  };

  const handleAuthGoogleCallback = async (callbackUrl) => {
    if (!platformService) {
      return;
    }
    try {
      await platformService.completeGoogleAuthFromCallback(callbackUrl);
      await emitPlatformAuth();
      await emitPlatformAiAccess(true, "auth");
      await emitPlatformUsage(true, "auth");
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", {
        auth,
        error: toErrorPayload(error, "AUTH_CALLBACK_FAILED"),
      });
    }
  };

  const handleAuthSignOut = async () => {
    if (!platformService) {
      return;
    }
    try {
      await platformService.signOut();
      await emitPlatformAuth();
      await emitPlatformAiAccess(true, "auth");
      await emitPlatformUsage(true, "auth");
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", {
        auth,
        error: toErrorPayload(error, "AUTH_SIGNOUT_FAILED"),
      });
    }
  };

  const handleAuthGoogleCancel = async () => {
    if (!platformService || typeof platformService.cancelGoogleAuthPending !== "function") {
      return;
    }
    try {
      await platformService.cancelGoogleAuthPending();
      await emitPlatformAuth();
      await emitPlatformAiAccess(true, "auth");
      await emitPlatformUsage(true, "auth");
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", {
        auth,
        error: toErrorPayload(error, "AUTH_CANCEL_FAILED"),
      });
    }
  };

  const handleOpenExternal = async (url) => {
    if (!shell?.openExternal) {
      return;
    }
    const normalized = typeof url === "string" ? url.trim() : "";
    if (!/^https?:\/\//i.test(normalized)) {
      return;
    }
    try {
      await shell.openExternal(normalized);
    } catch {
      // ignore browser launch failures
    }
  };

  const handleFeedbackSend = async (payload) => {
    if (!platformService || typeof platformService.submitFeedback !== "function") {
      return;
    }
    const message =
      typeof payload?.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : "";
    const category =
      typeof payload?.category === "string" && payload.category.trim()
        ? payload.category.trim()
        : "general";
    if (!message) {
      sendToRenderer("platform:feedback", {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Feedback content is empty.",
        },
      });
      return;
    }
    const contactEmail =
      typeof payload?.contactEmail === "string" && payload.contactEmail.trim()
        ? payload.contactEmail.trim()
        : null;
    const diagnostics =
      payload?.diagnostics && typeof payload.diagnostics === "object"
        ? payload.diagnostics
        : null;
    try {
      const response = await platformService.submitFeedback(
        {
          category,
          message,
          contactEmail,
          app: {
            version: appVersion,
            platform: `${appPlatform}-${appArch}`,
          },
          diagnostics,
        },
        {}
      );
      sendToRenderer("platform:feedback", {
        ok: true,
        feedbackId: response?.feedbackId ?? null,
      });
    } catch (error) {
      sendToRenderer("platform:feedback", {
        ok: false,
        error: toErrorPayload(error, "FEEDBACK_SEND_FAILED"),
      });
    }
  };

  return {
    emitPlatformAiAccess,
    emitPlatformUsage,
    handlePlatformStateGet,
    handleFeatureCheck,
    handlePlatformUsageGet,
    handleAuthGoogleStart,
    handleAuthGoogleCallback,
    handleAuthGoogleCancel,
    handleAuthSignOut,
    handleOpenExternal,
    handleFeedbackSend,
  };
};

module.exports = {
  createPlatformHandlers,
};

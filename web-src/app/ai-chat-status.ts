import type {
  PlatformAiAccessSnapshot,
  PlatformAuthSnapshot,
  PlatformUsageSnapshot,
  PlatformUpdateSnapshot,
} from "./types.js";
import { getUiLocale, onUiLocaleChange } from "./i18n.js";
import { aiText } from "./ai-i18n.js";

export type StatusAction = "login" | "pricing";

export type AiChatPlatformState = {
  platformAuth: PlatformAuthSnapshot | null;
  platformAiAccess: PlatformAiAccessSnapshot | null;
  platformUsage: PlatformUsageSnapshot | null;
  platformError: { code?: string; message?: string } | null;
  requestedInitialUsage: boolean;
};

type CreateAiChatStatusControllerParams = {
  aiStatus: Element | null | undefined;
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  requestAiAccessCheck: (force?: boolean) => void;
  requestPlatformUsage: (force?: boolean) => void;
  pricingFallbackUrl: string;
  state: AiChatPlatformState;
  onStatusUpdate?: () => void;
};

export const createAiChatStatusController = (params: CreateAiChatStatusControllerParams) => {
  const {
    aiStatus,
    postToNative,
    requestAiAccessCheck,
    requestPlatformUsage,
    pricingFallbackUrl,
    state,
    onStatusUpdate,
  } = params;

  const normalizeUsageSnapshot = (usage?: PlatformUsageSnapshot | null): PlatformUsageSnapshot | null => {
    if (!usage || typeof usage !== "object") return null;
    return usage;
  };

  const INTL_LOCALE_MAP: Record<string, string> = {
    ja: "ja-JP",
    en: "en-US",
    zh: "zh-CN",
    ko: "ko-KR",
    de: "de-DE",
    fr: "fr-FR",
    es: "es-ES",
  };
  const resolveIntlLocale = () => INTL_LOCALE_MAP[getUiLocale()] ?? "en-US";

  const isAiBlocked = () =>
    Boolean(state.platformAiAccess && state.platformAiAccess.allowed === false);
  const needsLogin = () =>
    Boolean(
      !state.platformAiAccess?.allowed &&
        (!state.platformAuth?.authenticated ||
          (state.platformAiAccess &&
            (state.platformAiAccess.reason === "AUTH_REQUIRED" ||
              state.platformAiAccess.reason === "TOKEN_EXPIRED")))
    );

  const withUtilityActions = (actions?: Array<{ action: StatusAction; label: string }>) => {
    return Array.isArray(actions) ? [...actions] : [];
  };

  const normalizeAuthError = (error?: { code?: string; message?: string } | null) => {
    if (!error || typeof error !== "object") {
      return null;
    }
    const code = typeof error.code === "string" ? error.code : "";
    const fallbackMessage =
      typeof error.message === "string" && error.message.trim()
        ? error.message.trim()
        : aiText("login_failed");
    switch (code) {
      case "AUTH_START_INVALID_URL":
        return {
          code,
          message: aiText("login_err_open"),
        };
      case "AUTH_BROWSER_UNAVAILABLE":
        return {
          code,
          message: aiText("login_err_browser"),
        };
      case "AUTH_BROWSER_OPEN_FAILED":
        return {
          code,
          message: aiText("login_err_open"),
        };
      case "OAUTH_PENDING_EXPIRED":
        return {
          code,
          message: aiText("login_err_timeout"),
        };
      case "OAUTH_NO_PENDING":
        return {
          code,
          message: aiText("login_err_confirm"),
        };
      case "OAUTH_STATE_MISMATCH":
      case "OAUTH_CALLBACK_MISMATCH":
      case "OAUTH_INVALID_CALLBACK":
        return {
          code,
          message: aiText("login_err_validate"),
        };
      case "OAUTH_DENIED":
        // User simply cancelled the login — not an error
        return null;
      default:
        return { code, message: fallbackMessage };
    }
  };

  const renderStatus = (
    headline: string,
    detail?: string,
    actions?: Array<{ action: StatusAction; label: string }>
  ) => {
    if (!(aiStatus instanceof HTMLElement)) {
      return;
    }
    aiStatus.replaceChildren();
    aiStatus.classList.remove("ai-status--actions-only");
    aiStatus.classList.remove("ai-status--error");
    aiStatus.classList.remove("ai-status--warn");
    aiStatus.classList.remove("ai-status--ok");
    const hasActions = Array.isArray(actions) && actions.length > 0;
    if (!headline && !detail && !hasActions) {
      aiStatus.style.display = "none";
      return;
    }
    aiStatus.style.display = "block";
    if (!headline && !detail && hasActions) {
      aiStatus.classList.add("ai-status--actions-only");
    }
    if (headline) {
      const head = document.createElement("div");
      head.className = "ai-status-line";
      head.textContent = headline;
      aiStatus.appendChild(head);
    }
    if (detail) {
      const body = document.createElement("div");
      body.className = "ai-status-detail";
      body.textContent = detail;
      aiStatus.appendChild(body);
    }
    if (Array.isArray(actions) && actions.length > 0) {
      const actionWrap = document.createElement("div");
      actionWrap.className = "ai-status-actions";
      actions.forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ai-status-action";
        button.dataset.aiStatusAction = item.action;
        button.textContent = item.label;
        actionWrap.appendChild(button);
      });
      aiStatus.appendChild(actionWrap);
    }
  };

  const formatTokenCount = (value: number) =>
    new Intl.NumberFormat(resolveIntlLocale()).format(Math.max(0, Math.round(value)));

  /** Share of the month's allowance still available, 0–100; null when unknown. */
  const remainingPercent = () => {
    const quota = state.platformUsage?.summary ?? state.platformAiAccess?.quota ?? null;
    const limitTokens =
      typeof quota?.limitTokens === "number" && Number.isFinite(quota.limitTokens)
        ? Math.max(0, Math.round(quota.limitTokens))
        : 0;
    const usedTokens =
      typeof quota?.usedTokens === "number" && Number.isFinite(quota.usedTokens)
        ? Math.max(0, Math.round(quota.usedTokens))
        : 0;
    if (!limitTokens) return null;
    return Math.max(0, Math.min(100, 100 - (usedTokens / limitTokens) * 100));
  };

  const openExternalUrl = (url: string) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
      return;
    }
    postToNative({ type: "shell:openExternal", url: url.trim() }, true);
  };

  const resolvePricingUrl = () => {
    const fromAccess =
      typeof state.platformAiAccess?.pricingUrl === "string" && state.platformAiAccess.pricingUrl.trim()
        ? state.platformAiAccess.pricingUrl.trim()
        : "";
    if (fromAccess) {
      return fromAccess;
    }
    const fromAuth =
      typeof state.platformAuth?.pricingUrl === "string" && state.platformAuth.pricingUrl.trim()
        ? state.platformAuth.pricingUrl.trim()
        : "";
    if (fromAuth) {
      return fromAuth;
    }
    return pricingFallbackUrl;
  };

  const updateStatusDisplay = () => {
    const pricingUrl = resolvePricingUrl();
    const quota = state.platformUsage?.summary ?? state.platformAiAccess?.quota ?? null;
    const periodEnd =
      typeof state.platformAiAccess?.periodEnd === "string" ? state.platformAiAccess.periodEnd : null;
    const periodEndLabel =
      periodEnd && Number.isFinite(Date.parse(periodEnd))
        ? new Date(periodEnd).toLocaleDateString(resolveIntlLocale())
        : "";
    if (state.platformError?.message) {
      renderStatus(
        aiText("login_failed"),
        state.platformError.message,
        withUtilityActions([{ action: "login", label: aiText("login_with_google") }])
      );
      return;
    }
    if (state.platformAuth?.pending) {
      renderStatus(aiText("login_processing"));
      return;
    }
    if (needsLogin()) {
      // One line above the composer, with the way in. Nothing covers the chat.
      renderStatus(
        aiText("login_needed"),
        "",
        withUtilityActions([{ action: "login", label: aiText("login_with_google") }])
      );
      return;
    }
    if (isAiBlocked()) {
      const reason =
        typeof state.platformAiAccess?.reason === "string" && state.platformAiAccess.reason
          ? state.platformAiAccess.reason
          : typeof state.platformUsage?.errorCode === "string" && state.platformUsage.errorCode
          ? state.platformUsage.errorCode
          : "";
      if (reason === "QUOTA_EXCEEDED") {
        const detailPieces: string[] = [];
        if (
          quota &&
          typeof quota.usedTokens === "number" &&
          typeof quota.limitTokens === "number"
        ) {
          detailPieces.push(
            `${formatTokenCount(quota.usedTokens)} / ${formatTokenCount(quota.limitTokens)} ${aiText("usage_tokens")}`
          );
        }
        if (periodEndLabel) {
          detailPieces.push(`${aiText("status_next_reset")}: ${periodEndLabel}`);
        }
        renderStatus(
          aiText("status_quota_reached"),
          detailPieces.join(" / "),
          withUtilityActions([{ action: "pricing", label: aiText("status_see_plan") }])
        );
        return;
      }
      if (
        reason === "PLAN_REQUIRED" ||
        reason === "FEATURE_NOT_ENABLED" ||
        reason === "PAYMENT_PAST_DUE"
      ) {
        renderStatus(
          aiText("status_unavailable"),
          aiText("status_plan_check"),
          withUtilityActions([{ action: "pricing", label: aiText("status_see_plan") }])
        );
        return;
      }
      const fallbackMessage =
        typeof state.platformAiAccess?.message === "string" && state.platformAiAccess.message.trim()
          ? state.platformAiAccess.message.trim()
          : typeof state.platformUsage?.message === "string" && state.platformUsage.message.trim()
          ? state.platformUsage.message.trim()
          : aiText("status_unavailable");
      renderStatus(
        fallbackMessage,
        "",
        withUtilityActions([{ action: "pricing", label: aiText("status_see_plan") }])
      );
      return;
    }
    // The month's allowance is a settings matter (Account › AI chat); the
    // chat never comments on it while requests still go through.
    void pricingUrl;
    renderStatus("", "", withUtilityActions());
  };

  const handlePlatformAuth = (payload: {
    auth: PlatformAuthSnapshot;
    error?: { code?: string; message?: string };
  }) => {
    state.platformAuth = payload?.auth ?? null;
    state.platformError = normalizeAuthError(payload?.error ?? null);
    if (!state.platformAuth?.authenticated) {
      if (!state.platformAiAccess?.allowed) {
        requestAiAccessCheck(false);
      }
      if (state.platformAiAccess?.allowed) {
        updateStatusDisplay();
        onStatusUpdate?.();
        return;
      }
      state.platformAiAccess = null;
      state.platformUsage = null;
      state.requestedInitialUsage = false;
    } else if (!state.platformAuth.pending && !state.requestedInitialUsage && !payload?.error?.message) {
      state.requestedInitialUsage = true;
      requestAiAccessCheck(false);
      requestPlatformUsage(false);
    }
    updateStatusDisplay();
    onStatusUpdate?.();
  };

  const handlePlatformAiAccess = (payload: {
    source?: string;
    access: PlatformAiAccessSnapshot;
  }) => {
    const access = payload?.access ?? null;
    if (!access) {
      return;
    }
    state.platformAiAccess = access;
    if (access.allowed) {
      state.platformError = null;
    }
    if (
      access.quota &&
      (!state.platformUsage?.summary ||
        payload?.source === "auth" ||
        payload?.source === "manual" ||
        payload?.source === "chat")
    ) {
      const usageFromAccess = normalizeUsageSnapshot({
        authenticated: Boolean(access.authenticated),
        plan: access.plan ?? null,
        period: null,
        summary: access.quota,
        byFeature: state.platformUsage?.byFeature ?? null,
        errorCode: access.allowed ? null : access.reason ?? null,
        message: access.message ?? null,
        fetchedAt: access.fetchedAt ?? Date.now(),
      });
      if (usageFromAccess) {
        const currentFetchedAt =
          typeof state.platformUsage?.fetchedAt === "number" && Number.isFinite(state.platformUsage.fetchedAt)
            ? state.platformUsage.fetchedAt
            : 0;
        const nextFetchedAt =
          typeof usageFromAccess.fetchedAt === "number" &&
          Number.isFinite(usageFromAccess.fetchedAt)
            ? usageFromAccess.fetchedAt
            : Date.now();
        if (!state.platformUsage || nextFetchedAt >= currentFetchedAt) {
          state.platformUsage = usageFromAccess;
        }
      }
    }
    updateStatusDisplay();
    onStatusUpdate?.();
  };

  const handlePlatformUsage = (payload: {
    source?: string;
    usage: PlatformUsageSnapshot;
  }) => {
    state.platformUsage = normalizeUsageSnapshot(payload?.usage ?? null);
    if (!state.platformUsage?.errorCode) {
      state.platformError = null;
    }
    updateStatusDisplay();
    onStatusUpdate?.();
  };

  const handlePlatformUpdate = (_payload: {
    source?: string;
    update: PlatformUpdateSnapshot | null;
    error?: { code?: string; message?: string };
  }) => {};

  onUiLocaleChange(() => {
    updateStatusDisplay();
  });

  return {
    isAiBlocked,
    needsLogin,
    openExternalUrl,
    resolvePricingUrl,
    remainingPercent,
    formatTokenCount,
    updateStatusDisplay,
    handlePlatformAuth,
    handlePlatformAiAccess,
    handlePlatformUsage,
    handlePlatformUpdate,
  };
};

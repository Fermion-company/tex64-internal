import type {
  PlatformAiAccessSnapshot,
  PlatformAuthSnapshot,
  PlatformUsageSnapshot,
  PlatformUpdateSnapshot,
} from "./types.js";

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
  aiAuthTopbar: Element | null | undefined;
  aiUsageMeter: Element | null | undefined;
  aiUsageMeterText: Element | null | undefined;
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
    aiAuthTopbar,
    aiUsageMeter,
    aiUsageMeterText,
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

  const isAiBlocked = () =>
    Boolean(state.platformAiAccess && state.platformAiAccess.allowed === false);
  const needsLogin = () =>
    Boolean(
      !state.platformAuth?.authenticated ||
        (state.platformAiAccess &&
          (!state.platformAiAccess.authenticated ||
            state.platformAiAccess.reason === "AUTH_REQUIRED" ||
            state.platformAiAccess.reason === "TOKEN_EXPIRED"))
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
        : "ログインに失敗しました。";
    switch (code) {
      case "AUTH_START_INVALID_URL":
        return {
          code,
          message: "ログインページを開けませんでした。",
        };
      case "AUTH_BROWSER_UNAVAILABLE":
        return {
          code,
          message: "ブラウザを起動できませんでした。",
        };
      case "AUTH_BROWSER_OPEN_FAILED":
        return {
          code,
          message: "ログインページを開けませんでした。",
        };
      case "OAUTH_PENDING_EXPIRED":
        return {
          code,
          message: "ログインがタイムアウトしました。",
        };
      case "OAUTH_NO_PENDING":
        return {
          code,
          message: "ログイン状態を確認できませんでした。",
        };
      case "OAUTH_STATE_MISMATCH":
      case "OAUTH_CALLBACK_MISMATCH":
      case "OAUTH_INVALID_CALLBACK":
        return {
          code,
          message: "ログイン結果の検証に失敗しました。",
        };
      case "OAUTH_DENIED":
        return {
          code,
          message: "Googleログインがキャンセルされました。",
        };
      default:
        return { code, message: fallbackMessage };
    }
  };

  const tokenNumberFormat = new Intl.NumberFormat("ja-JP");
  const formatTokenCount = (value: number) =>
    tokenNumberFormat.format(Math.max(0, Math.round(value)));
  const formatTokenCompact = (value: number) => {
    const v = Math.max(0, Math.round(value));
    if (v < 10_000) {
      return formatTokenCount(v);
    }
    if (v < 1_000_000) {
      const k = v / 1000;
      if (k < 100) {
        return `${k.toFixed(1).replace(/\.0$/, "")}k`;
      }
      return `${Math.floor(k)}k`;
    }
    const m = v / 1_000_000;
    if (m < 100) {
      return `${m.toFixed(1).replace(/\.0$/, "")}M`;
    }
    return `${Math.floor(m)}M`;
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

  const updateTopbarAuthButton = () => {
    if (!(aiAuthTopbar instanceof HTMLButtonElement)) {
      return;
    }
    const authenticated = Boolean(state.platformAuth?.authenticated);
    aiAuthTopbar.classList.toggle("is-hidden", authenticated);
    aiAuthTopbar.textContent = "ログイン";
    aiAuthTopbar.disabled = false;
  };

  const ensureTooltipDom = (parent: HTMLElement) => {
    let tooltip = parent.querySelector(".ai-usage-tooltip") as HTMLElement | null;
    if (tooltip) return tooltip;
    tooltip = document.createElement("div");
    tooltip.className = "ai-usage-tooltip";
    tooltip.innerHTML = [
      '<div class="ai-usage-tooltip-header">AI 使用量</div>',
      '<div class="ai-usage-tooltip-row"><span class="ai-usage-tooltip-label">使用</span><span class="ai-usage-tooltip-value" data-field="used">-</span></div>',
      '<div class="ai-usage-tooltip-row"><span class="ai-usage-tooltip-label">上限</span><span class="ai-usage-tooltip-value" data-field="limit">-</span></div>',
      '<div class="ai-usage-tooltip-row"><span class="ai-usage-tooltip-label">残り</span><span class="ai-usage-tooltip-value" data-field="remaining">-</span></div>',
      '<div class="ai-usage-tooltip-row"><span class="ai-usage-tooltip-label">リセット</span><span class="ai-usage-tooltip-value" data-field="reset">-</span></div>',
      '<div class="ai-usage-tooltip-bar-track"><div class="ai-usage-tooltip-bar-fill"></div></div>',
    ].join("");
    parent.appendChild(tooltip);
    return tooltip;
  };

  const updateUsageMeter = () => {
    if (!(aiUsageMeter instanceof HTMLElement)) {
      return;
    }
    const quota = state.platformUsage?.summary ?? state.platformAiAccess?.quota ?? null;
    const limitTokens =
      typeof quota?.limitTokens === "number" && Number.isFinite(quota.limitTokens)
        ? Math.max(0, Math.round(quota.limitTokens))
        : 0;
    const usedTokens =
      typeof quota?.usedTokens === "number" && Number.isFinite(quota.usedTokens)
        ? Math.max(0, Math.round(quota.usedTokens))
        : 0;
    if (!limitTokens) {
      aiUsageMeter.classList.add("is-hidden");
      aiUsageMeter.classList.remove("is-warn");
      aiUsageMeter.classList.remove("is-critical");
      aiUsageMeter.style.removeProperty("--ai-usage-pct");
      aiUsageMeter.style.removeProperty("--ai-remaining-pct");
      aiUsageMeter.removeAttribute("title");
      aiUsageMeter.setAttribute("aria-label", "Axiom 使用量");
      if (aiUsageMeterText instanceof HTMLElement) {
        aiUsageMeterText.textContent = "-";
      }
      return;
    }
    const usedPct = Math.max(0, Math.min(100, (usedTokens / limitTokens) * 100));
    const remainingPct = Math.max(0, 100 - usedPct);
    const remainingTokens = Math.max(0, limitTokens - usedTokens);
    aiUsageMeter.classList.remove("is-hidden");
    aiUsageMeter.classList.toggle("is-warn", usedPct >= 80 && usedPct < 95);
    aiUsageMeter.classList.toggle("is-critical", usedPct >= 95);
    aiUsageMeter.style.setProperty("--ai-usage-pct", usedPct.toFixed(2));
    aiUsageMeter.style.setProperty("--ai-remaining-pct", remainingPct.toFixed(2));
    const label = `残り ${remainingPct.toFixed(0)}% (${formatTokenCompact(remainingTokens)})`;
    aiUsageMeter.setAttribute("aria-label", `AI使用量: ${label}`);
    aiUsageMeter.removeAttribute("title");
    if (aiUsageMeterText instanceof HTMLElement) {
      aiUsageMeterText.textContent = `${remainingPct.toFixed(0)}%`;
    }
    const tooltip = ensureTooltipDom(aiUsageMeter);
    const setField = (field: string, text: string) => {
      const el = tooltip.querySelector(`[data-field="${field}"]`);
      if (el) el.textContent = text;
    };
    setField("used", `${formatTokenCount(usedTokens)} トークン`);
    setField("limit", `${formatTokenCount(limitTokens)} トークン`);
    setField("remaining", `${remainingPct.toFixed(1)}% (${formatTokenCompact(remainingTokens)})`);
    const periodEnd =
      typeof state.platformAiAccess?.periodEnd === "string" ? state.platformAiAccess.periodEnd : null;
    if (periodEnd && Number.isFinite(Date.parse(periodEnd))) {
      setField("reset", new Date(periodEnd).toLocaleDateString("ja-JP"));
    } else {
      setField("reset", "-");
    }
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
    updateTopbarAuthButton();
    updateUsageMeter();
    const pricingUrl = resolvePricingUrl();
    const quota = state.platformUsage?.summary ?? state.platformAiAccess?.quota ?? null;
    const periodEnd =
      typeof state.platformAiAccess?.periodEnd === "string" ? state.platformAiAccess.periodEnd : null;
    const periodEndLabel =
      periodEnd && Number.isFinite(Date.parse(periodEnd))
        ? new Date(periodEnd).toLocaleDateString("ja-JP")
        : "";
    if (state.platformError?.message) {
      renderStatus(
        "ログインに失敗しました。",
        state.platformError.message,
        withUtilityActions([{ action: "login", label: "Googleでログイン" }])
      );
      return;
    }
    if (state.platformAuth?.pending) {
      renderStatus("Googleログインを処理中です。");
      return;
    }
    if (needsLogin()) {
      renderStatus("");
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
            `${formatTokenCount(quota.usedTokens)} / ${formatTokenCount(quota.limitTokens)} トークン`
          );
        }
        if (periodEndLabel) {
          detailPieces.push(`次回リセット: ${periodEndLabel}`);
        }
        renderStatus(
          "今月のトークン上限に達しました。",
          detailPieces.join(" / "),
          withUtilityActions([{ action: "pricing", label: "プランを見る" }])
        );
        return;
      }
      if (
        reason === "PLAN_REQUIRED" ||
        reason === "FEATURE_NOT_ENABLED" ||
        reason === "PAYMENT_PAST_DUE"
      ) {
        renderStatus(
          "現在の契約状態ではAI機能を利用できません。",
          "プラン・契約状態を確認してください。",
          withUtilityActions([{ action: "pricing", label: "プランを見る" }])
        );
        return;
      }
      const fallbackMessage =
        typeof state.platformAiAccess?.message === "string" && state.platformAiAccess.message.trim()
          ? state.platformAiAccess.message.trim()
          : typeof state.platformUsage?.message === "string" && state.platformUsage.message.trim()
          ? state.platformUsage.message.trim()
          : "Axiom を利用できません。";
      renderStatus(
        fallbackMessage,
        "",
        withUtilityActions([{ action: "pricing", label: "プランを見る" }])
      );
      return;
    }
    if (!pricingUrl) {
      renderStatus("", "", withUtilityActions());
      return;
    }
    renderStatus("", "", withUtilityActions());
  };

  const handlePlatformAuth = (payload: {
    auth: PlatformAuthSnapshot;
    error?: { code?: string; message?: string };
  }) => {
    state.platformAuth = payload?.auth ?? null;
    state.platformError = normalizeAuthError(payload?.error ?? null);
    if (!state.platformAuth?.authenticated) {
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

  return {
    isAiBlocked,
    needsLogin,
    openExternalUrl,
    resolvePricingUrl,
    updateStatusDisplay,
    handlePlatformAuth,
    handlePlatformAiAccess,
    handlePlatformUsage,
    handlePlatformUpdate,
  };
};

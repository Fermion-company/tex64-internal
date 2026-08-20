import { getUiLocale, onUiLocaleChange } from "./i18n.js";
import { aiText } from "./ai-i18n.js";
export const createAiChatStatusController = (params) => {
    const { aiStatus, aiAuthTopbar, aiUsageMeter, aiUsageMeterText, postToNative, requestAiAccessCheck, requestPlatformUsage, pricingFallbackUrl, state, onStatusUpdate, } = params;
    const normalizeUsageSnapshot = (usage) => {
        if (!usage || typeof usage !== "object")
            return null;
        return usage;
    };
    const INTL_LOCALE_MAP = {
        ja: "ja-JP",
        en: "en-US",
        zh: "zh-CN",
        ko: "ko-KR",
        de: "de-DE",
        fr: "fr-FR",
        es: "es-ES",
    };
    const resolveIntlLocale = () => { var _a; return (_a = INTL_LOCALE_MAP[getUiLocale()]) !== null && _a !== void 0 ? _a : "en-US"; };
    const isAiBlocked = () => Boolean(state.platformAiAccess && state.platformAiAccess.allowed === false);
    const needsLogin = () => { var _a, _b; return Boolean(!((_a = state.platformAiAccess) === null || _a === void 0 ? void 0 : _a.allowed) &&
        (!((_b = state.platformAuth) === null || _b === void 0 ? void 0 : _b.authenticated) ||
            (state.platformAiAccess &&
                (state.platformAiAccess.reason === "AUTH_REQUIRED" ||
                    state.platformAiAccess.reason === "TOKEN_EXPIRED")))); };
    const withUtilityActions = (actions) => {
        return Array.isArray(actions) ? [...actions] : [];
    };
    const normalizeAuthError = (error) => {
        if (!error || typeof error !== "object") {
            return null;
        }
        const code = typeof error.code === "string" ? error.code : "";
        const fallbackMessage = typeof error.message === "string" && error.message.trim()
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
    const renderStatus = (headline, detail, actions) => {
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
        var _a;
        if (!(aiAuthTopbar instanceof HTMLButtonElement)) {
            return;
        }
        const authenticated = Boolean((_a = state.platformAuth) === null || _a === void 0 ? void 0 : _a.authenticated);
        aiAuthTopbar.classList.toggle("is-hidden", authenticated);
        aiAuthTopbar.textContent = aiText("login");
        aiAuthTopbar.disabled = false;
    };
    const ensureTooltipDom = (parent) => {
        let tooltip = parent.querySelector(".ai-usage-tooltip");
        if (tooltip)
            return tooltip;
        tooltip = document.createElement("div");
        tooltip.className = "ai-usage-tooltip";
        tooltip.innerHTML = [
            '<div class="ai-usage-tooltip-header" data-label="title"></div>',
            '<div class="ai-usage-tooltip-row"><span class="ai-usage-tooltip-label" data-label="used"></span><span class="ai-usage-tooltip-value" data-field="used">-</span></div>',
            '<div class="ai-usage-tooltip-row"><span class="ai-usage-tooltip-label" data-label="limit"></span><span class="ai-usage-tooltip-value" data-field="limit">-</span></div>',
            '<div class="ai-usage-tooltip-row"><span class="ai-usage-tooltip-label" data-label="remaining"></span><span class="ai-usage-tooltip-value" data-field="remaining">-</span></div>',
            '<div class="ai-usage-tooltip-row"><span class="ai-usage-tooltip-label" data-label="reset"></span><span class="ai-usage-tooltip-value" data-field="reset">-</span></div>',
            '<div class="ai-usage-tooltip-bar-track"><div class="ai-usage-tooltip-bar-fill"></div></div>',
        ].join("");
        parent.appendChild(tooltip);
        return tooltip;
    };
    const formatTokenCount = (value) => new Intl.NumberFormat(resolveIntlLocale()).format(Math.max(0, Math.round(value)));
    const formatTokenCompact = (value) => {
        const v = Math.max(0, Math.round(value));
        if (v < 10000) {
            return formatTokenCount(v);
        }
        if (v < 1000000) {
            const k = v / 1000;
            if (k < 100) {
                return `${k.toFixed(1).replace(/\.0$/, "")}k`;
            }
            return `${Math.floor(k)}k`;
        }
        const m = v / 1000000;
        if (m < 100) {
            return `${m.toFixed(1).replace(/\.0$/, "")}M`;
        }
        return `${Math.floor(m)}M`;
    };
    const updateUsageMeter = () => {
        var _a, _b, _c;
        var _d, _e;
        if (!(aiUsageMeter instanceof HTMLElement)) {
            return;
        }
        // Usage is metered internally in dollars (real provider cost), but the
        // user sees TOKENS — we never surface the internal budget/cost. The token
        // figures are a blended-rate estimate of the monthly budget.
        const quota = (_e = (_d = (_a = state.platformUsage) === null || _a === void 0 ? void 0 : _a.summary) !== null && _d !== void 0 ? _d : (_b = state.platformAiAccess) === null || _b === void 0 ? void 0 : _b.quota) !== null && _e !== void 0 ? _e : null;
        const limitTokens = typeof (quota === null || quota === void 0 ? void 0 : quota.limitTokens) === "number" && Number.isFinite(quota.limitTokens)
            ? Math.max(0, Math.round(quota.limitTokens))
            : 0;
        const usedTokens = typeof (quota === null || quota === void 0 ? void 0 : quota.usedTokens) === "number" && Number.isFinite(quota.usedTokens)
            ? Math.max(0, Math.round(quota.usedTokens))
            : 0;
        if (!limitTokens) {
            aiUsageMeter.classList.add("is-hidden");
            aiUsageMeter.classList.remove("is-warn");
            aiUsageMeter.classList.remove("is-critical");
            aiUsageMeter.style.removeProperty("--ai-usage-pct");
            aiUsageMeter.style.removeProperty("--ai-remaining-pct");
            aiUsageMeter.removeAttribute("title");
            aiUsageMeter.setAttribute("aria-label", "Axiom usage");
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
        const label = `Remaining ${remainingPct.toFixed(0)}% (${formatTokenCompact(remainingTokens)})`;
        aiUsageMeter.setAttribute("aria-label", `Axiom usage: ${label}`);
        aiUsageMeter.removeAttribute("title");
        if (aiUsageMeterText instanceof HTMLElement) {
            aiUsageMeterText.textContent = `${remainingPct.toFixed(0)}%`;
        }
        const tooltip = ensureTooltipDom(aiUsageMeter);
        const setField = (field, text) => {
            const el = tooltip.querySelector(`[data-field="${field}"]`);
            if (el)
                el.textContent = text;
        };
        const setLabel = (label, text) => {
            const el = tooltip.querySelector(`[data-label="${label}"]`);
            if (el)
                el.textContent = text;
        };
        setLabel("title", aiText("usage_title"));
        setLabel("used", aiText("usage_used"));
        setLabel("limit", aiText("usage_limit"));
        setLabel("remaining", aiText("usage_remaining"));
        setLabel("reset", aiText("usage_reset"));
        const tokensUnit = aiText("usage_tokens");
        setField("used", `${formatTokenCount(usedTokens)} ${tokensUnit}`);
        setField("limit", `${formatTokenCount(limitTokens)} ${tokensUnit}`);
        setField("remaining", `${remainingPct.toFixed(1)}% (${formatTokenCompact(remainingTokens)})`);
        const periodEnd = typeof ((_c = state.platformAiAccess) === null || _c === void 0 ? void 0 : _c.periodEnd) === "string" ? state.platformAiAccess.periodEnd : null;
        if (periodEnd && Number.isFinite(Date.parse(periodEnd))) {
            setField("reset", new Date(periodEnd).toLocaleDateString(resolveIntlLocale()));
        }
        else {
            setField("reset", "-");
        }
    };
    const openExternalUrl = (url) => {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
            return;
        }
        postToNative({ type: "shell:openExternal", url: url.trim() }, true);
    };
    const resolvePricingUrl = () => {
        var _a, _b;
        const fromAccess = typeof ((_a = state.platformAiAccess) === null || _a === void 0 ? void 0 : _a.pricingUrl) === "string" && state.platformAiAccess.pricingUrl.trim()
            ? state.platformAiAccess.pricingUrl.trim()
            : "";
        if (fromAccess) {
            return fromAccess;
        }
        const fromAuth = typeof ((_b = state.platformAuth) === null || _b === void 0 ? void 0 : _b.pricingUrl) === "string" && state.platformAuth.pricingUrl.trim()
            ? state.platformAuth.pricingUrl.trim()
            : "";
        if (fromAuth) {
            return fromAuth;
        }
        return pricingFallbackUrl;
    };
    const updateStatusDisplay = () => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        var _k, _l;
        updateTopbarAuthButton();
        updateUsageMeter();
        const pricingUrl = resolvePricingUrl();
        const quota = (_l = (_k = (_a = state.platformUsage) === null || _a === void 0 ? void 0 : _a.summary) !== null && _k !== void 0 ? _k : (_b = state.platformAiAccess) === null || _b === void 0 ? void 0 : _b.quota) !== null && _l !== void 0 ? _l : null;
        const periodEnd = typeof ((_c = state.platformAiAccess) === null || _c === void 0 ? void 0 : _c.periodEnd) === "string" ? state.platformAiAccess.periodEnd : null;
        const periodEndLabel = periodEnd && Number.isFinite(Date.parse(periodEnd))
            ? new Date(periodEnd).toLocaleDateString(resolveIntlLocale())
            : "";
        if ((_d = state.platformError) === null || _d === void 0 ? void 0 : _d.message) {
            renderStatus(aiText("login_failed"), state.platformError.message, withUtilityActions([{ action: "login", label: aiText("login_with_google") }]));
            return;
        }
        if ((_e = state.platformAuth) === null || _e === void 0 ? void 0 : _e.pending) {
            renderStatus(aiText("login_processing"));
            return;
        }
        if (needsLogin()) {
            renderStatus("");
            return;
        }
        if (isAiBlocked()) {
            const reason = typeof ((_f = state.platformAiAccess) === null || _f === void 0 ? void 0 : _f.reason) === "string" && state.platformAiAccess.reason
                ? state.platformAiAccess.reason
                : typeof ((_g = state.platformUsage) === null || _g === void 0 ? void 0 : _g.errorCode) === "string" && state.platformUsage.errorCode
                    ? state.platformUsage.errorCode
                    : "";
            if (reason === "QUOTA_EXCEEDED") {
                const detailPieces = [];
                if (quota &&
                    typeof quota.usedTokens === "number" &&
                    typeof quota.limitTokens === "number") {
                    detailPieces.push(`${formatTokenCount(quota.usedTokens)} / ${formatTokenCount(quota.limitTokens)} ${aiText("usage_tokens")}`);
                }
                if (periodEndLabel) {
                    detailPieces.push(`${aiText("status_next_reset")}: ${periodEndLabel}`);
                }
                renderStatus(aiText("status_quota_reached"), detailPieces.join(" / "), withUtilityActions([{ action: "pricing", label: aiText("status_see_plan") }]));
                return;
            }
            if (reason === "PLAN_REQUIRED" ||
                reason === "FEATURE_NOT_ENABLED" ||
                reason === "PAYMENT_PAST_DUE") {
                renderStatus(aiText("status_unavailable"), aiText("status_plan_check"), withUtilityActions([{ action: "pricing", label: aiText("status_see_plan") }]));
                return;
            }
            const fallbackMessage = typeof ((_h = state.platformAiAccess) === null || _h === void 0 ? void 0 : _h.message) === "string" && state.platformAiAccess.message.trim()
                ? state.platformAiAccess.message.trim()
                : typeof ((_j = state.platformUsage) === null || _j === void 0 ? void 0 : _j.message) === "string" && state.platformUsage.message.trim()
                    ? state.platformUsage.message.trim()
                    : aiText("status_unavailable");
            renderStatus(fallbackMessage, "", withUtilityActions([{ action: "pricing", label: aiText("status_see_plan") }]));
            return;
        }
        if (!pricingUrl) {
            renderStatus("", "", withUtilityActions());
            return;
        }
        renderStatus("", "", withUtilityActions());
    };
    const handlePlatformAuth = (payload) => {
        var _a, _b, _c, _d;
        var _e, _f;
        state.platformAuth = (_e = payload === null || payload === void 0 ? void 0 : payload.auth) !== null && _e !== void 0 ? _e : null;
        state.platformError = normalizeAuthError((_f = payload === null || payload === void 0 ? void 0 : payload.error) !== null && _f !== void 0 ? _f : null);
        if (!((_a = state.platformAuth) === null || _a === void 0 ? void 0 : _a.authenticated)) {
            if (!((_b = state.platformAiAccess) === null || _b === void 0 ? void 0 : _b.allowed)) {
                requestAiAccessCheck(false);
            }
            if ((_c = state.platformAiAccess) === null || _c === void 0 ? void 0 : _c.allowed) {
                updateStatusDisplay();
                onStatusUpdate === null || onStatusUpdate === void 0 ? void 0 : onStatusUpdate();
                return;
            }
            state.platformAiAccess = null;
            state.platformUsage = null;
            state.requestedInitialUsage = false;
        }
        else if (!state.platformAuth.pending && !state.requestedInitialUsage && !((_d = payload === null || payload === void 0 ? void 0 : payload.error) === null || _d === void 0 ? void 0 : _d.message)) {
            state.requestedInitialUsage = true;
            requestAiAccessCheck(false);
            requestPlatformUsage(false);
        }
        updateStatusDisplay();
        onStatusUpdate === null || onStatusUpdate === void 0 ? void 0 : onStatusUpdate();
    };
    const handlePlatformAiAccess = (payload) => {
        var _a, _b, _c;
        var _d, _e, _f, _g, _h, _j;
        const access = (_d = payload === null || payload === void 0 ? void 0 : payload.access) !== null && _d !== void 0 ? _d : null;
        if (!access) {
            return;
        }
        state.platformAiAccess = access;
        if (access.allowed) {
            state.platformError = null;
        }
        if (access.quota &&
            (!((_a = state.platformUsage) === null || _a === void 0 ? void 0 : _a.summary) ||
                (payload === null || payload === void 0 ? void 0 : payload.source) === "auth" ||
                (payload === null || payload === void 0 ? void 0 : payload.source) === "manual" ||
                (payload === null || payload === void 0 ? void 0 : payload.source) === "chat")) {
            const usageFromAccess = normalizeUsageSnapshot({
                authenticated: Boolean(access.authenticated),
                plan: (_e = access.plan) !== null && _e !== void 0 ? _e : null,
                period: null,
                summary: access.quota,
                byFeature: (_f = (_b = state.platformUsage) === null || _b === void 0 ? void 0 : _b.byFeature) !== null && _f !== void 0 ? _f : null,
                errorCode: access.allowed ? null : (_g = access.reason) !== null && _g !== void 0 ? _g : null,
                message: (_h = access.message) !== null && _h !== void 0 ? _h : null,
                fetchedAt: (_j = access.fetchedAt) !== null && _j !== void 0 ? _j : Date.now(),
            });
            if (usageFromAccess) {
                const currentFetchedAt = typeof ((_c = state.platformUsage) === null || _c === void 0 ? void 0 : _c.fetchedAt) === "number" && Number.isFinite(state.platformUsage.fetchedAt)
                    ? state.platformUsage.fetchedAt
                    : 0;
                const nextFetchedAt = typeof usageFromAccess.fetchedAt === "number" &&
                    Number.isFinite(usageFromAccess.fetchedAt)
                    ? usageFromAccess.fetchedAt
                    : Date.now();
                if (!state.platformUsage || nextFetchedAt >= currentFetchedAt) {
                    state.platformUsage = usageFromAccess;
                }
            }
        }
        updateStatusDisplay();
        onStatusUpdate === null || onStatusUpdate === void 0 ? void 0 : onStatusUpdate();
    };
    const handlePlatformUsage = (payload) => {
        var _a;
        var _b;
        state.platformUsage = normalizeUsageSnapshot((_b = payload === null || payload === void 0 ? void 0 : payload.usage) !== null && _b !== void 0 ? _b : null);
        if (!((_a = state.platformUsage) === null || _a === void 0 ? void 0 : _a.errorCode)) {
            state.platformError = null;
        }
        updateStatusDisplay();
        onStatusUpdate === null || onStatusUpdate === void 0 ? void 0 : onStatusUpdate();
    };
    const handlePlatformUpdate = (_payload) => { };
    onUiLocaleChange(() => {
        updateStatusDisplay();
    });
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

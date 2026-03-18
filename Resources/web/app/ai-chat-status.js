export const createAiChatStatusController = (params) => {
    const { aiStatus, aiAuthTopbar, aiUsageMeter, aiUsageMeterText, postToNative, requestAiAccessCheck, requestPlatformUsage, pricingFallbackUrl, state, onStatusUpdate, } = params;
    const normalizeUsageSnapshot = (usage) => {
        if (!usage || typeof usage !== "object")
            return null;
        return usage;
    };
    const isAiBlocked = () => Boolean(state.platformAiAccess && state.platformAiAccess.allowed === false);
    const needsLogin = () => {
        var _a;
        return Boolean(!((_a = state.platformAuth) === null || _a === void 0 ? void 0 : _a.authenticated) ||
            (state.platformAiAccess &&
                (!state.platformAiAccess.authenticated ||
                    state.platformAiAccess.reason === "AUTH_REQUIRED" ||
                    state.platformAiAccess.reason === "TOKEN_EXPIRED")));
    };
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
                // User simply cancelled the login — not an error
                return null;
            default:
                return { code, message: fallbackMessage };
        }
    };
    const tokenNumberFormat = new Intl.NumberFormat("ja-JP");
    const formatTokenCount = (value) => tokenNumberFormat.format(Math.max(0, Math.round(value)));
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
        aiAuthTopbar.textContent = "ログイン";
        aiAuthTopbar.disabled = false;
    };
    const ensureTooltipDom = (parent) => {
        let tooltip = parent.querySelector(".ai-usage-tooltip");
        if (tooltip)
            return tooltip;
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
        var _a, _b, _c, _d, _e;
        if (!(aiUsageMeter instanceof HTMLElement)) {
            return;
        }
        const quota = (_d = (_b = (_a = state.platformUsage) === null || _a === void 0 ? void 0 : _a.summary) !== null && _b !== void 0 ? _b : (_c = state.platformAiAccess) === null || _c === void 0 ? void 0 : _c.quota) !== null && _d !== void 0 ? _d : null;
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
        const setField = (field, text) => {
            const el = tooltip.querySelector(`[data-field="${field}"]`);
            if (el)
                el.textContent = text;
        };
        setField("used", `${formatTokenCount(usedTokens)} トークン`);
        setField("limit", `${formatTokenCount(limitTokens)} トークン`);
        setField("remaining", `${remainingPct.toFixed(1)}% (${formatTokenCompact(remainingTokens)})`);
        const periodEnd = typeof ((_e = state.platformAiAccess) === null || _e === void 0 ? void 0 : _e.periodEnd) === "string" ? state.platformAiAccess.periodEnd : null;
        if (periodEnd && Number.isFinite(Date.parse(periodEnd))) {
            setField("reset", new Date(periodEnd).toLocaleDateString("ja-JP"));
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
        updateTopbarAuthButton();
        updateUsageMeter();
        const pricingUrl = resolvePricingUrl();
        const quota = (_d = (_b = (_a = state.platformUsage) === null || _a === void 0 ? void 0 : _a.summary) !== null && _b !== void 0 ? _b : (_c = state.platformAiAccess) === null || _c === void 0 ? void 0 : _c.quota) !== null && _d !== void 0 ? _d : null;
        const periodEnd = typeof ((_e = state.platformAiAccess) === null || _e === void 0 ? void 0 : _e.periodEnd) === "string" ? state.platformAiAccess.periodEnd : null;
        const periodEndLabel = periodEnd && Number.isFinite(Date.parse(periodEnd))
            ? new Date(periodEnd).toLocaleDateString("ja-JP")
            : "";
        if ((_f = state.platformError) === null || _f === void 0 ? void 0 : _f.message) {
            renderStatus("ログインに失敗しました。", state.platformError.message, withUtilityActions([{ action: "login", label: "Googleでログイン" }]));
            return;
        }
        if ((_g = state.platformAuth) === null || _g === void 0 ? void 0 : _g.pending) {
            renderStatus("Googleログインを処理中です。");
            return;
        }
        if (needsLogin()) {
            renderStatus("");
            return;
        }
        if (isAiBlocked()) {
            const reason = typeof ((_h = state.platformAiAccess) === null || _h === void 0 ? void 0 : _h.reason) === "string" && state.platformAiAccess.reason
                ? state.platformAiAccess.reason
                : typeof ((_j = state.platformUsage) === null || _j === void 0 ? void 0 : _j.errorCode) === "string" && state.platformUsage.errorCode
                    ? state.platformUsage.errorCode
                    : "";
            if (reason === "QUOTA_EXCEEDED") {
                const detailPieces = [];
                if (quota &&
                    typeof quota.usedTokens === "number" &&
                    typeof quota.limitTokens === "number") {
                    detailPieces.push(`${formatTokenCount(quota.usedTokens)} / ${formatTokenCount(quota.limitTokens)} トークン`);
                }
                if (periodEndLabel) {
                    detailPieces.push(`次回リセット: ${periodEndLabel}`);
                }
                renderStatus("今月のトークン上限に達しました。", detailPieces.join(" / "), withUtilityActions([{ action: "pricing", label: "プランを見る" }]));
                return;
            }
            if (reason === "PLAN_REQUIRED" ||
                reason === "FEATURE_NOT_ENABLED" ||
                reason === "PAYMENT_PAST_DUE") {
                renderStatus("現在の契約状態ではAI機能を利用できません。", "プラン・契約状態を確認してください。", withUtilityActions([{ action: "pricing", label: "プランを見る" }]));
                return;
            }
            const fallbackMessage = typeof ((_k = state.platformAiAccess) === null || _k === void 0 ? void 0 : _k.message) === "string" && state.platformAiAccess.message.trim()
                ? state.platformAiAccess.message.trim()
                : typeof ((_l = state.platformUsage) === null || _l === void 0 ? void 0 : _l.message) === "string" && state.platformUsage.message.trim()
                    ? state.platformUsage.message.trim()
                    : "Axiom を利用できません。";
            renderStatus(fallbackMessage, "", withUtilityActions([{ action: "pricing", label: "プランを見る" }]));
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
        state.platformAuth = (_a = payload === null || payload === void 0 ? void 0 : payload.auth) !== null && _a !== void 0 ? _a : null;
        state.platformError = normalizeAuthError((_b = payload === null || payload === void 0 ? void 0 : payload.error) !== null && _b !== void 0 ? _b : null);
        if (!((_c = state.platformAuth) === null || _c === void 0 ? void 0 : _c.authenticated)) {
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const access = (_a = payload === null || payload === void 0 ? void 0 : payload.access) !== null && _a !== void 0 ? _a : null;
        if (!access) {
            return;
        }
        state.platformAiAccess = access;
        if (access.allowed) {
            state.platformError = null;
        }
        if (access.quota &&
            (!((_b = state.platformUsage) === null || _b === void 0 ? void 0 : _b.summary) ||
                (payload === null || payload === void 0 ? void 0 : payload.source) === "auth" ||
                (payload === null || payload === void 0 ? void 0 : payload.source) === "manual" ||
                (payload === null || payload === void 0 ? void 0 : payload.source) === "chat")) {
            const usageFromAccess = normalizeUsageSnapshot({
                authenticated: Boolean(access.authenticated),
                plan: (_c = access.plan) !== null && _c !== void 0 ? _c : null,
                period: null,
                summary: access.quota,
                byFeature: (_e = (_d = state.platformUsage) === null || _d === void 0 ? void 0 : _d.byFeature) !== null && _e !== void 0 ? _e : null,
                errorCode: access.allowed ? null : (_f = access.reason) !== null && _f !== void 0 ? _f : null,
                message: (_g = access.message) !== null && _g !== void 0 ? _g : null,
                fetchedAt: (_h = access.fetchedAt) !== null && _h !== void 0 ? _h : Date.now(),
            });
            if (usageFromAccess) {
                const currentFetchedAt = typeof ((_j = state.platformUsage) === null || _j === void 0 ? void 0 : _j.fetchedAt) === "number" && Number.isFinite(state.platformUsage.fetchedAt)
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
        var _a, _b;
        state.platformUsage = normalizeUsageSnapshot((_a = payload === null || payload === void 0 ? void 0 : payload.usage) !== null && _a !== void 0 ? _a : null);
        if (!((_b = state.platformUsage) === null || _b === void 0 ? void 0 : _b.errorCode)) {
            state.platformError = null;
        }
        updateStatusDisplay();
        onStatusUpdate === null || onStatusUpdate === void 0 ? void 0 : onStatusUpdate();
    };
    const handlePlatformUpdate = (_payload) => { };
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

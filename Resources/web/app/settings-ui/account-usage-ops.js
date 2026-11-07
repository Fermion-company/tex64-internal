import { aiText } from "../ai-i18n.js";
import { getUiLocale, onUiLocaleChange } from "../i18n.js";
const INTL_LOCALE = {
    ja: "ja-JP",
    en: "en-US",
    zh: "zh-CN",
    ko: "ko-KR",
    de: "de-DE",
    fr: "fr-FR",
    es: "es-ES",
};
const PLAN_LABEL = { free: "Free", basic: "Basic", pro: "Pro" };
export const createSettingsAccountUsageOps = (runtime) => {
    const { settingsUsage, settingsUsagePlan, settingsUsageReset, settingsUsageBar, settingsUsageFill, settingsUsageUsed, settingsUsagePct, } = runtime.context.dom;
    let access = null;
    let usage = null;
    const intlLocale = () => { var _a; return (_a = INTL_LOCALE[getUiLocale()]) !== null && _a !== void 0 ? _a : "en-US"; };
    const formatTokens = (value) => new Intl.NumberFormat(intlLocale()).format(Math.max(0, Math.round(value)));
    const render = () => {
        var _a, _b, _c, _d, _e, _f;
        if (!(settingsUsage instanceof HTMLElement))
            return;
        const rawPlan = ((_b = (_a = access === null || access === void 0 ? void 0 : access.plan) !== null && _a !== void 0 ? _a : usage === null || usage === void 0 ? void 0 : usage.plan) !== null && _b !== void 0 ? _b : "free").toLowerCase();
        const planLabel = (_c = PLAN_LABEL[rawPlan]) !== null && _c !== void 0 ? _c : rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1);
        const quota = (_e = (_d = usage === null || usage === void 0 ? void 0 : usage.summary) !== null && _d !== void 0 ? _d : access === null || access === void 0 ? void 0 : access.quota) !== null && _e !== void 0 ? _e : null;
        const limit = typeof (quota === null || quota === void 0 ? void 0 : quota.limitTokens) === "number" && Number.isFinite(quota.limitTokens) ? Math.max(0, quota.limitTokens) : 0;
        const used = typeof (quota === null || quota === void 0 ? void 0 : quota.usedTokens) === "number" && Number.isFinite(quota.usedTokens) ? Math.max(0, quota.usedTokens) : 0;
        const pct = limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;
        if (settingsUsagePlan instanceof HTMLElement) {
            settingsUsagePlan.textContent = planLabel;
        }
        const periodEnd = typeof (access === null || access === void 0 ? void 0 : access.periodEnd) === "string" ? access.periodEnd : (_f = quota === null || quota === void 0 ? void 0 : quota.periodEnd) !== null && _f !== void 0 ? _f : null;
        if (settingsUsageReset instanceof HTMLElement) {
            settingsUsageReset.textContent =
                periodEnd && Number.isFinite(Date.parse(periodEnd))
                    ? aiText("usage_resets").replace("{date}", new Date(periodEnd).toLocaleDateString(intlLocale(), { month: "short", day: "numeric" }))
                    : "";
        }
        const hasQuota = limit > 0;
        if (settingsUsageBar instanceof HTMLElement) {
            settingsUsageBar.hidden = !hasQuota;
            settingsUsageBar.setAttribute("aria-valuenow", pct.toFixed(0));
            settingsUsageBar.classList.toggle("is-warn", pct >= 80 && pct < 95);
            settingsUsageBar.classList.toggle("is-critical", pct >= 95);
        }
        if (settingsUsageFill instanceof HTMLElement) {
            settingsUsageFill.style.width = `${pct.toFixed(1)}%`;
        }
        if (settingsUsageUsed instanceof HTMLElement) {
            settingsUsageUsed.textContent = hasQuota
                ? `${aiText("usage_month")}: ${formatTokens(used)} / ${formatTokens(limit)} ${aiText("usage_tokens")}`
                : "";
        }
        if (settingsUsagePct instanceof HTMLElement) {
            settingsUsagePct.textContent = hasQuota ? `${pct.toFixed(0)}%` : "";
        }
    };
    onUiLocaleChange(() => render());
    return {
        render,
        handlePlatformAiAccess: (payload) => {
            if (payload === null || payload === void 0 ? void 0 : payload.access)
                access = payload.access;
            render();
        },
        handlePlatformUsage: (payload) => {
            if (payload === null || payload === void 0 ? void 0 : payload.usage)
                usage = payload.usage;
            render();
        },
    };
};

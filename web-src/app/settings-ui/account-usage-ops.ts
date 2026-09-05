import type { PlatformAiAccessSnapshot, PlatformUsageSnapshot } from "../types.js";
import type { SettingsUiRuntime } from "./runtime.js";
import { aiText } from "../ai-i18n.js";
import { getUiLocale, onUiLocaleChange } from "../i18n.js";

/**
 * Settings › Account › Axiom: the plan, this month's usage as one bar, and
 * the reset date. The same numbers the host already sends for the chat;
 * nothing here asks the server on its own.
 */
export type SettingsAccountUsageOps = {
  render: () => void;
  handlePlatformAiAccess: (payload: { source?: string; access: PlatformAiAccessSnapshot }) => void;
  handlePlatformUsage: (payload: { source?: string; usage: PlatformUsageSnapshot }) => void;
};

const INTL_LOCALE: Record<string, string> = {
  ja: "ja-JP",
  en: "en-US",
  zh: "zh-CN",
  ko: "ko-KR",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
};

const PLAN_LABEL: Record<string, string> = { free: "Free", basic: "Basic", pro: "Pro" };

export const createSettingsAccountUsageOps = (runtime: SettingsUiRuntime): SettingsAccountUsageOps => {
  const {
    settingsUsage,
    settingsUsagePlan,
    settingsUsageReset,
    settingsUsageBar,
    settingsUsageFill,
    settingsUsageUsed,
    settingsUsagePct,
    settingsUsageNote,
  } = runtime.context.dom;
  let access: PlatformAiAccessSnapshot | null = null;
  let usage: PlatformUsageSnapshot | null = null;

  const intlLocale = () => INTL_LOCALE[getUiLocale()] ?? "en-US";
  const formatTokens = (value: number) => new Intl.NumberFormat(intlLocale()).format(Math.max(0, Math.round(value)));

  const render = () => {
    if (!(settingsUsage instanceof HTMLElement)) return;
    const authenticated = Boolean(runtime.state.platformAuth?.authenticated);
    const rawPlan = (access?.plan ?? usage?.plan ?? "free").toLowerCase();
    const planLabel = PLAN_LABEL[rawPlan] ?? rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1);
    const quota = usage?.summary ?? access?.quota ?? null;
    const limit = typeof quota?.limitTokens === "number" && Number.isFinite(quota.limitTokens) ? Math.max(0, quota.limitTokens) : 0;
    const used = typeof quota?.usedTokens === "number" && Number.isFinite(quota.usedTokens) ? Math.max(0, quota.usedTokens) : 0;
    const pct = limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;
    if (settingsUsagePlan instanceof HTMLElement) {
      settingsUsagePlan.textContent = `${aiText("plan_word")}: ${planLabel}`;
    }
    const periodEnd = typeof access?.periodEnd === "string" ? access.periodEnd : quota?.periodEnd ?? null;
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
    if (settingsUsageNote instanceof HTMLElement) {
      const note = !authenticated && !hasQuota ? aiText("usage_signin") : "";
      settingsUsageNote.textContent = note;
      settingsUsageNote.classList.toggle("is-hidden", note.length === 0);
    }
  };

  onUiLocaleChange(() => render());

  return {
    render,
    handlePlatformAiAccess: (payload) => {
      if (payload?.access) access = payload.access;
      render();
    },
    handlePlatformUsage: (payload) => {
      if (payload?.usage) usage = payload.usage;
      render();
    },
  };
};

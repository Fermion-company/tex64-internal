import type { SettingsUiRuntime } from "./runtime.js";

export type SettingsAttentionOps = {
  hasUpdateAttention: () => boolean;
  syncUpdateAttentionUi: () => void;
};

export const createSettingsAttentionOps = (runtime: SettingsUiRuntime): SettingsAttentionOps => {
  const { settingsNavItems, settingsAccountAttention } = runtime.context.dom;
  const accountSettingsNavItem =
    settingsNavItems.find((button) => button.dataset.settingsTarget === "account") ?? null;

  const hasUpdateAttention = () => {
    const phase = runtime.state.platformUpdateStatus?.phase ?? "idle";
    if (phase === "available" || phase === "downloaded" || phase === "error") {
      return true;
    }
    if (phase === "idle" && runtime.state.platformUpdate?.hasUpdate) {
      return true;
    }
    return false;
  };

  const syncUpdateAttentionUi = () => {
    const updateAttention = hasUpdateAttention();
    if (accountSettingsNavItem instanceof HTMLElement) {
      accountSettingsNavItem.classList.toggle("has-alert", updateAttention);
    }
    if (settingsAccountAttention instanceof HTMLElement) {
      settingsAccountAttention.textContent = "Update";
      settingsAccountAttention.classList.toggle("is-hidden", !updateAttention);
      settingsAccountAttention.setAttribute("aria-hidden", updateAttention ? "false" : "true");
    }
    // The environment screen no longer raises a "setup needed" alert, and app
    // updates surface via the header Update button — so the gear tab stays clean.
    runtime.deps.onUpdateAttentionChange?.(false);
  };

  return { hasUpdateAttention, syncUpdateAttentionUi };
};

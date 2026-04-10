import type { SettingsUiRuntime } from "./runtime.js";

export type SettingsAttentionOps = {
  hasRuntimeSetupAttention: () => boolean;
  hasUpdateAttention: () => boolean;
  syncUpdateAttentionUi: () => void;
};

export const createSettingsAttentionOps = (runtime: SettingsUiRuntime): SettingsAttentionOps => {
  const { settingsNavItems, settingsRuntimeAttention, settingsAccountAttention } = runtime.context.dom;
  const runtimeSettingsNavItem =
    settingsNavItems.find((button) => button.dataset.settingsTarget === "env") ?? null;
  const accountSettingsNavItem =
    settingsNavItems.find((button) => button.dataset.settingsTarget === "account") ?? null;

  const hasRuntimeSetupAttention = () =>
    Boolean(
      runtime.state.runtimeStatusSummary?.hasAnyResult &&
        runtime.state.runtimeStatusSummary?.runtimeReady === false
    );

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
    const runtimeAttention = hasRuntimeSetupAttention();
    const anyAttention = updateAttention || runtimeAttention;
    const hideAlertWhileRuntimeOpen =
      runtime.state.activeSettingsPage === "env" || runtime.state.activeSettingsPage === "account";
    const showTabAlert = anyAttention && !hideAlertWhileRuntimeOpen;

    if (runtimeSettingsNavItem instanceof HTMLElement) {
      runtimeSettingsNavItem.classList.toggle("has-alert", runtimeAttention);
    }
    if (accountSettingsNavItem instanceof HTMLElement) {
      accountSettingsNavItem.classList.toggle("has-alert", updateAttention);
    }
    if (settingsRuntimeAttention instanceof HTMLElement) {
      settingsRuntimeAttention.textContent = "Setup needed";
      settingsRuntimeAttention.classList.toggle("is-hidden", !runtimeAttention);
      settingsRuntimeAttention.setAttribute("aria-hidden", runtimeAttention ? "false" : "true");
    }
    if (settingsAccountAttention instanceof HTMLElement) {
      settingsAccountAttention.textContent = "Update";
      settingsAccountAttention.classList.toggle("is-hidden", !updateAttention);
      settingsAccountAttention.setAttribute("aria-hidden", updateAttention ? "false" : "true");
    }
    runtime.deps.onUpdateAttentionChange?.(showTabAlert);
  };

  return { hasRuntimeSetupAttention, hasUpdateAttention, syncUpdateAttentionUi };
};


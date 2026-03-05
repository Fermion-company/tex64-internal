import type { SettingsUiRuntime } from "./runtime.js";
import type { SettingsAttentionOps } from "./attention.js";

export type SettingsPageNavOps = {
  setSettingsPage: (pageId: string | null) => void;
};

export const createSettingsPageNavOps = (
  runtime: SettingsUiRuntime,
  attentionOps: SettingsAttentionOps,
  deps: {
    checkEnvironmentStatus: () => void;
    updateRuntimeOnboardingUi: () => void;
    maybeRequestPlatformUpdateCheck: (force?: boolean) => boolean;
  }
): SettingsPageNavOps => {
  const { settingsPanel, settingsNav, settingsNavItems, settingsPages, settingsPageItems, settingsBackButtons } =
    runtime.context.dom;

  const setSettingsPage = (pageId: string | null) => {
    runtime.state.activeSettingsPage = pageId;
    const hasPage = !!pageId;
    if (settingsNav instanceof HTMLElement) {
      settingsNav.classList.toggle("is-hidden", hasPage);
      settingsNav.setAttribute("aria-hidden", hasPage ? "true" : "false");
    }
    if (settingsPages instanceof HTMLElement) {
      settingsPages.classList.toggle("is-hidden", !hasPage);
      settingsPages.setAttribute("aria-hidden", hasPage ? "false" : "true");
    }
    settingsPageItems.forEach((page) => {
      const isActive = hasPage && page.dataset.settingsPage === pageId;
      page.classList.toggle("is-hidden", !isActive);
      page.classList.toggle("is-active", isActive);
      page.setAttribute("aria-hidden", isActive ? "false" : "true");
    });
    if (settingsPanel instanceof HTMLElement) {
      settingsPanel.scrollTop = 0;
    }
    attentionOps.syncUpdateAttentionUi();
    if (pageId === "env") {
      deps.updateRuntimeOnboardingUi();
      deps.checkEnvironmentStatus();
    }
    if (pageId === "env" || pageId === "account") {
      deps.maybeRequestPlatformUpdateCheck(false);
    }
  };

  if (settingsNavItems.length > 0) {
    settingsNavItems.forEach((button) => {
      button.addEventListener("click", () => {
        const target = button.dataset.settingsTarget;
        if (!target) {
          return;
        }
        setSettingsPage(target);
      });
    });
  }

  if (settingsBackButtons.length > 0) {
    settingsBackButtons.forEach((button) => {
      button.addEventListener("click", () => {
        setSettingsPage(null);
      });
    });
  }

  return { setSettingsPage };
};


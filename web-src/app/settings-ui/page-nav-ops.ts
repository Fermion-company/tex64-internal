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

  // First nav category is the default page shown when the overlay opens.
  const defaultPageId =
    settingsNavItems[0]?.dataset.settingsTarget ??
    settingsPageItems[0]?.dataset.settingsPage ??
    null;

  // Pages that were merged into others: callers and remembered values that
  // still name them land on the page that holds their rows now.
  const MOVED_PAGES: Record<string, string> = { editor: "general", env: "build", info: "account" };
  const resolvePageId = (pageId: string | null) => {
    const id = pageId ? MOVED_PAGES[pageId] ?? pageId : null;
    return id && settingsPageItems.some((page) => page.dataset.settingsPage === id) ? id : defaultPageId;
  };

  const setSettingsPage = (pageId: string | null) => {
    // Full-screen side-by-side layout: the category nav stays visible and a
    // page is always shown in the content pane (no drill-in / back button).
    const resolved = resolvePageId(pageId);
    runtime.state.activeSettingsPage = resolved;
    if (settingsNav instanceof HTMLElement) {
      settingsNav.classList.remove("is-hidden");
      settingsNav.setAttribute("aria-hidden", "false");
    }
    if (settingsPages instanceof HTMLElement) {
      settingsPages.classList.remove("is-hidden");
      settingsPages.setAttribute("aria-hidden", "false");
    }
    settingsNavItems.forEach((item) => {
      const isActive = !!resolved && item.dataset.settingsTarget === resolved;
      item.classList.toggle("is-active", isActive);
      item.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    settingsPageItems.forEach((page) => {
      const isActive = !!resolved && page.dataset.settingsPage === resolved;
      page.classList.toggle("is-hidden", !isActive);
      page.classList.toggle("is-active", isActive);
      page.setAttribute("aria-hidden", isActive ? "false" : "true");
    });
    const activePage = settingsPageItems.find(
      (page) => page.dataset.settingsPage === resolved
    );
    if (activePage instanceof HTMLElement) {
      activePage.scrollTop = 0;
    }
    if (settingsPanel instanceof HTMLElement) {
      settingsPanel.scrollTop = 0;
    }
    attentionOps.syncUpdateAttentionUi();
    // The TeX status is the first row of Build.
    if (resolved === "build") {
      deps.updateRuntimeOnboardingUi();
      deps.checkEnvironmentStatus();
    }
    if (resolved === "build" || resolved === "account") {
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

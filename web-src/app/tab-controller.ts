import { TAB_KEY_SET, type TabKey } from "./config.js";
import type { AppContext } from "./context.js";

type TabControllerDeps = {
  onFilesTabActive: () => void;
  onSettingsTabActive: () => void;
};

export type TabControllerApi = {
  getActiveTab: () => TabKey;
  normalizeTabKey: (key: string | undefined) => TabKey;
  setActiveTab: (tabKey: TabKey) => void;
};

export const initTabController = (
  context: AppContext,
  deps: TabControllerDeps
): TabControllerApi => {
  const {
    tabs,
    sidebarPanels,
  } = context.dom;

  const activeTabStorageKey = "tex64.activeTab";

  const normalizeTabKey = (key: string | undefined): TabKey => {
    if (key && TAB_KEY_SET.has(key as TabKey)) {
      return key as TabKey;
    }
    return "files";
  };

  const loadStoredActiveTab = (): TabKey => {
    try {
      const stored = localStorage.getItem(activeTabStorageKey) ?? undefined;
      return normalizeTabKey(stored);
    } catch {
      return "files";
    }
  };

  const saveActiveTab = (tabKey: TabKey) => {
    try {
      localStorage.setItem(activeTabStorageKey, tabKey);
    } catch {
      // ignore storage failures
    }
  };

  let activeTab: TabKey = loadStoredActiveTab();

  const setActiveTab = (tabKey: TabKey) => {
    tabs.forEach((tab) => {
      const isActive = tab.dataset.tab === tabKey;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    activeTab = tabKey;
    saveActiveTab(tabKey);
    document.body.dataset.activeTab = tabKey;
    sidebarPanels.forEach((panel) => {
      const isActive = panel.dataset.panel === tabKey;
      panel.classList.toggle("is-active", isActive);
    });
    if (tabKey === "files") {
      deps.onFilesTabActive();
    }
    if (tabKey === "settings") {
      deps.onSettingsTabActive();
    }
  };

  return {
    getActiveTab: () => activeTab,
    normalizeTabKey,
    setActiveTab,
  };
};

import { TAB_KEY_SET } from "./config.js";
export const initTabController = (context, deps) => {
    const { tabs, sidebarPanels, } = context.dom;
    const activeTabStorageKey = "tex64.activeTab";
    const normalizeTabKey = (key) => {
        if (key && TAB_KEY_SET.has(key)) {
            return key;
        }
        return "files";
    };
    const loadStoredActiveTab = () => {
        var _a;
        try {
            const stored = (_a = localStorage.getItem(activeTabStorageKey)) !== null && _a !== void 0 ? _a : undefined;
            return normalizeTabKey(stored);
        }
        catch {
            return "files";
        }
    };
    const saveActiveTab = (tabKey) => {
        try {
            localStorage.setItem(activeTabStorageKey, tabKey);
        }
        catch {
            // ignore storage failures
        }
    };
    let activeTab = loadStoredActiveTab();
    const setActiveTab = (tabKey) => {
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

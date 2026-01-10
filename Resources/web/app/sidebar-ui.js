import { tabConfig } from "./config.js";
export const initSidebarVisibility = (context, deps) => {
    const { tabs, sidebarPanels, sidebar } = context.dom;
    const primarySidebarTabs = [
        "files",
        "outline",
        "blocks",
        "alchemy",
        "ai",
        "issues",
        "git",
        "project",
    ];
    let sidebarVisibleTabs = new Set(primarySidebarTabs);
    const sidebarVisibilityKey = "tex64.sidebar.primaryTabs";
    const saveSidebarVisibility = () => {
        localStorage.setItem(sidebarVisibilityKey, JSON.stringify(Array.from(sidebarVisibleTabs)));
    };
    const loadVisibility = () => {
        const stored = localStorage.getItem(sidebarVisibilityKey);
        if (!stored) {
            sidebarVisibleTabs = new Set(primarySidebarTabs);
            return;
        }
        try {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                const next = new Set();
                parsed.forEach((entry) => {
                    if (typeof entry === "string" && primarySidebarTabs.includes(entry)) {
                        next.add(entry);
                    }
                });
                if (next.size > 0) {
                    sidebarVisibleTabs = next;
                }
            }
        }
        catch {
            sidebarVisibleTabs = new Set(primarySidebarTabs);
        }
    };
    const isSidebarTabVisible = (tabKey) => {
        if (!primarySidebarTabs.includes(tabKey)) {
            return true;
        }
        return sidebarVisibleTabs.has(tabKey);
    };
    const applyVisibility = () => {
        var _a;
        tabs.forEach((tab) => {
            const key = deps.normalizeTabKey(tab.dataset.tab);
            const visible = isSidebarTabVisible(key);
            tab.classList.toggle("is-hidden", !visible);
            tab.setAttribute("aria-hidden", visible ? "false" : "true");
        });
        sidebarPanels.forEach((panel) => {
            const key = deps.normalizeTabKey(panel.dataset.panel);
            const visible = isSidebarTabVisible(key);
            panel.classList.toggle("is-hidden", !visible);
        });
        if (!isSidebarTabVisible(deps.getActiveTab())) {
            const fallback = (_a = primarySidebarTabs.find((key) => isSidebarTabVisible(key))) !== null && _a !== void 0 ? _a : "files";
            deps.setActiveTab(fallback);
        }
    };
    const toggleSidebarTabVisibility = (tabKey) => {
        if (!primarySidebarTabs.includes(tabKey)) {
            return;
        }
        if (sidebarVisibleTabs.has(tabKey)) {
            if (sidebarVisibleTabs.size <= 1) {
                return;
            }
            sidebarVisibleTabs.delete(tabKey);
        }
        else {
            sidebarVisibleTabs.add(tabKey);
        }
        saveSidebarVisibility();
        applyVisibility();
    };
    const buildSidebarContextMenuItems = () => primarySidebarTabs.map((key) => {
        const visible = sidebarVisibleTabs.has(key);
        const canHide = sidebarVisibleTabs.size > 1;
        return {
            type: "action",
            label: `${visible ? "✓ " : ""}${tabConfig[key].label}`,
            enabled: visible ? canHide : true,
            action: () => toggleSidebarTabVisibility(key),
        };
    });
    if (sidebar instanceof HTMLElement) {
        sidebar.addEventListener("contextmenu", (event) => {
            const target = event.target;
            if (target && target.closest(".tab-group.secondary")) {
                return;
            }
            event.preventDefault();
            deps.contextMenu.open(event.clientX, event.clientY, buildSidebarContextMenuItems());
        });
    }
    return { loadVisibility, applyVisibility };
};

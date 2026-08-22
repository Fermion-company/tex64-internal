import { getTabConfig } from "./config.js";
export const initSidebarVisibility = (context, deps) => {
    const { tabs, sidebarPanels, sidebar } = context.dom;
    const primarySidebarTabs = [
        "files",
        "search",
        "outline",
        "blocks",
        "ai",
        "issues",
        "project",
    ];
    let sidebarVisibleTabs = new Set(primarySidebarTabs);
    let primaryTabOrder = primarySidebarTabs.slice();
    const sidebarVisibilityKey = "tex64.sidebar.primaryTabs";
    const sidebarTabDragType = "application/x-tex64-sidebar-tab";
    const primaryTabGroup = sidebar === null || sidebar === void 0 ? void 0 : sidebar.querySelector(".tab-group:not(.secondary)");
    const isPrimaryTab = (tabKey) => primarySidebarTabs.includes(tabKey);
    const buildPrimaryTabMap = () => {
        const map = new Map();
        tabs.forEach((tab) => {
            const key = deps.normalizeTabKey(tab.dataset.tab);
            if (isPrimaryTab(key)) {
                map.set(key, tab);
            }
        });
        return map;
    };
    const normalizePrimaryTabOrder = (order) => {
        const next = [];
        order.forEach((key) => {
            if (isPrimaryTab(key) && !next.includes(key)) {
                next.push(key);
            }
        });
        primarySidebarTabs.forEach((key) => {
            if (!next.includes(key)) {
                next.push(key);
            }
        });
        return next;
    };
    const applyPrimaryTabOrder = () => {
        if (!(primaryTabGroup instanceof HTMLElement)) {
            return;
        }
        const tabMap = buildPrimaryTabMap();
        primaryTabOrder.forEach((key) => {
            const tab = tabMap.get(key);
            if (tab) {
                primaryTabGroup.appendChild(tab);
            }
        });
    };
    const saveSidebarVisibility = () => {
        const payload = primaryTabOrder.map((key) => ({
            key,
            visible: sidebarVisibleTabs.has(key),
        }));
        localStorage.setItem(sidebarVisibilityKey, JSON.stringify(payload));
    };
    const loadVisibility = () => {
        const stored = localStorage.getItem(sidebarVisibilityKey);
        if (!stored) {
            sidebarVisibleTabs = new Set(primarySidebarTabs);
            primaryTabOrder = primarySidebarTabs.slice();
            return;
        }
        try {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                const nextOrder = [];
                const nextVisible = new Set();
                parsed.forEach((entry) => {
                    if (typeof entry === "string") {
                        const key = entry;
                        if (isPrimaryTab(key)) {
                            if (!nextOrder.includes(key)) {
                                nextOrder.push(key);
                            }
                            nextVisible.add(key);
                        }
                        return;
                    }
                    if (entry && typeof entry === "object" && typeof entry.key === "string") {
                        const key = entry.key;
                        if (!isPrimaryTab(key)) {
                            return;
                        }
                        if (!nextOrder.includes(key)) {
                            nextOrder.push(key);
                        }
                        if (entry.visible !== false) {
                            nextVisible.add(key);
                        }
                    }
                });
                let normalizedOrder = normalizePrimaryTabOrder(nextOrder);
                if (!nextOrder.includes("search")) {
                    const withoutSearch = normalizedOrder.filter((key) => key !== "search");
                    const filesIndex = withoutSearch.indexOf("files");
                    withoutSearch.splice(filesIndex >= 0 ? filesIndex + 1 : 0, 0, "search");
                    normalizedOrder = withoutSearch;
                }
                if (normalizedOrder.length > 0) {
                    primaryTabOrder = normalizedOrder;
                }
                if (nextVisible.size > 0) {
                    sidebarVisibleTabs = nextVisible;
                }
                else {
                    sidebarVisibleTabs = new Set([primaryTabOrder[0]]);
                }
            }
        }
        catch {
            sidebarVisibleTabs = new Set(primarySidebarTabs);
            primaryTabOrder = primarySidebarTabs.slice();
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
        applyPrimaryTabOrder();
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
            const fallback = (_a = primaryTabOrder.find((key) => isSidebarTabVisible(key))) !== null && _a !== void 0 ? _a : "files";
            deps.setActiveTab(fallback);
        }
    };
    const toggleSidebarTabVisibility = (tabKey) => {
        if (!isPrimaryTab(tabKey)) {
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
            if (!primaryTabOrder.includes(tabKey)) {
                primaryTabOrder = normalizePrimaryTabOrder([...primaryTabOrder, tabKey]);
            }
        }
        saveSidebarVisibility();
        applyVisibility();
    };
    const buildSidebarContextMenuItems = () => primaryTabOrder.map((key) => {
        const tabConfig = getTabConfig();
        const visible = sidebarVisibleTabs.has(key);
        const canHide = sidebarVisibleTabs.size > 1;
        return {
            type: "action",
            label: `${visible ? "✓ " : ""}${tabConfig[key].label}`,
            enabled: visible ? canHide : true,
            action: () => toggleSidebarTabVisibility(key),
        };
    });
    const movePrimaryTab = (dragKey, targetKey, insertAfter) => {
        if (dragKey === targetKey) {
            return;
        }
        const next = primaryTabOrder.filter((key) => key !== dragKey);
        const targetIndex = next.indexOf(targetKey);
        if (targetIndex === -1) {
            return;
        }
        const insertIndex = insertAfter ? targetIndex + 1 : targetIndex;
        next.splice(insertIndex, 0, dragKey);
        primaryTabOrder = next;
    };
    const movePrimaryTabToEnd = (dragKey) => {
        const next = primaryTabOrder.filter((key) => key !== dragKey);
        next.push(dragKey);
        primaryTabOrder = next;
    };
    const setSidebarTabDragData = (event, tabKey) => {
        if (!event.dataTransfer) {
            return;
        }
        event.dataTransfer.clearData();
        event.dataTransfer.setData(sidebarTabDragType, tabKey);
        event.dataTransfer.effectAllowed = "move";
    };
    const getSidebarTabDragData = (event) => {
        var _a;
        const raw = (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.getData(sidebarTabDragType);
        if (!raw) {
            return null;
        }
        if (isPrimaryTab(raw)) {
            return raw;
        }
        return null;
    };
    const getPrimaryTabKeyFromTarget = (event) => {
        const target = event.target;
        if (!target) {
            return null;
        }
        const tab = target.closest(".tab[data-tab]");
        if (!tab) {
            return null;
        }
        const key = deps.normalizeTabKey(tab.dataset.tab);
        return isPrimaryTab(key) ? key : null;
    };
    const getDropInsertAfter = (event, tab) => {
        const rect = tab.getBoundingClientRect();
        return event.clientY > rect.top + rect.height / 2;
    };
    const setupPrimaryTabDnD = () => {
        if (!(primaryTabGroup instanceof HTMLElement)) {
            return;
        }
        let dragKey = null;
        let dropTarget = null;
        const clearDropTarget = () => {
            if (dropTarget) {
                dropTarget.classList.remove("is-drop-target");
                dropTarget.removeAttribute("data-drop-position");
            }
            dropTarget = null;
        };
        const setDropTarget = (tab, insertAfter) => {
            if (dropTarget === tab) {
                if (tab) {
                    tab.setAttribute("data-drop-position", insertAfter ? "after" : "before");
                }
                return;
            }
            clearDropTarget();
            if (tab) {
                tab.classList.add("is-drop-target");
                tab.setAttribute("data-drop-position", insertAfter ? "after" : "before");
                dropTarget = tab;
            }
        };
        buildPrimaryTabMap().forEach((tab, key) => {
            tab.draggable = true;
            tab.addEventListener("dragstart", (event) => {
                const dragEvent = event;
                dragKey = key;
                setSidebarTabDragData(dragEvent, key);
                tab.classList.add("is-dragging");
            });
            tab.addEventListener("dragend", () => {
                dragKey = null;
                tab.classList.remove("is-dragging");
                clearDropTarget();
            });
        });
        primaryTabGroup.addEventListener("dragover", (event) => {
            var _a;
            const dragEvent = event;
            const currentDragKey = dragKey !== null && dragKey !== void 0 ? dragKey : getSidebarTabDragData(dragEvent);
            if (!currentDragKey) {
                return;
            }
            const targetKey = getPrimaryTabKeyFromTarget(dragEvent);
            const targetTab = targetKey ? (_a = buildPrimaryTabMap().get(targetKey)) !== null && _a !== void 0 ? _a : null : null;
            if (targetTab) {
                if (targetKey === currentDragKey) {
                    clearDropTarget();
                    return;
                }
                dragEvent.preventDefault();
                if (dragEvent.dataTransfer) {
                    dragEvent.dataTransfer.dropEffect = "move";
                }
                const insertAfter = getDropInsertAfter(dragEvent, targetTab);
                setDropTarget(targetTab, insertAfter);
                return;
            }
            dragEvent.preventDefault();
            if (dragEvent.dataTransfer) {
                dragEvent.dataTransfer.dropEffect = "move";
            }
            clearDropTarget();
        });
        primaryTabGroup.addEventListener("drop", (event) => {
            const dragEvent = event;
            const currentDragKey = dragKey !== null && dragKey !== void 0 ? dragKey : getSidebarTabDragData(dragEvent);
            if (!currentDragKey) {
                return;
            }
            dragEvent.preventDefault();
            const targetKey = getPrimaryTabKeyFromTarget(dragEvent);
            if (targetKey) {
                const targetTab = buildPrimaryTabMap().get(targetKey);
                if (targetTab && targetKey !== currentDragKey) {
                    const insertAfter = getDropInsertAfter(dragEvent, targetTab);
                    movePrimaryTab(currentDragKey, targetKey, insertAfter);
                }
            }
            else {
                movePrimaryTabToEnd(currentDragKey);
            }
            saveSidebarVisibility();
            applyVisibility();
            clearDropTarget();
            dragKey = null;
        });
        primaryTabGroup.addEventListener("dragleave", (event) => {
            const dragEvent = event;
            if (dragEvent.relatedTarget && primaryTabGroup.contains(dragEvent.relatedTarget)) {
                return;
            }
            clearDropTarget();
        });
    };
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
    setupPrimaryTabDnD();
    return { loadVisibility, applyVisibility };
};

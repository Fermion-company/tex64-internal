import { getTabConfig, type TabKey } from "./config.js";
import type { AppContext } from "./context.js";
import type { ContextMenuApi, ContextMenuItem } from "./context-menu.js";

type SidebarVisibilityDeps = {
  contextMenu: ContextMenuApi;
  getActiveTab: () => TabKey;
  setActiveTab: (tabKey: TabKey) => void;
  normalizeTabKey: (key: string | undefined) => TabKey;
};

type StoredPrimaryTab = {
  key: TabKey;
  visible?: boolean;
};

export type SidebarVisibilityApi = {
  loadVisibility: () => void;
  applyVisibility: () => void;
};

export const initSidebarVisibility = (
  context: AppContext,
  deps: SidebarVisibilityDeps
): SidebarVisibilityApi => {
  const { tabs, sidebarPanels, sidebar } = context.dom;

  const primarySidebarTabs: TabKey[] = [
    "files",
    "search",
    "outline",
    "blocks",
    "ai",
    "issues",
    "project",
  ];
  let sidebarVisibleTabs = new Set<TabKey>(primarySidebarTabs);
  let primaryTabOrder = primarySidebarTabs.slice();
  const sidebarVisibilityKey = "tex64.sidebar.primaryTabs";
  const sidebarTabDragType = "application/x-tex64-sidebar-tab";
  const primaryTabGroup = sidebar?.querySelector<HTMLElement>(
    ".tab-group:not(.secondary)"
  );

  const isPrimaryTab = (tabKey: TabKey) => primarySidebarTabs.includes(tabKey);

  const buildPrimaryTabMap = () => {
    const map = new Map<TabKey, HTMLButtonElement>();
    tabs.forEach((tab) => {
      const key = deps.normalizeTabKey(tab.dataset.tab);
      if (isPrimaryTab(key)) {
        map.set(key, tab);
      }
    });
    return map;
  };

  const normalizePrimaryTabOrder = (order: TabKey[]) => {
    const next: TabKey[] = [];
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
    const payload: StoredPrimaryTab[] = primaryTabOrder.map((key) => ({
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
        const nextOrder: TabKey[] = [];
        const nextVisible = new Set<TabKey>();
        parsed.forEach((entry) => {
          if (typeof entry === "string") {
            const key = entry as TabKey;
            if (isPrimaryTab(key)) {
              if (!nextOrder.includes(key)) {
                nextOrder.push(key);
              }
              nextVisible.add(key);
            }
            return;
          }
          if (entry && typeof entry === "object" && typeof (entry as StoredPrimaryTab).key === "string") {
            const key = (entry as StoredPrimaryTab).key;
            if (!isPrimaryTab(key)) {
              return;
            }
            if (!nextOrder.includes(key)) {
              nextOrder.push(key);
            }
            if ((entry as StoredPrimaryTab).visible !== false) {
              nextVisible.add(key);
            }
          }
        });
        let normalizedOrder = normalizePrimaryTabOrder(nextOrder);
        if (!nextOrder.includes("search")) {
          const withoutSearch: TabKey[] = normalizedOrder.filter((key) => key !== "search");
          const filesIndex = withoutSearch.indexOf("files");
          withoutSearch.splice(filesIndex >= 0 ? filesIndex + 1 : 0, 0, "search");
          normalizedOrder = withoutSearch;
        }
        if (normalizedOrder.length > 0) {
          primaryTabOrder = normalizedOrder;
        }
        if (nextVisible.size > 0) {
          sidebarVisibleTabs = nextVisible;
        } else {
          sidebarVisibleTabs = new Set([primaryTabOrder[0]]);
        }
      }
    } catch {
      sidebarVisibleTabs = new Set(primarySidebarTabs);
      primaryTabOrder = primarySidebarTabs.slice();
    }
  };

  const isSidebarTabVisible = (tabKey: TabKey) => {
    if (!primarySidebarTabs.includes(tabKey)) {
      return true;
    }
    return sidebarVisibleTabs.has(tabKey);
  };

  const applyVisibility = () => {
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
      const fallback = primaryTabOrder.find((key) => isSidebarTabVisible(key)) ?? "files";
      deps.setActiveTab(fallback);
    }
  };

  const toggleSidebarTabVisibility = (tabKey: TabKey) => {
    if (!isPrimaryTab(tabKey)) {
      return;
    }
    if (sidebarVisibleTabs.has(tabKey)) {
      if (sidebarVisibleTabs.size <= 1) {
        return;
      }
      sidebarVisibleTabs.delete(tabKey);
    } else {
      sidebarVisibleTabs.add(tabKey);
      if (!primaryTabOrder.includes(tabKey)) {
        primaryTabOrder = normalizePrimaryTabOrder([...primaryTabOrder, tabKey]);
      }
    }
    saveSidebarVisibility();
    applyVisibility();
  };

  const buildSidebarContextMenuItems = (): ContextMenuItem[] =>
    primaryTabOrder.map((key) => {
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

  const movePrimaryTab = (dragKey: TabKey, targetKey: TabKey, insertAfter: boolean) => {
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

  const movePrimaryTabToEnd = (dragKey: TabKey) => {
    const next = primaryTabOrder.filter((key) => key !== dragKey);
    next.push(dragKey);
    primaryTabOrder = next;
  };

  const setSidebarTabDragData = (event: DragEvent, tabKey: TabKey) => {
    if (!event.dataTransfer) {
      return;
    }
    event.dataTransfer.clearData();
    event.dataTransfer.setData(sidebarTabDragType, tabKey);
    event.dataTransfer.effectAllowed = "move";
  };

  const getSidebarTabDragData = (event: DragEvent): TabKey | null => {
    const raw = event.dataTransfer?.getData(sidebarTabDragType);
    if (!raw) {
      return null;
    }
    if (isPrimaryTab(raw as TabKey)) {
      return raw as TabKey;
    }
    return null;
  };

  const getPrimaryTabKeyFromTarget = (event: DragEvent): TabKey | null => {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return null;
    }
    const tab = target.closest<HTMLButtonElement>(".tab[data-tab]");
    if (!tab) {
      return null;
    }
    const key = deps.normalizeTabKey(tab.dataset.tab);
    return isPrimaryTab(key) ? key : null;
  };

  const getDropInsertAfter = (event: DragEvent, tab: HTMLButtonElement) => {
    const rect = tab.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2;
  };

  const setupPrimaryTabDnD = () => {
    if (!(primaryTabGroup instanceof HTMLElement)) {
      return;
    }
    let dragKey: TabKey | null = null;
    let dropTarget: HTMLButtonElement | null = null;

    const clearDropTarget = () => {
      if (dropTarget) {
        dropTarget.classList.remove("is-drop-target");
        dropTarget.removeAttribute("data-drop-position");
      }
      dropTarget = null;
    };

    const setDropTarget = (tab: HTMLButtonElement | null, insertAfter: boolean) => {
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
        const dragEvent = event as DragEvent;
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
      const dragEvent = event as DragEvent;
      const currentDragKey = dragKey ?? getSidebarTabDragData(dragEvent);
      if (!currentDragKey) {
        return;
      }
      const targetKey = getPrimaryTabKeyFromTarget(dragEvent);
      const targetTab = targetKey ? buildPrimaryTabMap().get(targetKey) ?? null : null;
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
      const dragEvent = event as DragEvent;
      const currentDragKey = dragKey ?? getSidebarTabDragData(dragEvent);
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
      } else {
        movePrimaryTabToEnd(currentDragKey);
      }
      saveSidebarVisibility();
      applyVisibility();
      clearDropTarget();
      dragKey = null;
    });

    primaryTabGroup.addEventListener("dragleave", (event) => {
      const dragEvent = event as DragEvent;
      if (dragEvent.relatedTarget && primaryTabGroup.contains(dragEvent.relatedTarget as Node)) {
        return;
      }
      clearDropTarget();
    });
  };

  if (sidebar instanceof HTMLElement) {
    sidebar.addEventListener("contextmenu", (event) => {
      const target = event.target as HTMLElement | null;
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

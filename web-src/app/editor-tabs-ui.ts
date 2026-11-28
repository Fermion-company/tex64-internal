import type { AppContext } from "./context.js";
import { editorTabLabels } from "./editor-tab-labels.js";

import { fileTreeDragDataType, getDragData } from "./file-tree-utils.js";
import type { EditorGroupKey, EditorGroupState } from "./editor-session/types.js";
import type { TabPosition } from "./editor-session/tab-state-ops.js";
import type { DragPayload } from "./types.js";

type TabDrag = { path: string; group: EditorGroupKey };

type EditorTabsDeps = {
  getGroups: () => EditorGroupState[];
  getGroup: (key: EditorGroupKey) => EditorGroupState;
  isActiveGroup: (group: EditorGroupState) => boolean;
  setActiveGroup: (key: EditorGroupKey, options?: { focusEditor?: boolean }) => void;
  requestOpenFile: (path: string, groupKey: EditorGroupKey, force?: boolean, position?: TabPosition) => boolean;
  getTreeDragPayload: () => DragPayload | null;
  closeTab: (group: EditorGroupState, path: string) => void;
  addOpenTab: (group: EditorGroupState, path: string, position?: TabPosition) => void;
  scheduleAfterComposition: (group: EditorGroupState, action: () => void) => void;
  getDirtyPaths: () => Set<string>;
  setEditorEmptyState: (group: EditorGroupState, isEmpty: boolean) => void;
  updateSynctexButtonState: () => void;
  getSplitViewEnabled: () => boolean;
  setSplitViewEnabled: (enabled: boolean) => void;
};

export type EditorTabsUiApi = {
  render: (group: EditorGroupState) => void;
  setupInteractions: () => void;
};

export const initEditorTabsUi = (
  context: AppContext,
  deps: EditorTabsDeps
): EditorTabsUiApi => {
  const tabDragDataType = "application/x-tex64-tab";
  let tabDragPayload: TabDrag | null = null;
  let dropTarget: HTMLElement | null = null;

  const setTabDragData = (
    event: DragEvent,
    payload: TabDrag
  ) => {
    if (!event.dataTransfer) {
      return;
    }
    event.dataTransfer.clearData();
    event.dataTransfer.setData(tabDragDataType, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
  };

  const getTabDragData = (
    event: DragEvent
  ): TabDrag | null => {
    const raw = event.dataTransfer?.getData(tabDragDataType);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { path?: string; group?: EditorGroupKey };
      if (!parsed?.path || (parsed.group !== "primary" && parsed.group !== "secondary")) {
        return null;
      }
      return { path: parsed.path, group: parsed.group };
    } catch {
      return null;
    }
  };

  // One open file needs no tab: the editor's strip appears with the second
  // file. The PDF pane never shows its lone PDF tab; the × at the end of the
  // PDF toolbar closes it instead. A split editor on the right keeps its tab
  // (and ×) even alone, since that is the only way to close it.
  const syncStripVisibility = (group: EditorGroupState) => {
    const tabs = group.openTabs;
    const hidden =
      group.key === "primary"
        ? tabs.length <= 1
        : tabs.length === 1 && /\.pdf$/i.test(tabs[0]);
    if (!group.root || group.root.classList.contains("has-single-tab") === hidden) return false;
    group.root.classList.toggle("has-single-tab", hidden);
    return true;
  };

  const createTab = (group: EditorGroupState, path: string) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "editor-tab";
    tab.draggable = true;
    tab.dataset.path = path;
    tab.dataset.group = group.key;
    tab.title = path;
    const label = document.createElement("span");
    label.className = "editor-tab-label";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "editor-tab-close";
    closeButton.textContent = "\u00d7";
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      deps.scheduleAfterComposition(group, () => deps.closeTab(group, path));
    });
    tab.append(label, closeButton);
    tab.addEventListener("click", () => {
      deps.setActiveGroup(group.key, { focusEditor: false });
      // A click on the current tab also cancels a pending switch.
      const wasCurrent = path === group.currentFilePath;
      deps.requestOpenFile(path, group.key);
      if (wasCurrent && group.viewer.getViewerMode() === "hidden") {
        (group.editor as { focus?: () => void } | null)?.focus?.();
      }
    });
    tab.addEventListener("dragstart", (event) => {
      tabDragPayload = { path, group: group.key };
      setTabDragData(event, tabDragPayload);
      tab.classList.add("is-dragging");
    });
    tab.addEventListener("dragend", () => {
      tabDragPayload = null;
      tab.classList.remove("is-dragging");
      showDropTarget(null);
    });
    return tab;
  };

  const render = (group: EditorGroupState) => {
    const tabsList = group.tabsList;
    if (!(tabsList instanceof HTMLElement)) return;
    const stripChanged = syncStripVisibility(group);
    const isEmpty = group.openTabs.length === 0;
    if (stripChanged || tabsList.classList.contains("is-empty") !== isEmpty) {
      deps.setEditorEmptyState(group, isEmpty);
    }
    tabsList.classList.toggle("is-empty", isEmpty);

    // Keep existing buttons attached during focus changes, saves and watcher
    // updates. Replacing the pressed button between down and up loses the click.
    const existing = new Map(Array.from(tabsList.children, (child) => {
      const tab = child as HTMLElement;
      return [tab.dataset.path, tab] as const;
    }));
    const labels = editorTabLabels(group.openTabs);
    const dirtyPaths = deps.getDirtyPaths();
    for (const [path, tab] of existing) {
      if (!group.openTabs.includes(path)) tab.remove();
    }
    group.openTabs.forEach((path, index) => {
      const tab = existing.get(path) ?? createTab(group, path);
      const label = tab.firstElementChild;
      const { name, detail } = labels[index];
      const oldDetail = label.querySelector(".editor-tab-detail");
      if (label.firstChild?.nodeValue !== name || (oldDetail?.textContent ?? "") !== detail) {
        label.textContent = name;
        if (detail) {
          // Same name as another open tab: add the folder that tells them apart.
          const detailEl = document.createElement("span");
          detailEl.className = "editor-tab-detail";
          detailEl.textContent = detail;
          label.appendChild(detailEl);
        }
      }
      tab.classList.toggle("has-detail", Boolean(detail));
      tab.classList.toggle("is-dirty", dirtyPaths.has(path));
      tab.classList.toggle("is-active", path === group.currentFilePath);
      const next = tabsList.children[index] ?? null;
      if (tab !== next) tabsList.insertBefore(tab, next);
    });
    if (!isEmpty && deps.isActiveGroup(group)) deps.updateSynctexButtonState();
  };

  const showDropTarget = (tab: HTMLElement | null, position?: TabPosition) => {
    if (dropTarget !== tab) {
      dropTarget?.removeAttribute("data-drop-position");
      dropTarget = tab;
    }
    if (tab && position) tab.dataset.dropPosition = position.after ? "after" : "before";
  };

  const getDragSource = (event: DragEvent) => {
    const types = event.dataTransfer?.types ?? [];
    if (types.includes(tabDragDataType)) return tabDragPayload ?? getTabDragData(event);
    if (types.includes(fileTreeDragDataType)) return deps.getTreeDragPayload() ?? getDragData(event);
    return null;
  };

  const resolveDrop = (event: DragEvent, group: EditorGroupState, source: TabDrag | DragPayload) => {
    const sourceTab = "group" in source ? source : null;
    if ("kind" in source && source.kind === "dir") return null;
    const target = event.target instanceof Element ? event.target : null;
    const onStrip = group.tabs?.contains(target) ?? false;
    if (sourceTab?.group === group.key && !onStrip) return null;

    const hoveredTab = onStrip ? target?.closest<HTMLElement>(".editor-tab") : null;
    const targetTab = onStrip
      ? hoveredTab ?? group.tabsList?.querySelector<HTMLElement>(".editor-tab:last-child")
      : null;
    const rect = targetTab?.getBoundingClientRect();
    const position = rect && targetTab.dataset.path
      ? { path: targetTab.dataset.path, after: !hoveredTab || event.clientX >= rect.left + rect.width / 2 }
      : undefined;
    const { path } = source;
    if (sourceTab?.group === group.key && (!position || position.path === path)) return null;
    return { path, sourceTab, targetTab, position };
  };

  const moveTabToGroup = (
    path: string,
    sourceKey: EditorGroupKey,
    targetKey: EditorGroupKey,
    position?: TabPosition
  ) => {
    const sourceGroup = deps.getGroup(sourceKey);
    const targetGroup = deps.getGroup(targetKey);
    if (!sourceGroup.openTabs.includes(path)) {
      return;
    }
    if (sourceKey === targetKey) {
      deps.addOpenTab(targetGroup, path, position);
      render(targetGroup);
      return;
    }
    if (sourceGroup.currentFilePath === path && sourceGroup.isComposing) {
      deps.scheduleAfterComposition(sourceGroup, () => {
        moveTabToGroup(path, sourceKey, targetKey, position);
      });
      return;
    }
    deps.closeTab(sourceGroup, path);
    deps.addOpenTab(targetGroup, path, position);
    render(targetGroup);
    deps.requestOpenFile(path, targetKey, true);
  };

  const setupInteractions = () => {
    deps.setSplitViewEnabled(deps.getSplitViewEnabled());
    document.addEventListener("dragend", () => showDropTarget(null), true);
    deps.getGroups().forEach((group) => {
      const root = group.root;
      if (!(root instanceof HTMLElement)) return;
      root.addEventListener("mousedown", (event) => {
        if (event.target instanceof Element && event.target.closest(".editor-tab")) return;
        deps.setActiveGroup(group.key, { focusEditor: false });
      });
      root.addEventListener("dragover", (event) => {
        const source = getDragSource(event);
        const drop = source && resolveDrop(event, group, source);
        showDropTarget(drop?.targetTab ?? null, drop?.position);
        // Monaco handles generic drags as text. Internal file and tab drags
        // are owned here, including folders and other rejected drop targets.
        if (source) {
          event.stopPropagation();
          event.dataTransfer.dropEffect = drop ? (drop.sourceTab ? "move" : "copy") : "none";
        }
        if (!drop) return;
        event.preventDefault();
      }, true);
      root.addEventListener("dragleave", (event) => {
        if (root.contains(dropTarget) &&
            (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget))) {
          showDropTarget(null);
        }
      });
      root.addEventListener("drop", (event) => {
        showDropTarget(null);
        const source = getDragSource(event);
        if (!source) return;
        event.stopPropagation();
        const drop = resolveDrop(event, group, source);
        if (!drop) return;
        event.preventDefault();
        tabDragPayload = null;
        deps.setActiveGroup(group.key, { focusEditor: false });
        if (drop.sourceTab) {
          moveTabToGroup(drop.path, drop.sourceTab.group, group.key, drop.position);
        } else {
          deps.requestOpenFile(drop.path, group.key, true, drop.position);
        }
      }, true);
    });
  };

  return { render, setupInteractions };
};

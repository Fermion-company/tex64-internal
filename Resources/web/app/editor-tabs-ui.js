import { editorTabLabels } from "./editor-tab-labels.js";
import { fileTreeDragDataType, getDragData } from "./file-tree-utils.js";
export const initEditorTabsUi = (context, deps) => {
    const tabDragDataType = "application/x-tex64-tab";
    let tabDragPayload = null;
    let dropTarget = null;
    const setTabDragData = (event, payload) => {
        if (!event.dataTransfer) {
            return;
        }
        event.dataTransfer.clearData();
        event.dataTransfer.setData(tabDragDataType, JSON.stringify(payload));
        event.dataTransfer.effectAllowed = "move";
    };
    const getTabDragData = (event) => {
        var _a;
        const raw = (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.getData(tabDragDataType);
        if (!raw) {
            return null;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!(parsed === null || parsed === void 0 ? void 0 : parsed.path) || (parsed.group !== "primary" && parsed.group !== "secondary")) {
                return null;
            }
            return { path: parsed.path, group: parsed.group };
        }
        catch {
            return null;
        }
    };
    // One open file needs no tab: the editor's strip appears with the second
    // file. The PDF pane never shows its lone PDF tab; the × at the end of the
    // PDF toolbar closes it instead. A split editor on the right keeps its tab
    // (and ×) even alone, since that is the only way to close it.
    const syncStripVisibility = (group) => {
        const tabs = group.openTabs;
        const hidden = group.key === "primary"
            ? tabs.length <= 1
            : tabs.length === 1 && /\.pdf$/i.test(tabs[0]);
        if (!group.root || group.root.classList.contains("has-single-tab") === hidden)
            return false;
        group.root.classList.toggle("has-single-tab", hidden);
        return true;
    };
    const createTab = (group, path) => {
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
            var _a, _b;
            deps.setActiveGroup(group.key, { focusEditor: false });
            // A click on the current tab also cancels a pending switch.
            const wasCurrent = path === group.currentFilePath;
            deps.requestOpenFile(path, group.key);
            if (wasCurrent && group.viewer.getViewerMode() === "hidden") {
                (_b = (_a = group.editor) === null || _a === void 0 ? void 0 : _a.focus) === null || _b === void 0 ? void 0 : _b.call(_a);
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
    const render = (group) => {
        const tabsList = group.tabsList;
        if (!(tabsList instanceof HTMLElement))
            return;
        const stripChanged = syncStripVisibility(group);
        const isEmpty = group.openTabs.length === 0;
        if (stripChanged || tabsList.classList.contains("is-empty") !== isEmpty) {
            deps.setEditorEmptyState(group, isEmpty);
        }
        tabsList.classList.toggle("is-empty", isEmpty);
        // Keep existing buttons attached during focus changes, saves and watcher
        // updates. Replacing the pressed button between down and up loses the click.
        const existing = new Map(Array.from(tabsList.children, (child) => {
            const tab = child;
            return [tab.dataset.path, tab];
        }));
        const labels = editorTabLabels(group.openTabs);
        const dirtyPaths = deps.getDirtyPaths();
        for (const [path, tab] of existing) {
            if (!group.openTabs.includes(path))
                tab.remove();
        }
        group.openTabs.forEach((path, index) => {
            var _a, _b, _c, _d;
            const tab = (_a = existing.get(path)) !== null && _a !== void 0 ? _a : createTab(group, path);
            const label = tab.firstElementChild;
            const { name, detail } = labels[index];
            const oldDetail = label.querySelector(".editor-tab-detail");
            if (((_b = label.firstChild) === null || _b === void 0 ? void 0 : _b.nodeValue) !== name || ((_c = oldDetail === null || oldDetail === void 0 ? void 0 : oldDetail.textContent) !== null && _c !== void 0 ? _c : "") !== detail) {
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
            const next = (_d = tabsList.children[index]) !== null && _d !== void 0 ? _d : null;
            if (tab !== next)
                tabsList.insertBefore(tab, next);
        });
        if (!isEmpty && deps.isActiveGroup(group))
            deps.updateSynctexButtonState();
    };
    const showDropTarget = (tab, position) => {
        if (dropTarget !== tab) {
            dropTarget === null || dropTarget === void 0 ? void 0 : dropTarget.removeAttribute("data-drop-position");
            dropTarget = tab;
        }
        if (tab && position)
            tab.dataset.dropPosition = position.after ? "after" : "before";
    };
    const getDragSource = (event) => {
        var _a, _b, _c;
        const types = (_b = (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.types) !== null && _b !== void 0 ? _b : [];
        if (types.includes(tabDragDataType))
            return tabDragPayload !== null && tabDragPayload !== void 0 ? tabDragPayload : getTabDragData(event);
        if (types.includes(fileTreeDragDataType))
            return (_c = deps.getTreeDragPayload()) !== null && _c !== void 0 ? _c : getDragData(event);
        return null;
    };
    const resolveDrop = (event, group, source) => {
        var _a, _b, _c;
        const sourceTab = "group" in source ? source : null;
        if ("kind" in source && source.kind === "dir")
            return null;
        const target = event.target instanceof Element ? event.target : null;
        const onStrip = (_b = (_a = group.tabs) === null || _a === void 0 ? void 0 : _a.contains(target)) !== null && _b !== void 0 ? _b : false;
        if ((sourceTab === null || sourceTab === void 0 ? void 0 : sourceTab.group) === group.key && !onStrip)
            return null;
        const hoveredTab = onStrip ? target === null || target === void 0 ? void 0 : target.closest(".editor-tab") : null;
        const targetTab = onStrip
            ? hoveredTab !== null && hoveredTab !== void 0 ? hoveredTab : (_c = group.tabsList) === null || _c === void 0 ? void 0 : _c.querySelector(".editor-tab:last-child")
            : null;
        const rect = targetTab === null || targetTab === void 0 ? void 0 : targetTab.getBoundingClientRect();
        const position = rect && targetTab.dataset.path
            ? { path: targetTab.dataset.path, after: !hoveredTab || event.clientX >= rect.left + rect.width / 2 }
            : undefined;
        const { path } = source;
        if ((sourceTab === null || sourceTab === void 0 ? void 0 : sourceTab.group) === group.key && (!position || position.path === path))
            return null;
        return { path, sourceTab, targetTab, position };
    };
    const moveTabToGroup = (path, sourceKey, targetKey, position) => {
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
            if (!(root instanceof HTMLElement))
                return;
            root.addEventListener("mousedown", (event) => {
                if (event.target instanceof Element && event.target.closest(".editor-tab"))
                    return;
                deps.setActiveGroup(group.key, { focusEditor: false });
            });
            root.addEventListener("dragover", (event) => {
                var _a;
                const source = getDragSource(event);
                const drop = source && resolveDrop(event, group, source);
                showDropTarget((_a = drop === null || drop === void 0 ? void 0 : drop.targetTab) !== null && _a !== void 0 ? _a : null, drop === null || drop === void 0 ? void 0 : drop.position);
                // Monaco handles generic drags as text. Internal file and tab drags
                // are owned here, including folders and other rejected drop targets.
                if (source) {
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = drop ? (drop.sourceTab ? "move" : "copy") : "none";
                }
                if (!drop)
                    return;
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
                if (!source)
                    return;
                event.stopPropagation();
                const drop = resolveDrop(event, group, source);
                if (!drop)
                    return;
                event.preventDefault();
                tabDragPayload = null;
                deps.setActiveGroup(group.key, { focusEditor: false });
                if (drop.sourceTab) {
                    moveTabToGroup(drop.path, drop.sourceTab.group, group.key, drop.position);
                }
                else {
                    deps.requestOpenFile(drop.path, group.key, true, drop.position);
                }
            }, true);
        });
    };
    return { render, setupInteractions };
};

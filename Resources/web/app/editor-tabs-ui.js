export const initEditorTabsUi = (context, deps) => {
    const tabDragDataType = "application/x-tex64-tab";
    let tabDragPayload = null;
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
    const render = (group) => {
        const tabsList = group.tabsList;
        if (!(tabsList instanceof HTMLElement)) {
            return;
        }
        tabsList.innerHTML = "";
        if (group.openTabs.length === 0) {
            deps.setEditorEmptyState(group, true);
            tabsList.classList.add("is-empty");
            return;
        }
        deps.setEditorEmptyState(group, false);
        tabsList.classList.remove("is-empty");
        const dirtyPaths = deps.getDirtyPaths();
        group.openTabs.forEach((path) => {
            var _a;
            const tab = document.createElement("button");
            tab.type = "button";
            tab.className = "editor-tab";
            tab.draggable = true;
            tab.dataset.path = path;
            tab.dataset.group = group.key;
            const label = document.createElement("span");
            label.className = "editor-tab-label";
            label.textContent = (_a = path.split("/").pop()) !== null && _a !== void 0 ? _a : path;
            tab.title = path;
            if (dirtyPaths.has(path)) {
                tab.classList.add("is-dirty");
            }
            if (path === group.currentFilePath) {
                tab.classList.add("is-active");
            }
            const closeButton = document.createElement("button");
            closeButton.type = "button";
            closeButton.className = "editor-tab-close";
            closeButton.textContent = "\u00d7";
            closeButton.addEventListener("click", (event) => {
                event.stopPropagation();
                if (group.isComposing) {
                    deps.scheduleAfterComposition(group, () => {
                        deps.closeTab(group, path);
                    });
                    return;
                }
                deps.closeTab(group, path);
            });
            tab.append(label, closeButton);
            tab.addEventListener("click", () => {
                deps.setActiveGroup(group.key, { focusEditor: false });
                if (path !== group.currentFilePath) {
                    deps.requestOpenFile(path, group.key);
                }
            });
            tab.addEventListener("dragstart", (event) => {
                const dragEvent = event;
                const payload = { path, group: group.key };
                setTabDragData(dragEvent, payload);
                tabDragPayload = payload;
                tab.classList.add("is-dragging");
            });
            tab.addEventListener("dragend", () => {
                tabDragPayload = null;
                tab.classList.remove("is-dragging");
            });
            tabsList.appendChild(tab);
        });
        if (deps.isActiveGroup(group)) {
            deps.updateSynctexButtonState();
        }
    };
    const moveTabToGroup = (path, sourceKey, targetKey) => {
        if (sourceKey === targetKey) {
            return;
        }
        const sourceGroup = deps.getGroup(sourceKey);
        const targetGroup = deps.getGroup(targetKey);
        if (!sourceGroup.openTabs.includes(path)) {
            return;
        }
        if (sourceGroup.currentFilePath === path && sourceGroup.isComposing) {
            deps.scheduleAfterComposition(sourceGroup, () => {
                moveTabToGroup(path, sourceKey, targetKey);
            });
            return;
        }
        deps.closeTab(sourceGroup, path);
        deps.addOpenTab(targetGroup, path);
        render(targetGroup);
        deps.requestOpenFile(path, targetKey);
    };
    const setupInteractions = () => {
        deps.setSplitViewEnabled(deps.getSplitViewEnabled());
        deps.getGroups().forEach((group) => {
            if (group.root instanceof HTMLElement) {
                group.root.addEventListener("mousedown", (event) => {
                    const target = event.target;
                    if (target instanceof Element && target.closest(".editor-tab-close")) {
                        return;
                    }
                    deps.setActiveGroup(group.key, { focusEditor: false });
                });
            }
            const dropTargets = [group.tabs, group.root];
            dropTargets.forEach((target) => {
                if (!(target instanceof HTMLElement)) {
                    return;
                }
                target.addEventListener("dragover", (event) => {
                    const dragEvent = event;
                    const payload = tabDragPayload !== null && tabDragPayload !== void 0 ? tabDragPayload : getTabDragData(dragEvent);
                    if (!payload || payload.group === group.key) {
                        return;
                    }
                    dragEvent.preventDefault();
                    if (dragEvent.dataTransfer) {
                        dragEvent.dataTransfer.dropEffect = "move";
                    }
                });
                target.addEventListener("drop", (event) => {
                    const dragEvent = event;
                    const payload = tabDragPayload !== null && tabDragPayload !== void 0 ? tabDragPayload : getTabDragData(dragEvent);
                    if (!payload || payload.group === group.key) {
                        return;
                    }
                    dragEvent.preventDefault();
                    tabDragPayload = null;
                    deps.setActiveGroup(group.key, { focusEditor: false });
                    moveTabToGroup(payload.path, payload.group, group.key);
                });
            });
        });
    };
    return { render, setupInteractions };
};

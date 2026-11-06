export const createEditorSessionTabOps = (runtime, coreOps, splitViewOps, bufferOps, deps) => {
    const closeTab = (group, path) => {
        const index = group.openTabs.indexOf(path);
        if (index === -1) {
            return;
        }
        if (path === group.currentFilePath && group.isComposing) {
            bufferOps.scheduleAfterComposition(group, () => {
                closeTab(group, path);
            });
            return;
        }
        if (path === group.currentFilePath) {
            bufferOps.cacheCurrentBuffer(group);
        }
        group.openTabs = group.openTabs.filter((entry) => entry !== path);
        if (path === group.currentFilePath) {
            if (group.openTabs.length > 0) {
                const nextIndex = Math.min(index, group.openTabs.length - 1);
                const nextPath = group.openTabs[nextIndex];
                deps.requestOpenFile(nextPath, group.key, true);
            }
            else {
                group.currentFilePath = null;
                group.currentFileSavedContent = null;
                group.isDirty = false;
                group.viewer.hideViewer();
                bufferOps.clearEditorView(group);
                // The right-hand group opened for a PDF (or a split) has nothing left
                // to show: give its space back instead of leaving an empty pane.
                if (group.key === "secondary" && runtime.state.splitViewEnabled) {
                    splitViewOps.setSplitViewEnabled(false);
                }
                if (coreOps.isActiveGroup(group)) {
                    splitViewOps.updateBreadcrumbs();
                    splitViewOps.updateMiniOutline();
                    runtime.deps.outline.render();
                    runtime.deps.fileTree.render();
                }
            }
        }
        runtime.deps.editorTabs.render(group);
    };
    return { closeTab };
};

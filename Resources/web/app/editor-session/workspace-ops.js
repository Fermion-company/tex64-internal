export const createEditorSessionWorkspaceOps = (runtime, coreOps, splitViewOps, bufferOps) => {
    const handleRenameResult = (payload) => {
        const { oldPath, newPath } = payload;
        const remapPath = (path) => {
            if (payload.isDirectory) {
                if (path === oldPath || path.startsWith(`${oldPath}/`)) {
                    return newPath + path.slice(oldPath.length);
                }
                return path;
            }
            return path === oldPath ? newPath : path;
        };
        runtime.deps.fileTree.handleRenameResult(payload);
        coreOps.forEachEditorGroup((group) => {
            group.openTabs = group.openTabs.map((entry) => remapPath(entry));
            if (group.currentFilePath) {
                const nextPath = remapPath(group.currentFilePath);
                group.currentFilePath = nextPath;
            }
        });
        if (runtime.monacoModels.size > 0) {
            const updatedModels = new Map();
            runtime.monacoModels.forEach((entry, path) => {
                updatedModels.set(remapPath(path), entry);
            });
            runtime.monacoModels.clear();
            updatedModels.forEach((entry, path) => runtime.monacoModels.set(path, entry));
        }
        // Update lastCursorPositions so cursor restore works after rename.
        if (runtime.lastCursorPositions.size > 0) {
            const updatedPositions = new Map();
            runtime.lastCursorPositions.forEach((pos, path) => {
                updatedPositions.set(remapPath(path), pos);
            });
            runtime.lastCursorPositions.clear();
            updatedPositions.forEach((pos, path) => runtime.lastCursorPositions.set(path, pos));
        }
        coreOps.forEachEditorGroup((group) => {
            if (group.viewStates.size > 0) {
                const updatedViewStates = new Map();
                group.viewStates.forEach((state, path) => {
                    updatedViewStates.set(remapPath(path), state);
                });
                group.viewStates.clear();
                updatedViewStates.forEach((state, path) => group.viewStates.set(path, state));
            }
        });
        if (runtime.dirtyFiles.size > 0) {
            const updatedDirty = new Set();
            runtime.dirtyFiles.forEach((path) => {
                updatedDirty.add(remapPath(path));
            });
            runtime.dirtyFiles.clear();
            updatedDirty.forEach((path) => runtime.dirtyFiles.add(path));
        }
        coreOps.forEachEditorGroup((group) => {
            if (group.currentFilePath) {
                group.isDirty = runtime.dirtyFiles.has(group.currentFilePath);
                bufferOps.setEditorLanguage(group, group.currentFilePath);
            }
            if (group.currentFilePath && !group.isDirty) {
                const entry = runtime.monacoModels.get(group.currentFilePath);
                if (entry) {
                    group.currentFileSavedContent = entry.savedContent;
                }
                else if (group.editor) {
                    const editor = group.editor;
                    group.currentFileSavedContent = editor.getValue();
                }
            }
        });
        splitViewOps.updateBreadcrumbs();
        splitViewOps.updateMiniOutline();
        runtime.deps.fileTree.render();
        coreOps.forEachEditorGroup((group) => runtime.deps.editorTabs.render(group));
    };
    const syncWorkspaceFiles = (payload) => {
        const { workspaceFiles, rootChanged } = payload;
        if (rootChanged) {
            runtime.fileOpsState.pendingReveal = null;
            runtime.lastCursorPositions.clear();
            runtime.deps.fileTree.clearSelection();
            coreOps.forEachEditorGroup((group) => {
                group.currentFilePath = null;
                group.currentFileSavedContent = null;
                group.isDirty = false;
                group.openTabs = [];
                group.viewStates.clear();
                group.viewer.hideViewer();
                bufferOps.clearEditorView(group);
            });
            runtime.monacoModels.forEach((entry) => {
                if (typeof entry.model.dispose === "function") {
                    entry.model.dispose();
                }
            });
            runtime.monacoModels.clear();
            runtime.dirtyFiles.clear();
        }
        const workspaceFileSet = new Set(workspaceFiles);
        if (runtime.monacoModels.size > 0) {
            Array.from(runtime.monacoModels.keys()).forEach((path) => {
                if (!workspaceFileSet.has(path)) {
                    const entry = runtime.monacoModels.get(path);
                    if (entry && typeof entry.model.dispose === "function") {
                        entry.model.dispose();
                    }
                    runtime.monacoModels.delete(path);
                    runtime.dirtyFiles.delete(path);
                }
            });
        }
        coreOps.forEachEditorGroup((group) => {
            if (group.viewStates.size > 0) {
                Array.from(group.viewStates.keys()).forEach((path) => {
                    if (!workspaceFileSet.has(path)) {
                        group.viewStates.delete(path);
                    }
                });
            }
            if (group.currentFilePath && !workspaceFileSet.has(group.currentFilePath)) {
                group.currentFilePath = null;
                group.currentFileSavedContent = null;
                group.isDirty = false;
                if (coreOps.isActiveGroup(group)) {
                    runtime.deps.fileTree.clearSelection();
                }
            }
            if (group.openTabs.length > 0) {
                group.openTabs = group.openTabs.filter((path) => workspaceFileSet.has(path));
                if (group.currentFilePath && !group.openTabs.includes(group.currentFilePath)) {
                    group.currentFilePath = null;
                    group.currentFileSavedContent = null;
                    group.isDirty = false;
                }
            }
            if (group.currentFilePath) {
                group.isDirty = runtime.dirtyFiles.has(group.currentFilePath);
            }
            else {
                group.viewer.hideViewer();
                bufferOps.clearEditorView(group);
            }
        });
        runtime.deps.fileTree.loadOpenState();
        runtime.deps.fileTree.render();
        splitViewOps.updateBreadcrumbs();
        coreOps.forEachEditorGroup((group) => runtime.deps.editorTabs.render(group));
        runtime.deps.outline.render();
    };
    const getDirtyPaths = () => runtime.dirtyFiles;
    return {
        handleRenameResult,
        syncWorkspaceFiles,
        getDirtyPaths,
    };
};

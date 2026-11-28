import { getUiLocale } from "../i18n.js";
export const createEditorSessionInitialOpenOps = (runtime, coreOps, deps) => {
    const pickInitialFilePath = () => {
        const rootFilePath = runtime.deps.getRootFilePath();
        const workspaceFiles = runtime.deps.getWorkspaceFiles();
        if (rootFilePath && workspaceFiles.includes(rootFilePath)) {
            return rootFilePath;
        }
        const texFiles = workspaceFiles
            .filter((path) => path.toLowerCase().endsWith(".tex"))
            .sort((a, b) => a.localeCompare(b, getUiLocale()));
        if (texFiles.length > 0) {
            return texFiles[0];
        }
        if (workspaceFiles.length > 0) {
            return workspaceFiles[0];
        }
        return null;
    };
    const requestInitialOpen = () => {
        const activeGroup = coreOps.getActiveGroup();
        const workspaceFiles = runtime.deps.getWorkspaceFiles();
        // A file still open in the editor though missing from the listing (it
        // vanished and may come back, or it has unsaved typing) stays the active
        // file: the tree sync kept its tab on purpose.
        const hasValidCurrent = activeGroup.currentFilePath !== null &&
            (workspaceFiles.includes(activeGroup.currentFilePath) ||
                runtime.monacoModels.has(activeGroup.currentFilePath) ||
                activeGroup.viewer.getUnbuiltPdfPath() === activeGroup.currentFilePath);
        if (hasValidCurrent || runtime.fileOpsState.pendingOpenRequests.some(request => request.group === activeGroup.key && !request.background)) {
            return;
        }
        const path = pickInitialFilePath();
        if (!path) {
            return;
        }
        if (!activeGroup.editor) {
            runtime.state.pendingAutoOpenPath = path;
            return;
        }
        runtime.state.pendingAutoOpenPath = null;
        deps.requestOpenFile(path, coreOps.getActiveEditorGroupKey());
    };
    const openPendingFileIfReady = () => {
        const activeGroup = coreOps.getActiveGroup();
        if (!runtime.state.pendingAutoOpenPath || !activeGroup.editor) {
            return;
        }
        if (activeGroup.currentFilePath || runtime.fileOpsState.pendingOpenRequests.some(request => request.group === activeGroup.key && !request.background)) {
            runtime.state.pendingAutoOpenPath = null;
            return;
        }
        const path = runtime.state.pendingAutoOpenPath;
        runtime.state.pendingAutoOpenPath = null;
        deps.requestOpenFile(path, coreOps.getActiveEditorGroupKey());
    };
    return { requestInitialOpen, openPendingFileIfReady };
};

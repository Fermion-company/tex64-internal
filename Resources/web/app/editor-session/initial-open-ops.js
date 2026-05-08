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
        const hasValidCurrent = activeGroup.currentFilePath !== null &&
            workspaceFiles.includes(activeGroup.currentFilePath);
        if (hasValidCurrent) {
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
        if (activeGroup.currentFilePath) {
            runtime.state.pendingAutoOpenPath = null;
            return;
        }
        const path = runtime.state.pendingAutoOpenPath;
        runtime.state.pendingAutoOpenPath = null;
        deps.requestOpenFile(path, coreOps.getActiveEditorGroupKey());
    };
    return { requestInitialOpen, openPendingFileIfReady };
};

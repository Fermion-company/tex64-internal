import { PINNED_TAB_EXTENSIONS, getFileExtension } from "../files.js";
const isPersistentTabPath = (path) => {
    const ext = getFileExtension(path);
    return PINNED_TAB_EXTENSIONS.has(ext);
};
export const createEditorSessionTabStateOps = (runtime) => {
    const addOpenTab = (group, path, position) => {
        if (position && position.path !== path) {
            const tabs = group.openTabs.filter((entry) => entry !== path);
            const anchor = tabs.indexOf(position.path);
            tabs.splice(anchor < 0 ? tabs.length : anchor + Number(position.after), 0, path);
            group.openTabs = tabs;
        }
        else if (!group.openTabs.includes(path)) {
            group.openTabs = [...group.openTabs, path];
        }
    };
    const clearTemporaryTabs = (group, keepPath) => {
        const unbuilt = group.viewer.getUnbuiltPdfPath();
        const nextTabs = group.openTabs.filter((entry) => {
            if (entry === keepPath) {
                return true;
            }
            if (entry === unbuilt && !runtime.deps.getWorkspaceFiles().includes(entry))
                return false;
            if (runtime.dirtyFiles.has(entry)) {
                return true;
            }
            if (!isPersistentTabPath(entry)) {
                return false;
            }
            return true;
        });
        if (nextTabs.length === group.openTabs.length) {
            return;
        }
        group.openTabs = nextTabs;
        runtime.deps.editorTabs.render(group);
    };
    return {
        addOpenTab,
        clearTemporaryTabs,
    };
};

import { PINNED_TAB_EXTENSIONS, getFileExtension } from "../files.js";
const isPersistentTabPath = (path) => {
    const ext = getFileExtension(path);
    return PINNED_TAB_EXTENSIONS.has(ext);
};
export const createEditorSessionTabStateOps = (runtime) => {
    const addOpenTab = (group, path) => {
        if (!group.openTabs.includes(path)) {
            group.openTabs = [...group.openTabs, path];
        }
    };
    const clearTemporaryTabs = (group, keepPath) => {
        const nextTabs = group.openTabs.filter((entry) => {
            if (entry === keepPath) {
                return true;
            }
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

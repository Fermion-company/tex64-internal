import { PINNED_TAB_EXTENSIONS, getFileExtension } from "../files.js";
import type { EditorGroupState } from "./types.js";
import type { EditorSessionRuntime } from "./runtime.js";

export type EditorSessionTabStateOps = {
  addOpenTab: (group: EditorGroupState, path: string) => void;
  clearTemporaryTabs: (group: EditorGroupState, keepPath?: string) => void;
};

const isPersistentTabPath = (path: string) => {
  const ext = getFileExtension(path);
  return PINNED_TAB_EXTENSIONS.has(ext);
};

export const createEditorSessionTabStateOps = (runtime: EditorSessionRuntime): EditorSessionTabStateOps => {
  const addOpenTab = (group: EditorGroupState, path: string) => {
    if (!group.openTabs.includes(path)) {
      group.openTabs = [...group.openTabs, path];
    }
  };

  const clearTemporaryTabs = (group: EditorGroupState, keepPath?: string) => {
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


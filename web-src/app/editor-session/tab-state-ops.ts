import { PINNED_TAB_EXTENSIONS, getFileExtension } from "../files.js";
import type { EditorGroupState } from "./types.js";
import type { EditorSessionRuntime } from "./runtime.js";

export type TabPosition = { path: string; after: boolean };

export type EditorSessionTabStateOps = {
  addOpenTab: (group: EditorGroupState, path: string, position?: TabPosition) => void;
  clearTemporaryTabs: (group: EditorGroupState, keepPath?: string) => void;
};

const isPersistentTabPath = (path: string) => {
  const ext = getFileExtension(path);
  return PINNED_TAB_EXTENSIONS.has(ext);
};

export const createEditorSessionTabStateOps = (runtime: EditorSessionRuntime): EditorSessionTabStateOps => {
  const addOpenTab = (group: EditorGroupState, path: string, position?: TabPosition) => {
    if (position && position.path !== path) {
      const tabs = group.openTabs.filter((entry) => entry !== path);
      const anchor = tabs.indexOf(position.path);
      tabs.splice(anchor < 0 ? tabs.length : anchor + Number(position.after), 0, path);
      group.openTabs = tabs;
    } else if (!group.openTabs.includes(path)) {
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


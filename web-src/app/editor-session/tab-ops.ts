import type { EditorGroupState, EditorGroupKey } from "./types.js";
import type { EditorSessionRuntime } from "./runtime.js";
import type { EditorSessionCoreOps } from "./core-ops.js";
import type { EditorSessionSplitViewOps } from "./split-view-ops.js";
import type { EditorSessionBufferOps } from "./buffer-ops.js";

export type EditorSessionTabOps = {
  closeTab: (group: EditorGroupState, path: string) => void;
};

export const createEditorSessionTabOps = (
  runtime: EditorSessionRuntime,
  coreOps: EditorSessionCoreOps,
  splitViewOps: EditorSessionSplitViewOps,
  bufferOps: EditorSessionBufferOps,
  deps: {
    requestOpenFile: (path: string, groupKey: EditorGroupKey, force?: boolean) => boolean;
  }
): EditorSessionTabOps => {
  const closeTab = (group: EditorGroupState, path: string) => {
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
      } else {
        group.currentFilePath = null;
        group.currentFileSavedContent = null;
        group.isDirty = false;
        group.viewer.hideViewer();
        bufferOps.clearEditorView(group);
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


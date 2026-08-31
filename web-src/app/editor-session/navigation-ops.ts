import type { IndexEntry } from "../types.js";
import type { EditorGroupKey, EditorGroupState } from "./types.js";
import type { EditorSessionRuntime } from "./runtime.js";
import type { EditorSessionCoreOps } from "./core-ops.js";
import type { EditorSessionIssueOps } from "./issue-ops.js";

export type EditorSessionNavigationOps = {
  applyContentToOpenFile: (
    path: string,
    content: string,
    options?: {
      updateSaved?: boolean;
      showAiDiff?: boolean;
      expectedContent?: string;
      expectedFileMissing?: boolean;
      fileDeleted?: boolean;
      conversationId?: string;
    }
  ) => { handled: boolean; conflict: boolean };
  jumpToFileLine: (
    path: string,
    line: number,
    groupKey: EditorGroupKey,
    options?: { force?: boolean; focus?: boolean; className?: string; column?: number }
  ) => void;
  jumpToLocation: (entry: IndexEntry) => void;
};

export const createEditorSessionNavigationOps = (
  runtime: EditorSessionRuntime,
  coreOps: EditorSessionCoreOps,
  issueOps: EditorSessionIssueOps,
  deps: {
    applyFormattedContent: (
      group: EditorGroupState,
      path: string,
      content: string,
      options?: {
        updateSaved?: boolean;
        showAiDiff?: boolean;
        expectedContent?: string;
        expectedFileMissing?: boolean;
        fileDeleted?: boolean;
        conversationId?: string;
      }
    ) => boolean;
    requestOpenFile: (path: string, groupKey: EditorGroupKey, force?: boolean) => boolean;
  }
): EditorSessionNavigationOps => {
  const applyContentToOpenFile = (
    path: string,
    content: string,
    options?: {
      updateSaved?: boolean;
      showAiDiff?: boolean;
      expectedContent?: string;
      expectedFileMissing?: boolean;
      fileDeleted?: boolean;
      conversationId?: string;
    }
  ) => {
    const targetGroupKey = coreOps.findGroupKeyByPath(path);
    if (!targetGroupKey) {
      return { handled: false, conflict: false };
    }
    const targetGroup = coreOps.getEditorGroup(targetGroupKey);
    const conflict = deps.applyFormattedContent(targetGroup, path, content, options);
    return { handled: true, conflict };
  };

  const jumpToFileLine = (
    path: string,
    line: number,
    groupKey: EditorGroupKey,
    options: { force?: boolean; focus?: boolean; className?: string; column?: number } = {}
  ) => {
    const forceOpen = options.force === true;
    const focus = options.focus;
    const className = options.className;
    const column = options.column;
    const targetGroupKey = forceOpen ? groupKey : coreOps.resolveOpenTargetGroupKey(path, groupKey);
    const targetGroup = coreOps.getEditorGroup(targetGroupKey);
    if (targetGroup.currentFilePath === path) {
      issueOps.revealLine(targetGroup, line, { focus, className, column });
      return;
    }
    const requested = deps.requestOpenFile(path, targetGroupKey, forceOpen);
    if (requested) {
      runtime.fileOpsState.pendingReveal = {
        path,
        line,
        column,
        group: targetGroupKey,
        focus,
        className,
      };
    }
  };

  const jumpToLocation = (entry: IndexEntry) => {
    if (!entry.path || !entry.line) {
      return;
    }
    jumpToFileLine(entry.path, entry.line, coreOps.getActiveEditorGroupKey());
  };

  return {
    applyContentToOpenFile,
    jumpToFileLine,
    jumpToLocation,
  };
};

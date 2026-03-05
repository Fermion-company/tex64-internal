import { isTextFilePath } from "../files.js";
import type {
  EditorGroupKey,
  EditorGroupState,
} from "./types.js";
import type { EditorSessionRuntime } from "./runtime.js";

export type EditorSessionCoreOps = {
  getEditorGroup: (key: EditorGroupKey) => EditorGroupState;
  getActiveGroup: () => EditorGroupState;
  getActiveEditorGroupKey: () => EditorGroupKey;
  getActiveFilePath: () => string | null;
  getActiveFileSnapshot: () => { path: string; content: string; isDirty: boolean } | null;
  getActiveSelectionSnapshot: () => {
    path: string;
    text: string;
    isDirty: boolean;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null;
  getOpenFileSnapshots: (options?: { maxFiles?: number; maxChars?: number }) => {
    files: Array<{ path: string; isDirty: boolean; isActive: boolean }>;
    snapshots: Array<{
      path: string;
      content: string;
      isDirty: boolean;
      truncated: boolean;
      contentLength: number;
    }>;
  };
  isActiveGroup: (group: EditorGroupState) => boolean;
  getOtherGroupKey: (key: EditorGroupKey) => EditorGroupKey;
  resolveAutoOpenGroupKey: (preferredKey: EditorGroupKey) => EditorGroupKey;
  findGroupKeyByPath: (path: string) => EditorGroupKey | null;
  findGroupKeyByCurrentPath: (path: string) => EditorGroupKey | null;
  resolveOpenTargetGroupKey: (path: string, preferredKey: EditorGroupKey) => EditorGroupKey;
  forEachEditorGroup: (handler: (group: EditorGroupState) => void) => void;
  scheduleEditorLayout: () => void;
};

export const createEditorSessionCoreOps = (runtime: EditorSessionRuntime): EditorSessionCoreOps => {
  const getEditorGroup = (key: EditorGroupKey) => runtime.editorGroups[key];
  const getActiveGroup = () => runtime.editorGroups[runtime.state.activeEditorGroup];
  const getActiveEditorGroupKey = () => runtime.state.activeEditorGroup;
  const getActiveFilePath = () => getActiveGroup().currentFilePath;

  const getActiveFileSnapshot = () => {
    const group = getActiveGroup();
    if (!group.currentFilePath || !isTextFilePath(group.currentFilePath)) {
      return null;
    }
    const entry = runtime.monacoModels.get(group.currentFilePath);
    const editor = group.editor as { getValue?: () => string } | null;
    const content = entry?.model?.getValue?.() ?? editor?.getValue?.() ?? null;
    if (content === null) {
      return null;
    }
    return { path: group.currentFilePath, content, isDirty: group.isDirty };
  };

  const getActiveSelectionSnapshot = () => {
    const group = getActiveGroup();
    if (!group.currentFilePath || !isTextFilePath(group.currentFilePath) || !group.editor) {
      return null;
    }
    const editorAny = group.editor as {
      getSelection?: () => unknown;
      getModel?: () => { getValueInRange?: (range: unknown) => string } | null;
    };
    const selection =
      (typeof editorAny.getSelection === "function" ? editorAny.getSelection() : null) as
        | {
            startLineNumber?: number;
            selectionStartLineNumber?: number;
            positionLineNumber?: number;
            startColumn?: number;
            selectionStartColumn?: number;
            positionColumn?: number;
            endLineNumber?: number;
            selectionEndLineNumber?: number;
            endColumn?: number;
            selectionEndColumn?: number;
          }
        | null;
    if (!selection || typeof selection !== "object") {
      return null;
    }
    const startLine =
      selection.startLineNumber ??
      selection.selectionStartLineNumber ??
      selection.positionLineNumber;
    const startColumn =
      selection.startColumn ?? selection.selectionStartColumn ?? selection.positionColumn;
    const endLine =
      selection.endLineNumber ?? selection.selectionEndLineNumber ?? selection.positionLineNumber;
    const endColumn = selection.endColumn ?? selection.selectionEndColumn ?? selection.positionColumn;
    if (
      typeof startLine !== "number" ||
      typeof startColumn !== "number" ||
      typeof endLine !== "number" ||
      typeof endColumn !== "number"
    ) {
      return null;
    }
    if (startLine === endLine && startColumn === endColumn) {
      return null;
    }
    const model = typeof editorAny.getModel === "function" ? editorAny.getModel() : null;
    const getValueInRange =
      model && typeof model.getValueInRange === "function" ? model.getValueInRange.bind(model) : null;
    if (!getValueInRange) {
      return null;
    }
    const text = getValueInRange(selection).replace(/\r\n/g, "\n");
    return {
      path: group.currentFilePath,
      text,
      isDirty: group.isDirty,
      startLine,
      startColumn,
      endLine,
      endColumn,
    };
  };

  const isActiveGroup = (group: EditorGroupState) => group.key === runtime.state.activeEditorGroup;
  const getOtherGroupKey = (key: EditorGroupKey): EditorGroupKey => (key === "primary" ? "secondary" : "primary");

  const resolveAutoOpenGroupKey = (preferredKey: EditorGroupKey): EditorGroupKey => {
    if (!runtime.state.splitViewEnabled) {
      return preferredKey;
    }
    const preferred = getEditorGroup(preferredKey);
    if (preferred.openTabs.length === 0) {
      return preferredKey;
    }
    const otherKey = getOtherGroupKey(preferredKey);
    const other = getEditorGroup(otherKey);
    if (other.openTabs.length === 0) {
      return otherKey;
    }
    return preferredKey;
  };

  const findGroupKeyByPath = (path: string): EditorGroupKey | null => {
    const groups = Object.keys(runtime.editorGroups) as EditorGroupKey[];
    for (const key of groups) {
      if (runtime.editorGroups[key].openTabs.includes(path)) {
        return key;
      }
    }
    return null;
  };

  const findGroupKeyByCurrentPath = (path: string): EditorGroupKey | null => {
    const groups = Object.keys(runtime.editorGroups) as EditorGroupKey[];
    for (const key of groups) {
      if (runtime.editorGroups[key].currentFilePath === path) {
        return key;
      }
    }
    return null;
  };

  const resolveOpenTargetGroupKey = (path: string, preferredKey: EditorGroupKey): EditorGroupKey => {
    if (getEditorGroup(preferredKey).currentFilePath === path) {
      return preferredKey;
    }
    const currentGroupKey = findGroupKeyByCurrentPath(path);
    if (currentGroupKey) {
      return currentGroupKey;
    }
    const existingGroupKey = findGroupKeyByPath(path);
    if (existingGroupKey) {
      return existingGroupKey;
    }
    return resolveAutoOpenGroupKey(preferredKey);
  };

  const forEachEditorGroup = (handler: (group: EditorGroupState) => void) => {
    (Object.keys(runtime.editorGroups) as EditorGroupKey[]).forEach((key) => {
      handler(runtime.editorGroups[key]);
    });
  };

  const scheduleEditorLayout = () => {
    if (runtime.state.layoutFrame !== null) {
      return;
    }
    runtime.state.layoutFrame = requestAnimationFrame(() => {
      runtime.state.layoutFrame = null;
      forEachEditorGroup((group) => {
        const editor = group.editor as { layout?: () => void };
        editor?.layout?.();
      });
    });
  };

  const getOpenFileSnapshots = (options?: { maxFiles?: number; maxChars?: number }) => {
    const rawMaxFiles = options?.maxFiles ?? 8;
    const maxFiles = rawMaxFiles > 0 ? rawMaxFiles : Number.POSITIVE_INFINITY;
    const rawMaxChars = options?.maxChars ?? 20000;
    const maxChars = rawMaxChars > 0 ? rawMaxChars : Number.POSITIVE_INFINITY;
    const files = new Map<string, { path: string; isDirty: boolean; isActive: boolean }>();
    const snapshots: Array<{
      path: string;
      content: string;
      isDirty: boolean;
      truncated: boolean;
      contentLength: number;
    }> = [];
    const pushSnapshot = (path: string, isDirty: boolean) => {
      if (snapshots.length >= maxFiles || !isTextFilePath(path)) {
        return;
      }
      const entry = runtime.monacoModels.get(path);
      const editorGroupKey = findGroupKeyByPath(path);
      const group = editorGroupKey ? getEditorGroup(editorGroupKey) : null;
      const editor = group?.editor as { getValue?: () => string } | null;
      const rawContent = entry?.model?.getValue?.() ?? editor?.getValue?.() ?? null;
      if (rawContent === null) {
        return;
      }
      const truncated = Number.isFinite(maxChars) && rawContent.length > maxChars;
      const content = truncated ? rawContent.slice(0, maxChars) : rawContent;
      snapshots.push({
        path,
        content,
        isDirty,
        truncated,
        contentLength: rawContent.length,
      });
    };
    forEachEditorGroup((group) => {
      group.openTabs.forEach((path) => {
        if (!path) {
          return;
        }
        if (!files.has(path)) {
          files.set(path, {
            path,
            isDirty: runtime.dirtyFiles.has(path),
            isActive: group.currentFilePath === path,
          });
        } else {
          const entry = files.get(path);
          if (entry) {
            entry.isDirty = entry.isDirty || runtime.dirtyFiles.has(path);
            entry.isActive = entry.isActive || group.currentFilePath === path;
          }
        }
      });
    });
    const entries = Array.from(files.values());
    entries.forEach((entry) => {
      if (entry.isDirty && !entry.isActive) {
        pushSnapshot(entry.path, entry.isDirty);
      }
    });
    entries.forEach((entry) => {
      if (!entry.isDirty && !entry.isActive) {
        pushSnapshot(entry.path, entry.isDirty);
      }
    });
    return { files: Array.from(files.values()), snapshots };
  };

  return {
    getEditorGroup,
    getActiveGroup,
    getActiveEditorGroupKey,
    getActiveFilePath,
    getActiveFileSnapshot,
    getActiveSelectionSnapshot,
    getOpenFileSnapshots,
    isActiveGroup,
    getOtherGroupKey,
    resolveAutoOpenGroupKey,
    findGroupKeyByPath,
    findGroupKeyByCurrentPath,
    resolveOpenTargetGroupKey,
    forEachEditorGroup,
    scheduleEditorLayout,
  };
};


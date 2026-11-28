import type { EditorGroupKey, EditorGroupState, MonacoModelEntry } from "./types.js";

// New disk text for an open buffer that did not come from its keyboard:
// another program rewrote the file (file:externalChange) or Axiom wrote it
// (agent:applyContent). Nothing touches a buffer while an IME composition is
// open on it; those changes wait, in arrival order, until it ends.
//
// An Axiom edit that would change the paragraph the person is typing in (or
// overlaps their unsaved typing) also waits: until the file has had no typing
// for HOLD_PAUSE_MS, and never while composing. The person's text stays as it
// is meanwhile, and that file's autosave waits with it (the disk already has
// Axiom's text; the editor is not based on it yet). Then it is applied as
// ranged edits if it merges, or the usual conflict choices appear.
//   - More Axiom edits to the same file while one waits replace it: each
//     carries the whole file, and the later one already contains the earlier.
//     A disk change from elsewhere to that file joins the waiting one too.
//   - If the typing goes on past HOLD_MAX_MS, a waiting edit that merges is
//     applied anyway (the person's characters and caret stay where they are),
//     so their text is not kept off the disk for long; one that overlaps their
//     typing keeps waiting for the first pause, so the choices never appear
//     under their fingers.
//   - Save by hand, Build, History or Git applies the waiting edit at once (or
//     shows the choices): those act on the disk.
//
// A file that disappears from disk counts as deleted only after it has stayed
// missing for DELETE_GRACE_MS: editors and git replace files by deleting and
// recreating them, sometimes seconds apart. Meanwhile its tab stays as it is
// (workspace-ops.ts keeps it through tree updates) and nothing new is shown.
// If it comes back, the new text is applied like any outside change (ranged
// edits, caret kept). If not, a clean tab closes as before, and a buffer with
// unsaved typing keeps its tab and gets the deletion choices.

export type OutsideApplyOptions = {
  fileIdentity?: string;
  updateSaved?: boolean;
  showAiDiff?: boolean;
  expectedContent?: string;
  expectedFileMissing?: boolean;
  fileDeleted?: boolean;
  conversationId?: string;
  /** Called when a change that had to wait ends in a conflict. */
  onDeferredConflict?: () => void;
};

type OutsideEditDeps = {
  editorGroups: Record<EditorGroupKey, EditorGroupState>;
  monacoModels: Map<string, MonacoModelEntry>;
  findGroupKeyByPath: (path: string) => EditorGroupKey | null;
  getEditorGroup: (key: EditorGroupKey) => EditorGroupState;
  getPendingSave: () => { path: string; content: string } | null;
  applyFormattedContent: (
    group: EditorGroupState,
    path: string,
    content: string,
    options?: OutsideApplyOptions & { externalChange?: boolean },
  ) => boolean;
  onLivePreviewSourceChanged?: () => void;
  // Typing-pause rules (editor-session-file-ops.ts). Without them no edit waits.
  disturbsTyping?: (path: string, content: string, withinMs: number) => boolean;
  mergesCleanly?: (path: string, content: string) => boolean;
  lastTypedAt?: (path: string) => number | null;
  holdSaves?: (path: string, release: () => void) => void;
  unholdSaves?: (path: string) => void;
  now?: () => number;
  /** A reported deletion became final (or was dropped): re-check the tree. */
  onDeletionSettled?: () => void;
};

const COMPOSITION_RECHECK_MS = 100;
export const HOLD_PAUSE_MS = 2000;
export const HOLD_MAX_MS = 30_000;
const HOLD_RECHECK_MS = 250;
export const DELETE_GRACE_MS = 5000;

type HeldEdit = {
  entry: MonacoModelEntry;
  content: string;
  options?: OutsideApplyOptions;
  since: number;
};

export const createOutsideEdits = (deps: OutsideEditDeps) => {
  const waiting = new Map<string, Array<() => void>>();
  const held = new Map<string, HeldEdit>();
  const pendingDeletions = new Map<string, number>();
  const now = deps.now ?? (() => Date.now());

  const composingOn = (path: string) =>
    Object.values(deps.editorGroups).some(
      (group) => group.isComposing && (group.currentFilePath === path || group.composingFilePath === path),
    );

  // Runs `action` now, or after the composition on `path` ends (behind any
  // change already waiting for it). Returns true when it had to wait.
  const whenNotComposing = (path: string, action: () => void) => {
    const queue = waiting.get(path);
    if (queue) {
      queue.push(action);
      return true;
    }
    if (!composingOn(path)) {
      action();
      return false;
    }
    const pending = [action];
    waiting.set(path, pending);
    const drain = () => {
      if (waiting.get(path) !== pending) return;
      if (composingOn(path)) {
        window.setTimeout(drain, COMPOSITION_RECHECK_MS);
        return;
      }
      waiting.delete(path);
      for (const run of pending) run();
    };
    window.setTimeout(drain, COMPOSITION_RECHECK_MS);
    return true;
  };

  const applyNow = (path: string, content: string, options?: OutsideApplyOptions) => {
    const groupKey = deps.findGroupKeyByPath(path);
    if (!groupKey) return { handled: false, conflict: false };
    const conflict = deps.applyFormattedContent(deps.getEditorGroup(groupKey), path, content, options);
    return { handled: true, conflict };
  };

  // Applies the waiting edit of `path` now (merge, or the conflict choices).
  const release = (path: string) => {
    const edit = held.get(path);
    if (!edit) return;
    held.delete(path);
    deps.unholdSaves?.(path);
    if (deps.monacoModels.get(path) !== edit.entry) return;
    const result = applyNow(path, edit.content, edit.options);
    if (result.conflict) edit.options?.onDeferredConflict?.();
  };

  const checkHeld = (path: string) => {
    const edit = held.get(path);
    if (!edit) return;
    if (deps.monacoModels.get(path) !== edit.entry) {
      held.delete(path);
      deps.unholdSaves?.(path);
      return;
    }
    if (!composingOn(path)) {
      const typedAt = deps.lastTypedAt?.(path) ?? null;
      const paused = typedAt === null || now() - typedAt >= HOLD_PAUSE_MS;
      const overdue = now() - edit.since >= HOLD_MAX_MS && (deps.mergesCleanly?.(path, edit.content) ?? false);
      if (paused || overdue) {
        release(path);
        return;
      }
    }
    window.setTimeout(() => checkHeld(path), HOLD_RECHECK_MS);
  };

  const hold = (path: string, entry: MonacoModelEntry, content: string, options?: OutsideApplyOptions) => {
    const previous = held.get(path);
    held.set(path, { entry, content, options: options ?? previous?.options, since: previous?.since ?? now() });
    if (previous) return;
    deps.holdSaves?.(path, () => release(path));
    window.setTimeout(() => checkHeld(path), HOLD_RECHECK_MS);
  };

  const handleExternalFileChange = (payload: { path: string; content: string | null; fileDeleted?: boolean }) => {
    const entry = deps.monacoModels.get(payload.path);
    if (!entry || !deps.findGroupKeyByPath(payload.path)) return;
    if (payload.fileDeleted) {
      if (pendingDeletions.has(payload.path)) return;
      const timer = window.setTimeout(() => {
        if (pendingDeletions.get(payload.path) !== timer) return;
        pendingDeletions.delete(payload.path);
        applyExternalChange(payload, entry);
        deps.onDeletionSettled?.();
      }, DELETE_GRACE_MS);
      pendingDeletions.set(payload.path, timer);
      return;
    }
    // The file is back (or was never really gone).
    const pendingDeletion = pendingDeletions.get(payload.path);
    if (pendingDeletion !== undefined) {
      window.clearTimeout(pendingDeletion);
      pendingDeletions.delete(payload.path);
    }
    applyExternalChange(payload, entry);
  };

  const applyExternalChange = (
    payload: { path: string; content: string | null; fileDeleted?: boolean },
    entry: MonacoModelEntry,
  ) => {
    whenNotComposing(payload.path, () => {
      // A buffer closed and reopened meanwhile was read fresh from disk.
      if (deps.monacoModels.get(payload.path) !== entry) return;
      const groupKey = deps.findGroupKeyByPath(payload.path);
      if (!groupKey) return;
      // The newest disk text joins an Axiom edit waiting on this file.
      const waitingEdit = held.get(payload.path);
      if (waitingEdit && !payload.fileDeleted && typeof payload.content === "string") {
        waitingEdit.content = payload.content;
        return;
      }
      if (!payload.fileDeleted && payload.content === entry.savedContent) return;
      const pendingSave = deps.getPendingSave();
      if (!payload.fileDeleted && pendingSave?.path === payload.path && pendingSave.content === payload.content) return;
      deps.applyFormattedContent(deps.getEditorGroup(groupKey), payload.path, payload.content ?? "", {
        updateSaved: true,
        showAiDiff: false,
        expectedContent: entry.savedContent,
        fileDeleted: payload.fileDeleted,
        externalChange: true,
      });
      deps.onLivePreviewSourceChanged?.();
    });
  };

  const applyContentToOpenFile = (requestedPath: string, content: string, options?: OutsideApplyOptions) => {
    const path = options?.fileIdentity || requestedPath;
    const entry = deps.monacoModels.get(path);
    if (!entry || !deps.findGroupKeyByPath(path)) return applyNow(path, content, options);
    // A conflict found now is returned; one found after waiting (composition
    // or typing pause) is reported through onDeferredConflict.
    let synchronous = true;
    let result = { handled: true, conflict: false };
    whenNotComposing(path, () => {
      if (deps.monacoModels.get(path) !== entry) return;
      const textEdit = options?.fileDeleted !== true && options?.expectedFileMissing !== true;
      if (textEdit && (held.has(path) || (deps.disturbsTyping?.(path, content, HOLD_PAUSE_MS) ?? false))) {
        hold(path, entry, content, options);
        return;
      }
      if (held.has(path)) release(path);
      const applied = applyNow(path, content, options);
      if (synchronous) result = applied;
      else if (applied.conflict) options?.onDeferredConflict?.();
    });
    synchronous = false;
    return result;
  };

  return {
    handleExternalFileChange,
    applyContentToOpenFile,
    /** True while a file reported missing may still come back. */
    isDeletionPending: (path: string) => pendingDeletions.has(path),
    clear: () => {
      waiting.clear();
      for (const timer of pendingDeletions.values()) window.clearTimeout(timer);
      pendingDeletions.clear();
      for (const path of Array.from(held.keys())) deps.unholdSaves?.(path);
      held.clear();
    },
  };
};

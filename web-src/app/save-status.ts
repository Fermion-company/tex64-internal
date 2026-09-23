// Whether the user's edits are on disk. The editor session reports every
// change that can move the answer (a buffer turning dirty or clean, a save
// starting, finishing or failing); the toolbar re-reads the status then.

export type SaveStatus =
  | { kind: "saved"; savedAt: number | null }
  | { kind: "dirty"; count: number }
  | { kind: "saving"; path: string }
  | { kind: "error"; message: string; path: string | null; count: number };

const listeners = new Set<() => void>();
let notifyQueued = false;

export const onSaveStatusChange = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// Coalesced: a save touches the dirty set, the pending save and the error
// in one task, and the toolbar only needs the end state.
export const notifySaveStatusChange = () => {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error("[save-status] listener failed:", error);
      }
    });
  });
};

// The set of unsaved paths, telling the save status when it changes.
export class TrackedPathSet extends Set<string> {
  add(value: string) {
    const changed = !this.has(value);
    super.add(value);
    if (changed) notifySaveStatusChange();
    return this;
  }

  delete(value: string) {
    const changed = super.delete(value);
    if (changed) notifySaveStatusChange();
    return changed;
  }

  clear() {
    const changed = this.size > 0;
    super.clear();
    if (changed) notifySaveStatusChange();
  }
}

import type { EditorSessionApi } from "./editor-session.js";

type Guard = { setLocked: (owner: string, locked: boolean) => void; refresh: () => void };
const guards = new WeakMap<EditorSessionApi, Guard>();

// UI owners may overlap while main-process notifications are being delivered.
// Releasing a history UI lock must not make a Git-protected editor writable.
export function getEditorOperationGuard(editor: EditorSessionApi): Guard {
  const existing = guards.get(editor);
  if (existing) return existing;
  const owners = new Set<string>();
  const original = new Map<any, boolean>();
  const refresh = () => {
    const locked = owners.size > 0;
    for (const group of editor.getEditorGroups()) {
      const instance = group.editor as any;
      if (!instance?.updateOptions) continue;
      if (locked && !original.has(instance)) {
        original.set(instance, Boolean(instance.getRawOptions?.().readOnly));
        instance.updateOptions({ readOnly: true });
      }
    }
    if (!locked) {
      for (const [instance, readOnly] of original) instance.updateOptions({ readOnly });
      original.clear();
    }
  };
  const guard = {
    setLocked(owner: string, locked: boolean) {
      if (locked) owners.add(owner); else owners.delete(owner);
      refresh();
    },
    refresh,
  };
  guards.set(editor, guard);
  return guard;
}

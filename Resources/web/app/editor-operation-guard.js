const guards = new WeakMap();
// UI owners may overlap while main-process notifications are being delivered.
// Releasing a history UI lock must not make a Git-protected editor writable.
export function getEditorOperationGuard(editor) {
    const existing = guards.get(editor);
    if (existing)
        return existing;
    const owners = new Set();
    const original = new Map();
    const refresh = () => {
        var _a;
        const locked = owners.size > 0;
        for (const group of editor.getEditorGroups()) {
            const instance = group.editor;
            if (!(instance === null || instance === void 0 ? void 0 : instance.updateOptions))
                continue;
            if (locked && !original.has(instance)) {
                original.set(instance, Boolean((_a = instance.getRawOptions) === null || _a === void 0 ? void 0 : _a.call(instance).readOnly));
                instance.updateOptions({ readOnly: true });
            }
        }
        if (!locked) {
            for (const [instance, readOnly] of original)
                instance.updateOptions({ readOnly });
            original.clear();
        }
    };
    const guard = {
        setLocked(owner, locked) {
            if (locked)
                owners.add(owner);
            else
                owners.delete(owner);
            refresh();
        },
        refresh,
    };
    guards.set(editor, guard);
    return guard;
}

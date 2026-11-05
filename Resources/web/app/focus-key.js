// Views that rebuild themselves while open (the collab dialog on every state
// change, word count on a scope change, the canvas plot card) give focus back
// to the control the user was on. A control carries a key that survives the
// rebuild: a ▾'s `data-explain-key`, or `data-focus-key` on anything else.
const KEYED = "[data-explain-key], [data-focus-key]";
const keyOf = (node) => { var _a; return (_a = node.dataset.explainKey) !== null && _a !== void 0 ? _a : node.dataset.focusKey; };
// The keyed control inside `root` that has focus now, with the caret of a
// text field.
export const markFocus = (root) => {
    const active = document.activeElement;
    if (!active || !root.contains(active))
        return null;
    const keyed = active.closest(KEYED);
    const key = keyed && keyOf(keyed);
    if (!key)
        return null;
    const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
    return { key, selection: field ? [field.selectionStart, field.selectionEnd] : null };
};
// Focuses the control with the same key in the rebuilt `root`; false when it
// is gone.
export const restoreFocus = (root, mark) => {
    if (!mark)
        return false;
    const target = Array.from(root.querySelectorAll(KEYED)).find((node) => keyOf(node) === mark.key);
    if (!target)
        return false;
    target.focus();
    if (mark.selection && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        try {
            target.setSelectionRange(mark.selection[0], mark.selection[1]);
        }
        catch { }
    }
    return document.activeElement === target;
};

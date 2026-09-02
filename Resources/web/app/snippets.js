// Snippet store shared by the panel and the editor completion provider.
// The main process owns the files (electron/services/snippets.cjs); this keeps
// one in-memory copy so Monaco can answer a completion request synchronously.
const getBridge = () => {
    const bridge = window.tex64Snippets;
    return bridge && typeof bridge.list === "function" ? bridge : null;
};
let snippets = [];
const listeners = new Set();
const notify = () => {
    listeners.forEach((listener) => {
        try {
            listener(snippets);
        }
        catch {
            /* a broken listener must not stop the others */
        }
    });
};
export const getSnippets = () => snippets;
export const onSnippetsChange = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};
export const reloadSnippets = async () => {
    const bridge = getBridge();
    if (!bridge) {
        return snippets;
    }
    const result = await bridge.list();
    if (Array.isArray(result === null || result === void 0 ? void 0 : result.snippets)) {
        snippets = result.snippets;
        notify();
    }
    return snippets;
};
export const saveSnippet = async (snippet) => {
    const bridge = getBridge();
    if (!bridge) {
        return { ok: false, error: "Snippets are unavailable." };
    }
    const result = await bridge.save(snippet);
    if ((result === null || result === void 0 ? void 0 : result.ok) !== false) {
        await reloadSnippets();
    }
    return result;
};
export const deleteSnippet = async (id, scope) => {
    const bridge = getBridge();
    if (!bridge) {
        return { ok: false, error: "Snippets are unavailable." };
    }
    const result = await bridge.remove(id, scope);
    if ((result === null || result === void 0 ? void 0 : result.ok) !== false) {
        await reloadSnippets();
    }
    return result;
};

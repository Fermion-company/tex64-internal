import { uiText } from "./i18n.js";
import { deleteSnippet, getSnippets, onSnippetsChange, reloadSnippets, saveSnippet, } from "./snippets.js";
export const initSnippetsUi = (context, deps) => {
    const { snippetsFilter, snippetsNew, snippetsList, snippetsEditor, snippetName, snippetPrefix, snippetDescription, snippetScope, snippetBody, snippetCancel, snippetDelete, snippetsError, } = context.dom;
    let editing = null;
    let editorOpen = false;
    const setError = (message) => {
        if (snippetsError instanceof HTMLElement) {
            snippetsError.textContent = message;
            snippetsError.classList.toggle("is-hidden", !message);
        }
    };
    const setEditorOpen = (open) => {
        editorOpen = open;
        snippetsEditor === null || snippetsEditor === void 0 ? void 0 : snippetsEditor.classList.toggle("is-hidden", !open);
        if (!open) {
            editing = null;
            setError("");
        }
    };
    const openEditor = (snippet, seed) => {
        var _a, _b, _c, _d;
        // Built-ins are read-only; editing one starts a private copy instead, which
        // is what people expect from a "customise this" gesture.
        const isBuiltin = (snippet === null || snippet === void 0 ? void 0 : snippet.scope) === "builtin";
        editing = snippet && !isBuiltin ? snippet : null;
        if (snippetName instanceof HTMLInputElement) {
            snippetName.value = snippet ? (isBuiltin ? `${snippet.name} (copy)` : snippet.name) : "";
        }
        if (snippetPrefix instanceof HTMLInputElement) {
            snippetPrefix.value = (_a = snippet === null || snippet === void 0 ? void 0 : snippet.prefix) !== null && _a !== void 0 ? _a : "";
        }
        if (snippetDescription instanceof HTMLInputElement) {
            snippetDescription.value = (_b = snippet === null || snippet === void 0 ? void 0 : snippet.description) !== null && _b !== void 0 ? _b : "";
        }
        if (snippetScope instanceof HTMLSelectElement) {
            const preferred = snippet && !isBuiltin ? snippet.scope : "global";
            snippetScope.value = preferred === "workspace" && deps.hasWorkspace() ? "workspace" : preferred;
            const workspaceOption = snippetScope.querySelector('option[value="workspace"]');
            if (workspaceOption) {
                workspaceOption.disabled = !deps.hasWorkspace();
            }
        }
        if (snippetBody instanceof HTMLTextAreaElement) {
            snippetBody.value = (_d = (_c = seed === null || seed === void 0 ? void 0 : seed.body) !== null && _c !== void 0 ? _c : snippet === null || snippet === void 0 ? void 0 : snippet.body) !== null && _d !== void 0 ? _d : "";
        }
        if (snippetDelete instanceof HTMLElement) {
            snippetDelete.classList.toggle("is-hidden", !editing);
        }
        setError("");
        setEditorOpen(true);
        if (snippetPrefix instanceof HTMLInputElement && !snippetPrefix.value) {
            snippetPrefix.focus();
        }
        else if (snippetBody instanceof HTMLTextAreaElement) {
            snippetBody.focus();
        }
    };
    const render = () => {
        if (!(snippetsList instanceof HTMLElement)) {
            return;
        }
        const query = snippetsFilter instanceof HTMLInputElement ? snippetsFilter.value.trim().toLowerCase() : "";
        const items = getSnippets().filter((snippet) => {
            if (!query) {
                return true;
            }
            return (snippet.name.toLowerCase().includes(query) ||
                snippet.prefix.toLowerCase().includes(query) ||
                snippet.description.toLowerCase().includes(query));
        });
        snippetsList.innerHTML = "";
        if (items.length === 0) {
            const empty = document.createElement("div");
            empty.className = "panel-placeholder";
            empty.textContent = query
                ? uiText("No snippet matches.", "一致するスニペットがありません。")
                : uiText("No snippets yet.", "スニペットはまだありません。");
            snippetsList.appendChild(empty);
            return;
        }
        items.forEach((snippet) => {
            const row = document.createElement("div");
            row.className = "snippet-row";
            const insert = document.createElement("button");
            insert.type = "button";
            insert.className = "snippet-row-main";
            const title = document.createElement("span");
            title.className = "snippet-row-title";
            title.textContent = snippet.name;
            const prefix = document.createElement("span");
            prefix.className = "snippet-row-prefix";
            prefix.textContent = snippet.prefix;
            const scope = document.createElement("span");
            scope.className = `snippet-row-scope is-${snippet.scope}`;
            scope.textContent =
                snippet.scope === "workspace"
                    ? uiText("workspace", "ワークスペース")
                    : snippet.scope === "builtin"
                        ? uiText("built-in", "組み込み")
                        : uiText("global", "共通");
            insert.append(title, prefix, scope);
            if (snippet.description) {
                const description = document.createElement("span");
                description.className = "snippet-row-desc";
                description.textContent = snippet.description;
                insert.appendChild(description);
            }
            insert.title = snippet.body;
            insert.addEventListener("click", () => {
                if (!deps.insertSnippet(snippet.body)) {
                    setError(uiText("Open a file to insert into.", "挿入先のファイルを開いてください。"));
                }
            });
            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "snippet-row-action";
            edit.textContent = "✎";
            edit.title =
                snippet.scope === "builtin"
                    ? uiText("Duplicate and edit", "複製して編集")
                    : uiText("Edit snippet", "スニペットを編集");
            edit.addEventListener("click", (event) => {
                event.stopPropagation();
                openEditor(snippet);
            });
            row.append(insert, edit);
            snippetsList.appendChild(row);
        });
    };
    const submit = async (event) => {
        var _a;
        event.preventDefault();
        const prefix = snippetPrefix instanceof HTMLInputElement ? snippetPrefix.value.trim() : "";
        const body = snippetBody instanceof HTMLTextAreaElement ? snippetBody.value : "";
        if (!prefix || !body.trim()) {
            setError(uiText("A prefix and a body are required.", "プレフィックスと本文が必要です。"));
            return;
        }
        const scope = snippetScope instanceof HTMLSelectElement && snippetScope.value === "workspace"
            ? "workspace"
            : "global";
        const result = await saveSnippet({
            id: editing === null || editing === void 0 ? void 0 : editing.id,
            name: snippetName instanceof HTMLInputElement ? snippetName.value.trim() : prefix,
            prefix,
            description: snippetDescription instanceof HTMLInputElement ? snippetDescription.value.trim() : "",
            body,
            scope,
        });
        if ((result === null || result === void 0 ? void 0 : result.ok) === false) {
            setError(String((_a = result.error) !== null && _a !== void 0 ? _a : "Save failed."));
            return;
        }
        setEditorOpen(false);
        render();
    };
    const removeCurrent = async () => {
        var _a;
        if (!editing) {
            return;
        }
        const confirmed = window.confirm(uiText(`Delete snippet "${editing.name}"?`, `スニペット「${editing.name}」を削除しますか？`));
        if (!confirmed) {
            return;
        }
        const result = await deleteSnippet(editing.id, editing.scope);
        if ((result === null || result === void 0 ? void 0 : result.ok) === false) {
            setError(String((_a = result.error) !== null && _a !== void 0 ? _a : "Delete failed."));
            return;
        }
        setEditorOpen(false);
        render();
    };
    snippetsFilter === null || snippetsFilter === void 0 ? void 0 : snippetsFilter.addEventListener("input", render);
    // "+" with text selected in the editor starts the snippet from that text —
    // turning something you just wrote into a reusable macro is the common case.
    snippetsNew === null || snippetsNew === void 0 ? void 0 : snippetsNew.addEventListener("click", () => {
        const selection = deps.getSelectedText();
        openEditor(null, selection ? { body: selection } : undefined);
    });
    snippetCancel === null || snippetCancel === void 0 ? void 0 : snippetCancel.addEventListener("click", () => setEditorOpen(false));
    snippetDelete === null || snippetDelete === void 0 ? void 0 : snippetDelete.addEventListener("click", () => void removeCurrent());
    snippetsEditor === null || snippetsEditor === void 0 ? void 0 : snippetsEditor.addEventListener("submit", (event) => void submit(event));
    onSnippetsChange(() => render());
    return {
        activate: () => {
            void reloadSnippets().then(() => render());
            if (!editorOpen) {
                setEditorOpen(false);
            }
        },
        refresh: () => render(),
    };
};

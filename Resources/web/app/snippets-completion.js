import { getSnippets, reloadSnippets } from "./snippets.js";
export const registerSnippetCompletion = (monaco) => {
    var _a, _b, _c, _d;
    const languages = monaco === null || monaco === void 0 ? void 0 : monaco.languages;
    if (!(languages === null || languages === void 0 ? void 0 : languages.registerCompletionItemProvider)) {
        return () => { };
    }
    const kind = (_b = (_a = languages.CompletionItemKind) === null || _a === void 0 ? void 0 : _a.Snippet) !== null && _b !== void 0 ? _b : 27;
    const insertAsSnippet = (_d = (_c = languages.CompletionItemInsertTextRule) === null || _c === void 0 ? void 0 : _c.InsertAsSnippet) !== null && _d !== void 0 ? _d : 4;
    const provider = {
        provideCompletionItems: (model, position) => {
            const snippets = getSnippets();
            if (snippets.length === 0) {
                return { suggestions: [] };
            }
            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };
            return {
                suggestions: snippets.map((snippet) => ({
                    label: snippet.prefix,
                    kind,
                    insertText: snippet.body,
                    insertTextRules: insertAsSnippet,
                    range,
                    detail: snippet.name,
                    documentation: {
                        value: `${snippet.description ? `${snippet.description}\n\n` : ""}\`\`\`latex\n${snippet.body}\n\`\`\``,
                    },
                    // Snippets sort after the language server's own suggestions: they are
                    // the writer's own shortcuts, not the more likely completion of a
                    // half-typed command.
                    sortText: `zz-${snippet.prefix}`,
                })),
            };
        },
    };
    const disposables = ["latex", "bibtex"].map((languageId) => languages.registerCompletionItemProvider(languageId, provider));
    // Warm the in-memory list so the provider can answer synchronously. It stays
    // current because every save/delete in the panel reloads the same store.
    void reloadSnippets();
    return () => {
        disposables.forEach((disposable) => {
            var _a;
            try {
                (_a = disposable === null || disposable === void 0 ? void 0 : disposable.dispose) === null || _a === void 0 ? void 0 : _a.call(disposable);
            }
            catch {
                /* ignore */
            }
        });
    };
};

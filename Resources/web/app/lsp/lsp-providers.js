// Registers monaco language-feature providers backed by texlab over the LSP
// client. Each provider translates monaco's (model, position) call into an LSP
// request and converts the result back. Registration is gated on the server's
// advertised capabilities so we don't register no-op providers.
import { uiText } from "../i18n.js";
import { editorSettings } from "../editor-settings/editor-settings-store.js";
import { toLspPosition, toMonacoTextEdit, toMonacoCompletionItem, toMarkdownString, toMonacoLocations, toMonacoDocumentSymbols, toMonacoWorkspaceEdit, toMonacoMarkerSeverity, toMonacoFoldingRanges, toMonacoDocumentHighlights, toMonacoInlayHints, toMonacoLinks, } from "./lsp-conversions.js";
import { dropNonEnvironmentItems, findDefinedEnvironments, isBeginNameContext, isEnvironmentNameContext, keepNamedItems, } from "../completion-context.js";
import { countAllEnvironmentPairs, planEnvironmentAccept } from "../editor-ergonomics.js";
const DEFAULT_TRIGGER_CHARACTERS = ["\\", "{", "}", "[", "(", ",", "/", "@", " ", "="];
const uriOf = (model) => model.uri.toString();
// Environment names defined in the open LaTeX documents (the one being edited
// included). texlab lists a defined environment only once it is used.
const documentEnvironmentNames = (monaco, model) => {
    var _a, _b, _c, _d;
    const models = (_c = (_b = (_a = monaco === null || monaco === void 0 ? void 0 : monaco.editor) === null || _a === void 0 ? void 0 : _a.getModels) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : [model];
    const names = new Set();
    for (const candidate of models) {
        if (candidate !== model && ((_d = candidate === null || candidate === void 0 ? void 0 : candidate.getLanguageId) === null || _d === void 0 ? void 0 : _d.call(candidate)) !== "latex")
            continue;
        for (const name of findDefinedEnvironments(candidate.getValue()))
            names.add(name);
    }
    return [...names];
};
// Whether the focused editor showing `model` is filling in a snippet.
const isInSnippetSession = (monaco, model) => {
    var _a, _b, _c;
    return ((_c = (_b = (_a = monaco === null || monaco === void 0 ? void 0 : monaco.editor) === null || _a === void 0 ? void 0 : _a.getEditors) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : []).some((editor) => {
        var _a, _b, _c, _d, _e;
        return ((_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) === model &&
            ((_b = editor === null || editor === void 0 ? void 0 : editor.hasTextFocus) === null || _b === void 0 ? void 0 : _b.call(editor)) &&
            Boolean((_e = (_d = (_c = editor === null || editor === void 0 ? void 0 : editor.getContribution) === null || _c === void 0 ? void 0 : _c.call(editor, "snippetController2")) === null || _d === void 0 ? void 0 : _d.isInSnippet) === null || _e === void 0 ? void 0 : _e.call(_d));
    });
};
export const registerLspProviders = (monaco, client, languages = ["latex", "bibtex"], loadResource) => {
    var _a;
    const caps = ((_a = client.capabilities) !== null && _a !== void 0 ? _a : {});
    const disposables = [];
    const register = (fn) => {
        const d = fn === null || fn === void 0 ? void 0 : fn();
        if (d) {
            disposables.push(d);
        }
    };
    const langs = monaco.languages;
    // Flags are evaluated at call time (not at registration) so the settings
    // toggle UI can enable/disable a feature live, without a reload. Providers
    // register based on server capability; each invocation re-checks the flag.
    const gate = (flag) => client.isReady() && editorSettings.isEnabled(flag);
    const loadTargets = async (resources) => {
        if (!loadResource)
            return true;
        const unique = new Map(resources.map((uri) => [uri.toString(), uri]));
        const loaded = await Promise.all(Array.from(unique.values(), loadResource));
        return loaded.every(Boolean);
    };
    languages.forEach((languageId) => {
        var _a, _b, _c;
        // Completion
        if (caps.completionProvider) {
            const triggerCharacters = (_b = (_a = caps.completionProvider) === null || _a === void 0 ? void 0 : _a.triggerCharacters) !== null && _b !== void 0 ? _b : DEFAULT_TRIGGER_CHARACTERS;
            const canResolve = Boolean((_c = caps.completionProvider) === null || _c === void 0 ? void 0 : _c.resolveProvider);
            register(() => langs.registerCompletionItemProvider(languageId, {
                triggerCharacters,
                provideCompletionItems: async (model, position, _ctx, token) => {
                    var _a;
                    if (!gate("lsp.completion")) {
                        return { suggestions: [] };
                    }
                    // Read the text before awaiting texlab: monaco places the items
                    // relative to this request's position, while the model may already
                    // hold what was typed since.
                    const lineText = model.getLineContent(position.lineNumber);
                    const textBeforeCaret = lineText.slice(0, Math.max(0, position.column - 1));
                    const documentLines = isBeginNameContext(textBeforeCaret)
                        ? model.getLinesContent()
                        : null;
                    const definedEnvironments = isEnvironmentNameContext(textBeforeCaret)
                        ? documentEnvironmentNames(monaco, model)
                        : [];
                    const result = await client
                        .request("textDocument/completion", {
                        textDocument: { uri: uriOf(model) },
                        position: toLspPosition(position),
                    })
                        .catch(() => null);
                    if (!result || (token === null || token === void 0 ? void 0 : token.isCancellationRequested)) {
                        return { suggestions: [] };
                    }
                    const texlabItems = keepNamedItems(dropNonEnvironmentItems(Array.isArray(result) ? result : (_a = result.items) !== null && _a !== void 0 ? _a : [], textBeforeCaret));
                    // Environments the open documents define but do not use yet; the
                    // same shape as texlab's, so they also close on accept.
                    const offered = new Set(texlabItems.map((item) => item.label));
                    const nameStart = textBeforeCaret.lastIndexOf("{") + 1;
                    const items = [
                        ...texlabItems,
                        ...definedEnvironments
                            .filter((name) => !offered.has(name))
                            .map((name) => ({
                            label: name,
                            kind: 1,
                            sortText: "00",
                            textEdit: {
                                newText: name,
                                range: {
                                    start: { line: position.lineNumber - 1, character: nameStart },
                                    end: { line: position.lineNumber - 1, character: position.column - 1 },
                                },
                            },
                        })),
                    ];
                    const word = model.getWordUntilPosition(position);
                    const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
                    // Accepting an environment name closes the environment, as typing
                    // its "}" does. Not inside a snippet's placeholders: a snippet that
                    // writes "\begin{$1}…\end{$1}" already has its end.
                    const pairCounts = documentLines &&
                        editorSettings.isEnabled("ergo.autoCloseEnvironment") &&
                        !isInSnippetSession(monaco, model)
                        ? countAllEnvironmentPairs(documentLines, position.lineNumber - 1)
                        : null;
                    return {
                        suggestions: items.map((item) => {
                            var _a, _b, _c, _d, _e;
                            const monacoItem = toMonacoCompletionItem(monaco, item, defaultRange);
                            const name = (_c = (_b = (_a = item === null || item === void 0 ? void 0 : item.textEdit) === null || _a === void 0 ? void 0 : _a.newText) !== null && _b !== void 0 ? _b : item === null || item === void 0 ? void 0 : item.insertText) !== null && _c !== void 0 ? _c : item === null || item === void 0 ? void 0 : item.label;
                            const accept = pairCounts && (item === null || item === void 0 ? void 0 : item.insertTextFormat) !== 2 && typeof name === "string"
                                ? planEnvironmentAccept(lineText, position.column, name, pairCounts)
                                : null;
                            if (accept) {
                                monacoItem.insertText = accept.snippet;
                                monacoItem.insertTextRules =
                                    (_e = (_d = monaco.languages.CompletionItemInsertTextRule) === null || _d === void 0 ? void 0 : _d.InsertAsSnippet) !== null && _e !== void 0 ? _e : 4;
                                monacoItem.range = new monaco.Range(position.lineNumber, accept.startColumn, position.lineNumber, accept.endColumn);
                            }
                            // Stash the original LSP item so resolve can enrich it lazily.
                            monacoItem._lsp = item;
                            return monacoItem;
                        }),
                        incomplete: Boolean(result.isIncomplete),
                    };
                },
                // Lazily fetch documentation/detail for the focused item.
                resolveCompletionItem: canResolve
                    ? async (item) => {
                        const lsp = item && item._lsp;
                        if (!lsp || !client.isReady()) {
                            return item;
                        }
                        const resolved = await client
                            .request("completionItem/resolve", lsp)
                            .catch(() => null);
                        if (resolved) {
                            if (resolved.documentation) {
                                item.documentation = toMarkdownString(resolved.documentation);
                            }
                            if (resolved.detail) {
                                item.detail = resolved.detail;
                            }
                        }
                        return item;
                    }
                    : undefined,
            }));
        }
        // Hover is intentionally NOT registered from texlab: TeX64's own hover
        // provider (monaco-hover) is richer — it renders math previews, image
        // thumbnails, and .bib/file excerpts that texlab's plain-markdown hover
        // can't. Registering both would stack duplicate popups, so the custom one
        // stays the single hover source.
        // Go to definition
        if (caps.definitionProvider) {
            register(() => langs.registerDefinitionProvider(languageId, {
                provideDefinition: async (model, position) => {
                    if (!gate("lsp.definition")) {
                        return null;
                    }
                    const result = await client
                        .request("textDocument/definition", {
                        textDocument: { uri: uriOf(model) },
                        position: toLspPosition(position),
                    })
                        .catch(() => null);
                    return toMonacoLocations(monaco, result);
                },
            }));
        }
        // Find references
        if (caps.referencesProvider) {
            register(() => langs.registerReferenceProvider(languageId, {
                provideReferences: async (model, position, context) => {
                    var _a, _b;
                    if (!gate("lsp.references")) {
                        return null;
                    }
                    const result = await client
                        .request("textDocument/references", {
                        textDocument: { uri: uriOf(model) },
                        position: toLspPosition(position),
                        context: { includeDeclaration: (_a = context === null || context === void 0 ? void 0 : context.includeDeclaration) !== null && _a !== void 0 ? _a : true },
                    })
                        .catch(() => null);
                    const locations = toMonacoLocations(monaco, result);
                    await loadTargets((_b = locations === null || locations === void 0 ? void 0 : locations.map((location) => location.uri)) !== null && _b !== void 0 ? _b : []);
                    return locations;
                },
            }));
        }
        // Document symbols (outline)
        if (caps.documentSymbolProvider) {
            register(() => langs.registerDocumentSymbolProvider(languageId, {
                provideDocumentSymbols: async (model) => {
                    if (!gate("lsp.documentSymbol")) {
                        return [];
                    }
                    const result = await client
                        .request("textDocument/documentSymbol", {
                        textDocument: { uri: uriOf(model) },
                    })
                        .catch(() => null);
                    return toMonacoDocumentSymbols(monaco, result);
                },
            }));
        }
        // Rename
        if (caps.renameProvider) {
            register(() => langs.registerRenameProvider(languageId, {
                provideRenameEdits: async (model, position, newName) => {
                    var _a, _b, _c, _d;
                    if (!gate("lsp.rename")) {
                        return { edits: [] };
                    }
                    const versions = new Map(((_c = (_b = (_a = monaco.editor).getModels) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : []).map((model) => [model.uri.toString(), model.getVersionId()]));
                    const result = await client
                        .request("textDocument/rename", {
                        textDocument: { uri: uriOf(model) },
                        position: toLspPosition(position),
                        newName,
                    })
                        .catch(() => null);
                    const edit = toMonacoWorkspaceEdit(monaco, result);
                    if (!await loadTargets(edit.edits.map((item) => item.resource))) {
                        return { edits: [], rejectReason: uiText("A file needed for this rename could not be opened.", "名前の変更に必要なファイルを開けませんでした。") };
                    }
                    for (const item of edit.edits) {
                        const current = monaco.editor.getModel(item.resource);
                        item.versionId = (_d = versions.get(item.resource.toString())) !== null && _d !== void 0 ? _d : current === null || current === void 0 ? void 0 : current.getVersionId();
                    }
                    return edit;
                },
            }));
        }
        // Document formatting
        if (caps.documentFormattingProvider) {
            register(() => langs.registerDocumentFormattingEditProvider(languageId, {
                provideDocumentFormattingEdits: async (model, options) => {
                    var _a, _b;
                    if (!gate("lsp.formatting")) {
                        return [];
                    }
                    const result = await client
                        .request("textDocument/formatting", {
                        textDocument: { uri: uriOf(model) },
                        options: {
                            tabSize: (_a = options === null || options === void 0 ? void 0 : options.tabSize) !== null && _a !== void 0 ? _a : 2,
                            insertSpaces: (_b = options === null || options === void 0 ? void 0 : options.insertSpaces) !== null && _b !== void 0 ? _b : true,
                        },
                    })
                        .catch(() => null);
                    if (!Array.isArray(result)) {
                        return [];
                    }
                    return result.map((edit) => toMonacoTextEdit(monaco, edit));
                },
            }));
        }
        // Code folding (sections/environments)
        if (caps.foldingRangeProvider) {
            register(() => langs.registerFoldingRangeProvider(languageId, {
                provideFoldingRanges: async (model) => {
                    if (!gate("lsp.folding")) {
                        return [];
                    }
                    const result = await client
                        .request("textDocument/foldingRange", { textDocument: { uri: uriOf(model) } })
                        .catch(() => null);
                    return toMonacoFoldingRanges(result);
                },
            }));
        }
        // Highlight occurrences of the symbol under the cursor
        if (caps.documentHighlightProvider) {
            register(() => langs.registerDocumentHighlightProvider(languageId, {
                provideDocumentHighlights: async (model, position) => {
                    if (!gate("lsp.documentHighlight")) {
                        return [];
                    }
                    const result = await client
                        .request("textDocument/documentHighlight", {
                        textDocument: { uri: uriOf(model) },
                        position: toLspPosition(position),
                    })
                        .catch(() => null);
                    return toMonacoDocumentHighlights(monaco, result);
                },
            }));
        }
        // Inlay hints
        if (caps.inlayHintProvider) {
            register(() => langs.registerInlayHintsProvider(languageId, {
                provideInlayHints: async (model, range) => {
                    if (!gate("lsp.inlayHint")) {
                        return { hints: [], dispose: () => { } };
                    }
                    const result = await client
                        .request("textDocument/inlayHint", {
                        textDocument: { uri: uriOf(model) },
                        range: {
                            start: toLspPosition({ lineNumber: range.startLineNumber, column: range.startColumn }),
                            end: toLspPosition({ lineNumber: range.endLineNumber, column: range.endColumn }),
                        },
                    })
                        .catch(() => null);
                    return { hints: toMonacoInlayHints(result), dispose: () => { } };
                },
            }));
        }
        // Clickable \input/\include/\href targets
        if (caps.documentLinkProvider) {
            register(() => langs.registerLinkProvider(languageId, {
                provideLinks: async (model) => {
                    if (!gate("lsp.documentLink")) {
                        return { links: [] };
                    }
                    const result = await client
                        .request("textDocument/documentLink", { textDocument: { uri: uriOf(model) } })
                        .catch(() => null);
                    return { links: toMonacoLinks(monaco, result) };
                },
            }));
        }
    });
    return disposables;
};
// Wire texlab's publishDiagnostics into monaco markers under a distinct owner so
// they coexist with the app's build-log diagnostics ("tex64").
export const registerDiagnostics = (monaco, client, owner = "texlab") => {
    const offNotify = client.onNotification("textDocument/publishDiagnostics", (raw) => {
        const params = raw !== null && raw !== void 0 ? raw : {};
        const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
        if (!model) {
            return;
        }
        // Flag checked at publish time so the toggle takes effect without a reload.
        if (!editorSettings.isEnabled("lsp.diagnostics")) {
            monaco.editor.setModelMarkers(model, owner, []);
            return;
        }
        const diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics : [];
        const markers = diagnostics.map((d) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
            return ({
                severity: toMonacoMarkerSeverity(monaco, d.severity),
                message: (_a = d.message) !== null && _a !== void 0 ? _a : "",
                startLineNumber: ((_d = (_c = (_b = d.range) === null || _b === void 0 ? void 0 : _b.start) === null || _c === void 0 ? void 0 : _c.line) !== null && _d !== void 0 ? _d : 0) + 1,
                startColumn: ((_g = (_f = (_e = d.range) === null || _e === void 0 ? void 0 : _e.start) === null || _f === void 0 ? void 0 : _f.character) !== null && _g !== void 0 ? _g : 0) + 1,
                endLineNumber: ((_k = (_j = (_h = d.range) === null || _h === void 0 ? void 0 : _h.end) === null || _j === void 0 ? void 0 : _j.line) !== null && _k !== void 0 ? _k : 0) + 1,
                endColumn: ((_o = (_m = (_l = d.range) === null || _l === void 0 ? void 0 : _l.end) === null || _m === void 0 ? void 0 : _m.character) !== null && _o !== void 0 ? _o : 0) + 1,
                source: (_p = d.source) !== null && _p !== void 0 ? _p : "texlab",
                code: d.code && typeof d.code === "object" ? d.code.value : d.code,
            });
        });
        monaco.editor.setModelMarkers(model, owner, markers);
    });
    // Clear existing texlab markers immediately when diagnostics are toggled off.
    const offFlag = editorSettings.subscribe((change) => {
        var _a, _b, _c;
        if (change.kind === "flag" && change.id === "lsp.diagnostics" && !change.value) {
            ((_c = (_b = (_a = monaco.editor).getModels) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : []).forEach((model) => monaco.editor.setModelMarkers(model, owner, []));
        }
    });
    return () => {
        offNotify();
        offFlag();
    };
};

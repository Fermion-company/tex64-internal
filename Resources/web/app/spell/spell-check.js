// Renderer spell-check controller. Tokenizes file models (LaTeX-aware),
// debounces, asks the main-process spell service which prose words are
// misspelled, and renders them as markers under the "spell" owner. Provides
// quick-fix code actions (replace with a suggestion, add to dictionary). Gated
// by the `spell.check` feature flag (live-toggle aware).
import { editorSettings } from "../editor-settings/editor-settings-store.js";
import { tokenizeLatexProse } from "./latex-tokenizer.js";
const OWNER = "spell";
const DEBOUNCE_MS = 500;
export class SpellChecker {
    constructor(monaco, bridge) {
        this.timers = new Map();
        this.disposables = [];
        // Per-model cleanup, removed when the model is disposed so subscriptions don't
        // accumulate over a long session of opening files.
        this.modelSubs = new Map();
        this.monaco = monaco;
        this.bridge = bridge;
    }
    isTarget(model) {
        return Boolean(model &&
            model.uri &&
            model.uri.scheme === "file" &&
            (model.getLanguageId ? model.getLanguageId() === "latex" : true));
    }
    start() {
        var _a, _b, _c;
        ((_c = (_b = (_a = this.monaco.editor).getModels) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : []).forEach((model) => this.attach(model));
        if (this.monaco.editor.onDidCreateModel) {
            this.disposables.push(this.monaco.editor.onDidCreateModel((model) => this.attach(model)));
        }
        this.registerCodeActions();
        // React to the feature flag being toggled at runtime.
        this.disposables.push({
            dispose: editorSettings.subscribe((change) => {
                if (change.kind === "flag" && change.id === "spell.check") {
                    if (change.value) {
                        this.recheckAll();
                    }
                    else {
                        this.clearAll();
                    }
                }
            }),
        });
    }
    attach(model) {
        if (!this.isTarget(model)) {
            return;
        }
        const uri = model.uri.toString();
        if (this.modelSubs.has(uri)) {
            return;
        }
        this.schedule(model);
        const subs = [];
        if (model.onDidChangeContent) {
            subs.push(model.onDidChangeContent(() => this.schedule(model)));
        }
        const cleanup = () => {
            const timer = this.timers.get(uri);
            if (timer) {
                clearTimeout(timer);
            }
            this.timers.delete(uri);
            subs.forEach((s) => { var _a; return (_a = s.dispose) === null || _a === void 0 ? void 0 : _a.call(s); });
            this.modelSubs.delete(uri);
        };
        if (model.onWillDispose) {
            subs.push(model.onWillDispose(cleanup));
        }
        this.modelSubs.set(uri, cleanup);
    }
    schedule(model) {
        const uri = model.uri.toString();
        const prev = this.timers.get(uri);
        if (prev) {
            clearTimeout(prev);
        }
        this.timers.set(uri, setTimeout(() => this.run(model), DEBOUNCE_MS));
    }
    clearMarkers(model) {
        this.monaco.editor.setModelMarkers(model, OWNER, []);
    }
    clearAll() {
        var _a, _b, _c;
        ((_c = (_b = (_a = this.monaco.editor).getModels) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : []).forEach((model) => {
            if (this.isTarget(model)) {
                this.clearMarkers(model);
            }
        });
    }
    recheckAll() {
        var _a, _b, _c;
        ((_c = (_b = (_a = this.monaco.editor).getModels) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : []).forEach((model) => {
            if (this.isTarget(model)) {
                this.run(model);
            }
        });
    }
    async run(model) {
        var _a, _b, _c, _d, _e;
        if ((_a = model.isDisposed) === null || _a === void 0 ? void 0 : _a.call(model)) {
            return;
        }
        if (!editorSettings.isEnabled("spell.check")) {
            this.clearMarkers(model);
            return;
        }
        const versionBefore = (_b = model.getVersionId) === null || _b === void 0 ? void 0 : _b.call(model);
        const tokens = tokenizeLatexProse(model.getValue());
        if (tokens.length === 0) {
            this.clearMarkers(model);
            return;
        }
        const unique = Array.from(new Set(tokens.map((t) => t.word)));
        let misspelled = [];
        try {
            misspelled = await this.bridge.check(unique);
        }
        catch {
            return;
        }
        if ((_c = model.isDisposed) === null || _c === void 0 ? void 0 : _c.call(model)) {
            return;
        }
        // Drop stale results if the document changed during the async check; that
        // edit already rescheduled another run with fresh token positions.
        if (model.getVersionId && model.getVersionId() !== versionBefore) {
            return;
        }
        const bad = new Set(misspelled);
        if (bad.size === 0) {
            this.clearMarkers(model);
            return;
        }
        const severity = (_e = (_d = this.monaco.MarkerSeverity) === null || _d === void 0 ? void 0 : _d.Info) !== null && _e !== void 0 ? _e : 2;
        const markers = tokens
            .filter((t) => bad.has(t.word))
            .map((t) => ({
            severity,
            message: `“${t.word}”: possible spelling mistake`,
            source: OWNER,
            startLineNumber: t.lineNumber,
            startColumn: t.startColumn,
            endLineNumber: t.lineNumber,
            endColumn: t.endColumn,
        }));
        this.monaco.editor.setModelMarkers(model, OWNER, markers);
    }
    // Add the word at the editor's cursor to the user dictionary, then re-check.
    // Invoked from a per-editor action (context menu / command palette) registered
    // in monaco-setup, because this Monaco build lacks editor.registerCommand for
    // wiring an "Add to dictionary" code-action command.
    async addWordAtCursor(editor) {
        var _a, _b, _c, _d;
        const model = (_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
        const position = (_b = editor === null || editor === void 0 ? void 0 : editor.getPosition) === null || _b === void 0 ? void 0 : _b.call(editor);
        if (!model || !position) {
            return;
        }
        const word = (_d = (_c = model.getWordAtPosition) === null || _c === void 0 ? void 0 : _c.call(model, position)) === null || _d === void 0 ? void 0 : _d.word;
        if (!word) {
            return;
        }
        try {
            await this.bridge.add(word);
            this.recheckAll();
        }
        catch {
            // ignore
        }
    }
    registerCodeActions() {
        const monaco = this.monaco;
        // Quick-fix "Replace with <suggestion>" for each spell marker. (Add-to-
        // dictionary is a separate editor action; see addWordAtCursor.)
        this.disposables.push(monaco.languages.registerCodeActionProvider("latex", {
            provideCodeActions: async (model, _range, context) => {
                var _a;
                const markers = ((_a = context === null || context === void 0 ? void 0 : context.markers) !== null && _a !== void 0 ? _a : []).filter((m) => m.source === OWNER);
                if (markers.length === 0) {
                    return { actions: [], dispose: () => { } };
                }
                const actions = [];
                for (const marker of markers) {
                    const wordRange = new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn);
                    const word = model.getValueInRange(wordRange);
                    let suggestions = [];
                    try {
                        suggestions = await this.bridge.suggest(word);
                    }
                    catch {
                        suggestions = [];
                    }
                    suggestions.slice(0, 5).forEach((suggestion) => {
                        const textEdit = { range: wordRange, text: suggestion };
                        actions.push({
                            title: `Replace with “${suggestion}”`,
                            kind: "quickfix",
                            diagnostics: [marker],
                            edit: { edits: [{ resource: model.uri, textEdit, edit: textEdit }] },
                        });
                    });
                }
                return { actions, dispose: () => { } };
            },
        }));
    }
    dispose() {
        this.disposables.forEach((d) => { var _a; return (_a = d.dispose) === null || _a === void 0 ? void 0 : _a.call(d); });
        this.disposables = [];
        Array.from(this.modelSubs.values()).forEach((cleanup) => cleanup());
        this.modelSubs.clear();
        this.timers.forEach((t) => clearTimeout(t));
        this.timers.clear();
    }
}

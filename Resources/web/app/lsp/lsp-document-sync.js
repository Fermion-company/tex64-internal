// Drives LSP textDocument/did{Open,Change,Close} from monaco's model lifecycle.
// Decoupled from editor-session: we only observe models that carry a file:// URI
// (see ensureModelEntry, which now creates models with monaco.Uri.file). Full
// document sync — simplest correct option; texlab supports it.
export class LspDocumentSync {
    constructor(monaco, client) {
        this.versions = new Map();
        this.contentListeners = new Map();
        this.disposables = [];
        this.monaco = monaco;
        this.client = client;
    }
    isFileModel(model) {
        return Boolean(model && model.uri && model.uri.scheme === "file");
    }
    languageId(model) {
        const id = model.getLanguageId ? model.getLanguageId() : "latex";
        return id === "bibtex" ? "bibtex" : "latex";
    }
    start() {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const models = (_d = (_c = (_b = (_a = this.monaco) === null || _a === void 0 ? void 0 : _a.editor) === null || _b === void 0 ? void 0 : _b.getModels) === null || _c === void 0 ? void 0 : _c.call(_b)) !== null && _d !== void 0 ? _d : [];
        models.forEach((model) => this.openModel(model));
        if ((_f = (_e = this.monaco) === null || _e === void 0 ? void 0 : _e.editor) === null || _f === void 0 ? void 0 : _f.onDidCreateModel) {
            this.disposables.push(this.monaco.editor.onDidCreateModel((model) => this.openModel(model)));
        }
        if ((_h = (_g = this.monaco) === null || _g === void 0 ? void 0 : _g.editor) === null || _h === void 0 ? void 0 : _h.onWillDisposeModel) {
            this.disposables.push(this.monaco.editor.onWillDisposeModel((model) => this.closeModel(model)));
        }
    }
    openModel(model) {
        if (!this.isFileModel(model)) {
            return;
        }
        const uri = model.uri.toString();
        // Attach the change listener once, even before the server is ready, so we
        // never miss edits; the notify itself is guarded on readiness.
        if (!this.contentListeners.has(uri) && model.onDidChangeContent) {
            this.contentListeners.set(uri, model.onDidChangeContent(() => this.changeModel(model)));
        }
        if (this.versions.has(uri) || !this.client.isReady()) {
            return;
        }
        const version = 1;
        this.versions.set(uri, version);
        this.client.notify("textDocument/didOpen", {
            textDocument: {
                uri,
                languageId: this.languageId(model),
                version,
                text: model.getValue(),
            },
        });
    }
    changeModel(model) {
        var _a;
        if (!this.isFileModel(model) || !this.client.isReady()) {
            return;
        }
        const uri = model.uri.toString();
        if (!this.versions.has(uri)) {
            // Edited before didOpen was sent (e.g. server became ready late): open it.
            this.openModel(model);
            return;
        }
        const version = ((_a = this.versions.get(uri)) !== null && _a !== void 0 ? _a : 0) + 1;
        this.versions.set(uri, version);
        this.client.notify("textDocument/didChange", {
            textDocument: { uri, version },
            contentChanges: [{ text: model.getValue() }],
        });
    }
    closeModel(model) {
        if (!model || !model.uri) {
            return;
        }
        const uri = model.uri.toString();
        const listener = this.contentListeners.get(uri);
        if (listener) {
            listener.dispose();
            this.contentListeners.delete(uri);
        }
        if (!this.versions.has(uri)) {
            return;
        }
        this.versions.delete(uri);
        if (this.client.isReady()) {
            this.client.notify("textDocument/didClose", { textDocument: { uri } });
        }
    }
    // Open any file models that exist but haven't been opened yet (used right
    // after the server becomes ready).
    openPending() {
        var _a, _b, _c, _d;
        const models = (_d = (_c = (_b = (_a = this.monaco) === null || _a === void 0 ? void 0 : _a.editor) === null || _b === void 0 ? void 0 : _b.getModels) === null || _c === void 0 ? void 0 : _c.call(_b)) !== null && _d !== void 0 ? _d : [];
        models.forEach((model) => this.openModel(model));
    }
    dispose() {
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
        this.contentListeners.forEach((d) => d.dispose());
        this.contentListeners.clear();
        this.versions.clear();
    }
}

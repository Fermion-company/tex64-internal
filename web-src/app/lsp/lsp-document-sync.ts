// Drives LSP textDocument/did{Open,Change,Close} from monaco's model lifecycle.
// Decoupled from editor-session: we only observe models that carry a file:// URI
// (see ensureModelEntry, which now creates models with monaco.Uri.file). Full
// document sync — simplest correct option; texlab supports it.

import type { LspClient } from "./lsp-client.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Monaco = any;

export class LspDocumentSync {
  private monaco: Monaco;
  private client: LspClient;
  private versions = new Map<string, number>();
  private contentListeners = new Map<string, { dispose: () => void }>();
  private disposables: Array<{ dispose: () => void }> = [];

  constructor(monaco: Monaco, client: LspClient) {
    this.monaco = monaco;
    this.client = client;
  }

  private isFileModel(model: any): boolean {
    return Boolean(model && model.uri && model.uri.scheme === "file");
  }

  private languageId(model: any): string {
    const id = model.getLanguageId ? model.getLanguageId() : "latex";
    return id === "bibtex" ? "bibtex" : "latex";
  }

  start(): void {
    const models = this.monaco?.editor?.getModels?.() ?? [];
    models.forEach((model: any) => this.openModel(model));
    if (this.monaco?.editor?.onDidCreateModel) {
      this.disposables.push(
        this.monaco.editor.onDidCreateModel((model: any) => this.openModel(model))
      );
    }
    if (this.monaco?.editor?.onWillDisposeModel) {
      this.disposables.push(
        this.monaco.editor.onWillDisposeModel((model: any) => this.closeModel(model))
      );
    }
  }

  private openModel(model: any): void {
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

  private changeModel(model: any): void {
    if (!this.isFileModel(model) || !this.client.isReady()) {
      return;
    }
    const uri = model.uri.toString();
    if (!this.versions.has(uri)) {
      // Edited before didOpen was sent (e.g. server became ready late): open it.
      this.openModel(model);
      return;
    }
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.client.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: model.getValue() }],
    });
  }

  private closeModel(model: any): void {
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
  openPending(): void {
    const models = this.monaco?.editor?.getModels?.() ?? [];
    models.forEach((model: any) => this.openModel(model));
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.contentListeners.forEach((d) => d.dispose());
    this.contentListeners.clear();
    this.versions.clear();
  }
}

// Renderer spell-check controller. Tokenizes file models (LaTeX-aware),
// debounces, asks the main-process spell service which prose words are
// misspelled, and renders them as markers under the "spell" owner. Provides
// quick-fix code actions (replace with a suggestion, add to dictionary). Gated
// by the `spell.check` feature flag (live-toggle aware).

import { editorSettings } from "../editor-settings/editor-settings-store.js";
import { tokenizeLatexProse } from "./latex-tokenizer.js";
import type { SpellBridge } from "../types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Monaco = any;

const OWNER = "spell";
const DEBOUNCE_MS = 500;

export class SpellChecker {
  private monaco: Monaco;
  private bridge: SpellBridge;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposables: Array<{ dispose: () => void }> = [];
  // Per-model cleanup, removed when the model is disposed so subscriptions don't
  // accumulate over a long session of opening files.
  private modelSubs = new Map<string, () => void>();

  constructor(monaco: Monaco, bridge: SpellBridge) {
    this.monaco = monaco;
    this.bridge = bridge;
  }

  private isTarget(model: any): boolean {
    return Boolean(
      model &&
        model.uri &&
        model.uri.scheme === "file" &&
        (model.getLanguageId ? model.getLanguageId() === "latex" : true)
    );
  }

  start(): void {
    (this.monaco.editor.getModels?.() ?? []).forEach((model: any) => this.attach(model));
    if (this.monaco.editor.onDidCreateModel) {
      this.disposables.push(
        this.monaco.editor.onDidCreateModel((model: any) => this.attach(model))
      );
    }
    this.registerCodeActions();
    // React to the feature flag being toggled at runtime.
    this.disposables.push({
      dispose: editorSettings.subscribe((change) => {
        if (change.kind === "flag" && change.id === "spell.check") {
          if (change.value) {
            this.recheckAll();
          } else {
            this.clearAll();
          }
        }
      }),
    });
  }

  private attach(model: any): void {
    if (!this.isTarget(model)) {
      return;
    }
    const uri = model.uri.toString();
    if (this.modelSubs.has(uri)) {
      return;
    }
    this.schedule(model);
    const subs: Array<{ dispose: () => void }> = [];
    if (model.onDidChangeContent) {
      subs.push(model.onDidChangeContent(() => this.schedule(model)));
    }
    const cleanup = () => {
      const timer = this.timers.get(uri);
      if (timer) {
        clearTimeout(timer);
      }
      this.timers.delete(uri);
      subs.forEach((s) => s.dispose?.());
      this.modelSubs.delete(uri);
    };
    if (model.onWillDispose) {
      subs.push(model.onWillDispose(cleanup));
    }
    this.modelSubs.set(uri, cleanup);
  }

  private schedule(model: any): void {
    const uri = model.uri.toString();
    const prev = this.timers.get(uri);
    if (prev) {
      clearTimeout(prev);
    }
    this.timers.set(
      uri,
      setTimeout(() => this.run(model), DEBOUNCE_MS)
    );
  }

  private clearMarkers(model: any): void {
    this.monaco.editor.setModelMarkers(model, OWNER, []);
  }

  private clearAll(): void {
    (this.monaco.editor.getModels?.() ?? []).forEach((model: any) => {
      if (this.isTarget(model)) {
        this.clearMarkers(model);
      }
    });
  }

  recheckAll(): void {
    (this.monaco.editor.getModels?.() ?? []).forEach((model: any) => {
      if (this.isTarget(model)) {
        this.run(model);
      }
    });
  }

  private async run(model: any): Promise<void> {
    if (model.isDisposed?.()) {
      return;
    }
    if (!editorSettings.isEnabled("spell.check")) {
      this.clearMarkers(model);
      return;
    }
    const versionBefore = model.getVersionId?.();
    const tokens = tokenizeLatexProse(model.getValue());
    if (tokens.length === 0) {
      this.clearMarkers(model);
      return;
    }
    const unique = Array.from(new Set(tokens.map((t) => t.word)));
    let misspelled: string[] = [];
    try {
      misspelled = await this.bridge.check(unique);
    } catch {
      return;
    }
    if (model.isDisposed?.()) {
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
    const severity = this.monaco.MarkerSeverity?.Info ?? 2;
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
  async addWordAtCursor(editor: any): Promise<void> {
    const model = editor?.getModel?.();
    const position = editor?.getPosition?.();
    if (!model || !position) {
      return;
    }
    const word = model.getWordAtPosition?.(position)?.word;
    if (!word) {
      return;
    }
    try {
      await this.bridge.add(word);
      this.recheckAll();
    } catch {
      // ignore
    }
  }

  private registerCodeActions(): void {
    const monaco = this.monaco;
    // Quick-fix "Replace with <suggestion>" for each spell marker. (Add-to-
    // dictionary is a separate editor action; see addWordAtCursor.)
    this.disposables.push(
      monaco.languages.registerCodeActionProvider("latex", {
        provideCodeActions: async (model: any, _range: any, context: any) => {
          const markers = (context?.markers ?? []).filter((m: any) => m.source === OWNER);
          if (markers.length === 0) {
            return { actions: [], dispose: () => {} };
          }
          const actions: any[] = [];
          for (const marker of markers) {
            const wordRange = new monaco.Range(
              marker.startLineNumber,
              marker.startColumn,
              marker.endLineNumber,
              marker.endColumn
            );
            const word = model.getValueInRange(wordRange);
            let suggestions: string[] = [];
            try {
              suggestions = await this.bridge.suggest(word);
            } catch {
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
          return { actions, dispose: () => {} };
        },
      })
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose?.());
    this.disposables = [];
    Array.from(this.modelSubs.values()).forEach((cleanup) => cleanup());
    this.modelSubs.clear();
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
  }
}

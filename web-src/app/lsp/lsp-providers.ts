// Registers monaco language-feature providers backed by texlab over the LSP
// client. Each provider translates monaco's (model, position) call into an LSP
// request and converts the result back. Registration is gated on the server's
// advertised capabilities so we don't register no-op providers.

import type { LspClient } from "./lsp-client.js";
import { editorSettings } from "../editor-settings/editor-settings-store.js";
import type { EditorFeatureId } from "../editor-settings/editor-settings-store.js";
import {
  toLspPosition,
  toMonacoRange,
  toMonacoTextEdit,
  toMonacoCompletionItem,
  toMarkdownString,
  toMonacoLocations,
  toMonacoDocumentSymbols,
  toMonacoWorkspaceEdit,
  toMonacoMarkerSeverity,
  toMonacoFoldingRanges,
  toMonacoDocumentHighlights,
  toMonacoInlayHints,
  toMonacoLinks,
} from "./lsp-conversions.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Monaco = any;
type Disposable = { dispose: () => void };

const DEFAULT_TRIGGER_CHARACTERS = ["\\", "{", "}", "[", "(", ",", "/", "@", " ", "="];

const uriOf = (model: any): string => model.uri.toString();

export const registerLspProviders = (
  monaco: Monaco,
  client: LspClient,
  languages: string[] = ["latex", "bibtex"]
): Disposable[] => {
  const caps = (client.capabilities ?? {}) as Record<string, any>;
  const disposables: Disposable[] = [];
  const register = (fn: (() => Disposable | undefined) | undefined) => {
    const d = fn?.();
    if (d) {
      disposables.push(d);
    }
  };

  const langs = monaco.languages;
  // Flags are evaluated at call time (not at registration) so the settings
  // toggle UI can enable/disable a feature live, without a reload. Providers
  // register based on server capability; each invocation re-checks the flag.
  const gate = (flag: EditorFeatureId): boolean =>
    client.isReady() && editorSettings.isEnabled(flag);

  languages.forEach((languageId) => {
    // Completion
    if (caps.completionProvider) {
      const triggerCharacters =
        caps.completionProvider?.triggerCharacters ?? DEFAULT_TRIGGER_CHARACTERS;
      const canResolve = Boolean(caps.completionProvider?.resolveProvider);
      register(() =>
        langs.registerCompletionItemProvider(languageId, {
          triggerCharacters,
          provideCompletionItems: async (model: any, position: any, _ctx: any, token: any) => {
            if (!gate("lsp.completion")) {
              return { suggestions: [] };
            }
            const result = await client
              .request<any>("textDocument/completion", {
                textDocument: { uri: uriOf(model) },
                position: toLspPosition(position),
              })
              .catch(() => null);
            if (!result || token?.isCancellationRequested) {
              return { suggestions: [] };
            }
            const items = Array.isArray(result) ? result : result.items ?? [];
            const word = model.getWordUntilPosition(position);
            const defaultRange = new monaco.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn
            );
            return {
              suggestions: items.map((item: any) => {
                const monacoItem: any = toMonacoCompletionItem(monaco, item, defaultRange);
                // Stash the original LSP item so resolve can enrich it lazily.
                monacoItem._lsp = item;
                return monacoItem;
              }),
              incomplete: Boolean(result.isIncomplete),
            };
          },
          // Lazily fetch documentation/detail for the focused item.
          resolveCompletionItem: canResolve
            ? async (item: any) => {
                const lsp = item && item._lsp;
                if (!lsp || !client.isReady()) {
                  return item;
                }
                const resolved = await client
                  .request<any>("completionItem/resolve", lsp)
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
        })
      );
    }

    // Hover is intentionally NOT registered from texlab: TeX64's own hover
    // provider (monaco-hover) is richer — it renders math previews, image
    // thumbnails, and .bib/file excerpts that texlab's plain-markdown hover
    // can't. Registering both would stack duplicate popups, so the custom one
    // stays the single hover source.

    // Go to definition
    if (caps.definitionProvider) {
      register(() =>
        langs.registerDefinitionProvider(languageId, {
          provideDefinition: async (model: any, position: any) => {
            if (!gate("lsp.definition")) {
              return null;
            }
            const result = await client
              .request<any>("textDocument/definition", {
                textDocument: { uri: uriOf(model) },
                position: toLspPosition(position),
              })
              .catch(() => null);
            return toMonacoLocations(monaco, result);
          },
        })
      );
    }

    // Find references
    if (caps.referencesProvider) {
      register(() =>
        langs.registerReferenceProvider(languageId, {
          provideReferences: async (model: any, position: any, context: any) => {
            if (!gate("lsp.references")) {
              return null;
            }
            const result = await client
              .request<any>("textDocument/references", {
                textDocument: { uri: uriOf(model) },
                position: toLspPosition(position),
                context: { includeDeclaration: context?.includeDeclaration ?? true },
              })
              .catch(() => null);
            return toMonacoLocations(monaco, result);
          },
        })
      );
    }

    // Document symbols (outline)
    if (caps.documentSymbolProvider) {
      register(() =>
        langs.registerDocumentSymbolProvider(languageId, {
          provideDocumentSymbols: async (model: any) => {
            if (!gate("lsp.documentSymbol")) {
              return [];
            }
            const result = await client
              .request<any>("textDocument/documentSymbol", {
                textDocument: { uri: uriOf(model) },
              })
              .catch(() => null);
            return toMonacoDocumentSymbols(monaco, result);
          },
        })
      );
    }

    // Rename
    if (caps.renameProvider) {
      register(() =>
        langs.registerRenameProvider(languageId, {
          provideRenameEdits: async (model: any, position: any, newName: string) => {
            if (!gate("lsp.rename")) {
              return { edits: [] };
            }
            const result = await client
              .request<any>("textDocument/rename", {
                textDocument: { uri: uriOf(model) },
                position: toLspPosition(position),
                newName,
              })
              .catch(() => null);
            return toMonacoWorkspaceEdit(monaco, result);
          },
        })
      );
    }

    // Document formatting
    if (caps.documentFormattingProvider) {
      register(() =>
        langs.registerDocumentFormattingEditProvider(languageId, {
          provideDocumentFormattingEdits: async (model: any, options: any) => {
            if (!gate("lsp.formatting")) {
              return [];
            }
            const result = await client
              .request<any>("textDocument/formatting", {
                textDocument: { uri: uriOf(model) },
                options: {
                  tabSize: options?.tabSize ?? 2,
                  insertSpaces: options?.insertSpaces ?? true,
                },
              })
              .catch(() => null);
            if (!Array.isArray(result)) {
              return [];
            }
            return result.map((edit: any) => toMonacoTextEdit(monaco, edit));
          },
        })
      );
    }

    // Code folding (sections/environments)
    if (caps.foldingRangeProvider) {
      register(() =>
        langs.registerFoldingRangeProvider(languageId, {
          provideFoldingRanges: async (model: any) => {
            if (!gate("lsp.folding")) {
              return [];
            }
            const result = await client
              .request<any>("textDocument/foldingRange", { textDocument: { uri: uriOf(model) } })
              .catch(() => null);
            return toMonacoFoldingRanges(result);
          },
        })
      );
    }

    // Highlight occurrences of the symbol under the cursor
    if (caps.documentHighlightProvider) {
      register(() =>
        langs.registerDocumentHighlightProvider(languageId, {
          provideDocumentHighlights: async (model: any, position: any) => {
            if (!gate("lsp.documentHighlight")) {
              return [];
            }
            const result = await client
              .request<any>("textDocument/documentHighlight", {
                textDocument: { uri: uriOf(model) },
                position: toLspPosition(position),
              })
              .catch(() => null);
            return toMonacoDocumentHighlights(monaco, result);
          },
        })
      );
    }

    // Inlay hints
    if (caps.inlayHintProvider) {
      register(() =>
        langs.registerInlayHintsProvider(languageId, {
          provideInlayHints: async (model: any, range: any) => {
            if (!gate("lsp.inlayHint")) {
              return { hints: [], dispose: () => {} };
            }
            const result = await client
              .request<any>("textDocument/inlayHint", {
                textDocument: { uri: uriOf(model) },
                range: {
                  start: toLspPosition({ lineNumber: range.startLineNumber, column: range.startColumn }),
                  end: toLspPosition({ lineNumber: range.endLineNumber, column: range.endColumn }),
                },
              })
              .catch(() => null);
            return { hints: toMonacoInlayHints(result), dispose: () => {} };
          },
        })
      );
    }

    // Clickable \input/\include/\href targets
    if (caps.documentLinkProvider) {
      register(() =>
        langs.registerLinkProvider(languageId, {
          provideLinks: async (model: any) => {
            if (!gate("lsp.documentLink")) {
              return { links: [] };
            }
            const result = await client
              .request<any>("textDocument/documentLink", { textDocument: { uri: uriOf(model) } })
              .catch(() => null);
            return { links: toMonacoLinks(monaco, result) };
          },
        })
      );
    }
  });

  return disposables;
};

// Wire texlab's publishDiagnostics into monaco markers under a distinct owner so
// they coexist with the app's build-log diagnostics ("tex64").
export const registerDiagnostics = (
  monaco: Monaco,
  client: LspClient,
  owner = "texlab"
): (() => void) => {
  const offNotify = client.onNotification("textDocument/publishDiagnostics", (raw: any) => {
    const params = raw ?? {};
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
    const markers = diagnostics.map((d: any) => ({
      severity: toMonacoMarkerSeverity(monaco, d.severity),
      message: d.message ?? "",
      startLineNumber: (d.range?.start?.line ?? 0) + 1,
      startColumn: (d.range?.start?.character ?? 0) + 1,
      endLineNumber: (d.range?.end?.line ?? 0) + 1,
      endColumn: (d.range?.end?.character ?? 0) + 1,
      source: d.source ?? "texlab",
      code: d.code && typeof d.code === "object" ? d.code.value : d.code,
    }));
    monaco.editor.setModelMarkers(model, owner, markers);
  });
  // Clear existing texlab markers immediately when diagnostics are toggled off.
  const offFlag = editorSettings.subscribe((change) => {
    if (change.kind === "flag" && change.id === "lsp.diagnostics" && !change.value) {
      (monaco.editor.getModels?.() ?? []).forEach((model: any) =>
        monaco.editor.setModelMarkers(model, owner, [])
      );
    }
  });
  return () => {
    offNotify();
    offFlag();
  };
};

import { getSnippets, reloadSnippets } from "./snippets.js";

// Editor completion for saved snippets. A snippet is offered by its prefix in
// .tex and .bib buffers and inserted as a Monaco snippet, so ${1:...} markers
// become real tab stops. Registered as a plain global provider, matching how
// every other language feature in this app reaches Monaco (see CLAUDE.md).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MonacoApi = any;

export const registerSnippetCompletion = (monaco: MonacoApi) => {
  const languages = monaco?.languages;
  if (!languages?.registerCompletionItemProvider) {
    return () => {};
  }
  const kind = languages.CompletionItemKind?.Snippet ?? 27;
  const insertAsSnippet = languages.CompletionItemInsertTextRule?.InsertAsSnippet ?? 4;

  const provider = {
    provideCompletionItems: (model: MonacoApi, position: MonacoApi) => {
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

  const disposables = ["latex", "bibtex"].map((languageId) =>
    languages.registerCompletionItemProvider(languageId, provider)
  );

  // Warm the in-memory list so the provider can answer synchronously. It stays
  // current because every save/delete in the panel reloads the same store.
  void reloadSnippets();

  return () => {
    disposables.forEach((disposable) => {
      try {
        disposable?.dispose?.();
      } catch {
        /* ignore */
      }
    });
  };
};

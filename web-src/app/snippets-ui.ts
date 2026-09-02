import type { AppContext } from "./context.js";
import { uiText } from "./i18n.js";
import {
  deleteSnippet,
  getSnippets,
  onSnippetsChange,
  reloadSnippets,
  saveSnippet,
  type Snippet,
  type SnippetScope,
} from "./snippets.js";

// The Snippets panel: a searchable list of reusable macros, an editor for them,
// and one-click insertion. Issue #38 asked for somewhere to keep frequently
// used macros; the same store feeds editor completion, so a snippet can be
// pulled in either by clicking it here or by typing its prefix.

type SnippetsUiDeps = {
  insertSnippet: (body: string) => boolean;
  getSelectedText: () => string;
  hasWorkspace: () => boolean;
};

export type SnippetsUiApi = {
  activate: () => void;
  refresh: () => void;
};

export const initSnippetsUi = (context: AppContext, deps: SnippetsUiDeps): SnippetsUiApi => {
  const {
    snippetsFilter,
    snippetsNew,
    snippetsList,
    snippetsEditor,
    snippetName,
    snippetPrefix,
    snippetDescription,
    snippetScope,
    snippetBody,
    snippetCancel,
    snippetDelete,
    snippetsError,
  } = context.dom;

  let editing: Snippet | null = null;
  let editorOpen = false;

  const setError = (message: string) => {
    if (snippetsError instanceof HTMLElement) {
      snippetsError.textContent = message;
      snippetsError.classList.toggle("is-hidden", !message);
    }
  };

  const setEditorOpen = (open: boolean) => {
    editorOpen = open;
    snippetsEditor?.classList.toggle("is-hidden", !open);
    if (!open) {
      editing = null;
      setError("");
    }
  };

  const openEditor = (snippet: Snippet | null, seed?: { body?: string }) => {
    // Built-ins are read-only; editing one starts a private copy instead, which
    // is what people expect from a "customise this" gesture.
    const isBuiltin = snippet?.scope === "builtin";
    editing = snippet && !isBuiltin ? snippet : null;
    if (snippetName instanceof HTMLInputElement) {
      snippetName.value = snippet ? (isBuiltin ? `${snippet.name} (copy)` : snippet.name) : "";
    }
    if (snippetPrefix instanceof HTMLInputElement) {
      snippetPrefix.value = snippet?.prefix ?? "";
    }
    if (snippetDescription instanceof HTMLInputElement) {
      snippetDescription.value = snippet?.description ?? "";
    }
    if (snippetScope instanceof HTMLSelectElement) {
      const preferred = snippet && !isBuiltin ? snippet.scope : "global";
      snippetScope.value = preferred === "workspace" && deps.hasWorkspace() ? "workspace" : preferred;
      const workspaceOption = snippetScope.querySelector<HTMLOptionElement>('option[value="workspace"]');
      if (workspaceOption) {
        workspaceOption.disabled = !deps.hasWorkspace();
      }
    }
    if (snippetBody instanceof HTMLTextAreaElement) {
      snippetBody.value = seed?.body ?? snippet?.body ?? "";
    }
    if (snippetDelete instanceof HTMLElement) {
      snippetDelete.classList.toggle("is-hidden", !editing);
    }
    setError("");
    setEditorOpen(true);
    if (snippetPrefix instanceof HTMLInputElement && !snippetPrefix.value) {
      snippetPrefix.focus();
    } else if (snippetBody instanceof HTMLTextAreaElement) {
      snippetBody.focus();
    }
  };

  const render = () => {
    if (!(snippetsList instanceof HTMLElement)) {
      return;
    }
    const query =
      snippetsFilter instanceof HTMLInputElement ? snippetsFilter.value.trim().toLowerCase() : "";
    const items = getSnippets().filter((snippet) => {
      if (!query) {
        return true;
      }
      return (
        snippet.name.toLowerCase().includes(query) ||
        snippet.prefix.toLowerCase().includes(query) ||
        snippet.description.toLowerCase().includes(query)
      );
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

  const submit = async (event: Event) => {
    event.preventDefault();
    const prefix = snippetPrefix instanceof HTMLInputElement ? snippetPrefix.value.trim() : "";
    const body = snippetBody instanceof HTMLTextAreaElement ? snippetBody.value : "";
    if (!prefix || !body.trim()) {
      setError(uiText("A prefix and a body are required.", "プレフィックスと本文が必要です。"));
      return;
    }
    const scope: SnippetScope =
      snippetScope instanceof HTMLSelectElement && snippetScope.value === "workspace"
        ? "workspace"
        : "global";
    const result = await saveSnippet({
      id: editing?.id,
      name: snippetName instanceof HTMLInputElement ? snippetName.value.trim() : prefix,
      prefix,
      description:
        snippetDescription instanceof HTMLInputElement ? snippetDescription.value.trim() : "",
      body,
      scope,
    });
    if (result?.ok === false) {
      setError(String(result.error ?? "Save failed."));
      return;
    }
    setEditorOpen(false);
    render();
  };

  const removeCurrent = async () => {
    if (!editing) {
      return;
    }
    const confirmed = window.confirm(
      uiText(`Delete snippet "${editing.name}"?`, `スニペット「${editing.name}」を削除しますか？`)
    );
    if (!confirmed) {
      return;
    }
    const result = await deleteSnippet(editing.id, editing.scope);
    if (result?.ok === false) {
      setError(String(result.error ?? "Delete failed."));
      return;
    }
    setEditorOpen(false);
    render();
  };

  snippetsFilter?.addEventListener("input", render);
  // "+" with text selected in the editor starts the snippet from that text —
  // turning something you just wrote into a reusable macro is the common case.
  snippetsNew?.addEventListener("click", () => {
    const selection = deps.getSelectedText();
    openEditor(null, selection ? { body: selection } : undefined);
  });
  snippetCancel?.addEventListener("click", () => setEditorOpen(false));
  snippetDelete?.addEventListener("click", () => void removeCurrent());
  snippetsEditor?.addEventListener("submit", (event) => void submit(event));
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

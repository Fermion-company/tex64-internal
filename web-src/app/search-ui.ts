import type { AppContext } from "./context.js";
import type { SearchResult } from "./types.js";

type SearchUpdatePayload = {
  query: string;
  results?: SearchResult[];
  message?: string;
};

type SearchRenameResultPayload = {
  ok: boolean;
  from?: string;
  to?: string;
  fileCount?: number;
  appliedCount?: number;
  skippedCount?: number;
  error?: string;
};

type SearchUiDeps = {
  getWorkspaceRootKey: () => string | null;
  postToNative: (message: { type: string; [key: string]: unknown }) => void;
  openSearchResult: (result: SearchResult) => void;
  openAiPanel?: () => void;
  buildRenameContext?: () => {
    activeFilePath?: string;
    activeFileContent?: string;
    activeFileIsDirty?: boolean;
    activeFileContentTruncated?: boolean;
    activeFileContentLength?: number;
    openFiles?: Array<{ path: string; isDirty: boolean; isActive: boolean }>;
    openFileSnapshots?: Array<{
      path: string;
      content: string;
      isDirty: boolean;
      truncated: boolean;
      contentLength: number;
    }>;
  };
};

export type SearchUiApi = {
  requestSearch: (query: string) => void;
  handleSearchUpdate: (payload: SearchUpdatePayload) => void;
  handleRenameResult: (payload: SearchRenameResultPayload) => void;
  reset: (message?: string) => void;
  render: () => void;
};

export const initSearchUi = (context: AppContext, deps: SearchUiDeps): SearchUiApi => {
  const {
    searchInput,
    searchButton,
    searchResults,
    searchRenameFrom,
    searchRenameTo,
    searchRenameLabel,
    searchRenameCite,
    searchRenameRun,
    searchRenameOpenAi,
    searchRenameStatus,
  } = context.dom;

  let searchResultsData: SearchResult[] = [];
  let searchMessage = "検索結果はここに表示します。";
  let lastSearchQuery = "";
  let renameBusy = false;
  const defaultRenameMessage = "ラベル名や引用キーを入力してください。";
  let renameStatusMessage = defaultRenameMessage;
  let renameStatusState: "idle" | "busy" | "ok" | "error" = "idle";

  const renderSearchResults = () => {
    if (!(searchResults instanceof HTMLElement)) {
      return;
    }
    searchResults.innerHTML = "";
    if (searchResultsData.length === 0) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = searchMessage;
      searchResults.appendChild(empty);
      return;
    }
    const groups = new Map<string, typeof searchResultsData>();
    searchResultsData.forEach((result) => {
      if (!groups.has(result.path)) {
        groups.set(result.path, []);
      }
      groups.get(result.path)?.push(result);
    });

    const sortedPaths = Array.from(groups.keys()).sort();

    sortedPaths.forEach((path) => {
      const groupList = groups.get(path);
      if (!groupList) return;

      const groupDiv = document.createElement("div");
      groupDiv.className = "search-file-group";

      const header = document.createElement("div");
      header.className = "search-file-header";

      const icon = document.createElement("span");
      icon.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';
      icon.style.display = "flex";
      icon.style.opacity = "0.7";

      const name = document.createElement("span");
      name.textContent = path;
      name.style.marginLeft = "6px";

      header.appendChild(icon);
      header.appendChild(name);
      groupDiv.appendChild(header);

      groupList.forEach((result) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "search-match-item";

        const line = document.createElement("div");
        line.className = "search-match-line";
        line.textContent = `行 ${result.line}`;

        const preview = document.createElement("div");
        preview.className = "search-match-preview";
        preview.textContent = result.preview;

        item.appendChild(line);
        item.appendChild(preview);
        item.addEventListener("click", () => {
          deps.openSearchResult(result);
        });
        groupDiv.appendChild(item);
      });

      searchResults.appendChild(groupDiv);
    });
  };

  const setRenameStatus = (
    message: string,
    state: "idle" | "busy" | "ok" | "error" = "idle"
  ) => {
    renameStatusMessage = message;
    renameStatusState = state;
    if (!(searchRenameStatus instanceof HTMLElement)) {
      return;
    }
    searchRenameStatus.textContent = renameStatusMessage;
    searchRenameStatus.classList.remove("is-busy", "is-ok", "is-error");
    if (renameStatusState === "busy") {
      searchRenameStatus.classList.add("is-busy");
    } else if (renameStatusState === "ok") {
      searchRenameStatus.classList.add("is-ok");
    } else if (renameStatusState === "error") {
      searchRenameStatus.classList.add("is-error");
    }
  };

  const setRenameBusy = (busy: boolean) => {
    renameBusy = busy;
    if (searchRenameRun instanceof HTMLButtonElement) {
      searchRenameRun.disabled = busy;
    }
  };

  const handleSearchUpdate = (payload: SearchUpdatePayload) => {
    lastSearchQuery = payload.query;
    searchResultsData = Array.isArray(payload.results) ? payload.results : [];
    if (payload.message) {
      searchMessage = payload.message;
    } else if (searchResultsData.length === 0) {
      searchMessage =
        lastSearchQuery.trim().length === 0
          ? "検索語を入力してください。"
          : "一致する結果がありません。";
    }
    renderSearchResults();
  };

  const buildRenameKinds = () => {
    const kinds = [];
    const labelEnabled =
      searchRenameLabel instanceof HTMLInputElement && searchRenameLabel.checked;
    const citeEnabled =
      searchRenameCite instanceof HTMLInputElement && searchRenameCite.checked;
    if (labelEnabled) {
      kinds.push("label", "ref");
    }
    if (citeEnabled) {
      kinds.push("cite");
    }
    return { kinds, labelEnabled, citeEnabled };
  };

  const validateRenameInputs = () => {
    if (!deps.getWorkspaceRootKey()) {
      return { ok: false, message: "ワークスペースが未選択です。" };
    }
    const from =
      searchRenameFrom instanceof HTMLInputElement ? searchRenameFrom.value.trim() : "";
    const to =
      searchRenameTo instanceof HTMLInputElement ? searchRenameTo.value.trim() : "";
    if (!from || !to) {
      return { ok: false, message: "現在のキーと新しいキーを入力してください。" };
    }
    if (from === to) {
      return { ok: false, message: "新しいキーが同じです。" };
    }
    const invalidPattern = /[\s,{}]/;
    if (invalidPattern.test(from) || invalidPattern.test(to)) {
      return { ok: false, message: "キーに空白・カンマ・{} は使えません。" };
    }
    const { kinds, labelEnabled, citeEnabled } = buildRenameKinds();
    if (!labelEnabled && !citeEnabled) {
      return { ok: false, message: "対象（ラベル/参照・引用）を選んでください。" };
    }
    return { ok: true, from, to, kinds };
  };

  const requestRename = () => {
    if (renameBusy) {
      return;
    }
    const validation = validateRenameInputs();
    if (!validation.ok) {
      setRenameStatus(validation.message ?? "入力を確認してください。", "error");
      return;
    }
    const { from, to, kinds } = validation as {
      ok: true;
      from: string;
      to: string;
      kinds: string[];
    };
    setRenameBusy(true);
    setRenameStatus("提案を作成中です...（未保存がある場合は保存してください）", "busy");
    const context = deps.buildRenameContext ? deps.buildRenameContext() : undefined;
    deps.postToNative({
      type: "search:renameSymbol",
      from,
      to,
      kinds,
      context,
      conversationId: "search-rename",
    });
  };

  const handleRenameResult = (payload: SearchRenameResultPayload) => {
    setRenameBusy(false);
    if (!payload.ok) {
      setRenameStatus(payload.error ?? "リネームに失敗しました。", "error");
      return;
    }
    const fileCount = payload.fileCount ?? 0;
    const appliedCount = payload.appliedCount ?? 0;
    const skippedCount = payload.skippedCount ?? 0;
    let message = `${fileCount}ファイルに提案を作成しました（${appliedCount}箇所）`;
    if (skippedCount > 0) {
      message += `。除外: ${skippedCount}件`;
    }
    message += "。AIパネルで確認できます。";
    setRenameStatus(message, "ok");
  };

  const requestSearch = (query: string) => {
    lastSearchQuery = query;
    if (!deps.getWorkspaceRootKey()) {
      searchResultsData = [];
      searchMessage = "ワークスペースが未選択です。";
      renderSearchResults();
      return;
    }
    if (query.trim().length === 0) {
      searchResultsData = [];
      searchMessage = "検索語を入力してください。";
      renderSearchResults();
      return;
    }
    searchResultsData = [];
    searchMessage = "検索中...";
    renderSearchResults();
    deps.postToNative({ type: "search", query });
  };

  const reset = (message?: string) => {
    searchResultsData = [];
    searchMessage = message ?? "検索結果はここに表示します。";
    renderSearchResults();
  };

  if (searchButton instanceof HTMLButtonElement) {
    searchButton.addEventListener("click", () => {
      const value = searchInput instanceof HTMLInputElement ? searchInput.value.trim() : "";
      requestSearch(value);
    });
  }

  if (searchInput instanceof HTMLInputElement) {
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        requestSearch(searchInput.value.trim());
      }
    });
  }

  if (searchRenameRun instanceof HTMLButtonElement) {
    searchRenameRun.addEventListener("click", () => {
      requestRename();
    });
  }

  if (searchRenameFrom instanceof HTMLInputElement) {
    searchRenameFrom.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        requestRename();
      }
    });
  }

  if (searchRenameTo instanceof HTMLInputElement) {
    searchRenameTo.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        requestRename();
      }
    });
  }

  if (searchRenameOpenAi instanceof HTMLButtonElement) {
    searchRenameOpenAi.addEventListener("click", () => {
      deps.openAiPanel?.();
    });
  }

  const renameInputs = [searchRenameFrom, searchRenameTo];
  renameInputs.forEach((input) => {
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    input.addEventListener("input", () => {
      if (renameStatusState === "error") {
        setRenameStatus(defaultRenameMessage, "idle");
      }
    });
  });

  const renameOptions = [searchRenameLabel, searchRenameCite];
  renameOptions.forEach((option) => {
    if (!(option instanceof HTMLInputElement)) {
      return;
    }
    option.addEventListener("change", () => {
      if (renameStatusState === "error") {
        setRenameStatus(defaultRenameMessage, "idle");
      }
    });
  });

  setRenameStatus(renameStatusMessage, "idle");

  return {
    requestSearch,
    handleSearchUpdate,
    handleRenameResult,
    reset,
    render: renderSearchResults,
  };
};

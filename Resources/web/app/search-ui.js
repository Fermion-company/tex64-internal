import { uiText } from "./i18n.js";
export const initSearchUi = (context, deps) => {
    const { searchInput, searchButton, searchResults, searchRenameFrom, searchRenameTo, searchRenameLabel, searchRenameCite, searchRenameRun, searchRenameOpenAi, searchRenameStatus, } = context.dom;
    let searchResultsData = [];
    const defaultSearchMessage = "";
    let searchMessage = defaultSearchMessage;
    let lastSearchQuery = "";
    let currentSearchRequestId = 0;
    let renameBusy = false;
    const defaultRenameMessage = "";
    let renameStatusMessage = defaultRenameMessage;
    let renameStatusState = "idle";
    const renderPreviewWithHighlight = (target, result, query) => {
        var _a;
        const text = (_a = result.preview) !== null && _a !== void 0 ? _a : "";
        if (!text) {
            target.textContent = "";
            return;
        }
        let start = typeof result.matchStart === "number" && Number.isFinite(result.matchStart)
            ? Math.max(0, Math.floor(result.matchStart))
            : -1;
        const fallbackQuery = query.trim().toLowerCase();
        if (start < 0 && fallbackQuery) {
            start = text.toLowerCase().indexOf(fallbackQuery);
        }
        let length = typeof result.matchLength === "number" && Number.isFinite(result.matchLength)
            ? Math.max(0, Math.floor(result.matchLength))
            : fallbackQuery.length;
        if (start < 0 || length <= 0 || start >= text.length) {
            target.textContent = text;
            return;
        }
        const end = Math.min(text.length, start + length);
        target.textContent = "";
        if (start > 0) {
            target.appendChild(document.createTextNode(text.slice(0, start)));
        }
        const highlight = document.createElement("mark");
        highlight.className = "search-match-highlight";
        highlight.textContent = text.slice(start, end);
        target.appendChild(highlight);
        if (end < text.length) {
            target.appendChild(document.createTextNode(text.slice(end)));
        }
    };
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
        const groups = new Map();
        searchResultsData.forEach((result) => {
            var _a;
            if (!groups.has(result.path)) {
                groups.set(result.path, []);
            }
            (_a = groups.get(result.path)) === null || _a === void 0 ? void 0 : _a.push(result);
        });
        const sortedPaths = Array.from(groups.keys()).sort();
        sortedPaths.forEach((path) => {
            const groupList = groups.get(path);
            if (!groupList)
                return;
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
            name.style.flex = "1 1 auto";
            const count = document.createElement("span");
            count.className = "search-file-count";
            count.textContent = uiText(`${groupList.length} items`, `${groupList.length}件`);
            header.appendChild(icon);
            header.appendChild(name);
            header.appendChild(count);
            groupDiv.appendChild(header);
            groupList.forEach((result) => {
                const item = document.createElement("button");
                item.type = "button";
                item.className = "search-match-item";
                const line = document.createElement("div");
                line.className = "search-match-line";
                line.textContent = uiText(`Line ${result.line}`, `行 ${result.line}`);
                const preview = document.createElement("div");
                preview.className = "search-match-preview";
                renderPreviewWithHighlight(preview, result, lastSearchQuery);
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
    const setRenameStatus = (message, state = "idle") => {
        renameStatusMessage = message;
        renameStatusState = state;
        if (!(searchRenameStatus instanceof HTMLElement)) {
            return;
        }
        searchRenameStatus.textContent = renameStatusMessage;
        searchRenameStatus.classList.remove("is-busy", "is-ok", "is-error");
        if (renameStatusState === "busy") {
            searchRenameStatus.classList.add("is-busy");
        }
        else if (renameStatusState === "ok") {
            searchRenameStatus.classList.add("is-ok");
        }
        else if (renameStatusState === "error") {
            searchRenameStatus.classList.add("is-error");
        }
    };
    const setRenameBusy = (busy) => {
        renameBusy = busy;
        if (searchRenameRun instanceof HTMLButtonElement) {
            searchRenameRun.disabled = busy;
        }
    };
    const handleSearchUpdate = (payload) => {
        const incomingRequestId = typeof payload.requestId === "number" && Number.isFinite(payload.requestId)
            ? Math.floor(payload.requestId)
            : null;
        if (incomingRequestId !== null && incomingRequestId !== currentSearchRequestId) {
            return;
        }
        const incomingQuery = typeof payload.query === "string" ? payload.query.trim() : "";
        if (incomingRequestId === null && incomingQuery !== lastSearchQuery) {
            return;
        }
        lastSearchQuery = incomingQuery;
        searchResultsData = Array.isArray(payload.results) ? payload.results : [];
        if (payload.message) {
            searchMessage = payload.message;
        }
        else if (searchResultsData.length === 0) {
            searchMessage =
                lastSearchQuery.trim().length === 0
                    ? ""
                    : uiText("No matching results found.", "一致する結果がありません。");
        }
        renderSearchResults();
    };
    const buildRenameKinds = () => {
        const kinds = [];
        const labelEnabled = searchRenameLabel instanceof HTMLInputElement && searchRenameLabel.checked;
        const citeEnabled = searchRenameCite instanceof HTMLInputElement && searchRenameCite.checked;
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
            return { ok: false, message: uiText("No workspace is selected.", "ワークスペースが未選択です。") };
        }
        const from = searchRenameFrom instanceof HTMLInputElement ? searchRenameFrom.value.trim() : "";
        const to = searchRenameTo instanceof HTMLInputElement ? searchRenameTo.value.trim() : "";
        if (!from || !to) {
            return { ok: false, message: uiText("Enter the current key and the new key.", "Please enter your current key and new key.") };
        }
        if (from === to) {
            return { ok: false, message: uiText("The new key is the same.", "新しいキーが同じです。") };
        }
        const invalidPattern = /[\s,{}]/;
        if (invalidPattern.test(from) || invalidPattern.test(to)) {
            return { ok: false, message: uiText("Keys cannot contain spaces, commas, or {}.", "Spaces, commas, and {} cannot be used in keys.") };
        }
        const { kinds, labelEnabled, citeEnabled } = buildRenameKinds();
        if (!labelEnabled && !citeEnabled) {
            return { ok: false, message: uiText("Select a target (labels/references/citations).", "Please select the target (label/reference/citation).") };
        }
        return { ok: true, from, to, kinds };
    };
    const requestRename = () => {
        var _a;
        if (renameBusy) {
            return;
        }
        const validation = validateRenameInputs();
        if (!validation.ok) {
            setRenameStatus((_a = validation.message) !== null && _a !== void 0 ? _a : uiText("Please check your input.", "入力を確認してください。"), "error");
            return;
        }
        const { from, to, kinds } = validation;
        setRenameBusy(true);
        setRenameStatus(uiText("Creating a proposal...", "提案を作成中..."), "busy");
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
    const handleRenameResult = (payload) => {
        var _a, _b, _c, _d;
        setRenameBusy(false);
        if (!payload.ok) {
            setRenameStatus((_a = payload.error) !== null && _a !== void 0 ? _a : uiText("Rename failed.", "リネームに失敗しました。"), "error");
            return;
        }
        const fileCount = (_b = payload.fileCount) !== null && _b !== void 0 ? _b : 0;
        const appliedCount = (_c = payload.appliedCount) !== null && _c !== void 0 ? _c : 0;
        const skippedCount = (_d = payload.skippedCount) !== null && _d !== void 0 ? _d : 0;
        let message = uiText(`Created suggestions for ${fileCount} files (${appliedCount} locations)`, `Created suggestion in ${fileCount} file (${appliedCount} place)`);
        if (skippedCount > 0) {
            message += uiText(`. Excluded: ${skippedCount}`, `。除外: ${skippedCount}件`);
        }
        message += uiText(". Check the AI panel.", ". You can check it on the AI ​​panel.");
        setRenameStatus(message, "ok");
    };
    const requestSearch = (query) => {
        const normalizedQuery = query.trim();
        lastSearchQuery = normalizedQuery;
        currentSearchRequestId += 1;
        const requestId = currentSearchRequestId;
        if (!deps.getWorkspaceRootKey()) {
            searchResultsData = [];
            searchMessage = uiText("No workspace is selected.", "ワークスペースが未選択です。");
            renderSearchResults();
            return;
        }
        if (normalizedQuery.length === 0) {
            searchResultsData = [];
            searchMessage = "";
            renderSearchResults();
            return;
        }
        searchResultsData = [];
        searchMessage = uiText("Searching...", "検索中...");
        renderSearchResults();
        deps.postToNative({
            type: "search",
            query: normalizedQuery,
            requestId,
        });
    };
    const reset = (message) => {
        currentSearchRequestId += 1;
        searchResultsData = [];
        searchMessage = message !== null && message !== void 0 ? message : defaultSearchMessage;
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
            var _a;
            (_a = deps.openAiPanel) === null || _a === void 0 ? void 0 : _a.call(deps);
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

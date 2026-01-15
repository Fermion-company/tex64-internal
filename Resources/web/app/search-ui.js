export const initSearchUi = (context, deps) => {
    const { searchInput, searchButton, searchResults, searchRenameFrom, searchRenameTo, searchRenameLabel, searchRenameCite, searchRenameRun, searchRenameOpenAi, searchRenameStatus, } = context.dom;
    let searchResultsData = [];
    let searchMessage = "検索結果はここに表示します。";
    let lastSearchQuery = "";
    let renameBusy = false;
    const defaultRenameMessage = "ラベル名や引用キーを入力してください。";
    let renameStatusMessage = defaultRenameMessage;
    let renameStatusState = "idle";
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
        lastSearchQuery = payload.query;
        searchResultsData = Array.isArray(payload.results) ? payload.results : [];
        if (payload.message) {
            searchMessage = payload.message;
        }
        else if (searchResultsData.length === 0) {
            searchMessage =
                lastSearchQuery.trim().length === 0
                    ? "検索語を入力してください。"
                    : "一致する結果がありません。";
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
            return { ok: false, message: "ワークスペースが未選択です。" };
        }
        const from = searchRenameFrom instanceof HTMLInputElement ? searchRenameFrom.value.trim() : "";
        const to = searchRenameTo instanceof HTMLInputElement ? searchRenameTo.value.trim() : "";
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
        var _a;
        if (renameBusy) {
            return;
        }
        const validation = validateRenameInputs();
        if (!validation.ok) {
            setRenameStatus((_a = validation.message) !== null && _a !== void 0 ? _a : "入力を確認してください。", "error");
            return;
        }
        const { from, to, kinds } = validation;
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
    const handleRenameResult = (payload) => {
        var _a, _b, _c, _d;
        setRenameBusy(false);
        if (!payload.ok) {
            setRenameStatus((_a = payload.error) !== null && _a !== void 0 ? _a : "リネームに失敗しました。", "error");
            return;
        }
        const fileCount = (_b = payload.fileCount) !== null && _b !== void 0 ? _b : 0;
        const appliedCount = (_c = payload.appliedCount) !== null && _c !== void 0 ? _c : 0;
        const skippedCount = (_d = payload.skippedCount) !== null && _d !== void 0 ? _d : 0;
        let message = `${fileCount}ファイルに提案を作成しました（${appliedCount}箇所）`;
        if (skippedCount > 0) {
            message += `。除外: ${skippedCount}件`;
        }
        message += "。AIパネルで確認できます。";
        setRenameStatus(message, "ok");
    };
    const requestSearch = (query) => {
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
    const reset = (message) => {
        searchResultsData = [];
        searchMessage = message !== null && message !== void 0 ? message : "検索結果はここに表示します。";
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

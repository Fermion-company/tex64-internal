export const initSearchUi = (context, deps) => {
    const { searchInput, searchButton, searchResults } = context.dom;
    let searchResultsData = [];
    let searchMessage = "検索結果はここに表示します。";
    let lastSearchQuery = "";
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
    return {
        requestSearch,
        handleSearchUpdate,
        reset,
        render: renderSearchResults,
    };
};

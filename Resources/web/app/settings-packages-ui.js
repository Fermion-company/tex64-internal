import { uiText } from "./i18n.js";
export const formatBytes = (bytes) => {
    const value = Number.isFinite(bytes) ? bytes : 0;
    if (value <= 0) {
        return "";
    }
    if (value < 1024) {
        return `${value} B`;
    }
    if (value < 1024 * 1024) {
        return `${Math.round(value / 1024)} KB`;
    }
    if (value < 1024 * 1024 * 1024) {
        const mb = value / (1024 * 1024);
        return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    }
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};
// Relevance, not alphabetical: someone typing "tikz" wants tikz first, not
// tikz-3dplot. Returns null when the entry does not match at all.
export const scorePackage = (entry, query) => {
    const q = query.trim().toLowerCase();
    if (!q) {
        return 0;
    }
    const name = entry.name.toLowerCase();
    if (name === q) {
        return 1000;
    }
    if (name.startsWith(q)) {
        // Shorter names are the better prefix match: "tikz" should beat "tikz-cd".
        return 800 - Math.min(199, name.length - q.length);
    }
    if (name.includes(q)) {
        return 600 - Math.min(199, name.length - q.length);
    }
    if (entry.shortdesc.toLowerCase().includes(q)) {
        return 300;
    }
    return null;
};
export const rankPackages = (packages, query, filter, limit = 120) => {
    const scored = [];
    for (const entry of packages) {
        if (filter === "installed" && !entry.installed) {
            continue;
        }
        if (filter === "available" && entry.installed) {
            continue;
        }
        const score = scorePackage(entry, query);
        if (score === null) {
            continue;
        }
        scored.push({ entry, score });
    }
    scored.sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }
        // With no query this is the plain list, and what you own comes first.
        if (!query.trim() && a.entry.installed !== b.entry.installed) {
            return a.entry.installed ? -1 : 1;
        }
        return a.entry.name.localeCompare(b.entry.name);
    });
    return { rows: scored.slice(0, limit).map((item) => item.entry), total: scored.length };
};
export const countPackages = (packages) => {
    let installed = 0;
    for (const entry of packages) {
        if (entry.installed) {
            installed += 1;
        }
    }
    return { all: packages.length, installed, available: packages.length - installed };
};
export const describeScope = (catalog) => {
    if (!catalog || catalog.scope === "none") {
        return uiText("No TeX Live found.", "TeX Live が見つかりません。");
    }
    if (catalog.scope === "managed") {
        return uiText("TeX64's own TeX Live — no password needed.", "TeX64 専用の TeX Live — パスワードは不要です。");
    }
    return uiText("System TeX Live — changes ask for your administrator password.", "システムの TeX Live — 変更には管理者パスワードが必要です。");
};
const DOC_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 15.5z"/>' +
    '<path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h4.5a1.5 1.5 0 0 0 1.5-1.5z"/>' +
    "</svg>";
const TRASH_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 7h16"/><path d="M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1z"/>' +
    '<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>' +
    '<path d="M10 11v6M14 11v6"/>' +
    "</svg>";
export const initSettingsPackagesUi = (deps) => {
    const scopeEl = document.getElementById("pkg-scope");
    const updateBtn = document.getElementById("pkg-update");
    const searchEl = document.getElementById("pkg-search");
    const filtersEl = document.getElementById("pkg-filters");
    const listEl = document.getElementById("pkg-list");
    const truncatedEl = document.getElementById("pkg-truncated");
    const extraEl = document.getElementById("pkg-extra");
    const noteEl = document.getElementById("pkg-note");
    const opEl = document.getElementById("pkg-op");
    const opFill = document.getElementById("pkg-op-fill");
    const opLabel = document.getElementById("pkg-op-label");
    const ctanBtn = document.getElementById("pkg-ctan");
    let catalog = null;
    let filter = "all";
    let query = "";
    let loaded = false;
    let busy = false;
    let fileMatches = [];
    let fileMatchTerm = "";
    let ctanMatches = [];
    let ctanTerm = "";
    let fileSearchTimer = null;
    const expanded = new Set();
    const detailFiles = new Map();
    const setNote = (message, tone = "neutral") => {
        if (!(noteEl instanceof HTMLElement)) {
            return;
        }
        const text = message.trim();
        noteEl.textContent = text;
        noteEl.classList.toggle("is-hidden", !text);
        noteEl.classList.toggle("is-error", tone === "error");
        noteEl.setAttribute("aria-hidden", text ? "false" : "true");
    };
    const setBusy = (value, label = "") => {
        busy = value;
        if (opEl instanceof HTMLElement) {
            opEl.classList.toggle("is-hidden", !value);
            opEl.setAttribute("aria-hidden", value ? "false" : "true");
        }
        if (opLabel instanceof HTMLElement && label) {
            opLabel.textContent = label;
        }
        if (opFill instanceof HTMLElement && !value) {
            opFill.style.width = "0%";
        }
        if (updateBtn instanceof HTMLButtonElement) {
            updateBtn.disabled = value;
        }
        render();
    };
    const requestCatalog = (force = false) => {
        deps.postToNative({ type: "packages:catalog", force }, true);
    };
    const stateLabel = (entry) => entry.installed
        ? uiText("Installed", "導入済み")
        : uiText("Not installed", "未導入");
    const buildRow = (entry) => {
        const row = document.createElement("div");
        row.className = `pkg-row${entry.installed ? " is-installed" : ""}`;
        row.dataset.name = entry.name;
        const dot = document.createElement("span");
        dot.className = "pkg-dot";
        dot.setAttribute("aria-hidden", "true");
        row.appendChild(dot);
        const main = document.createElement("div");
        main.className = "pkg-main";
        const nameRow = document.createElement("div");
        nameRow.className = "pkg-name-row";
        const name = document.createElement("span");
        name.className = "pkg-name";
        name.textContent = entry.name;
        nameRow.appendChild(name);
        if (entry.kind !== "package") {
            const kind = document.createElement("span");
            kind.className = "pkg-kind";
            kind.textContent =
                entry.kind === "collection"
                    ? uiText("collection", "コレクション")
                    : uiText("scheme", "スキーム");
            nameRow.appendChild(kind);
        }
        const state = document.createElement("span");
        state.className = "pkg-state";
        state.textContent = stateLabel(entry);
        nameRow.appendChild(state);
        main.appendChild(nameRow);
        if (entry.shortdesc) {
            const desc = document.createElement("div");
            desc.className = "pkg-desc";
            desc.textContent = entry.shortdesc;
            main.appendChild(desc);
        }
        if (expanded.has(entry.name)) {
            const files = document.createElement("div");
            files.className = "pkg-files";
            const known = detailFiles.get(entry.name);
            files.textContent = known
                ? known.join("\n")
                : uiText("Loading files…", "ファイルを読み込み中…");
            main.appendChild(files);
        }
        row.appendChild(main);
        const size = document.createElement("span");
        size.className = "pkg-size";
        size.textContent = formatBytes(entry.sizeBytes);
        row.appendChild(size);
        const actions = document.createElement("div");
        actions.className = "pkg-actions";
        // The documentation is already on disk for anything installed; texdoc knows
        // where. Nothing to read for a package that is not here yet.
        if (entry.installed) {
            const doc = document.createElement("button");
            doc.type = "button";
            doc.className = "pkg-icon-action is-doc";
            doc.innerHTML = DOC_ICON;
            const docLabel = uiText("Open documentation", "ドキュメントを開く");
            doc.title = docLabel;
            doc.setAttribute("aria-label", docLabel);
            doc.addEventListener("click", (event) => {
                event.stopPropagation();
                setNote(uiText("Opening documentation…", "ドキュメントを開いています…"));
                deps.postToNative({ type: "packages:texdoc", name: entry.name }, true);
            });
            actions.appendChild(doc);
        }
        const action = document.createElement("button");
        action.type = "button";
        action.disabled = busy;
        if (entry.installed) {
            action.className = "pkg-icon-action is-remove";
            action.innerHTML = TRASH_ICON;
            const label = uiText("Remove", "削除");
            action.title = label;
            action.setAttribute("aria-label", label);
        }
        else {
            action.className = "pkg-action is-install";
            action.textContent = uiText("Install", "導入");
        }
        action.addEventListener("click", (event) => {
            event.stopPropagation();
            if (busy) {
                return;
            }
            setNote("");
            if (entry.installed) {
                deps.postToNative({ type: "packages:remove", names: [entry.name] }, true);
            }
            else {
                deps.postToNative({ type: "packages:install", names: [entry.name] }, true);
            }
        });
        actions.appendChild(action);
        row.appendChild(actions);
        // Opening a row answers "what is actually in this package?" — the file list
        // is the honest answer, and it is what the file search matches against.
        row.addEventListener("click", () => {
            if (expanded.has(entry.name)) {
                expanded.delete(entry.name);
            }
            else {
                expanded.add(entry.name);
                if (!detailFiles.has(entry.name)) {
                    deps.postToNative({ type: "packages:detail", name: entry.name }, true);
                }
            }
            render();
        });
        return row;
    };
    const render = () => {
        var _a, _b, _c, _d;
        if (!(listEl instanceof HTMLElement)) {
            return;
        }
        if (scopeEl instanceof HTMLElement) {
            scopeEl.textContent = describeScope(catalog);
            scopeEl.classList.toggle("needs-admin", Boolean(catalog === null || catalog === void 0 ? void 0 : catalog.needsAdmin));
        }
        const packages = (_a = catalog === null || catalog === void 0 ? void 0 : catalog.packages) !== null && _a !== void 0 ? _a : [];
        const counts = countPackages(packages);
        if (filtersEl instanceof HTMLElement) {
            for (const key of ["all", "installed", "available"]) {
                const button = filtersEl.querySelector(`[data-pkg-filter="${key}"]`);
                const count = filtersEl.querySelector(`[data-pkg-count="${key}"]`);
                if (button instanceof HTMLElement) {
                    const active = key === filter;
                    button.setAttribute("aria-selected", active ? "true" : "false");
                    button.classList.toggle("is-active", active);
                }
                if (count instanceof HTMLElement) {
                    count.textContent = String(counts[key]);
                }
            }
        }
        listEl.textContent = "";
        if (!loaded) {
            const loading = document.createElement("div");
            loading.className = "pkg-empty";
            loading.textContent = uiText("Reading the package list…", "パッケージ一覧を読み込み中…");
            listEl.appendChild(loading);
            return;
        }
        const { rows, total } = rankPackages(packages, query, filter);
        for (const entry of rows) {
            listEl.appendChild(buildRow(entry));
        }
        // Packages whose *files* match, and anything the CTAN escape hatch turned up,
        // go after the name/description hits so the instant results are never held up
        // by the slower searches — but in their own block, not appended inside the
        // list's scroll, where 120 rows of name hits would bury them.
        const byName = new Set(rows.map((entry) => entry.name));
        const extraFileHits = fileMatches.filter((match) => !byName.has(match.name));
        const extraTarget = extraEl instanceof HTMLElement ? extraEl : listEl;
        if (extraEl instanceof HTMLElement) {
            extraEl.textContent = "";
        }
        if (query.trim() && fileMatchTerm === query.trim() && extraFileHits.length > 0) {
            const heading = document.createElement("div");
            heading.className = "pkg-section";
            heading.textContent = uiText("Matched by file name", "ファイル名で一致");
            extraTarget.appendChild(heading);
            for (const match of extraFileHits.slice(0, 40)) {
                const entry = (_b = packages.find((item) => item.name === match.name)) !== null && _b !== void 0 ? _b : {
                    name: match.name,
                    installed: false,
                    sizeBytes: 0,
                    shortdesc: (_c = match.files[0]) !== null && _c !== void 0 ? _c : "",
                    kind: "package",
                };
                const row = buildRow(entry);
                const hint = document.createElement("div");
                hint.className = "pkg-file-hit";
                hint.textContent = match.files.slice(0, 3).join("\n");
                (_d = row.querySelector(".pkg-main")) === null || _d === void 0 ? void 0 : _d.appendChild(hint);
                extraTarget.appendChild(row);
            }
        }
        if (ctanTerm && ctanTerm === query.trim() && ctanMatches.length > 0) {
            const heading = document.createElement("div");
            heading.className = "pkg-section";
            heading.textContent = uiText("Found on CTAN", "CTAN で見つかったもの");
            extraTarget.appendChild(heading);
            for (const match of ctanMatches.slice(0, 40)) {
                if (byName.has(match.name)) {
                    continue;
                }
                const known = packages.find((item) => item.name === match.name);
                extraTarget.appendChild(buildRow(known !== null && known !== void 0 ? known : {
                    name: match.name,
                    installed: false,
                    sizeBytes: 0,
                    shortdesc: match.shortdesc,
                    kind: "package",
                }));
            }
        }
        const extraShown = extraEl instanceof HTMLElement ? extraEl.childElementCount > 0 : extraFileHits.length > 0;
        if (rows.length === 0 && !extraShown) {
            const empty = document.createElement("div");
            empty.className = "pkg-empty";
            empty.textContent = query.trim()
                ? uiText("Nothing matched.", "一致するものがありません。")
                : uiText("No packages.", "パッケージがありません。");
            listEl.appendChild(empty);
        }
        if (extraEl instanceof HTMLElement) {
            const hasExtra = extraEl.childElementCount > 0;
            extraEl.classList.toggle("is-hidden", !hasExtra);
            extraEl.setAttribute("aria-hidden", hasExtra ? "false" : "true");
        }
        if (truncatedEl instanceof HTMLElement) {
            const hidden = total - rows.length;
            const show = hidden > 0;
            truncatedEl.textContent = show
                ? uiText(`Showing ${rows.length} of ${total} — narrow the search to see the rest.`, `${total} 件中 ${rows.length} 件を表示中 — 絞り込むと残りが見えます。`)
                : "";
            truncatedEl.classList.toggle("is-hidden", !show);
            truncatedEl.setAttribute("aria-hidden", show ? "false" : "true");
        }
    };
    const scheduleFileSearch = () => {
        if (fileSearchTimer !== null) {
            window.clearTimeout(fileSearchTimer);
            fileSearchTimer = null;
        }
        const term = query.trim();
        if (term.length < 2) {
            fileMatches = [];
            fileMatchTerm = "";
            return;
        }
        // The name/description filter is instant; the file search costs a tlmgr call,
        // so it only runs once typing settles and its results arrive underneath.
        fileSearchTimer = window.setTimeout(() => {
            fileSearchTimer = null;
            deps.postToNative({ type: "packages:searchFiles", term }, true);
        }, 300);
    };
    if (searchEl instanceof HTMLInputElement) {
        searchEl.addEventListener("input", () => {
            query = searchEl.value;
            ctanMatches = [];
            ctanTerm = "";
            render();
            scheduleFileSearch();
        });
    }
    if (filtersEl instanceof HTMLElement) {
        filtersEl.addEventListener("click", (event) => {
            var _a;
            const button = (_a = event.target) === null || _a === void 0 ? void 0 : _a.closest("[data-pkg-filter]");
            if (!(button instanceof HTMLElement)) {
                return;
            }
            const value = button.dataset.pkgFilter;
            if (!value) {
                return;
            }
            filter = value;
            render();
        });
    }
    if (updateBtn instanceof HTMLButtonElement) {
        updateBtn.addEventListener("click", () => {
            if (busy) {
                return;
            }
            setNote("");
            deps.postToNative({ type: "packages:update" }, true);
        });
    }
    if (ctanBtn instanceof HTMLButtonElement) {
        ctanBtn.addEventListener("click", () => {
            const term = query.trim();
            if (term.length < 2) {
                setNote(uiText("Type something to search for first.", "先に検索したい語を入力してください。"));
                return;
            }
            setNote(uiText("Searching CTAN…", "CTAN を検索中…"));
            deps.postToNative({ type: "packages:ctanSearch", term }, true);
        });
    }
    return {
        onPageActive: () => {
            if (!loaded) {
                requestCatalog(false);
            }
            render();
        },
        handleCatalog: (payload) => {
            var _a, _b, _c;
            if ((payload === null || payload === void 0 ? void 0 : payload.ok) === false) {
                loaded = true;
                setNote((_a = payload.error) !== null && _a !== void 0 ? _a : uiText("Could not read the package list.", "パッケージ一覧を読み込めませんでした。"), "error");
                render();
                return;
            }
            catalog = {
                scope: (_b = payload.scope) !== null && _b !== void 0 ? _b : "none",
                needsAdmin: Boolean(payload.needsAdmin),
                root: (_c = payload.root) !== null && _c !== void 0 ? _c : "",
                packages: Array.isArray(payload.packages) ? payload.packages : [],
            };
            loaded = true;
            render();
        },
        handleFiles: (payload) => {
            var _a;
            if ((payload === null || payload === void 0 ? void 0 : payload.ok) === false) {
                return;
            }
            fileMatches = Array.isArray(payload.matches) ? payload.matches : [];
            fileMatchTerm = ((_a = payload.term) !== null && _a !== void 0 ? _a : "").trim();
            render();
        },
        handleCtan: (payload) => {
            var _a, _b;
            setNote("");
            if ((payload === null || payload === void 0 ? void 0 : payload.ok) === false) {
                setNote((_a = payload.error) !== null && _a !== void 0 ? _a : uiText("CTAN search failed.", "CTAN 検索に失敗しました。"), "error");
                return;
            }
            ctanMatches = Array.isArray(payload.matches) ? payload.matches : [];
            ctanTerm = ((_b = payload.term) !== null && _b !== void 0 ? _b : "").trim();
            if (ctanMatches.length === 0) {
                setNote(uiText("CTAN had nothing either.", "CTAN にも見つかりませんでした。"));
            }
            render();
        },
        handleTexdoc: (payload) => {
            var _a;
            if ((payload === null || payload === void 0 ? void 0 : payload.ok) === false) {
                setNote((_a = payload.error) !== null && _a !== void 0 ? _a : uiText("No documentation found.", "ドキュメントが見つかりません。"), "error");
                return;
            }
            setNote("");
        },
        handleDetail: (payload) => {
            var _a, _b;
            if ((payload === null || payload === void 0 ? void 0 : payload.ok) === false || !payload.name) {
                return;
            }
            detailFiles.set(payload.name, (_b = (_a = payload.detail) === null || _a === void 0 ? void 0 : _a.files) !== null && _b !== void 0 ? _b : []);
            render();
        },
        handleOpStart: (payload) => {
            var _a;
            const op = (_a = payload === null || payload === void 0 ? void 0 : payload.op) !== null && _a !== void 0 ? _a : "";
            const names = Array.isArray(payload === null || payload === void 0 ? void 0 : payload.names) ? payload.names : [];
            const label = op === "update"
                ? uiText("Updating every package…", "すべてのパッケージを更新中…")
                : op === "remove"
                    ? uiText(`Removing ${names.join(", ")}…`, `${names.join(", ")} を削除中…`)
                    : uiText(`Installing ${names.join(", ")}…`, `${names.join(", ")} を導入中…`);
            setBusy(true, label);
        },
        handleOpProgress: (payload) => {
            const current = typeof (payload === null || payload === void 0 ? void 0 : payload.current) === "number" ? payload.current : null;
            const total = typeof (payload === null || payload === void 0 ? void 0 : payload.total) === "number" ? payload.total : null;
            if (opFill instanceof HTMLElement && current !== null && total !== null && total > 0) {
                opFill.style.width = `${Math.round((current / total) * 100)}%`;
            }
            if (opLabel instanceof HTMLElement && (payload === null || payload === void 0 ? void 0 : payload.line)) {
                opLabel.textContent =
                    current !== null && total !== null ? `${payload.line} (${current}/${total})` : payload.line;
            }
        },
        handleOpResult: (payload) => {
            var _a;
            setBusy(false);
            if (payload === null || payload === void 0 ? void 0 : payload.cancelled) {
                setNote(uiText("Cancelled.", "キャンセルされました。"));
                return;
            }
            const blockers = Array.isArray(payload === null || payload === void 0 ? void 0 : payload.blockers) ? payload.blockers : [];
            if (blockers.length > 0) {
                // tlmgr refuses to strand a collection; saying which one is the useful part.
                setNote(blockers
                    .map((blocker) => uiText(`${blocker.name} was kept: ${blocker.neededBy} needs it.`, `${blocker.name} は残しました: ${blocker.neededBy} が必要としています。`))
                    .join("\n"), "error");
                return;
            }
            if ((payload === null || payload === void 0 ? void 0 : payload.ok) === false) {
                setNote((_a = payload.error) !== null && _a !== void 0 ? _a : uiText("The operation failed.", "操作に失敗しました。"), "error");
                return;
            }
            setNote((payload === null || payload === void 0 ? void 0 : payload.op) === "update"
                ? uiText("Everything is up to date.", "すべて最新になりました。")
                : uiText("Done.", "完了しました。"));
            loaded = false;
            requestCatalog(true);
            render();
        },
    };
};

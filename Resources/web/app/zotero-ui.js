// Zotero: the editor command "Insert citation from Zotero…" (search dialog
// with a .bib sync button) and the Settings → Zotero page. Everything that
// talks to Zotero runs in the main process behind `tex64Zotero`.
import { uiText } from "./i18n.js";
import { insertCitation } from "./citation-insert.js";
const ZOTERO_KEYS_URL = "https://www.zotero.org/settings/keys/new";
const bridge = () => window.tex64Zotero;
const call = async (action, payload = {}) => {
    const result = await bridge().call(action, payload);
    if (!result.ok)
        throw Object.assign(new Error(result.error || action), { code: result.code });
    return result;
};
const node = (tag, className = "", text = "") => {
    const element = document.createElement(tag);
    if (className)
        element.className = className;
    if (text)
        element.textContent = text;
    return element;
};
const errorCode = (error) => (error === null || error === void 0 ? void 0 : error.code) || "";
const describeError = (error) => {
    switch (errorCode(error)) {
        case "no-transport":
            return uiText("Start Zotero, or enter an API key in Settings → Zotero.", "Zotero を起動するか、設定 → Zotero で API キーを入れてください。");
        case "forbidden":
            return uiText("Zotero rejected the API key.", "Zotero が API キーを拒否しました。");
        case "timeout":
            return uiText("Zotero did not answer in time.", "Zotero の応答がありません。");
        case "unreachable":
            return uiText("Zotero is not running.", "Zotero が起動していません。");
        case "not-found":
            return uiText("The item is no longer in the library.", "ライブラリにその項目がありません。");
        case "NO_MAIN_FILE":
            return uiText("Open a .tex document first.", "先に .tex 文書を開いてください。");
        case "NO_BIBTEX":
            return uiText("Zotero returned no BibTeX for this item.", "この項目の BibTeX を取得できませんでした。");
        case "NO_SAFE_STORAGE":
            return uiText("This computer cannot store the key securely.", "この PC では鍵を安全に保存できません。");
        default:
            return error instanceof Error && error.message ? error.message : uiText("Zotero request failed.", "Zotero への要求に失敗しました。");
    }
};
const transportLabel = (status) => {
    switch (status.transport) {
        case "bbt":
            return "Better BibTeX";
        case "local":
            return uiText("Zotero on this computer", "この PC の Zotero");
        case "web":
            return status.probe.web.username ? `Zotero Web API (${status.probe.web.username})` : "Zotero Web API";
        default:
            return "";
    }
};
/** One line: where citations come from, or what to do to get connected. */
export const describeStatus = (status) => {
    var _a;
    if (!status.transport) {
        return uiText("Start Zotero, or enter an API key in Settings → Zotero.", "Zotero を起動するか、設定 → Zotero で API キーを入れてください。");
    }
    const library = ((_a = status.libraries.find((entry) => entry.id === status.library)) === null || _a === void 0 ? void 0 : _a.name) || "";
    const head = library ? `${transportLabel(status)} · ${library}` : transportLabel(status);
    if (status.missingLibrary) {
        return `${head} — ${uiText(`“${status.missingLibrary}” is not available here`, `「${status.missingLibrary}」はこの接続では使えません`)}`;
    }
    return head;
};
/** The per-door breakdown, shown on the settings page only. */
const describeDoors = (status) => {
    const doors = [
        status.probe.bbt.ok
            ? uiText("Better BibTeX: connected", "Better BibTeX: 接続中")
            : status.probe.bbt.code === "timeout"
                ? uiText("Better BibTeX: no answer", "Better BibTeX: 応答なし")
                : uiText("Better BibTeX: not running", "Better BibTeX: 未起動"),
        status.probe.local.ok
            ? uiText("Local API: connected", "ローカル API: 接続中")
            : status.probe.local.code === "not-found" || (status.probe.local.code || "").startsWith("http-")
                ? uiText("Local API: off in Zotero settings", "ローカル API: Zotero の設定で無効")
                : uiText("Local API: Zotero not running", "ローカル API: Zotero 未起動"),
        status.probe.web.ok
            ? uiText("Web API: connected", "Web API: 接続中")
            : status.probe.web.code === "no-key"
                ? uiText("Web API: no API key", "Web API: API キー未設定")
                : status.probe.web.code === "forbidden"
                    ? uiText("Web API: key rejected", "Web API: キーが拒否されました")
                    : uiText("Web API: no connection", "Web API: 接続できません"),
    ];
    return doors.join(" · ");
};
const bibHint = (result) => {
    const file = result.bibPath;
    const stem = file.replace(/\.bib$/i, "");
    const command = result.style === "biblatex" ? `\\addbibresource{${file}}` : `\\bibliography{${stem}}`;
    return uiText(`add ${command} to the document`, `文書に ${command} を追加してください`);
};
// ---- Search dialog -----------------------------------------------------------
let dialogOpen = false;
export const openZoteroDialog = (editor, getActiveFilePath) => {
    var _a;
    if (dialogOpen || !bridge())
        return;
    dialogOpen = true;
    const model = (_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
    const dialog = node("dialog", "history-confirm zotero-dialog");
    const heading = node("h2", "", uiText("Insert citation from Zotero", "Zotero から引用を挿入"));
    heading.id = "zotero-dialog-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const search = node("input", "zotero-search");
    // A plain text input: in a search input Escape clears the text instead of
    // closing the dialog.
    search.type = "text";
    search.placeholder = uiText("Search title, author or year", "題名・著者・年で検索");
    search.setAttribute("aria-label", search.placeholder);
    search.autocomplete = "off";
    search.spellcheck = false;
    const results = node("div", "zotero-results");
    results.setAttribute("role", "listbox");
    const status = node("p", "history-error zotero-status");
    status.setAttribute("role", "status");
    const actions = node("div", "history-confirm-actions");
    const button = (text, onClick) => {
        const element = node("button", "history-button", text);
        element.type = "button";
        element.addEventListener("click", onClick);
        return element;
    };
    let items = [];
    let highlighted = 0;
    let busy = false;
    let searchTimer = null;
    let searchSerial = 0;
    let connected = false;
    // The connection line comes back whenever nothing more specific applies.
    let baseStatus = "";
    const setStatus = (text) => { status.textContent = text; };
    const showBase = () => setStatus(baseStatus);
    const renderResults = (placeholder = "") => {
        results.replaceChildren();
        if (placeholder) {
            results.append(node("p", "zotero-empty", placeholder));
            return;
        }
        const mixed = new Set(items.map((item) => item.library)).size > 1;
        items.forEach((item, index) => {
            const row = node("button", "zotero-result");
            row.type = "button";
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", String(index === highlighted));
            row.dataset.noI18n = "true";
            const creator = item.creator ? ((item.creatorCount || 1) > 1 ? `${item.creator} et al.` : item.creator) : "";
            const meta = [creator, item.year, mixed ? item.libraryName : ""].filter(Boolean).join(" · ");
            row.append(node("span", "zotero-result-title", item.title || item.citekey || item.key));
            if (meta)
                row.append(node("span", "zotero-result-meta", meta));
            row.addEventListener("click", () => void insert(index));
            results.append(row);
        });
    };
    const highlight = (index) => {
        var _a, _b;
        if (items.length === 0)
            return;
        highlighted = (index + items.length) % items.length;
        Array.from(results.children).forEach((child, position) => child.setAttribute("aria-selected", String(position === highlighted)));
        (_b = (_a = results.children[highlighted]) === null || _a === void 0 ? void 0 : _a.scrollIntoView) === null || _b === void 0 ? void 0 : _b.call(_a, { block: "nearest" });
    };
    const runSearch = async () => {
        const query = search.value.trim();
        const serial = (searchSerial += 1);
        showBase();
        if (!query) {
            items = [];
            renderResults();
            return;
        }
        renderResults(uiText("Searching…", "検索中…"));
        try {
            const result = await call("search", { query });
            if (serial !== searchSerial)
                return;
            items = result.items;
            highlighted = 0;
            renderResults(items.length ? "" : uiText("No matches", "見つかりません"));
        }
        catch (error) {
            if (serial !== searchSerial)
                return;
            items = [];
            renderResults();
            if (errorCode(error) !== "no-transport" || !connected)
                setStatus(describeError(error));
        }
    };
    const insert = async (index) => {
        var _a, _b, _c, _d;
        const item = items[index];
        if (!item || busy)
            return;
        if (!model || ((_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) !== model || ((_b = model.isDisposed) === null || _b === void 0 ? void 0 : _b.call(model))) {
            setStatus(uiText("The document changed. Close and choose the insertion point again.", "文書が変更されました。閉じて挿入位置を選び直してください。"));
            return;
        }
        busy = true;
        sync.disabled = true;
        try {
            const result = await call("cite", { item, activeFilePath: getActiveFilePath() });
            const line = (_d = (_c = editor.getPosition) === null || _c === void 0 ? void 0 : _c.call(editor)) === null || _d === void 0 ? void 0 : _d.lineNumber;
            const inserted = insertCitation(editor, result.key, "zotero");
            // insertCitation hands focus to the editor; the dialog stays open for
            // the next citation, so keep the keyboard here.
            search.focus();
            const where = line ? `L${line}` : "";
            const citeNote = inserted === null
                ? uiText("not inserted", "挿入できません")
                : inserted === ""
                    ? uiText(`\\cite already has ${result.key}`, `\\cite に ${result.key} は既にあります`)
                    : uiText(`inserted ${result.key} at ${where}`, `${where} に ${result.key} を挿入`);
            const bibNote = result.created
                ? uiText(`created ${result.bibPath}`, `${result.bibPath} を作成`)
                : result.appended
                    ? uiText(`added to ${result.bibPath}`, `${result.bibPath} に追加`)
                    : uiText(`already in ${result.bibPath}`, `${result.bibPath} に既存`);
            setStatus([citeNote, bibNote, result.named ? "" : bibHint(result)].filter(Boolean).join(" · "));
        }
        catch (error) {
            setStatus(describeError(error));
        }
        finally {
            busy = false;
            sync.disabled = false;
        }
    };
    const sync = button(uiText("Sync .bib with Zotero", ".bib を Zotero と同期"), () => {
        if (busy)
            return;
        busy = true;
        sync.disabled = true;
        setStatus(uiText("Syncing…", "同期中…"));
        void call("sync", { activeFilePath: getActiveFilePath() })
            .then((result) => {
            if (result.total === 0) {
                setStatus(uiText(`${result.bibPath}: no entries`, `${result.bibPath}: 項目なし`));
                return;
            }
            const parts = [
                uiText(`${result.updated} updated`, `更新 ${result.updated}`),
                uiText(`${result.unchanged} unchanged`, `変更なし ${result.unchanged}`),
            ];
            if (result.unmatched)
                parts.push(uiText(`${result.unmatched} not matched`, `照合できず ${result.unmatched}`));
            setStatus(`${result.bibPath}: ${parts.join(" · ")}`);
        })
            .catch((error) => setStatus(describeError(error)))
            .finally(() => {
            busy = false;
            sync.disabled = false;
        });
    });
    const close = button(uiText("Close", "閉じる"), () => dialog.close());
    actions.append(sync, close);
    search.addEventListener("input", () => {
        if (searchTimer !== null)
            window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => void runSearch(), 250);
    });
    search.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            highlight(highlighted + 1);
        }
        else if (event.key === "ArrowUp") {
            event.preventDefault();
            highlight(highlighted - 1);
        }
        else if (event.key === "Enter") {
            event.preventDefault();
            void insert(highlighted);
        }
    });
    dialog.addEventListener("close", () => {
        var _a;
        dialogOpen = false;
        dialog.remove();
        (_a = editor.focus) === null || _a === void 0 ? void 0 : _a.call(editor);
    });
    dialog.append(heading, search, results, status, actions);
    document.body.append(dialog);
    dialog.showModal();
    search.focus();
    setStatus(uiText("Checking…", "確認中…"));
    void call("status")
        .then((current) => {
        connected = Boolean(current.transport);
        baseStatus = describeStatus(current);
        showBase();
    })
        .catch((error) => {
        baseStatus = describeError(error);
        showBase();
    });
};
/** Context-menu command on every editor; enabled for LaTeX models only. */
export const attachZoteroEditor = (editor, getActiveFilePath) => {
    var _a, _b, _c;
    if (!bridge() || typeof (editor === null || editor === void 0 ? void 0 : editor.addAction) !== "function")
        return;
    const isTex = (_a = editor.createContextKey) === null || _a === void 0 ? void 0 : _a.call(editor, "tex64.isTexFile", false);
    const syncKey = () => { var _a, _b, _c; return isTex === null || isTex === void 0 ? void 0 : isTex.set(((_c = (_b = (_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) === null || _b === void 0 ? void 0 : _b.getLanguageId) === null || _c === void 0 ? void 0 : _c.call(_b)) === "latex"); };
    syncKey();
    (_b = editor.onDidChangeModel) === null || _b === void 0 ? void 0 : _b.call(editor, syncKey);
    (_c = editor.onDidChangeModelLanguage) === null || _c === void 0 ? void 0 : _c.call(editor, syncKey);
    editor.addAction({
        id: "tex64.zotero.insert",
        label: uiText("Insert citation from Zotero…", "Zotero から引用を挿入…"),
        contextMenuGroupId: "9_cite",
        contextMenuOrder: 1,
        precondition: isTex ? "tex64.isTexFile" : undefined,
        run: () => openZoteroDialog(editor, getActiveFilePath),
    });
};
// ---- Settings → Zotero -----------------------------------------------------
export const initZoteroSettingsUi = () => {
    const apiKeyInput = document.getElementById("settings-zotero-api-key");
    const librarySelect = document.getElementById("settings-zotero-library");
    const statusLine = document.getElementById("settings-zotero-status");
    const explainer = document.getElementById("settings-zotero-explainer");
    const keysLink = document.getElementById("settings-zotero-open-keys");
    const navItem = document.querySelector('.settings-nav-item[data-settings-target="zotero"]');
    if (!bridge() || !(apiKeyInput instanceof HTMLInputElement) || !(librarySelect instanceof HTMLSelectElement) || !(statusLine instanceof HTMLElement))
        return;
    if (explainer instanceof HTMLElement) {
        explainer.textContent = uiText("With Zotero 7 or Better BibTeX running on this computer, no key is needed. An API key reaches your library and groups through zotero.org.", "この PC で Zotero 7 か Better BibTeX が動いていれば鍵は不要です。API キーを入れると zotero.org 経由でライブラリとグループを使えます。");
    }
    if (keysLink instanceof HTMLButtonElement) {
        keysLink.textContent = uiText("Create an API key", "API キーを発行");
        keysLink.addEventListener("click", () => {
            var _a, _b;
            (_b = (_a = window.tex64Bridge) === null || _a === void 0 ? void 0 : _a.postMessage) === null || _b === void 0 ? void 0 : _b.call(_a, { type: "shell:openExternal", url: ZOTERO_KEYS_URL });
        });
    }
    let serial = 0;
    const apply = (status) => {
        librarySelect.replaceChildren();
        for (const library of status.libraries) {
            const option = document.createElement("option");
            option.value = library.id;
            option.textContent = library.name;
            option.dataset.noI18n = "true";
            librarySelect.append(option);
        }
        librarySelect.disabled = status.libraries.length === 0;
        if (status.libraries.length === 0) {
            const option = document.createElement("option");
            option.value = "";
            option.textContent = uiText("Not connected", "未接続");
            librarySelect.append(option);
        }
        librarySelect.value = status.library;
        apiKeyInput.placeholder = status.hasApiKey ? "••••••••••••" : uiText("Paste a Zotero API key", "Zotero の API キーを貼り付け");
        statusLine.textContent = `${describeStatus(status)} — ${describeDoors(status)}`;
        statusLine.classList.toggle("is-error", !status.transport);
        statusLine.classList.toggle("is-success", Boolean(status.transport));
    };
    const refresh = (request) => {
        const current = (serial += 1);
        statusLine.textContent = uiText("Checking…", "確認中…");
        statusLine.classList.remove("is-error", "is-success");
        void request()
            .then((status) => { if (current === serial)
            apply(status); })
            .catch((error) => {
            if (current !== serial)
                return;
            statusLine.textContent = describeError(error);
            statusLine.classList.add("is-error");
        });
    };
    apiKeyInput.addEventListener("change", () => {
        const apiKey = apiKeyInput.value;
        apiKeyInput.value = "";
        refresh(() => call("settings", { apiKey }));
    });
    librarySelect.addEventListener("change", () => {
        refresh(() => call("settings", { library: librarySelect.value }));
    });
    navItem === null || navItem === void 0 ? void 0 : navItem.addEventListener("click", () => refresh(() => call("status")));
};

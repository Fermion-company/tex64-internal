// Zotero: the editor command "Insert citation from Zotero…" (search dialog
// with a .bib sync button) and the Settings → Zotero page. Everything that
// talks to Zotero runs in the main process behind `tex64Zotero`.

import { uiText } from "./i18n.js";
import { insertCitation, type CitationEditor } from "./citation-insert.js";

type ZoteroItem = {
  transport: string;
  key: string;
  citekey: string;
  title: string;
  creator: string;
  year: string;
  library: string;
  libraryName: string;
};
type ProbeResult = { ok: boolean; code?: string; status?: number; username?: string };
type ZoteroStatus = {
  transport: "bbt" | "local" | "web" | null;
  probe: { bbt: ProbeResult; local: ProbeResult; web: ProbeResult };
  libraries: Array<{ id: string; kind: "user" | "group"; name: string }>;
  library: string;
  hasApiKey: boolean;
  encryptionAvailable: boolean;
};

const bridge = () => (window as any).tex64Zotero;
const call = async <T = any>(action: string, payload: Record<string, unknown> = {}): Promise<T> => {
  const result = await bridge().call(action, payload);
  if (!result.ok) throw Object.assign(new Error(result.error || action), { code: result.code });
  return result as T;
};

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

const describeError = (error: unknown) => {
  const code = (error as { code?: string })?.code;
  switch (code) {
    case "no-transport":
      return uiText("Zotero is not reachable.", "Zotero に接続できません。");
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

const transportLabel = (status: ZoteroStatus) => {
  switch (status.transport) {
    case "bbt":
      return uiText("Better BibTeX", "Better BibTeX");
    case "local":
      return uiText("Zotero on this computer", "この PC の Zotero");
    case "web":
      return status.probe.web.username
        ? uiText(`Zotero Web API (${status.probe.web.username})`, `Zotero Web API（${status.probe.web.username}）`)
        : uiText("Zotero Web API", "Zotero Web API");
    default:
      return "";
  }
};

/** One line: which door is open, or why each one is closed. */
export const describeStatus = (status: ZoteroStatus) => {
  if (status.transport) {
    const library = status.libraries.find((entry) => entry.id === status.library)?.name || "";
    return library ? `${transportLabel(status)} · ${library}` : transportLabel(status);
  }
  const reasons = [
    status.probe.bbt.code === "timeout"
      ? uiText("Better BibTeX: no answer", "Better BibTeX: 応答なし")
      : uiText("Better BibTeX: not running", "Better BibTeX: 未起動"),
    status.probe.local.code === "not-found" || (status.probe.local.code || "").startsWith("http-")
      ? uiText("local API: off in Zotero settings", "ローカル API: Zotero の設定で無効")
      : uiText("local API: Zotero not running", "ローカル API: Zotero 未起動"),
    status.probe.web.code === "no-key"
      ? uiText("Web API: no API key", "Web API: API キー未設定")
      : status.probe.web.code === "forbidden"
        ? uiText("Web API: key rejected", "Web API: キーが拒否されました")
        : uiText("Web API: no connection", "Web API: 接続できません"),
  ];
  return `${uiText("Not reachable", "接続できません")} — ${reasons.join(" · ")}`;
};

// ---- Search dialog -----------------------------------------------------------

let dialogOpen = false;

export const openZoteroDialog = (editor: CitationEditor, getActiveFilePath: () => string | null) => {
  if (dialogOpen || !bridge()) return;
  dialogOpen = true;
  const model = editor.getModel?.();

  const dialog = node("dialog", "history-confirm zotero-dialog");
  const heading = node("h2", "", uiText("Insert citation from Zotero", "Zotero から引用を挿入"));
  heading.id = "zotero-dialog-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  const search = node("input", "settings-input");
  // A plain text input: in a search input Escape clears the text instead of
  // closing the dialog.
  search.type = "text";
  search.placeholder = uiText("Search title, author or year", "題名・著者・年で検索");
  search.setAttribute("aria-label", search.placeholder);
  search.autocomplete = "off";
  const results = node("div", "zotero-results");
  results.setAttribute("role", "listbox");
  const status = node("p", "zotero-status");
  status.setAttribute("role", "status");
  const actions = node("div", "history-confirm-actions");
  const button = (text: string, onClick: () => void) => {
    const element = node("button", "panel-button", text);
    element.type = "button";
    element.addEventListener("click", onClick);
    return element;
  };

  let items: ZoteroItem[] = [];
  let highlighted = 0;
  let busy = false;
  let searchTimer: number | null = null;
  let searchSerial = 0;

  const setStatus = (text: string, tone: "" | "is-error" = "") => {
    status.textContent = text;
    status.classList.toggle("is-error", tone === "is-error");
  };

  const renderResults = (placeholder = "") => {
    results.replaceChildren();
    if (placeholder) {
      results.append(node("p", "zotero-empty", placeholder));
      return;
    }
    items.forEach((item, index) => {
      const row = node("button", "zotero-result");
      row.type = "button";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === highlighted));
      const parts = [item.title || item.citekey || item.key, item.creator, item.year, item.libraryName].filter(Boolean);
      row.textContent = parts.join(" · ");
      row.dataset.noI18n = "true";
      row.addEventListener("click", () => void insert(index));
      results.append(row);
    });
  };

  const highlight = (index: number) => {
    if (items.length === 0) return;
    highlighted = (index + items.length) % items.length;
    Array.from(results.children).forEach((child, position) => child.setAttribute("aria-selected", String(position === highlighted)));
    (results.children[highlighted] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  };

  const runSearch = async () => {
    const query = search.value.trim();
    const serial = (searchSerial += 1);
    if (!query) {
      items = [];
      renderResults();
      return;
    }
    renderResults(uiText("Searching…", "検索中…"));
    try {
      const result = await call<{ items: ZoteroItem[] }>("search", { query });
      if (serial !== searchSerial) return;
      items = result.items;
      highlighted = 0;
      renderResults(items.length ? "" : uiText("No matches", "見つかりません"));
    } catch (error) {
      if (serial !== searchSerial) return;
      items = [];
      renderResults();
      setStatus(describeError(error), "is-error");
    }
  };

  const insert = async (index: number) => {
    const item = items[index];
    if (!item || busy) return;
    if (!model || editor.getModel?.() !== model || model.isDisposed?.()) {
      setStatus(uiText("The document changed. Close and choose the insertion point again.", "文書が変更されました。閉じて挿入位置を選び直してください。"), "is-error");
      return;
    }
    busy = true;
    sync.disabled = true;
    try {
      const result = await call<{ key: string; bibPath: string; created: boolean; appended: boolean; named: boolean }>("cite", {
        item,
        activeFilePath: getActiveFilePath(),
      });
      const inserted = insertCitation(editor, result.key, "zotero");
      // insertCitation hands focus to the editor; the dialog stays open for
      // the next citation, so keep the keyboard here.
      search.focus();
      const bib = result.bibPath;
      const bibNote = result.created
        ? uiText(`created ${bib} — add \\addbibresource{${bib}} to the preamble`, `${bib} を作成 — プリアンブルに \\addbibresource{${bib}} を追加してください`)
        : result.appended
          ? uiText(`added to ${bib}`, `${bib} に追加`)
          : uiText(`already in ${bib}`, `${bib} に既存`);
      const citeNote = inserted === null
        ? uiText("not inserted", "挿入できません")
        : inserted === ""
          ? uiText(`\\cite already has ${result.key}`, `\\cite に ${result.key} は既にあります`)
          : uiText(`inserted ${result.key}`, `${result.key} を挿入`);
      setStatus(`${citeNote} · ${bibNote}`);
    } catch (error) {
      setStatus(describeError(error), "is-error");
    } finally {
      busy = false;
      sync.disabled = false;
    }
  };

  const sync = button(uiText("Sync .bib with Zotero", ".bib を Zotero と同期"), () => {
    if (busy) return;
    busy = true;
    sync.disabled = true;
    setStatus(uiText("Syncing…", "同期中…"));
    void call<{ bibPath: string; total: number; updated: number; unchanged: number; notFound: number; skipped: number }>("sync", {
      activeFilePath: getActiveFilePath(),
    })
      .then((result) => {
        if (result.total === 0) {
          setStatus(uiText(`${result.bibPath}: no entries`, `${result.bibPath}: 項目なし`));
          return;
        }
        const parts = [
          uiText(`${result.updated} updated`, `更新 ${result.updated}`),
          uiText(`${result.unchanged} unchanged`, `変更なし ${result.unchanged}`),
        ];
        if (result.notFound) parts.push(uiText(`${result.notFound} not in library`, `ライブラリになし ${result.notFound}`));
        if (result.skipped) parts.push(uiText(`${result.skipped} not from Zotero`, `Zotero 以外 ${result.skipped}`));
        setStatus(`${result.bibPath}: ${parts.join(" · ")}`);
      })
      .catch((error) => setStatus(describeError(error), "is-error"))
      .finally(() => {
        busy = false;
        sync.disabled = false;
      });
  });
  const close = button(uiText("Close", "閉じる"), () => dialog.close());
  actions.append(sync, close);

  search.addEventListener("input", () => {
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runSearch(), 250);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); highlight(highlighted + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); highlight(highlighted - 1); }
    else if (event.key === "Enter") { event.preventDefault(); void insert(highlighted); }
  });
  dialog.addEventListener("close", () => {
    dialogOpen = false;
    dialog.remove();
    editor.focus?.();
  });

  dialog.append(heading, search, results, status, actions);
  document.body.append(dialog);
  dialog.showModal();
  search.focus();

  void call<ZoteroStatus>("status")
    .then((current) => {
      setStatus(describeStatus(current), current.transport ? "" : "is-error");
    })
    .catch((error) => setStatus(describeError(error), "is-error"));
};

/** Context-menu command on every editor; enabled for LaTeX models only. */
export const attachZoteroEditor = (
  editor: any,
  getActiveFilePath: () => string | null
) => {
  if (!bridge() || typeof editor?.addAction !== "function") return;
  const isTex = editor.createContextKey?.("tex64.isTexFile", false);
  const syncKey = () => isTex?.set(editor.getModel?.()?.getLanguageId?.() === "latex");
  syncKey();
  editor.onDidChangeModel?.(syncKey);
  editor.onDidChangeModelLanguage?.(syncKey);
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
  const navItem = document.querySelector<HTMLElement>('.settings-nav-item[data-settings-target="zotero"]');
  if (!bridge() || !(apiKeyInput instanceof HTMLInputElement) || !(librarySelect instanceof HTMLSelectElement) || !(statusLine instanceof HTMLElement)) return;

  let serial = 0;
  const apply = (status: ZoteroStatus) => {
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
    statusLine.textContent = describeStatus(status);
    statusLine.classList.toggle("is-error", !status.transport);
    statusLine.classList.toggle("is-success", Boolean(status.transport));
  };

  const refresh = (request: () => Promise<ZoteroStatus>) => {
    const current = (serial += 1);
    statusLine.textContent = uiText("Checking…", "確認中…");
    statusLine.classList.remove("is-error", "is-success");
    void request()
      .then((status) => { if (current === serial) apply(status); })
      .catch((error) => {
        if (current !== serial) return;
        statusLine.textContent = describeError(error);
        statusLine.classList.add("is-error");
      });
  };

  apiKeyInput.addEventListener("change", () => {
    const apiKey = apiKeyInput.value;
    apiKeyInput.value = "";
    refresh(() => call<ZoteroStatus>("settings", { apiKey }));
  });
  librarySelect.addEventListener("change", () => {
    refresh(() => call<ZoteroStatus>("settings", { library: librarySelect.value }));
  });
  navItem?.addEventListener("click", () => refresh(() => call<ZoteroStatus>("status")));
};

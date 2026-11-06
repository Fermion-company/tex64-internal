// Zotero: the editor command "Insert citation from Zotero…" (search dialog
// with a .bib sync button) and the Settings → Zotero page. Everything that
// talks to Zotero runs in the main process behind `tex64Zotero`.

import { getUiLocale, uiText } from "./i18n.js";
import { citationDocumentFor, insertCitation } from "./citation-insert.js";

type CitationEditor = Parameters<typeof insertCitation>[0] & {
  getPosition?: () => { lineNumber: number; column: number } | null;
  getRawOptions?: () => { readOnly?: boolean };
};

type ZoteroItem = {
  transport: string;
  key: string;
  citekey: string;
  title: string;
  creator: string;
  creatorCount?: number;
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
  missingLibrary: string;
  hasApiKey: boolean;
  encryptionAvailable: boolean;
};
type CiteResult = { key: string; bibPath: string; named: boolean; style: "biblatex" | "bibtex"; created: boolean; appended: boolean };
type SyncResult = { bibPath: string; total: number; updated: number; unchanged: number; notFound: number };

const ZOTERO_KEYS_URL = "https://www.zotero.org/settings/keys/new";
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

const errorCode = (error: unknown) => (error as { code?: string })?.code || "";

const documentChanged = () =>
  uiText("The document changed. Close and choose the insertion point again.", "文書が変更されました。閉じて挿入位置を選び直してください。");

const describeError = (error: unknown, activeFilePath: string | null = null) => {
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
    // The project closed while Zotero answered; nothing was written.
    case "STALE_WORKSPACE":
      return documentChanged();
    // The .bib is written under the same lease as saves; Axiom holds it.
    case "AGENT_WORKSPACE_BUSY":
      return uiText("Axiom is editing this project. Try again when it finishes.", "Axiom がこのプロジェクトを編集中です。終わってからもう一度お試しください。");
    // The file belongs to several documents with different .bib files; Build's
    // chooser (or a % !TEX root line) settles which one.
    case "BUILD_TARGET_CHOICE":
      return activeFilePath
        ? uiText(`${activeFilePath} belongs to more than one document.`, `${activeFilePath} は複数の文書から読み込まれています。`)
        : uiText("This folder has several documents and no main file is set.", "このフォルダには文書が複数あり、メイン TeX が決まっていません。");
    default:
      return error instanceof Error && error.message ? error.message : uiText("Zotero request failed.", "Zotero への要求に失敗しました。");
  }
};

const transportLabel = (status: ZoteroStatus) => {
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
export const describeStatus = (status: ZoteroStatus) => {
  if (!status.transport) {
    return uiText("Start Zotero, or enter an API key in Settings → Zotero.", "Zotero を起動するか、設定 → Zotero で API キーを入れてください。");
  }
  const library = status.libraries.find((entry) => entry.id === status.library)?.name || "";
  const head = library ? `${transportLabel(status)} · ${library}` : transportLabel(status);
  if (status.missingLibrary) {
    return `${head} — ${uiText(`“${status.missingLibrary}” is not available here`, `「${status.missingLibrary}」はこの接続では使えません`)}`;
  }
  return head;
};

const bibHint = (result: CiteResult) => {
  const file = result.bibPath;
  const stem = file.replace(/\.bib$/i, "");
  const command = result.style === "biblatex" ? `\\addbibresource{${file}}` : `\\bibliography{${stem}}`;
  return uiText(`add ${command} to the document`, `文書に ${command} を追加してください`);
};

// ---- Search dialog -----------------------------------------------------------

let dialogOpen = false;

// The eyebrow already says Zotero: the door alone.
const doorLabel = (status: ZoteroStatus) => {
  if (status.transport === "web") return status.probe.web.username ? `Web API · ${status.probe.web.username}` : "Web API";
  if (status.transport === "local") return uiText("this computer", "この PC");
  return transportLabel(status);
};

const SEARCH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="M10.6 10.6 14 14" stroke-linecap="round"/></svg>';

export const openZoteroDialog = (editor: CitationEditor, getActiveFilePath: () => string | null) => {
  if (dialogOpen || !bridge()) return;
  dialogOpen = true;
  const model = editor.getModel?.();

  const dialog = node("dialog", "tool-dialog zotero-dialog");
  // Where results come from: a dot (connected or not) and the door.
  const eyebrow = node("p", "tool-dialog-eyebrow");
  eyebrow.dataset.noI18n = "true";
  const dot = node("span", "zotero-connection-dot");
  const door = node("span", "tool-dialog-eyebrow-detail");
  eyebrow.append(dot, "Zotero", door);
  const heading = node("h2", "tool-dialog-title", uiText("Insert citation", "引用を挿入"));
  heading.id = "zotero-dialog-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  // Where the \cite goes.
  const target = node("p", "zotero-target");
  target.dataset.noI18n = "true";
  const renderTarget = () => {
    const path = getActiveFilePath();
    const line = editor.getPosition?.()?.lineNumber;
    target.replaceChildren();
    if (!path) return;
    const file = node("code", "", path);
    if (getUiLocale() === "ja") target.append(file, line ? ` の ${line} 行目に ` : " に ", node("code", "", "\\cite"), " を入れます");
    else target.append("Adds ", node("code", "", "\\cite"), " to ", file, line ? ` at line ${line}` : "");
  };

  const searchWrap = node("div", "zotero-search-wrap");
  searchWrap.innerHTML = SEARCH_ICON;
  const search = node("input", "tool-input zotero-search");
  // A plain text input: in a search input Escape clears the text instead of
  // closing the dialog.
  search.type = "text";
  search.placeholder = uiText("Search title, author or year", "題名・著者・年で検索");
  search.setAttribute("aria-label", search.placeholder);
  search.autocomplete = "off";
  search.spellcheck = false;
  searchWrap.append(search);
  const library = node("select", "zotero-library");
  library.setAttribute("aria-label", uiText("Library", "ライブラリ"));
  library.hidden = true;
  const controls = node("div", "zotero-controls");
  controls.append(searchWrap, library);
  const listLabel = node("p", "tool-dialog-label zotero-list-label");
  const results = node("div", "zotero-results");
  results.setAttribute("role", "listbox");
  const status = node("p", "zotero-status");
  status.setAttribute("role", "status");
  const actions = node("div", "tool-dialog-actions");
  const button = (text: string, onClick: () => void, className = "") => {
    const element = node("button", `tool-button${className ? ` ${className}` : ""}`, text);
    element.type = "button";
    element.addEventListener("click", onClick);
    return element;
  };

  let items: ZoteroItem[] = [];
  let highlighted = 0;
  let busy = false;
  let searchTimer: number | null = null;
  let searchSerial = 0;
  let current: ZoteroStatus | null = null;
  let hinted = false;

  const setStatus = (text: string, isError = false) => {
    status.textContent = text;
    status.classList.toggle("is-error", isError);
  };

  const renderConnection = () => {
    const on = Boolean(current?.transport);
    dot.classList.toggle("is-on", on);
    dot.classList.toggle("is-off", Boolean(current) && !on);
    door.textContent = current && on ? `· ${doorLabel(current)}` : "";
    const libraries = current?.libraries ?? [];
    library.replaceChildren(...libraries.map((entry) => new Option(entry.kind === "group" ? `${entry.name}` : uiText(`${entry.name} (mine)`, `${entry.name}（自分）`), entry.id)));
    library.value = current?.library ?? "";
    library.hidden = libraries.length < 2;
  };

  const empty = (headline: string, text = "", action: HTMLElement | null = null) => {
    const box = node("div", "zotero-empty");
    if (headline) box.append(node("strong", "", headline));
    if (text) box.append(node("span", "", text));
    if (action) box.append(action);
    results.replaceChildren(box);
  };

  const renderResults = () => {
    results.replaceChildren();
    const mixed = new Set(items.map((item) => item.library)).size > 1;
    items.forEach((item, index) => {
      const row = node("button", "zotero-result");
      row.type = "button";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === highlighted));
      row.dataset.noI18n = "true";
      const creator = item.creator ? ((item.creatorCount || 1) > 1 ? uiText(`${item.creator} et al.`, `${item.creator} ほか`) : item.creator) : "";
      const meta = [creator, item.year, mixed ? item.libraryName : ""].filter(Boolean).join(" · ");
      row.append(node("span", "zotero-result-title", item.title || item.citekey || item.key));
      if (meta) row.append(node("span", "zotero-result-meta", meta));
      if (item.citekey) row.append(node("span", "zotero-result-key", item.citekey));
      row.addEventListener("click", () => void insert(index));
      row.addEventListener("mousemove", () => { if (highlighted !== index) highlight(index); });
      results.append(row);
    });
  };

  const highlight = (index: number) => {
    if (items.length === 0) return;
    highlighted = (index + items.length) % items.length;
    Array.from(results.children).forEach((child, position) => child.setAttribute("aria-selected", String(position === highlighted)));
    (results.children[highlighted] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  };

  const notConnected = () => {
    const open = button(uiText("Open Settings", "設定を開く"), () => {
      dialog.close();
      (window as unknown as { tex64Bridge?: { postMessage: (message: unknown) => void } }).tex64Bridge?.postMessage({ type: "app:command", payload: { command: "settings:open" } });
      window.setTimeout(() => (document.querySelector('.settings-nav-item[data-settings-target="zotero"]') as HTMLElement | null)?.click(), 300);
    });
    empty(uiText("Zotero is not connected", "Zotero につながっていません"), uiText("Start Zotero, or enter an API key in Settings → Zotero.", "Zotero を起動するか、設定 → Zotero で API キーを入れてください。"), open);
  };

  // With nothing typed: the library's newest items, where the door can list them.
  const showRecent = async (serial: number) => {
    listLabel.textContent = uiText("Recently added", "最近追加した文献");
    if (!current?.transport) {
      notConnected();
      return;
    }
    empty("", uiText("Loading…", "読み込み中…"));
    try {
      const result = await call<{ items: ZoteroItem[] }>("recent");
      if (serial !== searchSerial) return;
      items = result.items;
      highlighted = 0;
      if (items.length) renderResults();
      else {
        listLabel.textContent = "";
        empty(uiText("Search your library", "ライブラリを検索"));
      }
    } catch (error) {
      if (serial !== searchSerial) return;
      items = [];
      empty("", describeError(error));
    }
  };

  const runSearch = async () => {
    const query = search.value.trim();
    const serial = (searchSerial += 1);
    if (!query) {
      await showRecent(serial);
      return;
    }
    listLabel.textContent = uiText("Results", "検索結果");
    empty("", uiText("Searching…", "検索中…"));
    try {
      const result = await call<{ items: ZoteroItem[] }>("search", { query });
      if (serial !== searchSerial) return;
      items = result.items;
      highlighted = 0;
      listLabel.textContent = `${uiText("Results", "検索結果")} · ${items.length}`;
      if (items.length) renderResults();
      else empty(uiText("No matches", "見つかりません"));
      if (!current?.transport) {
        // Zotero came back since the dialog opened: say where results come from.
        current = await call<ZoteroStatus>("status").catch(() => current);
        renderConnection();
      }
    } catch (error) {
      if (serial !== searchSerial) return;
      items = [];
      if (errorCode(error) === "no-transport") {
        current = current ? { ...current, transport: null } : current;
        renderConnection();
        notConnected();
      } else {
        empty("", describeError(error));
      }
    }
  };

  // The editor must still show the model the dialog opened on, writable.
  const sameDocument = () =>
    Boolean(model) && editor.getModel?.() === model && !model?.isDisposed?.() && !editor.getRawOptions?.()?.readOnly;

  const insert = async (index: number) => {
    const item = items[index];
    if (!item || busy) return;
    if (!sameDocument()) {
      setStatus(documentChanged(), true);
      return;
    }
    busy = true;
    sync.disabled = true;
    const activeFilePath = getActiveFilePath();
    try {
      const result = await call<CiteResult>("cite", { item, activeFilePath, documentMainFile: citationDocumentFor(activeFilePath) });
      const bibNote = result.created
        ? uiText(`created ${result.bibPath}`, `${result.bibPath} を作成`)
        : result.appended
          ? uiText(`added to ${result.bibPath}`, `${result.bibPath} に追加`)
          : uiText(`already in ${result.bibPath}`, `${result.bibPath} に既存`);
      // Zotero answered after the editor moved on: the .bib has the entry,
      // the \cite is not placed in another document.
      if (!sameDocument()) {
        setStatus([documentChanged(), bibNote].join(" · "), true);
        return;
      }
      const line = editor.getPosition?.()?.lineNumber;
      const outcome = insertCitation(editor, result.key);
      // The dialog stays open for the next citation, so keep the keyboard here.
      search.focus();
      renderTarget();
      const where = line ? `L${line}` : "";
      const citeNote = outcome === "unavailable"
        ? uiText("not inserted", "挿入できません")
        : outcome === "present"
          ? uiText(`\\cite already has ${result.key}`, `\\cite に ${result.key} は既にあります`)
          : uiText(`inserted ${result.key} at ${where}`, `${where} に ${result.key} を挿入`);
      // The "add \bibliography{…}" reminder is said once per dialog.
      const hint = !result.named && !hinted ? bibHint(result) : "";
      if (hint) hinted = true;
      setStatus(`✓ ${[citeNote, bibNote, hint].filter(Boolean).join(" · ")}`);
    } catch (error) {
      setStatus(describeError(error, activeFilePath), true);
    } finally {
      busy = false;
      sync.disabled = false;
    }
  };

  const sync = button(uiText("Refresh cited entries", "引用済みを最新に更新"), () => {
    if (busy) return;
    busy = true;
    sync.disabled = true;
    setStatus(uiText("Refreshing…", "更新中…"));
    const activeFilePath = getActiveFilePath();
    void call<SyncResult>("sync", { activeFilePath, documentMainFile: citationDocumentFor(activeFilePath) })
      .then((result) => {
        if (result.total === 0) {
          setStatus(uiText(`${result.bibPath}: no entries`, `${result.bibPath}: 項目なし`));
          return;
        }
        const parts = [
          uiText(`${result.updated} updated`, `更新 ${result.updated}`),
          uiText(`${result.unchanged} unchanged`, `変更なし ${result.unchanged}`),
        ];
        if (result.notFound) parts.push(uiText(`${result.notFound} not found`, `見つからず ${result.notFound}`));
        setStatus(`${result.bibPath}: ${parts.join(" · ")}`);
      })
      .catch((error) => setStatus(describeError(error, activeFilePath), true))
      .finally(() => {
        busy = false;
        sync.disabled = false;
      });
  });
  sync.title = uiText("Brings the entries already in this document's .bib up to date with Zotero.", "この文書の .bib にある文献を、Zotero の最新の内容に合わせます。");
  const close = button(uiText("Close", "閉じる"), () => dialog.close());
  actions.append(sync, node("span", "tool-dialog-spacer"), close);

  library.addEventListener("change", () => {
    const chosen = library.value;
    void call<ZoteroStatus>("settings", { library: chosen })
      .then((next) => {
        current = next;
        renderConnection();
        void runSearch();
      })
      .catch((error) => setStatus(describeError(error), true));
  });
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

  renderTarget();
  dialog.append(eyebrow, heading, target, controls, listLabel, results, status, actions);
  document.body.append(dialog);
  dialog.showModal();
  search.focus();
  empty("", uiText("Checking…", "確認中…"));

  void call<ZoteroStatus>("status")
    .then((next) => {
      current = next;
      renderConnection();
      void runSearch();
    })
    .catch((error) => {
      empty("", describeError(error));
    });
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
    // A view-only guest's .bib is the host's; nothing is cited from there.
    precondition: isTex ? "tex64.isTexFile && !tex64CollabViewer" : "!tex64CollabViewer",
    run: () => openZoteroDialog(editor, getActiveFilePath),
  });
};

// ---- Settings → Zotero -----------------------------------------------------

export const initZoteroSettingsUi = () => {
  const apiKeyInput = document.getElementById("settings-zotero-api-key");
  const librarySelect = document.getElementById("settings-zotero-library");
  const statusLine = document.getElementById("settings-zotero-status");
  const keysLink = document.getElementById("settings-zotero-open-keys");
  const navItem = document.querySelector<HTMLElement>('.settings-nav-item[data-settings-target="zotero"]');
  if (!bridge() || !(apiKeyInput instanceof HTMLInputElement) || !(librarySelect instanceof HTMLSelectElement) || !(statusLine instanceof HTMLElement)) return;

  if (keysLink instanceof HTMLButtonElement) {
    keysLink.textContent = uiText("Create an API key", "API キーを発行");
    keysLink.addEventListener("click", () => {
      (window as any).tex64Bridge?.postMessage?.({ type: "shell:openExternal", url: ZOTERO_KEYS_URL });
    });
  }

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
      librarySelect.append(option);
    }
    librarySelect.value = status.library;
    apiKeyInput.placeholder = status.hasApiKey ? "••••••••••••" : uiText("Paste a Zotero API key", "Zotero の API キーを貼り付け");
    statusLine.textContent = status.transport ? describeStatus(status) : uiText("Not connected", "未接続");
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

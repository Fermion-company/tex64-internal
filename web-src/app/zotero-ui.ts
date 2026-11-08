// "Insert citation…": one dialog with two result sections, Zotero (the
// library, instant) and arXiv (arxiv-search-ui.ts, over the network), a .bib
// sync button, and the Settings → Zotero page. Everything that talks to Zotero
// runs in the main process behind `tex64Zotero`.

import { uiText } from "./i18n.js";
import { explainedHeading } from "./explain.js";
import { citationDocumentFor, insertCitation } from "./citation-insert.js";
import { ARXIV_CONTEXT_KEY, arxivBridge, createArxivSection, isArxivTexModel } from "./arxiv-search-ui.js";

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
  uiText("The document changed. Choose the insertion point again.", "文書が変更されました。挿入位置を選び直してください。");

const describeError = (error: unknown, activeFilePath: string | null = null) => {
  switch (errorCode(error)) {
    case "no-transport":
      return uiText("Start Zotero, or enter an API key in Settings → Zotero.", "Zoteroを起動するか、設定 → ZoteroでAPIキーを入れてください。");
    case "forbidden":
      return uiText("The API key was rejected.", "APIキーが拒否されました。");
    case "timeout":
      return uiText("Zotero did not answer in time.", "Zoteroの応答がありません。");
    case "unreachable":
      return uiText("Zotero is not running.", "Zoteroが起動していません。");
    case "not-found":
      return uiText("The item is no longer in the library.", "ライブラリにその項目がありません。");
    case "NO_MAIN_FILE":
      return uiText("Open a .tex document.", ".tex文書を開いてください。");
    case "NO_BIBTEX":
      return uiText("Could not get the BibTeX.", "BibTeXを取得できませんでした。");
    case "NO_SAFE_STORAGE":
      return uiText("This computer cannot store the key securely.", "このPCでは鍵を安全に保存できません。");
    // The project closed while Zotero answered; nothing was written.
    case "STALE_WORKSPACE":
      return documentChanged();
    // The .bib is written under the same lease as saves; Axiom holds it.
    case "AGENT_WORKSPACE_BUSY":
      return uiText("Axiom is editing this project. Try again when it finishes.", "Axiomがこのプロジェクトを編集中です。終わってからもう一度お試しください。");
    // The file belongs to several documents with different .bib files; Build's
    // chooser (or a % !TEX root line) settles which one.
    case "BUILD_TARGET_CHOICE":
      return activeFilePath
        ? uiText(`${activeFilePath} belongs to more than one document.`, `${activeFilePath}は複数の文書から読み込まれています。`)
        : uiText("This folder has several documents and no main file is set.", "このフォルダには文書が複数あり、メインTeXが決まっていません。");
    default:
      return error instanceof Error && error.message ? error.message : uiText("Zotero request failed.", "Zoteroとやり取りできませんでした。");
  }
};

const transportLabel = (status: ZoteroStatus) => {
  switch (status.transport) {
    case "bbt":
      return "Better BibTeX";
    case "local":
      return uiText("Zotero on this computer", "このPCのZotero");
    case "web":
      return status.probe.web.username ? `Zotero Web API (${status.probe.web.username})` : "Zotero Web API";
    default:
      return "";
  }
};

/** One line: where citations come from, or what to do to get connected. */
export const describeStatus = (status: ZoteroStatus) => {
  if (!status.transport) {
    return uiText("Start Zotero, or enter an API key in Settings → Zotero.", "Zoteroを起動するか、設定 → ZoteroでAPIキーを入れてください。");
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
  return uiText(`add ${command} to the document`, `文書に${command}を追加してください`);
};

// ---- Citation dialog ---------------------------------------------------------

let dialogOpen = false;

const SEARCH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="M10.6 10.6 14 14" stroke-linecap="round"/></svg>';

export const openCiteDialog = (editor: CitationEditor, getActiveFilePath: () => string | null) => {
  const zotero = Boolean(bridge());
  if (dialogOpen || (!zotero && !(arxivBridge() && isArxivTexModel(editor)))) return;
  dialogOpen = true;
  const model = editor.getModel?.();

  const dialog = node("dialog", "tool-dialog cite-dialog");
  const heading = node("h2", "tool-dialog-title", uiText("Insert citation", "引用を挿入"));
  heading.id = "cite-dialog-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  // Where the \cite goes: file and line.
  const target = node("p", "zotero-target");
  target.dataset.noI18n = "true";
  const renderTarget = () => {
    const path = getActiveFilePath();
    const line = editor.getPosition?.()?.lineNumber;
    target.replaceChildren();
    if (!path) return;
    target.append(node("code", "", line ? `${path}:${line}` : path));
  };

  const searchWrap = node("div", "zotero-search-wrap");
  searchWrap.innerHTML = SEARCH_ICON;
  const search = node("input", "tool-input zotero-search");
  // A plain text input: in a search input Escape clears the text instead of
  // closing the dialog.
  search.type = "text";
  search.placeholder = zotero ? uiText("Title, author or year", "題名・著者・年") : uiText("Search in English", "英語で検索");
  search.setAttribute("aria-label", search.placeholder);
  search.autocomplete = "off";
  search.spellcheck = false;
  searchWrap.append(search);
  const library = node("select", "zotero-library");
  library.setAttribute("aria-label", uiText("Library", "ライブラリ"));
  library.hidden = true;
  const controls = node("div", "zotero-controls");
  controls.append(searchWrap, library);
  // Each section is named by its source; with nothing typed, Zotero's list is
  // the library's newest items ("Recently added").
  const listLabel = node("p", "tool-dialog-label cite-section-label", "Zotero");
  const listDetail = node("span", "cite-section-detail");
  listLabel.append(listDetail);
  const setListLabel = (detail: string, visible = true) => {
    listDetail.textContent = detail;
    listLabel.hidden = !visible;
  };
  const results = node("div", "zotero-results");
  results.setAttribute("role", "listbox");
  const zoteroSection = node("section", "cite-section cite-zotero");
  zoteroSection.append(listLabel, results);
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
  // The results rebuild while the user types; an opened ▾ stays open.
  const explainOpen = new Set<string>();

  const setStatus = (text: string, isError = false) => {
    status.textContent = text;
    status.classList.toggle("is-error", isError);
  };

  const renderConnection = () => {
    const libraries = current?.libraries ?? [];
    library.replaceChildren(...libraries.map((entry) => new Option(entry.name, entry.id)));
    library.value = current?.library ?? "";
    library.hidden = libraries.length < 2;
  };

  const empty = (headline: string, text = "") => {
    const box = node("div", "zotero-empty");
    if (headline) box.append(node("strong", "", headline));
    if (text) box.append(node("span", "", text));
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
      const creator = item.creator ? ((item.creatorCount || 1) > 1 ? uiText(`${item.creator} et al.`, `${item.creator}ほか`) : item.creator) : "";
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

  // One quiet line where the Zotero results would be; what to do waits behind ▾.
  const notConnected = () => {
    setListLabel("", false);
    const open = button(uiText("Settings", "設定"), () => {
      dialog.close();
      (window as unknown as { tex64Bridge?: { postMessage: (message: unknown) => void } }).tex64Bridge?.postMessage({ type: "app:command", payload: { command: "settings:open" } });
      window.setTimeout(() => (document.querySelector('.settings-nav-item[data-settings-target="zotero"]') as HTMLElement | null)?.click(), 300);
    }, "is-quiet");
    const [line, panel] = explainedHeading(
      node("p", "zotero-off", uiText("Zotero is not connected", "Zoteroにつながっていません")),
      uiText("Start Zotero, or enter an API key in Settings → Zotero.", "Zoteroを起動するか、設定 → ZoteroでAPIキーを入れてください。"),
      { topic: "Zotero", memory: explainOpen, key: "connect" },
    );
    line.append(node("span", "tool-dialog-spacer"), open);
    results.replaceChildren(line, panel);
  };

  // With nothing typed: the library's newest items, where the door can list them.
  const showRecent = async (serial: number) => {
    setListLabel(uiText("Recently added", "最近追加した文献"));
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
        setListLabel("", false);
        results.replaceChildren();
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
    setListLabel("");
    empty("", uiText("Searching…", "検索中…"));
    try {
      const result = await call<{ items: ZoteroItem[] }>("search", { query });
      if (serial !== searchSerial) return;
      items = result.items;
      highlighted = 0;
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
        ? uiText(`created ${result.bibPath}`, `${result.bibPath}を作成`)
        : result.appended
          ? uiText(`added to ${result.bibPath}`, `${result.bibPath}に追加`)
          : uiText(`already in ${result.bibPath}`, `${result.bibPath}に既存`);
      // Zotero answered after the editor moved on: the .bib has the entry,
      // the \cite is not placed in another document.
      if (!sameDocument()) {
        setStatus([documentChanged(), bibNote].join(" · "), true);
        return;
      }
      const outcome = insertCitation(editor, result.key);
      // The dialog stays open for the next citation, so keep the keyboard here.
      search.focus();
      renderTarget();
      if (outcome === "unavailable") {
        setStatus(uiText("Could not insert the citation.", "引用を挿入できませんでした。"), true);
        return;
      }
      // Inserted is silent: the \cite is in the editor. What is left to say is
      // a key already cited there, or (once per dialog) the missing
      // \bibliography{…}.
      const hint = !result.named && !hinted ? bibHint(result) : "";
      if (hint) hinted = true;
      const present = outcome === "present"
        ? uiText(`\\cite already has ${result.key}`, `\\citeに${result.key}は既にあります`)
        : "";
      setStatus([present, hint].filter(Boolean).join(" · "));
    } catch (error) {
      setStatus(describeError(error, activeFilePath), true);
    } finally {
      busy = false;
      sync.disabled = false;
    }
  };

  // arXiv's section follows the Zotero one; it shows itself when results arrive.
  const arxiv = createArxivSection(editor, getActiveFilePath, setStatus);

  const sync = button(uiText("Sync .bib", ".bibを同期"), () => {
    if (busy) return;
    busy = true;
    sync.disabled = true;
    setStatus(uiText("Syncing…", "同期中…"));
    const activeFilePath = getActiveFilePath();
    void call<SyncResult>("sync", { activeFilePath, documentMainFile: citationDocumentFor(activeFilePath) })
      .then((result) => {
        if (result.total === 0) {
          setStatus(uiText(`${result.bibPath}: no entries`, `${result.bibPath}: 項目なし`));
          return;
        }
        const parts = [
          uiText(`${result.updated} updated`, `更新${result.updated}`),
          uiText(`${result.unchanged} unchanged`, `変更なし${result.unchanged}`),
        ];
        if (result.notFound) parts.push(uiText(`${result.notFound} not found`, `見つからず${result.notFound}`));
        setStatus(`${result.bibPath}: ${parts.join(" · ")}`);
      })
      .catch((error) => setStatus(describeError(error, activeFilePath), true))
      .finally(() => {
        busy = false;
        sync.disabled = false;
      });
  });
  sync.title = uiText("Brings the entries already in this document's .bib up to date with Zotero.", "この文書の .bibにある文献を、Zoteroの最新の内容に合わせます。");
  const close = button(uiText("Close", "閉じる"), () => dialog.close());
  if (zotero) actions.append(sync);
  actions.append(node("span", "tool-dialog-spacer"), close);

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
    arxiv?.setQuery(search.value);
    if (!zotero) return;
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runSearch(), 250);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); highlight(highlighted + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); highlight(highlighted - 1); }
    else if (event.key === "Enter") {
      // The highlighted Zotero item; with none, arXiv searches without waiting.
      event.preventDefault();
      if (items.length) void insert(highlighted);
      else arxiv?.searchNow();
    }
  });
  dialog.addEventListener("close", () => {
    dialogOpen = false;
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    arxiv?.dispose();
    dialog.remove();
    editor.focus?.();
  });

  renderTarget();
  const body = node("div", "cite-body");
  if (zotero) body.append(zoteroSection);
  if (arxiv) body.append(arxiv.element);
  dialog.append(heading, target, controls, body, status, actions);
  document.body.append(dialog);
  dialog.showModal();
  search.focus();
  if (!zotero) return;
  setListLabel("", false);
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

/**
 * The two commands that open the citation dialog, on every editor. The Zotero
 * one is the context-menu entry ("Insert citation…", LaTeX models); the arXiv
 * one stays a command (.tex files). Both open the same dialog.
 */
export const attachCitationEditor = (
  editor: any,
  getActiveFilePath: () => string | null
) => {
  if (typeof editor?.addAction !== "function") return;
  const open = () => openCiteDialog(editor, getActiveFilePath);
  if (bridge()) {
    const isTex = editor.createContextKey?.("tex64.isTexFile", false);
    const syncKey = () => isTex?.set(editor.getModel?.()?.getLanguageId?.() === "latex");
    syncKey();
    editor.onDidChangeModel?.(syncKey);
    editor.onDidChangeModelLanguage?.(syncKey);
    editor.addAction({
      id: "tex64.zotero.insert",
      label: uiText("Insert citation…", "引用を挿入…"),
      contextMenuGroupId: "9_cite",
      contextMenuOrder: 1,
      // A view-only guest's .bib is the host's; nothing is cited from there.
      precondition: isTex ? "tex64.isTexFile && !tex64CollabViewer" : "!tex64CollabViewer",
      run: open,
    });
  }
  if (arxivBridge()) {
    const texKey = editor.createContextKey?.(ARXIV_CONTEXT_KEY, isArxivTexModel(editor));
    editor.onDidChangeModel?.(() => texKey?.set(isArxivTexModel(editor)));
    editor.addAction({
      id: "tex64.arxiv.search",
      label: uiText("Search arXiv…", "arXivを検索…"),
      precondition: texKey ? `${ARXIV_CONTEXT_KEY} && !tex64CollabViewer` : "!tex64CollabViewer",
      run: open,
    });
  }
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
    keysLink.textContent = uiText("Create an API key", "APIキーを発行");
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
    apiKeyInput.placeholder = status.hasApiKey ? "••••••••••••" : "";
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

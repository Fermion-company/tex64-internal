import { createActionsMenu } from "./actions-menu.js";
import { uiText } from "./i18n.js";

type Snippet = { id: string; name: string; prefix: string; body: string };
let items: Snippet[] = [];
let revision = 0;
let activeEditor: any;
let registered = false;
let modalOpen = false;
const bridge = () => (window as any).tex64Snippets;
const call = async (action: string, payload: any = {}) => {
  const result = await bridge().call(action, payload);
  if (!result.ok) throw new Error(result.error);
  items = result.items; revision = result.revision;
  return result;
};

export const attachSnippetEditor = (editor: any, monaco: any) => {
  if (!bridge()) return;
  activeEditor ||= editor;
  editor.onDidFocusEditorText(() => { activeEditor = editor; });
  editor.addAction({ id: "tex64.snippets", label: uiText("Snippets…", "スニペット…"), contextMenuGroupId: "9_snippets", contextMenuOrder: 1, run: () => openSnippets(editor) });
  if (registered) return;
  registered = true;
  void call("list").catch(() => {});
  for (const language of ["latex", "bibtex"]) monaco.languages.registerCompletionItemProvider(language, {
    provideCompletionItems: (model: any, position: any) => {
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const prefix = before.match(/\\?[A-Za-z0-9_-]+$/)?.[0] || "";
      if (!prefix) return { suggestions: [] };
      return { suggestions: items.filter((item) => item.prefix.startsWith(prefix)).map((item) => ({
        label: item.prefix, detail: item.name, kind: monaco.languages.CompletionItemKind.Snippet,
        insertText: item.body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range: { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: position.column - prefix.length, endColumn: position.column },
      })) };
    },
  });
};

export const openSnippets = (editor = activeEditor) => {
  if (modalOpen || !bridge()) return;
  modalOpen = true;
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  const modelVersion = model?.getVersionId();
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const value = document.createElement(tag); value.textContent = text; return value; };
  const dialog = node("dialog"); dialog.className = "snippets-dialog";
  const lifecycle = new AbortController();
  const heading = node("h2", uiText("Snippets", "スニペット")); heading.id = "snippets-title"; dialog.setAttribute("aria-labelledby", heading.id);
  const error = node("p"); error.className = "snippets-error"; error.setAttribute("role", "status");
  const search = node("input"); search.type = "search"; search.placeholder = uiText("Search snippets", "スニペットを検索"); search.setAttribute("aria-label", search.placeholder);
  const list = node("div"); list.className = "snippets-list";
  const name = node("input"); name.maxLength = 120;
  const prefix = node("input"); prefix.maxLength = 65;
  const body = node("textarea"); body.rows = 10; body.spellcheck = false; body.maxLength = 65536;
  const form = node("div"); form.className = "snippets-form";
  for (const [text, input] of [[uiText("Name", "名前"), name], [uiText("Trigger text", "呼び出し文字"), prefix], [uiText("LaTeX code", "LaTeXコード"), body]] as const) {
    const label = node("label", text); label.append(input); form.append(label);
    if (input === prefix) form.append(node("p", uiText("Type this in your document and choose a suggestion.", "本文に入力して、補完候補から選択します。")));
  }
  form.append(node("p", uiText("Use ${1:placeholder}, ${2} and $0. After insertion, Tab moves between placeholders.", "${1:初期値}、${2}、$0 を使用。挿入後、Tabで入力箇所を移動します。")));
  const saveState = node("p"); saveState.setAttribute("role", "status"); form.prepend(saveState);
  let selected = "";
  let baseline = "";
  let busy = false;
  const draft = () => JSON.stringify([name.value, prefix.value, body.value]);
  const mayLeave = () => draft() === baseline || window.confirm(uiText("Discard the unsaved snippet changes?", "保存していないスニペットの変更を破棄しますか？"));
  const button = (text: string, fn: () => void) => { const el = node("button", text); el.type = "button"; el.addEventListener("click", fn); return el; };
  const render = () => {
    list.replaceChildren();
    for (const item of items.filter((item) => `${item.name} ${item.prefix} ${item.body}`.toLowerCase().includes(search.value.toLowerCase()))) {
      const row = button(`${item.name} · ${item.prefix}`, () => { if (!busy && mayLeave()) load(item); });
      row.setAttribute("aria-pressed", String(item.id === selected)); list.append(row);
    }
    if (!list.childElementCount) list.append(node("p", uiText("No snippets", "スニペットはありません")));
    const dirty = draft() !== baseline;
    saveState.textContent = dirty ? uiText("Unsaved changes", "未保存の変更") : selected ? uiText("Saved", "保存済み") : "";
    remove.disabled = !selected || busy; save.disabled = busy || !dirty; save.hidden = !dirty;
    for (const input of [name, prefix, body]) input.disabled = busy;
    insert.textContent = dirty ? uiText("Save & insert", "保存して挿入") : uiText("Insert", "挿入");
    insert.disabled = busy || !model || !body.value.trim();
  };
  const load = (item?: Snippet) => {
    selected = item?.id || ""; name.value = item?.name || ""; prefix.value = item?.prefix || ""; body.value = item?.body || "";
    baseline = draft(); render();
  };
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true; error.textContent = ""; render();
    try { await fn(); } catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); }
    finally { busy = false; render(); }
  };
  const saveDraft = async () => {
    const item = { id: selected || undefined, name: name.value, prefix: prefix.value, body: body.value };
    await call("save", { revision, item });
    const saved = items.find((entry) => entry.prefix === item.prefix.trim());
    if (!saved) throw new Error(uiText("The saved snippet could not be loaded.", "保存したスニペットを読み込めませんでした。"));
    load(saved);
    return saved;
  };
  const save = button(uiText("Save", "保存"), () => void run(async () => { await saveDraft(); }));
  const remove = button(uiText("Delete snippet…", "スニペットを削除…"), () => {
    if (!window.confirm(uiText(`Delete “${items.find((item) => item.id === selected)?.name}”? This removes the snippet from all projects on this computer.`, `「${items.find((item) => item.id === selected)?.name}」を削除しますか？このPCの全プロジェクトで使うスニペットが削除されます。`))) return;
    void run(async () => { await call("delete", { revision, id: selected }); load(); });
  });
  const insert = button(uiText("Insert", "挿入"), () => void run(async () => {
    const needsSave = draft() !== baseline;
    const text = needsSave ? (await saveDraft()).body : body.value;
    if (!editor || editor.getModel() !== model || model.isDisposed() || model.getVersionId() !== modelVersion || editor.getRawOptions().readOnly) {
      throw new Error(needsSave
        ? uiText("Snippet saved. The document changed, so nothing was inserted. Close snippets and select the insertion point again.", "スニペットは保存済みです。文書が変更されたため挿入しませんでした。閉じて挿入位置を選び直してください。")
        : uiText("The document changed. Close snippets and select the insertion point again.", "文書が変更されました。閉じて挿入位置を選び直してください。"));
    }
    const controller = editor.getContribution("snippetController2");
    if (!controller?.insert) throw new Error(uiText("Snippet insertion is unavailable.", "スニペット挿入を利用できません。"));
    dialog.close(); editor.focus(); editor.setSelection(selection);
    controller.insert(text);
  }));
  insert.classList.add("is-primary");
  const close = button(uiText("Close", "閉じる"), () => { if (!busy && mayLeave()) dialog.close(); });
  const actions = node("div"); actions.className = "snippets-actions"; actions.append(save, insert, close);
  const library = node("div"); library.className = "snippets-library";
  library.append(search, button(uiText("New snippet", "新規作成"), () => { if (!busy && mayLeave()) { load(); name.focus(); } }), list);
  const reload = button(uiText("Reload snippets", "スニペットを再読み込み"), () => { if (!busy && mayLeave()) void run(async () => { await call("list"); load(); }); });
  const header = node("div"); header.className = "snippets-heading";
  header.append(heading, createActionsMenu([remove, reload], lifecycle.signal));
  const scope = node("p", uiText("Available in all projects on this computer", "このPCの全プロジェクトで使用")); scope.className = "snippets-scope";
  const columns = node("div"); columns.className = "snippets-columns"; columns.append(library, form);
  dialog.append(header, scope, columns, error, actions);
  search.addEventListener("input", render);
  for (const input of [name, prefix, body]) input.addEventListener("input", render);
  dialog.addEventListener("cancel", (event) => { if (busy || !mayLeave()) event.preventDefault(); });
  dialog.addEventListener("close", () => { modalOpen = false; lifecycle.abort(); dialog.remove(); });
  document.body.append(dialog); load(); dialog.showModal();
  void run(async () => { await call("list"); render(); });
};

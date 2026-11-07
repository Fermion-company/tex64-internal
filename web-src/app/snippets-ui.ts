import { createActionsMenu } from "./actions-menu.js";
import { uiText } from "./i18n.js";
import { createExplain } from "./explain.js";

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
  const search = node("input"); search.type = "search"; search.placeholder = uiText("Search", "検索"); search.setAttribute("aria-label", search.placeholder);
  // The dialog opens on the search box, not on the heading's ▾.
  search.autofocus = true;
  const list = node("div"); list.className = "snippets-list";
  const name = node("input"); name.maxLength = 120;
  const prefix = node("input"); prefix.maxLength = 65;
  const body = node("textarea"); body.rows = 10; body.spellcheck = false; body.maxLength = 65536;
  const form = node("div"); form.className = "snippets-form";
  const fields = [
    [uiText("Name", "名前"), name, ""],
    [uiText("Trigger text", "呼び出し文字"), prefix, uiText("Type this in your document and choose a suggestion.", "本文に入力して、補完候補から選択します。")],
    [uiText("Code", "コード"), body, uiText("Use ${1:placeholder}, ${2} and $0. After insertion, Tab moves between placeholders.", "${1:初期値}、${2}、$0 を使用。挿入後、Tabで入力箇所を移動します。")],
  ] as const;
  for (const [text, input, explanation] of fields) {
    if (!explanation) {
      const label = node("label"); label.append(node("span", text), input); form.append(label);
      continue;
    }
    // The ▾ sits beside the field's name and its text opens between the name
    // and the field, so the name is a sibling label pointing at the field.
    const explain = createExplain(explanation, { topic: text });
    const label = node("label", text); input.id = `${explain.panel.id}-field`; label.htmlFor = input.id;
    const head = node("div"); head.className = "has-explain"; head.append(label, explain.button);
    const field = node("div"); field.className = "snippets-field"; field.append(head, explain.panel, input);
    form.append(field);
  }
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
    saveState.textContent = dirty ? uiText("Unsaved", "未保存") : selected ? uiText("Saved", "保存済み") : "";
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
  const remove = button(uiText("Delete…", "削除…"), () => {
    if (!window.confirm(uiText(`Delete “${items.find((item) => item.id === selected)?.name}”? This removes the snippet from all projects on this computer.`, `「${items.find((item) => item.id === selected)?.name}」を削除しますか？このPCの全プロジェクトで使うスニペットが削除されます。`))) return;
    void run(async () => { await call("delete", { revision, id: selected }); load(); });
  });
  const insert = button(uiText("Insert", "挿入"), () => void run(async () => {
    const needsSave = draft() !== baseline;
    const text = needsSave ? (await saveDraft()).body : body.value;
    if (!editor || editor.getModel() !== model || model.isDisposed() || model.getVersionId() !== modelVersion || editor.getRawOptions().readOnly) {
      throw new Error(needsSave
        ? uiText("Saved. The document changed, so nothing was inserted. Select the insertion point again.", "保存しました。文書が変更されたため挿入していません。挿入位置を選び直してください。")
        : uiText("The document changed. Select the insertion point again.", "文書が変更されました。挿入位置を選び直してください。"));
    }
    const controller = editor.getContribution("snippetController2");
    if (!controller?.insert) throw new Error(uiText("Snippet insertion is unavailable.", "スニペット挿入を利用できません。"));
    dialog.close(); editor.focus(); editor.setSelection(selection);
    controller.insert(text);
  }));
  insert.classList.add("is-primary");
  const close = button(uiText("Close", "閉じる"), () => { if (!busy && mayLeave()) dialog.close(); });
  const actions = node("div"); actions.className = "snippets-actions"; actions.append(close, save, insert);
  const library = node("div"); library.className = "snippets-library";
  library.append(search, button(uiText("New", "新規"), () => { if (!busy && mayLeave()) { load(); name.focus(); } }), list);
  const reload = button(uiText("Reload", "再読み込み"), () => { if (!busy && mayLeave()) void run(async () => { await call("list"); load(); }); });
  const header = node("div"); header.className = "snippets-heading";
  header.append(heading, createActionsMenu([remove, reload], lifecycle.signal));
  const scope = createExplain(uiText("Available in all projects on this computer", "このPCの全プロジェクトで使用"), {topic: uiText("snippets", "スニペット")});
  heading.classList.add("has-explain"); heading.append(scope.button);
  const columns = node("div"); columns.className = "snippets-columns"; columns.append(library, form);
  dialog.append(header, scope.panel, columns, error, actions);
  search.addEventListener("input", render);
  for (const input of [name, prefix, body]) input.addEventListener("input", render);
  dialog.addEventListener("cancel", (event) => { if (busy || !mayLeave()) event.preventDefault(); });
  dialog.addEventListener("close", () => { modalOpen = false; lifecycle.abort(); dialog.remove(); });
  document.body.append(dialog); load(); dialog.showModal();
  void run(async () => { await call("list"); render(); });
};

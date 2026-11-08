// The editor's right-click menu: about ten items in at most four groups, all
// in the UI language, with Bold / Italic / Emphasize / Monospace under one
// "Text Style ▸". Monaco still builds, draws and drives the menu; this only
// reshapes its list just before it opens (the context-menu contribution's
// _getMenuActions). What is left out (Peek, Go to Symbol, Change All
// Occurrences, Command Palette and any other Monaco item) keeps its shortcut
// and its place in the command palette (F1). If Monaco's internals ever differ,
// the stock menu shows unchanged.

import { uiText } from "./i18n.js";

type MenuAction = { id: string; label: string; actions?: readonly MenuAction[] };
type SubmenuClass = new (id: string, label: string, actions: MenuAction[]) => MenuAction;
type MenuController = {
  _getMenuActions?: (model: unknown, menuId: unknown) => MenuAction[];
  _menuService?: { getMenuActions?: (menuId: unknown, contextKeyService: unknown, options?: unknown) => Array<[string, MenuAction[]]> };
  _contextKeyService?: object;
};

const SEPARATOR_ID = "vs.actions.separator";
// Actions added with editor.addAction carry the editor's id in front of their own.
const EDITOR_ACTION_PREFIX = /^vs\.editor\.ICodeEditor:\d+:/;

// Monaco's own items that stay, in the UI language.
const BUILTIN_LABELS: Record<string, () => string> = {
  "editor.action.revealDefinition": () => uiText("Go to Definition", "定義へ移動"),
  "editor.action.goToReferences": () => uiText("Go to References", "参照を検索"),
  "editor.action.rename": () => uiText("Rename Symbol", "名前を変更"),
  "editor.action.formatDocument": () => uiText("Format Document", "ドキュメントを整形"),
  "editor.action.formatSelection": () => uiText("Format Selection", "選択範囲を整形"),
  "editor.action.clipboardCutAction": () => uiText("Cut", "切り取り"),
  "editor.action.clipboardCopyAction": () => uiText("Copy", "コピー"),
  "editor.action.clipboardPasteAction": () => uiText("Paste", "貼り付け"),
};

const TEXT_STYLE = "text-style";
const TEXT_STYLE_ITEMS = ["tex64.wrap.textbf", "tex64.wrap.textit", "tex64.wrap.emph", "tex64.wrap.texttt"];
// Top to bottom, a rule between groups. An id ending in "." takes every item
// that starts with it (the comment actions are numbered per editor group).
const GROUPS: string[][] = [
  ["editor.action.revealDefinition", "editor.action.goToReferences", "editor.action.rename", "editor.action.formatDocument", "editor.action.formatSelection"],
  ["editor.action.clipboardCutAction", "editor.action.clipboardCopyAction", "editor.action.clipboardPasteAction"],
  [TEXT_STYLE, "tex64.zotero.insert", "tex64.snippets", "tex64.comments.", "tex64.spell.addWordToDictionary"],
  ["tex64.ai-edit-selection", "tex64.voice-edit", "tex64.pro-canvas-edit"],
];
// The group that takes any other TeX64 item, so none of the app's own is lost.
const APP_GROUP = 2;

// Monaco keeps its submenu class to itself. Every submenu entry the menu
// service hands out is built on it, so one is asked for with every condition
// taken as true (the Peek submenu then always has entries) and the class is
// read from its prototype. Found once; null means the styles stay a flat group.
let submenuClass: SubmenuClass | null | undefined;
const findSubmenuClass = (controller: MenuController, model: { uri?: unknown }, menuId: unknown): SubmenuClass | null => {
  if (submenuClass !== undefined) return submenuClass;
  submenuClass = null;
  try {
    const real = controller._contextKeyService;
    const getMenuActions = controller._menuService?.getMenuActions;
    if (!real || typeof getMenuActions !== "function") return null;
    const everything = new Proxy(real, {
      get: (target, property) => {
        if (property === "contextMatchesRules") return () => true;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const groups = getMenuActions.call(controller._menuService, menuId, everything, { arg: model?.uri }) ?? [];
    for (const [, actions] of groups) {
      for (const action of actions) {
        const base = (action as { item?: { submenu?: unknown } }).item?.submenu ? Object.getPrototypeOf(action.constructor) : null;
        if (typeof base === "function" && base !== Function.prototype) {
          submenuClass = base as SubmenuClass;
          return submenuClass;
        }
      }
    }
  } catch {
    // The stock list still shows; the styles are a flat group.
  }
  return submenuClass;
};

export type EditorContextMenuOptions = {
  // Items that apply only somewhere: "Add to dictionary" on a flagged word,
  // "Edit in canvas" inside a figure block. Keyed by action id.
  applies?: Record<string, () => boolean>;
};

export const installEditorContextMenu = (editor: any, options: EditorContextMenuOptions = {}) => {
  const controller = editor?.getContribution?.("editor.contrib.contextmenu") as MenuController | null;
  const original = controller?._getMenuActions;
  if (!controller || typeof original !== "function") return;

  const reshape = (model: { uri?: unknown }, menuId: unknown, actions: MenuAction[]): MenuAction[] => {
    const separator = actions.find((action) => action.id === SEPARATOR_ID);
    const byId = new Map<string, MenuAction>();
    for (const action of actions) {
      // Separators are redrawn below; Monaco's own submenus (Peek) are left out.
      if (action.id === SEPARATOR_ID || Array.isArray(action.actions)) continue;
      const id = action.id.replace(EDITOR_ACTION_PREFIX, "");
      if (options.applies?.[id] && !options.applies[id]()) continue;
      byId.set(id, action);
    }
    const used = new Set<string>();
    const take = (key: string): MenuAction[] => {
      const ids = key.endsWith(".") ? [...byId.keys()].filter((id) => id.startsWith(key)) : byId.has(key) ? [key] : [];
      return ids.filter((id) => !used.has(id)).map((id) => {
        used.add(id);
        const action = byId.get(id)!;
        const label = BUILTIN_LABELS[id];
        if (label) action.label = label();
        return action;
      });
    };
    const groups = GROUPS.map((keys) => keys.flatMap((key) => {
      if (key !== TEXT_STYLE) return take(key);
      const styles = TEXT_STYLE_ITEMS.flatMap(take);
      const Submenu = styles.length ? findSubmenuClass(controller, model, menuId) : null;
      return Submenu ? [new Submenu("tex64.text-style", uiText("Text Style", "書式"), styles)] : styles;
    }));
    for (const id of byId.keys()) {
      if (id.startsWith("tex64.") && !used.has(id)) groups[APP_GROUP].push(...take(id));
    }
    const shaped: MenuAction[] = [];
    for (const group of groups.filter((items) => items.length)) {
      if (shaped.length && separator) shaped.push(new (separator.constructor as new () => MenuAction)());
      shaped.push(...group);
    }
    return shaped;
  };

  controller._getMenuActions = function (this: unknown, model: any, menuId: unknown) {
    const actions = original.call(controller, model, menuId);
    // Submenus are built by the same call; only the editor's own menu changes.
    if (menuId !== editor.contextMenuId) return actions;
    try {
      return reshape(model, menuId, actions);
    } catch {
      return actions;
    }
  };
};

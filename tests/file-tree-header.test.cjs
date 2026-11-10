"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const html = fs.readFileSync(path.join(__dirname, "../Resources/web/index.html"), "utf8");
const header = html.match(/<div class="workspace-header">([\s\S]*?)<div class="file-tree"/)[1];

// A small event DOM keeps these unit tests independent of Chromium/sockets.
// The real HTML, DOM refs, i18n, collaboration state and creation flow are used.
class Element {
  constructor() {
    this.listeners = {};
    this.attributes = {};
    this.dataset = {};
    this.textContent = "";
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type, extra = {}) {
    for (const listener of this.listeners[type] || []) {
      listener({ target: this, preventDefault() {}, ...extra });
    }
  }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
}
class Button extends Element {
  click() { if (!this.disabled) this.dispatch("click"); }
}
class Input extends Element {}

const setup = (t) => {
  const elements = new Map();
  for (const [, tag, attrs, id] of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const node = tag === "button" ? new Button() : tag === "input" ? new Input() : new Element();
    for (const [, key, value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(key, value);
    elements.set(id, node);
  }
  let receiveCollab;
  const globals = {
    HTMLElement: Element, HTMLButtonElement: Button, HTMLInputElement: Input, Element,
    Text: class {}, Document: class {}, DocumentFragment: class {},
    document: {
      documentElement: { dataset: {} },
      getElementById: (id) => elements.get(id) ?? null,
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {},
    },
    window: {
      addEventListener() {},
      tex64Collab: { onMessage: (listener) => { receiveCollab = listener; } },
    },
    localStorage: { setItem() {}, getItem: () => null },
    requestAnimationFrame: (fn) => fn(),
  };
  const originals = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const cache = new Map();
  let treeActions;
  const load = (file) => {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("exports", "require", code)(exports, (id) => {
      if (id === "./file-tree-render.js") return { createFileTreeRenderer: ({ actions }) => {
        treeActions = actions;
        return { render() {} };
      } };
      return load(path.resolve(path.dirname(file), id.replace(/\.js$/, ".ts")));
    });
    return exports;
  };
  const app = (name) => load(path.join(__dirname, "../web-src/app", name + ".ts"));
  const i18n = app("i18n");
  const dom = app("dom").getDomRefs();
  let root = "/tmp/project";
  let menu = [];
  const posts = [];
  const issues = [];
  const ui = app("file-tree-ui").initFileTreeUi({ dom }, {
    getWorkspaceRootKey: () => root,
    getWorkspaceName: () => "empty-proj",
    getWorkspaceFiles: () => [], getWorkspaceFolders: () => [],
    getActiveFilePath: () => "active/chapter.tex",
    getActiveEditorGroupKey: () => "primary",
    getDirtyPaths: () => new Set(), isAnyGroupComposing: () => false,
    contextMenu: { open: (_x, _y, items) => { menu = items; } },
    postToNative: (payload) => posts.push(payload),
    updateIssues: (...args) => issues.push(args),
  });
  return {
    dom, ui, posts, issues, i18n, treeActions,
    buttons: [dom.fileTreeNewFile, dom.fileTreeNewFolder],
    rootMenu: () => { menu = []; dom.fileTree.dispatch("contextmenu"); return menu; },
    setRoot: (value) => { root = value; ui.render(); },
    setCollab: (state) => receiveCollab({ type: "collab:state", ...state }),
  };
};

test("file header has two icon-only native buttons in file/folder Tab order", () => {
  const buttons = [...header.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.equal(buttons.length, 2);
  buttons.forEach(([, attributes, content], index) => {
    assert.match(attributes, new RegExp(`id="file-tree-new-${index ? "folder" : "file"}"`));
    assert.match(attributes, /class="bottom-panel-close"/);
    assert.match(attributes, /type="button"/);
    assert.doesNotMatch(attributes, /tabindex=/);
    assert.match(content, /width="16" height="16"/);
    assert.match(content, /aria-hidden="true"/);
    assert.equal(content.replace(/<[^>]+>/g, "").trim(), "");
  });
});

test("header and root menu use identical handlers and localized labels in every UI language", (t) => {
  const page = setup(t);
  for (const locale of [...page.i18n.SUPPORTED_LOCALES.map((item) => item.code), "en"]) {
    page.i18n.setUiLocale(locale);
    const items = page.rootMenu();
    page.buttons.forEach((button, index) => {
      assert.equal(button.listeners.click[0], items[index].action, "same function, not a second creation path");
      assert.equal(button.getAttribute("aria-label"), items[index].label, locale);
      assert.equal(button.title, items[index].label, locale);
      if (locale === "ja") assert.equal(button.title, index ? "新しいフォルダ…" : "新しいファイル…");
      if (locale === "en") assert.equal(button.title, index ? "New folder…" : "New file…");
    });
  }
});

test("header creation uses root naming and validation even with a nested selection or active file", (t) => {
  const page = setup(t);
  for (const [index, type] of ["createFile", "createFolder"].entries()) {
    for (const viaMenu of [false, true]) {
      page.ui.setSelection("selected/deep", "dir");
      const action = viaMenu ? page.rootMenu()[index].action : () => page.buttons[index].click();
      action();
      assert.equal(page.dom.createModalParent.textContent, "Workspace root");
      assert.equal(page.dom.createModal.getAttribute("aria-hidden"), "false");
      const before = page.posts.length;
      page.dom.createModalInput.value = "../outside";
      page.dom.createModalSubmit.click();
      assert.equal(page.posts.length, before);
      assert.equal(page.dom.createModalHelp.classList.contains("is-error"), true);
      page.dom.createModalInput.value = index ? " figures/ " : " intro.tex ";
      page.dom.createModalInput.dispatch("keydown", { key: "Enter" });
      assert.deepEqual(page.posts.at(-1), { type, path: index ? "figures" : "intro.tex" });
      assert.equal(page.dom.createModal.getAttribute("aria-hidden"), "true");
    }
  }
  // Subfolder and file context menus retain their existing relative parent.
  for (const items of [page.treeActions.buildFolderContextMenu("chapters"), page.treeActions.buildFileContextMenu("chapters/old.tex").slice(1)]) {
    items[0].action();
    page.dom.createModalInput.value = "new.tex";
    page.dom.createModalSubmit.click();
    assert.deepEqual(page.posts.at(-1), { type: "createFile", path: "chapters/new.tex" });
  }
});

test("header and menus share availability across project and collaboration changes", (t) => {
  const page = setup(t);
  const items = page.rootMenu().slice(0, 2);
  const check = (enabled) => page.buttons.forEach((button, index) => {
    assert.equal(button.disabled, !enabled);
    assert.equal(items[index].enabled, enabled);
    assert.equal(page.treeActions.buildFileContextMenu("chapter.tex")[index + 1].enabled, enabled);
    assert.equal(page.treeActions.buildFolderContextMenu("chapters")[index].enabled, enabled);
  });
  check(true);
  page.setRoot(null);
  check(false);
  assert.deepEqual(page.rootMenu(), []);
  page.setRoot("/tmp/other");
  check(true);
  page.buttons[0].click();
  page.setCollab({ active: true, role: "guest", access: "view" });
  check(false);
  page.dom.createModalInput.value = "must-not-create.tex";
  page.dom.createModalSubmit.click();
  assert.deepEqual(page.posts, [], "permission changed while the naming dialog was open");
  page.dom.createModalCancel.click();
  items[0].action(); // A previously opened menu must also recheck availability.
  page.buttons[1].dispatch("click");
  page.ui.requestCreate("file");
  assert.equal(page.dom.createModal.getAttribute("aria-hidden"), "true");
  page.setCollab({ active: true, role: "guest", access: "edit" });
  check(true);
  page.setCollab({ active: true, role: "host" });
  check(true);
  page.setCollab({ active: false });
  check(true);
});

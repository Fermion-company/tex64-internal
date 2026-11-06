"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// Just enough of the DOM for the Prism dialog: elements with children,
// listeners and the <dialog> open/close pair.
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.attributes = {};
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.type = "";
    this.id = "";
    this.open = false;
    this.offsetHeight = 0;
    this.style = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type) { for (const listener of this.listeners[type] || []) listener({ type, preventDefault() {}, stopPropagation() {} }); }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatch("close"); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); this.parent = null; }
  text() { return [this.textContent, ...this.children.map((child) => child.text())].filter(Boolean).join(" "); }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) { const found = child.find(predicate); if (found) return found; }
    return null;
  }
}

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

const setup = () => {
  const calls = [];
  const starts = [];
  let onProgress = null;
  const body = new FakeElement("body");
  globalThis.document = { createElement: (tag) => new FakeElement(tag), body };
  globalThis.window = {
    crypto: globalThis.crypto,
    addEventListener() {},
    setInterval: (fn, ms) => { const timer = setInterval(fn, ms); timer.unref?.(); return timer; },
    clearInterval: (timer) => clearInterval(timer),
    tex64Prism: {
      call: (action, payload = {}) => {
        calls.push({ action, payload });
        if (action === "start") { const pending = deferred(); starts.push({ payload, ...pending }); return pending.promise; }
        if (action === "build") return Promise.resolve({ ok: true, build: { ok: false, kind: "failure", issues: [], issueCount: 0, pdfPath: null, installed: [] }, diff: null });
        return Promise.resolve({ ok: true });
      },
      pathForFile: () => "",
      onChange: (handler) => { onProgress = handler; return () => {}; },
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "../web-src/app/prism-import-ui.ts"), "utf8");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const i18n = { getUiLocale: () => "en", uiText: (english) => english };
  new Function("exports", "require", "module", javascript)(module.exports, (id) => (id === "./i18n.js" ? i18n : require(id)), module);
  const deps = { opened: [], runtime: 0 };
  const ui = module.exports.initPrismImportUi({
    openProjectPath: (root) => deps.opened.push(root),
    getWorkspaceRoot: () => null,
    showIssues: () => {},
    requestRuntimeSetup: () => { deps.runtime += 1; },
  });
  const dialog = () => body.children.find((node) => node.tagName === "DIALOG") ?? null;
  const steps = () => dialog()?.find((node) => node.className === "prism-steps").children.map((item) => item.text()) ?? [];
  const closeButton = () => dialog().find((node) => node.tagName === "BUTTON" && node.textContent === "Close");
  return { ui, calls, starts, progress: (payload) => onProgress(payload), dialog, steps, closeButton, deps };
};

const startedResult = (sessionId) => ({
  ok: true,
  sessionId,
  destination: "/tmp/export",
  env: { ready: true, hasEngine: true, distribution: "Test TeX", autoInstall: false },
  projects: [{
    id: "project-1",
    name: "paper",
    root: "/tmp/export/paper",
    analysis: { mainFile: "main.tex", candidates: ["main.tex"], texFiles: ["main.tex"], engine: "pdflatex", bibTool: "none", packages: [], prismPdf: null, conversations: [] },
    notes: [],
    missingPackages: [],
  }],
});

test("closing while the zip unpacks ends that session and its late result is dropped", async (t) => {
  const page = setup();
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  page.ui.start("/tmp/a.zip");
  assert.equal(page.starts.length, 1);
  const id = page.starts[0].payload.sessionId;
  assert.equal(typeof id, "string");
  assert.ok(id.length >= 8);
  // Progress for this id moves the steps before `start` returns; another id does not.
  page.progress({ sessionId: id, step: "extract", status: "running", current: 3, total: 10 });
  page.progress({ sessionId: "someone-else", step: "extract", status: "running", current: 9, total: 10 });
  assert.match(page.steps()[0], /Unpack 3\/10/);

  page.closeButton().dispatch("click");
  assert.equal(page.dialog(), null);
  assert.deepEqual(page.calls.filter((call) => call.action === "end").map((call) => call.payload), [{ sessionId: id }]);

  page.starts[0].resolve(startedResult(id));
  await flush();
  await flush();
  assert.equal(page.dialog(), null, "the dialog came back for a closed import");
  assert.equal(page.calls.some((call) => call.action === "build"), false, "a closed import started a build");
  assert.equal(page.deps.runtime, 0);
});

test("reopening while the first zip unpacks: the first result neither builds nor touches the new dialog", async (t) => {
  const page = setup();
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  page.ui.start("/tmp/a.zip");
  const first = page.starts[0].payload.sessionId;
  page.closeButton().dispatch("click");
  page.ui.start("/tmp/b.zip");
  assert.equal(page.starts.length, 2);
  const second = page.starts[1].payload.sessionId;
  assert.notEqual(second, first);
  const before = page.steps();

  page.progress({ sessionId: first, step: "extract", status: "running", current: 7, total: 10 });
  page.starts[0].resolve(startedResult(first));
  await flush();
  await flush();
  assert.deepEqual(page.steps(), before, "the first import changed the second dialog");
  assert.equal(page.calls.some((call) => call.action === "build"), false);

  page.starts[1].resolve(startedResult(second));
  await flush();
  await flush();
  const builds = page.calls.filter((call) => call.action === "build");
  assert.equal(builds.length, 1);
  assert.equal(builds[0].payload.sessionId, second);
  page.closeButton().dispatch("click");
  assert.deepEqual(page.calls.filter((call) => call.action === "end").map((call) => call.payload.sessionId), [first, second]);
});

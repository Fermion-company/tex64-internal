"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const { WorkspaceManager, WorkspaceError } = require("../electron/services/workspace.cjs");
const { createWorkspaceContext } = require("../electron/handlers/workspace/context.cjs");
const { createWorkspaceFileHandlers } = require("../electron/handlers/workspace/file-handlers.cjs");

// Edits to an open file that do not come from its keyboard: another program
// rewrites the file (file:externalChange) or Axiom writes it
// (agent:applyContent), while the person may be typing. The production
// renderer session modules run against a fake Monaco that moves the caret
// and decorations through edits the way Monaco does, and against the real
// main-process open/save handlers (so autosave's disk guard is real).
//
// TEX64_WEB_SRC_APP=<dir> runs the same scenarios against another copy of
// web-src/app (e.g. `git archive HEAD web-src/app`) to see them fail there.
const APP = process.env.TEX64_WEB_SRC_APP || path.join(__dirname, "../web-src/app");
const noop = () => {};
const LINE = 20;

// ── Fake DOM (only what the conflict bar uses) ──
class FakeElement {
  constructor(tag) { this.tag = tag; this.children = []; this.parentElement = null; this.listeners = {}; this.id = ""; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
}
const documentRoot = new FakeElement("root");
documentRoot.root = true;
const findById = (node, id) => {
  if (node.id === id) return node;
  for (const child of node.children) { const hit = findById(child, id); if (hit) return hit; }
  return null;
};
globalThis.document = { getElementById: (id) => findById(documentRoot, id), createElement: (tag) => new FakeElement(tag) };

// ── Fake Monaco ──
const lineInfo = (text) => {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\r" && text[i + 1] === "\n") { lines.push({ start, length: i - start }); start = i + 2; i += 1; }
    else if (text[i] === "\n" || text[i] === "\r") { lines.push({ start, length: i - start }); start = i + 1; }
  }
  lines.push({ start, length: text.length - start });
  return lines;
};
class FakeModel {
  constructor(value) {
    this.bom = value.startsWith("﻿") ? "﻿" : "";
    const body = value.slice(this.bom.length);
    this.eol = (body.match(/\r\n/g) ?? []).length > (body.match(/(^|[^\r])\n/g) ?? []).length ? "\r\n" : "\n";
    this.text = body.replace(/\r\n|\r|\n/g, this.eol);
    this.cursor = 0;
    this.decorations = new Map();
    this.nextDecoration = 1;
    this.edits = [];
    this.setValueCalls = 0;
    this.language = "latex";
    this.contentListeners = [];
  }
  onDidChangeContent(listener) {
    this.contentListeners.push(listener);
    return { dispose: () => { this.contentListeners = this.contentListeners.filter((l) => l !== listener); } };
  }
  emit(event) { this.contentListeners.forEach((listener) => listener(event)); }
  getValue(_eol, preserveBOM = false) { return (preserveBOM ? this.bom : "") + this.text; }
  getEOL() { return this.eol; }
  getLanguageId() { return this.language; }
  setValue(value) {
    this.setValueCalls += 1;
    this.text = value.replace(/\r\n|\r|\n/g, this.eol);
    this.cursor = 0;
    this.emit({ isFlush: true, changes: [] });
  }
  // Like Monaco: a position never points inside a line break.
  getPositionAt(offset) {
    const lines = lineInfo(this.text);
    offset = Math.max(0, Math.min(offset, this.text.length));
    let i = lines.length - 1;
    while (i > 0 && lines[i].start > offset) i -= 1;
    return { lineNumber: i + 1, column: Math.min(offset - lines[i].start, lines[i].length) + 1 };
  }
  getOffsetAt({ lineNumber, column }) {
    const lines = lineInfo(this.text);
    const line = lines[Math.max(0, Math.min(lineNumber - 1, lines.length - 1))];
    return line.start + Math.max(0, Math.min(column - 1, line.length));
  }
  getFullModelRange() {
    const end = this.getPositionAt(this.text.length);
    return { startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column };
  }
  pushStackElement() {}
  pushEditOperations(_before, edits) { this.applyEdits(edits); return null; }
  applyEdits(edits) {
    const ops = edits.map((edit) => ({
      start: this.getOffsetAt({ lineNumber: edit.range.startLineNumber, column: edit.range.startColumn }),
      end: this.getOffsetAt({ lineNumber: edit.range.endLineNumber, column: edit.range.endColumn }),
      text: edit.text.replace(/\r\n|\r|\n/g, this.eol),
      force: edit.forceMoveMarkers === true,
    })).sort((a, b) => b.start - a.start);
    const changes = [];
    for (const op of ops) {
      changes.push({ rangeOffset: op.start, rangeLength: op.end - op.start, text: op.text });
      this.edits.push({ ...op, removed: this.text.slice(op.start, op.end) });
      this.text = this.text.slice(0, op.start) + op.text + this.text.slice(op.end);
      const delta = op.text.length - (op.end - op.start);
      // Cursors and decorations are tracked ranges: before the edit they stay,
      // after it they shift, inside a replaced range they collapse.
      const move = (pos, afterInsert) => {
        if (pos < op.start) return pos;
        if (pos === op.start && op.start === op.end) return afterInsert || op.force ? pos + op.text.length : pos;
        if (pos === op.start) return pos;
        if (pos >= op.end) return pos + delta;
        return op.force ? op.start + op.text.length : op.start;
      };
      this.cursor = move(this.cursor, false);
      for (const [id, offset] of this.decorations) this.decorations.set(id, move(offset, true));
    }
    if (changes.length) this.emit({ isFlush: false, changes });
  }
  deltaDecorations(old, next) {
    old.forEach((id) => this.decorations.delete(id));
    return next.map((decoration) => {
      const id = `d${this.nextDecoration++}`;
      this.decorations.set(id, this.getOffsetAt({ lineNumber: decoration.range.startLineNumber, column: decoration.range.startColumn }));
      return id;
    });
  }
  getDecorationRange(id) {
    if (!this.decorations.has(id)) return null;
    const p = this.getPositionAt(this.decorations.get(id));
    return { startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber, endColumn: p.column };
  }
  // The caret shown with its neighbours, e.g. "line 30 te|xt".
  caretText() {
    const lines = lineInfo(this.text);
    const p = this.getPositionAt(this.cursor);
    const line = this.text.slice(lines[p.lineNumber - 1].start, lines[p.lineNumber - 1].start + lines[p.lineNumber - 1].length);
    return `${line.slice(0, p.column - 1)}|${line.slice(p.column - 1)}`;
  }
}

const makeGroup = (key, calls) => {
  let model = null;
  let scrollTop = 0;
  let mode = "hidden";
  const container = new FakeElement("div");
  documentRoot.appendChild(container);
  const dom = container.appendChild(new FakeElement("div"));
  const editor = {
    setModel: (value) => { model = value; },
    getModel: () => model,
    getValue: () => model.getValue(),
    focus: () => calls.push(`focus:${key}`),
    saveViewState: () => ({ cursor: model.getPositionAt(model.cursor), scrollTop }),
    restoreViewState: (state) => { model.cursor = model.getOffsetAt(state.cursor); scrollTop = state.scrollTop; },
    executeEdits: (_source, edits) => model.applyEdits(edits),
    deltaDecorations: (old, next) => model.deltaDecorations(old, next),
    onDidChangeModelContent: () => ({ dispose: noop }),
    getDomNode: () => dom,
    getVisibleRanges: () => [{ startLineNumber: Math.floor(scrollTop / LINE) + 1 }],
    getScrollTop: () => scrollTop,
    setScrollTop: (value) => { scrollTop = value; },
    getTopForLineNumber: (line) => (line - 1) * LINE,
  };
  return {
    key, currentFilePath: null, currentFileSavedContent: null, openTabs: [],
    isDirty: false, isComposing: false, composingFilePath: null, compositionText: "",
    isApplyingFile: false, pendingCompositionAction: null, editorHost: null, viewStates: new Map(),
    editor,
    viewer: { getViewerMode: () => mode, hideViewer: () => { mode = "hidden"; },
      showUnsupportedViewer: () => { mode = "unsupported"; },
      showPdfViewer: () => { mode = "pdf"; }, showImageViewer: () => { mode = "image"; },
      getUnbuiltPdfPath: () => null },
  };
};

// ── Main process (real open/save handlers) ──
const mainFixture = async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-outside-edits-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  let receiver = noop;
  const ctx = createWorkspaceContext({
    fs, fsp, path, workspace, WorkspaceError, state: {},
    sendToRenderer: (type, payload) => receiver(type, payload),
    sendIssues: noop,
  });
  ctx.updateWorkspaceIfNeeded = async () => {};
  ctx.requestIndex = noop;
  const handlers = createWorkspaceFileHandlers(ctx);
  return {
    root, handlers,
    receive: (fn) => { receiver = fn; },
    write: (name, content) => fsp.writeFile(path.join(root, name), content),
    read: (name) => fsp.readFile(path.join(root, name), "utf8"),
  };
};

const renderer = (main) => {
  documentRoot.children = [];
  const clock = { t: 1_000_000 };
  const timers = new Map();
  let nextTimer = 1;
  const window = {
    setTimeout: (fn, ms = 0) => { const id = nextTimer++; timers.set(id, { fn, due: clock.t + (ms || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    dispatchEvent: noop,
  };
  const cache = new Map();
  const load = (file) => {
    file = path.resolve(APP, file);
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const requireTs = (name) => name.endsWith("/i18n.js")
      ? { getUiLocale: () => "en", uiText: (en) => en }
      : load(path.resolve(path.dirname(file), name.replace(/\.js$/, ".ts")));
    new Function("exports", "require", "window", code)(exports, requireTs, window);
    return exports;
  };
  const calls = [];
  const posted = [];
  const pending = [];
  const issues = [];
  const runtime = {
    editorGroups: { primary: makeGroup("primary", calls), secondary: makeGroup("secondary", calls) },
    monacoModels: new Map(), dirtyFiles: new Set(),
    state: { activeEditorGroup: "primary", splitViewEnabled: false, pendingAutoOpenPath: null },
    workspaceFiles: [],
    deps: {
      getWorkspaceFiles: () => runtime.workspaceFiles,
      getRootFilePath: () => null,
      getMonacoApi: () => ({
        languages: { getLanguages: () => [{ id: "latex", extensions: [".tex"] }] },
        editor: { createModel: (content) => new FakeModel(content), setModelLanguage: noop },
      }),
      updateIssues: (...args) => issues.push(args),
      updateFallback: (message) => assert.fail(message),
      setBlockPreviewActive: noop, setAutoDetectedUi: noop,
      fileTree: { setSelection: noop, render: noop, setTreeFocus: noop, clearSelection: noop, loadOpenState: noop },
      outline: { render: noop }, editorTabs: { render: noop },
      buildOps: { updateSynctexButtonState: noop },
      postToNative: (message) => {
        posted.push(message);
        if (message.type === "openFile") pending.push(main.handlers.handleOpenFile(message.path));
        else if (message.type === "saveFile") pending.push(main.handlers.handleSaveFile(message.path, message.content, message));
        return true;
      },
    },
  };
  const core = load("editor-session/core-ops.ts").createEditorSessionCoreOps(runtime);
  const buffer = load("editor-session/buffer-ops.ts").createEditorSessionBufferOps(runtime, core);
  const tabs = load("editor-session/tab-state-ops.ts").createEditorSessionTabStateOps(runtime);
  const fileOpsState = { pendingOpenRequests: [], pendingReveal: null, pendingSave: null, autoSaveTimer: null, autoSavePending: false };
  runtime.fileOpsState = fileOpsState;
  runtime.lastCursorPositions = new Map();
  const ops = load("editor-session-file-ops.ts").createEditorSessionFileOps({
    ...runtime, ...core, ...buffer, ...tabs,
    state: fileOpsState,
    setSplitViewEnabled: noop, clearJumpHighlight: noop,
    updateBreadcrumbs: noop, updateMiniOutline: noop, revealLine: noop,
    now: () => clock.t,
  });
  // The tree sync (updateWorkspace), wired to the outside edits as in init.ts.
  const workspaceOps = load("editor-session/workspace-ops.ts").createEditorSessionWorkspaceOps(
    runtime, core, { updateBreadcrumbs: noop }, buffer,
  );
  const initialOpen = load("editor-session/initial-open-ops.ts").createEditorSessionInitialOpenOps(
    runtime, core, { requestOpenFile: ops.requestOpenFile },
  );
  // What the bridge calls for agent:applyContent / file:externalChange.
  let outside = null;
  if (fs.existsSync(path.join(APP, "editor-session/outside-edits.ts"))) {
    outside = load("editor-session/outside-edits.ts").createOutsideEdits({
      editorGroups: runtime.editorGroups, monacoModels: runtime.monacoModels,
      findGroupKeyByPath: core.findGroupKeyByPath, getEditorGroup: core.getEditorGroup,
      getPendingSave: () => fileOpsState.pendingSave,
      applyFormattedContent: ops.applyFormattedContent,
      disturbsTyping: ops.disturbsTyping,
      mergesCleanly: ops.mergesCleanly,
      lastTypedAt: ops.lastTypedAt,
      holdSaves: ops.holdSaves,
      unholdSaves: ops.unholdSaves,
      now: () => clock.t,
      onDeletionSettled: () => {
        workspaceOps.resyncWorkspaceFiles?.();
        initialOpen.requestInitialOpen();
      },
    });
    workspaceOps.setKeepMissingPath?.((path) => outside.isDeletionPending(path));
  }
  const navigation = load("editor-session/navigation-ops.ts").createEditorSessionNavigationOps(runtime, core, {}, {
    applyFormattedContent: ops.applyFormattedContent, requestOpenFile: ops.requestOpenFile,
  });
  main.receive((type, payload) => {
    if (type === "openFileResult") ops.handleOpenFileResult(payload);
    if (type === "saveResult") ops.handleSaveResult(payload);
  });
  // Lets queued continuations run, then waits for the host's open/save replies.
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    while (pending.length) {
      await Promise.all(pending.splice(0));
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const group = runtime.editorGroups.primary;
  return {
    runtime, buffer, ops, calls, posted, issues, group, outside, clock, workspaceOps,
    // updateWorkspace as workspace-controller.ts handles it: tree sync, then
    // "open something if nothing valid is open".
    treeUpdate: (files) => {
      runtime.workspaceFiles = files;
      workspaceOps.syncWorkspaceFiles({ workspaceFiles: files, rootChanged: false });
      initialOpen.requestInitialOpen();
    },
    // Issues reported as errors (not the clearing calls).
    errorIssues: () => issues.filter(([count, , status]) => count > 0 && status === "error"),
    model: (name) => runtime.monacoModels.get(name).model,
    open: async (name) => { ops.requestOpenFile(name, "primary"); await settle(); },
    settle,
    // Runs every pending timer due within the next few seconds whatever the
    // clock says (the clock stays); not the 30 s save safety timeout.
    runTimers: async () => {
      for (let round = 0; round < 10; round += 1) {
        const due = [...timers].filter(([, timer]) => timer.due < clock.t + 10_000);
        if (!due.length) break;
        due.forEach(([id]) => timers.delete(id));
        due.forEach(([, timer]) => timer.fn());
        await settle();
      }
    },
    // Moves the clock on and runs only the timers that fall due.
    advance: async (ms, step = 100) => {
      const end = clock.t + ms;
      while (clock.t < end) {
        clock.t = Math.min(end, clock.t + step);
        for (let round = 0; round < 20; round += 1) {
          const due = [...timers].filter(([, timer]) => timer.due <= clock.t).sort((a, b) => a[1].due - b[1].due);
          if (!due.length) break;
          due.forEach(([id]) => timers.delete(id));
          due.forEach(([, timer]) => timer.fn());
          await settle();
        }
      }
    },
    // The person typing: Monaco edits the model at the caret and the
    // content listener (monaco-setup.ts) updates the dirty state.
    type: (name, text, at) => {
      const model = runtime.monacoModels.get(name).model;
      const p = model.getPositionAt(at);
      model.applyEdits([{ range: { startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber, endColumn: p.column }, text }]);
      model.cursor = at + text.length;
      buffer.updateDirtyState(name, model.getValue());
    },
    // file:externalChange as the session handles it (same options in the old
    // init.ts handler and in outside-edits.ts).
    external: (name, content) => ops.applyFormattedContent(
      runtime.editorGroups[core.findGroupKeyByPath(name)], name, content, {
        updateSaved: true, showAiDiff: false,
        expectedContent: runtime.monacoModels.get(name).savedContent, externalChange: true,
      }),
    // agent:applyContent as the bridge calls it.
    agent: (name, content, options) => (outside ?? navigation).applyContentToOpenFile(name, content, options),
    conflictBar: () => document.getElementById("ai-content-conflict-bar"),
  };
};

const doc = (count = 40) => Array.from({ length: count }, (_, i) => `line ${i + 1} text`).join("\n") + "\n";

test("clean buffer: an outside insertion above the caret keeps the caret and the view on the same text", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = doc();
  await main.write("main.tex", original);
  await r.open("main.tex");
  const model = r.model("main.tex");
  model.cursor = original.indexOf("line 30 text") + "line 30 te".length;
  r.group.editor.setScrollTop(24 * LINE); // line 25 at the top
  const changed = original.replace("line 3 text\n", "line 3 text\ninserted A\ninserted B\ninserted C\n");
  await main.write("main.tex", changed);
  assert.equal(r.external("main.tex", changed), false);
  assert.equal(model.getValue(), changed);
  assert.equal(model.caretText(), "line 30 te|xt", "the caret stays where the person was typing");
  assert.equal(model.setValueCalls, 0);
  assert.ok(model.edits.every((edit) => edit.removed.length < 20 && edit.text.length < 40),
    "only the changed range is replaced, not the whole buffer");
  const top = r.group.editor.getVisibleRanges()[0].startLineNumber;
  assert.equal(model.getValue().split("\n")[top - 1], "line 25 text", "the page does not slide under the reader");
  assert.equal(r.runtime.dirtyFiles.has("main.tex"), false);
  assert.equal(r.runtime.monacoModels.get("main.tex").savedContent, changed);
});

test("clean CRLF buffer: a deleted line just above the caret leaves the caret on its own line", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = doc().replace(/\n/g, "\r\n");
  await main.write("main.tex", original);
  await r.open("main.tex");
  const model = r.model("main.tex");
  assert.equal(model.getEOL(), "\r\n");
  model.cursor = original.indexOf("line 11 text") + "li".length;
  const changed = original.replace("line 10 text\r\n", "").replace("line 1 text", "line 1 TEXT");
  await main.write("main.tex", changed);
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(r.external("main.tex", changed), false);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, []);
  assert.equal(model.getValue(), changed);
  assert.equal(model.caretText(), "li|ne 11 text");
  assert.equal(model.setValueCalls, 0);
  assert.equal(r.runtime.dirtyFiles.has("main.tex"), false);
});

test("a read-only editor (project operation in progress) still receives the outside change", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = doc(10);
  await main.write("main.tex", original);
  await r.open("main.tex");
  // Monaco's executeEdits refuses (returns false) while the editor is read-only.
  r.group.editor.executeEdits = () => false;
  const changed = original.replace("line 2 text", "line 2 changed");
  await main.write("main.tex", changed);
  r.external("main.tex", changed);
  assert.equal(r.model("main.tex").getValue(), changed,
    "a buffer marked clean must not keep the old text (the next save would put it back)");
});

test("unsaved typing elsewhere is kept: the outside change is rebased, not prompted, and autosave writes both", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = doc();
  await main.write("main.tex", original);
  await r.open("main.tex");
  const at = original.indexOf("line 30 text") + "line 30 text".length;
  r.type("main.tex", " typed", at);
  const changed = original.replace("line 5 text", "line 5 TEXT (ChatGPT)");
  await main.write("main.tex", changed);
  assert.equal(r.external("main.tex", changed), false, "non-overlapping edits must not ask");
  assert.equal(r.conflictBar(), null);
  const model = r.model("main.tex");
  assert.equal(model.getValue(), changed.replace("line 30 text", "line 30 text typed"));
  assert.equal(model.caretText(), "line 30 text typed|");
  assert.equal(r.runtime.dirtyFiles.has("main.tex"), true);
  assert.equal(await r.ops.saveDirtyFiles(), true);
  await r.settle();
  assert.equal(await main.read("main.tex"), changed.replace("line 30 text", "line 30 text typed"));
});

test("an outside change overlapping the typing still asks, and autosave never writes over it", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = doc();
  await main.write("main.tex", original);
  await r.open("main.tex");
  r.type("main.tex", " typed", original.indexOf("line 30 text") + "line 30 text".length);
  const mine = r.model("main.tex").getValue();
  const changed = original.replace("line 30 text", "line 30 rewritten");
  await main.write("main.tex", changed);
  assert.equal(r.external("main.tex", changed), true);
  assert.equal(r.model("main.tex").getValue(), mine, "the person's text is untouched");
  assert.ok(r.conflictBar(), "the two choices are shown");
  assert.equal(await r.ops.saveDirtyFiles(), false);
  await r.settle();
  assert.equal(await main.read("main.tex"), changed);
});

test("many outside writes while typing (an agent writing every half second) all land with the typing", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  let disk = doc();
  await main.write("main.tex", disk);
  await r.open("main.tex");
  let typed = "";
  for (let i = 1; i <= 10; i += 1) {
    const model = r.model("main.tex");
    const value = model.getValue();
    r.type("main.tex", String(i % 10), value.indexOf("line 30 text") + "line 30 text".length + typed.length);
    typed += String(i % 10);
    disk = disk.replace(`line ${i} text`, `line ${i} edited`);
    await main.write("main.tex", disk);
    assert.equal(r.external("main.tex", disk), false, `write ${i}`);
  }
  assert.equal(await r.ops.saveDirtyFiles(), true);
  await r.settle();
  assert.equal(await main.read("main.tex"), disk.replace("line 30 text", `line 30 text${typed}`));
});

test("a conflict in a background tab neither switches tabs nor takes focus; its choices appear when the file is shown", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = doc(10);
  await main.write("b.tex", original);
  await main.write("a.tex", "the file being typed in\n");
  await r.open("b.tex");
  r.type("b.tex", " unsaved", original.indexOf("line 4 text") + "line 4 text".length);
  await r.open("a.tex");
  assert.equal(r.group.currentFilePath, "a.tex");
  const callsBefore = r.calls.length;
  const postedBefore = r.posted.length;
  const changed = original.replace("line 4 text", "line 4 changed elsewhere");
  await main.write("b.tex", changed);
  assert.equal(r.external("b.tex", changed), true);
  await r.settle();
  assert.equal(r.group.currentFilePath, "a.tex", "the tab the person types in stays");
  assert.deepEqual(r.calls.slice(callsBefore), [], "no focus() while typing elsewhere");
  assert.equal(r.posted.slice(postedBefore).some((m) => m.type === "openFile"), false);
  assert.equal(r.conflictBar(), null, "no buttons over a different file");
  // Unsaved, not failed: the conflict choices are its notice (no error toast).
  assert.equal(r.ops.getSaveStatus().kind, "dirty");
  await r.open("b.tex");
  assert.ok(r.conflictBar(), "opening b.tex shows its two choices");
  assert.equal(r.model("b.tex").getValue(), original.replace("line 4 text", "line 4 text unsaved"));
});

test("Axiom: a write that does not touch the typing merges without a conflict", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = doc();
  await main.write("main.tex", original);
  await r.open("main.tex");
  r.type("main.tex", " typed", original.indexOf("line 30 text") + "line 30 text".length);
  r.clock.t += 2500; // a pause in typing (no blank lines here: one paragraph)
  const axiom = original.replace("line 2 text", "line 2 text, fixed by Axiom");
  await main.write("main.tex", axiom);
  const result = r.agent("main.tex", axiom, {
    updateSaved: true, expectedContent: original, conversationId: "c1", showAiDiff: true,
  });
  assert.equal(result.conflict, false);
  assert.equal(r.model("main.tex").getValue(), axiom.replace("line 30 text", "line 30 text typed"));
  assert.equal(r.model("main.tex").caretText(), "line 30 text typed|");
  assert.equal(await r.ops.saveDirtyFiles(), true);
  await r.settle();
  assert.equal(await main.read("main.tex"), axiom.replace("line 30 text", "line 30 text typed"));
});

test("Axiom: a write that arrives during an IME composition waits for it to end", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = doc();
  await main.write("main.tex", original);
  await r.open("main.tex");
  const model = r.model("main.tex");
  r.group.isComposing = true;
  r.group.composingFilePath = "main.tex";
  const axiom = original.replace("line 2 text", "line 2 by Axiom");
  await main.write("main.tex", axiom);
  let deferredConflicts = 0;
  const result = r.agent("main.tex", axiom, {
    updateSaved: true, expectedContent: original, conversationId: "c1",
    onDeferredConflict: () => { deferredConflicts += 1; },
  });
  assert.equal(result.conflict, false);
  assert.equal(model.getValue(), original, "the buffer is not edited under an open composition");
  assert.equal(model.edits.length, 0);
  await r.runTimers();
  assert.equal(model.getValue(), original, "still composing");
  r.group.isComposing = false;
  r.group.composingFilePath = null;
  await r.runTimers();
  assert.equal(model.getValue(), axiom);
  assert.equal(deferredConflicts, 0);
});

test("outside change and Axiom writes queued behind a composition apply in order; a deferred conflict is reported", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  assert.ok(r.outside, "outside-edits.ts");
  const original = doc();
  await main.write("main.tex", original);
  await r.open("main.tex");
  const model = r.model("main.tex");
  r.group.isComposing = true;
  r.group.composingFilePath = "main.tex";
  const first = original.replace("line 2 text", "line 2 first");
  r.outside.handleExternalFileChange({ path: "main.tex", content: first });
  const second = first.replace("line 3 text", "line 3 second");
  r.outside.handleExternalFileChange({ path: "main.tex", content: second });
  // The composition commits text into line 10, then Axiom rewrites that line.
  r.type("main.tex", "漢字", original.indexOf("line 10 text") + "line 10 ".length);
  const third = second.replace("line 10 text", "line 10 axiom");
  let deferredConflicts = 0;
  r.outside.applyContentToOpenFile("main.tex", third, {
    updateSaved: true, expectedContent: second, conversationId: "c1",
    onDeferredConflict: () => { deferredConflicts += 1; },
  });
  assert.equal(model.edits.length, 1, "only the composition's own text so far");
  r.group.isComposing = false;
  await r.runTimers();
  assert.equal(model.getValue(), second.replace("line 10 text", "line 10 漢字text"));
  // Axiom's edit overlaps what was just typed: it waits for a pause.
  assert.equal(deferredConflicts, 0);
  assert.equal(r.conflictBar(), null);
  r.clock.t += 2100;
  await r.runTimers();
  assert.equal(model.getValue(), second.replace("line 10 text", "line 10 漢字text"));
  assert.equal(deferredConflicts, 1, "Axiom is told about the conflict that waited");
  assert.ok(r.conflictBar());
});

test("a change queued for a buffer that was closed and reopened meanwhile is dropped", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  assert.ok(r.outside, "outside-edits.ts");
  await main.write("main.tex", "old\n");
  await r.open("main.tex");
  r.group.isComposing = true;
  r.group.composingFilePath = "main.tex";
  r.outside.handleExternalFileChange({ path: "main.tex", content: "stale\n" });
  // Reopened from disk with newer text.
  r.runtime.monacoModels.set("main.tex", { model: new FakeModel("newer\n"), savedContent: "newer\n" });
  r.group.isComposing = false;
  await r.runTimers();
  assert.equal(r.model("main.tex").getValue(), "newer\n");
});

// ── Axiom edits wait for a pause in typing (owner's request, proposal 2) ──
// Paragraphs separated by blank lines, as in a manuscript.
const manuscript = () => [
  "\\section{One}", "First paragraph sentence one.", "First paragraph sentence two.", "",
  "Second paragraph, where the person is writing.", "It goes on here.", "",
  "Third paragraph.", "",
].join("\n");
const endOf = (text, needle) => text.indexOf(needle) + needle.length;

test("an Axiom edit to the paragraph being typed waits for a 2 s pause; the text and autosave wait with it", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = manuscript();
  await main.write("main.tex", original);
  await r.open("main.tex");
  const model = r.model("main.tex");
  r.type("main.tex", " More words", endOf(original, "where the person is writing."));
  const mine = model.getValue();
  const axiom = original.replace("It goes on here.", "It continues here.");
  await main.write("main.tex", axiom);
  let reported = 0;
  const result = r.agent("main.tex", axiom, {
    updateSaved: true, expectedContent: original, conversationId: "c1", showAiDiff: true,
    onDeferredConflict: () => { reported += 1; },
  });
  assert.equal(result.conflict, false);
  assert.equal(model.getValue(), mine, "nothing changes under the person's fingers");
  // Autosave leaves the file alone meanwhile (the disk has Axiom's text) and
  // reports nothing.
  assert.equal(await r.ops.saveDirtyFiles({ auto: true }), true);
  await r.settle();
  assert.equal(await main.read("main.tex"), axiom);
  assert.equal(r.ops.getSaveStatus().kind, "dirty");
  // Still typing 1.5 s later: still waiting.
  r.clock.t += 1500;
  r.type("main.tex", "!", model.cursor);
  r.clock.t += 1500;
  await r.runTimers();
  assert.equal(model.getValue(), mine.replace("More words", "More words!"));
  // A 2 s pause: applied as ranged edits, the caret stays after "!".
  r.clock.t += 600;
  await r.runTimers();
  const merged = axiom.replace("where the person is writing.", "where the person is writing. More words!");
  assert.equal(model.getValue(), merged);
  assert.equal(model.caretText(), "Second paragraph, where the person is writing. More words!|");
  assert.equal(reported, 0);
  assert.equal(r.conflictBar(), null);
  assert.equal(await r.ops.saveDirtyFiles({ auto: true }), true);
  await r.settle();
  assert.equal(await main.read("main.tex"), merged);
});

test("an Axiom edit to another paragraph applies at once while typing", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = manuscript();
  await main.write("main.tex", original);
  await r.open("main.tex");
  r.type("main.tex", " More", endOf(original, "where the person is writing."));
  const axiom = original.replace("Third paragraph.", "Third paragraph, by Axiom.");
  await main.write("main.tex", axiom);
  assert.equal(r.agent("main.tex", axiom, { updateSaved: true, expectedContent: original, conversationId: "c1" }).conflict, false);
  assert.equal(r.model("main.tex").getValue(), axiom.replace("is writing.", "is writing. More"));
});

test("an Axiom edit overlapping the typing shows the choices only after a pause, never while typing or composing", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = manuscript();
  await main.write("main.tex", original);
  await r.open("main.tex");
  const model = r.model("main.tex");
  r.type("main.tex", "X", endOf(original, "It goes on"));
  const axiom = original.replace("It goes on here.", "It goes onward."); // touches the typing
  await main.write("main.tex", axiom);
  let reported = 0;
  r.agent("main.tex", axiom, {
    updateSaved: true, expectedContent: original, conversationId: "c1",
    onDeferredConflict: () => { reported += 1; },
  });
  // A second Axiom write to the same file replaces the waiting one.
  const axiom2 = axiom.replace("Third paragraph.", "Third paragraph, too.");
  await main.write("main.tex", axiom2);
  r.agent("main.tex", axiom2, {
    updateSaved: true, expectedContent: axiom, conversationId: "c1",
    onDeferredConflict: () => { reported += 1; },
  });
  // Typing without a 2 s pause for 40 s: no choices, even past the 30 s cap
  // (this edit cannot merge), and nothing changes.
  for (let i = 0; i < 40; i += 1) {
    r.clock.t += 1000;
    r.type("main.tex", ".", model.cursor);
    await r.runTimers();
  }
  assert.equal(r.conflictBar(), null);
  assert.equal(reported, 0);
  assert.equal(model.getValue().includes("onward"), false);
  // Pause, but an IME composition is open: still nothing.
  r.group.isComposing = true;
  r.group.composingFilePath = "main.tex";
  r.clock.t += 5000;
  await r.runTimers();
  assert.equal(r.conflictBar(), null);
  r.group.isComposing = false;
  r.group.composingFilePath = null;
  await r.runTimers();
  assert.ok(r.conflictBar(), "the choices appear once the person has stopped");
  assert.equal(reported, 1, "Axiom is told once");
  assert.equal(model.getValue().includes("goes onX"), true, "the person's text is kept");
  // "Use Axiom" would take the latest Axiom text (both edits).
  const disk = await main.read("main.tex");
  assert.equal(disk, axiom2);
});

test("typing for more than 30 s: a waiting edit that merges is applied without waiting for a pause", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = manuscript();
  await main.write("main.tex", original);
  await r.open("main.tex");
  const model = r.model("main.tex");
  r.type("main.tex", " A", endOf(original, "where the person is writing."));
  const axiom = original.replace("It goes on here.", "It goes on, Axiom says.");
  await main.write("main.tex", axiom);
  r.agent("main.tex", axiom, { updateSaved: true, expectedContent: original, conversationId: "c1" });
  for (let i = 0; i < 29; i += 1) {
    r.clock.t += 1000;
    r.type("main.tex", "a", model.cursor);
    await r.runTimers();
  }
  assert.equal(model.getValue().includes("Axiom says"), false);
  r.clock.t += 1500;
  r.type("main.tex", "b", model.cursor);
  await r.runTimers();
  assert.equal(model.getValue().includes("Axiom says"), true);
  assert.match(model.caretText(), /aab\|$/);
});

test("Save, Build, History or Git (an explicit save) brings a waiting edit in at once", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = manuscript();
  await main.write("main.tex", original);
  await r.open("main.tex");
  r.type("main.tex", " More", endOf(original, "where the person is writing."));
  const axiom = original.replace("It goes on here.", "It continues.");
  await main.write("main.tex", axiom);
  r.agent("main.tex", axiom, { updateSaved: true, expectedContent: original, conversationId: "c1" });
  assert.equal(r.model("main.tex").getValue().includes("It continues."), false);
  assert.equal(await r.ops.saveDirtyFiles(), true);
  await r.settle();
  const merged = axiom.replace("is writing.", "is writing. More");
  assert.equal(r.model("main.tex").getValue(), merged);
  assert.equal(await main.read("main.tex"), merged);
});

test("autosave during an IME composition waits for it to end and never blurs the input", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  await main.write("main.tex", manuscript());
  await r.open("main.tex");
  let blurs = 0;
  r.group.editorHost = { querySelector: () => ({ blur: () => { blurs += 1; } }) };
  r.group.isComposing = true;
  r.group.composingFilePath = "main.tex";
  r.type("main.tex", "かな", 0);
  r.ops.scheduleAutoSave();
  await r.runTimers();
  assert.equal(blurs, 0, "the composition is not ended by autosave");
  assert.equal(await main.read("main.tex"), manuscript());
  r.group.isComposing = false;
  r.group.composingFilePath = null;
  await r.runTimers();
  assert.equal(await main.read("main.tex"), "かな" + manuscript());
});

// ── Real-app follow-ups (2026-11-25 verification) ──

test("an open conflict is a state: autosave waits silently (no issue, no 'cannot save'); only Save by hand says why", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = doc();
  await main.write("main.tex", original);
  await r.open("main.tex");
  r.type("main.tex", " typed", original.indexOf("line 30 text") + "line 30 text".length);
  const changed = original.replace("line 30 text", "line 30 rewritten");
  await main.write("main.tex", changed);
  assert.equal(r.external("main.tex", changed), true);
  const bar = r.conflictBar();
  assert.ok(bar, "the conflict bar is what the person sees");
  assert.match(bar.title, /changed outside TeX64/);
  // The person keeps typing; autosave and its retries come and go.
  r.type("main.tex", "!", r.model("main.tex").cursor);
  r.ops.scheduleAutoSave();
  await r.advance(5000);
  assert.deepEqual(r.errorIssues(), [], "no issue count");
  assert.equal(r.ops.getSaveStatus().kind, "dirty", "no 'cannot save' state, so no error notice");
  assert.equal(await main.read("main.tex"), changed);
  // Cmd+S: now the save status says why (its notice names the file).
  assert.equal(await r.ops.saveCurrentFile(), false);
  const status = r.ops.getSaveStatus();
  assert.equal(status.kind, "error");
  assert.equal(status.path, "main.tex");
  assert.match(status.message, /Resolve the edit conflict/);
  assert.deepEqual(r.errorIssues(), []);
});

test("an autosave refused because the disk changed under it stays silent once the conflict bar is up", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = doc();
  await main.write("main.tex", original);
  await r.open("main.tex");
  r.type("main.tex", " typed", original.indexOf("line 30 text") + "line 30 text".length);
  // Another program writes first; the autosave already on its way is refused.
  const changed = original.replace("line 30 text", "line 30 rewritten");
  await main.write("main.tex", changed);
  await r.ops.saveDirtyFiles({ auto: true });
  assert.equal(r.external("main.tex", changed), true);
  await r.advance(3000);
  assert.deepEqual(r.errorIssues(), [], "the refusal is never shown: the bar explains it");
  assert.equal(r.ops.getSaveStatus().kind, "dirty");
});

test("a save refused because the disk changed, with no notice of that change, is reported after 3 s", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = doc();
  await main.write("main.tex", original);
  await r.open("main.tex");
  r.type("main.tex", " typed", original.indexOf("line 30 text") + "line 30 text".length);
  await main.write("main.tex", original.replace("line 1 text", "line 1 elsewhere"));
  await r.ops.saveDirtyFiles({ auto: true });
  assert.equal(r.ops.getSaveStatus().kind, "dirty");
  await r.advance(3500);
  assert.equal(r.ops.getSaveStatus().kind, "error");
  assert.match(r.ops.getSaveStatus().message, /changed on disk/);
});

const deleteAndReport = (r, name) => r.outside.handleExternalFileChange({ path: name, content: null, fileDeleted: true });
const listWithout = (r, name, files) => r.workspaceOps.syncWorkspaceFiles({ workspaceFiles: files.filter((f) => f !== name), rootChanged: false });

test("a clean file deleted and recreated 1.5 s later keeps its tab; the new text comes in with the caret kept", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const original = doc();
  await main.write("main.tex", original);
  await main.write("other.tex", "other\n");
  await r.open("main.tex");
  const model = r.model("main.tex");
  model.cursor = original.indexOf("line 30 text") + "line 30 ".length;
  // The watcher reports the deletion, then the tree without the file.
  await fsp.rm(path.join(main.root, "main.tex"));
  deleteAndReport(r, "main.tex");
  listWithout(r, "main.tex", ["main.tex", "other.tex"]);
  await r.advance(1500);
  assert.equal(r.group.openTabs.includes("main.tex"), true, "the tab stays during the grace period");
  assert.equal(r.group.currentFilePath, "main.tex");
  assert.equal(r.runtime.monacoModels.get("main.tex").model, model);
  // Recreated with an edit near the top: applied in place.
  const recreated = original.replace("line 2 text\n", "line 2 text\nadded by git\n");
  await main.write("main.tex", recreated);
  r.outside.handleExternalFileChange({ path: "main.tex", content: recreated });
  r.workspaceOps.syncWorkspaceFiles({ workspaceFiles: ["main.tex", "other.tex"], rootChanged: false });
  await r.advance(6000);
  assert.equal(model.getValue(), recreated);
  assert.equal(model.caretText(), "line 30 |text");
  assert.equal(r.group.openTabs.includes("main.tex"), true);
  assert.equal(r.conflictBar(), null);
  assert.deepEqual(r.errorIssues(), []);
});

test("a real deletion: a clean tab closes after the grace period; a buffer with unsaved typing keeps its tab and gets the deletion choices", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  await main.write("clean.tex", "clean\n");
  await main.write("dirty.tex", "dirty\n");
  await r.open("dirty.tex");
  r.type("dirty.tex", " typed", "dirty".length);
  await r.open("clean.tex");
  for (const name of ["clean.tex", "dirty.tex"]) {
    await fsp.rm(path.join(main.root, name));
    deleteAndReport(r, name);
  }
  r.workspaceOps.syncWorkspaceFiles({ workspaceFiles: [], rootChanged: false });
  await r.advance(4000);
  assert.deepEqual(r.group.openTabs.slice().sort(), ["clean.tex", "dirty.tex"], "nothing closes during the grace period");
  assert.equal(r.conflictBar(), null);
  await r.advance(1500);
  assert.equal(r.group.openTabs.includes("clean.tex"), false, "the clean tab closes, as before");
  assert.equal(r.runtime.monacoModels.has("clean.tex"), false);
  assert.equal(r.group.openTabs.includes("dirty.tex"), true, "unsaved typing is never closed");
  assert.equal(r.model("dirty.tex").getValue(), "dirty typed\n");
  assert.ok(r.conflictBar(), "the deletion choices");
});

test("a file deleted by TeX64 itself (tree updated with no deletion report) closes at once, as before", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  await main.write("main.tex", "x\n");
  await main.write("other.tex", "y\n");
  await r.open("other.tex");
  await r.open("main.tex");
  listWithout(r, "main.tex", ["main.tex", "other.tex"]);
  assert.equal(r.group.openTabs.includes("main.tex"), false);
});

for (const gap of [1500, 3000]) {
  test(`the ACTIVE file deleted and recreated ${gap / 1000} s later stays the active tab, with no focus change, and shows the new text`, async (t) => {
    const main = await mainFixture(t);
    const r = renderer(main);
    await fsp.mkdir(path.join(main.root, "ch"));
    const original = doc();
    await main.write("ch/one.tex", "chapter\n");
    await main.write("main.tex", original);
    r.runtime.workspaceFiles = ["ch/one.tex", "main.tex"];
    await r.open("ch/one.tex");
    await r.open("main.tex");
    const model = r.model("main.tex");
    model.cursor = original.indexOf("line 30 text") + "line 30 ".length;
    const callsBefore = r.calls.length;
    const postedBefore = r.posted.length;
    await fsp.rm(path.join(main.root, "main.tex"));
    r.outside.handleExternalFileChange({ path: "main.tex", content: null, fileDeleted: true });
    r.treeUpdate(["ch/one.tex"]);
    await r.settle();
    await r.advance(gap);
    assert.equal(r.group.currentFilePath, "main.tex", "no neighbour is activated");
    assert.equal(r.posted.slice(postedBefore).some((m) => m.type === "openFile"), false);
    const recreated = original.replace("line 2 text\n", "line 2 text\nback from git\n");
    await main.write("main.tex", recreated);
    r.outside.handleExternalFileChange({ path: "main.tex", content: recreated });
    r.treeUpdate(["ch/one.tex", "main.tex"]);
    await r.settle();
    await r.advance(6000);
    assert.equal(r.group.currentFilePath, "main.tex");
    assert.equal(model.getValue(), recreated, "the new text is in the visible tab");
    assert.equal(model.caretText(), "line 30 |text");
    assert.deepEqual(r.calls.slice(callsBefore), [], "no focus() calls");
    assert.equal(r.posted.slice(postedBefore).some((m) => m.type === "openFile"), false);
  });
}

test("a BACKGROUND file deleted and recreated keeps its tab; the active tab does not move", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  await fsp.mkdir(path.join(main.root, "ch"));
  await main.write("main.tex", "main\n");
  await main.write("ch/one.tex", "chapter\n");
  r.runtime.workspaceFiles = ["ch/one.tex", "main.tex"];
  await r.open("main.tex");
  await r.open("ch/one.tex");
  const callsBefore = r.calls.length;
  const postedBefore = r.posted.length;
  await fsp.rm(path.join(main.root, "main.tex"));
  r.outside.handleExternalFileChange({ path: "main.tex", content: null, fileDeleted: true });
  r.treeUpdate(["ch/one.tex"]);
  await r.settle();
  await r.advance(1500);
  assert.equal(r.group.currentFilePath, "ch/one.tex");
  assert.equal(r.group.openTabs.includes("main.tex"), true);
  await main.write("main.tex", "main, recreated\n");
  r.outside.handleExternalFileChange({ path: "main.tex", content: "main, recreated\n" });
  r.treeUpdate(["ch/one.tex", "main.tex"]);
  await r.settle();
  await r.advance(6000);
  assert.equal(r.group.currentFilePath, "ch/one.tex");
  assert.equal(r.model("main.tex").getValue(), "main, recreated\n");
  assert.deepEqual(r.calls.slice(callsBefore), []);
  assert.equal(r.posted.slice(postedBefore).some((m) => m.type === "openFile"), false);
});

test("an active file really deleted: after the grace its clean tab closes and another file opens, as before", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  await fsp.mkdir(path.join(main.root, "ch"));
  await main.write("ch/one.tex", "chapter\n");
  await main.write("main.tex", "main\n");
  r.runtime.workspaceFiles = ["ch/one.tex", "main.tex"];
  await r.open("main.tex");
  await fsp.rm(path.join(main.root, "main.tex"));
  r.outside.handleExternalFileChange({ path: "main.tex", content: null, fileDeleted: true });
  r.treeUpdate(["ch/one.tex"]);
  await r.settle();
  await r.advance(4000);
  assert.equal(r.group.currentFilePath, "main.tex");
  await r.advance(1500);
  await r.settle();
  // When the grace ends the tab closes and another file opens, as a tree
  // update without the file did before.
  assert.equal(r.runtime.monacoModels.has("main.tex"), false);
  assert.equal(r.group.currentFilePath, "ch/one.tex");
});

test("opening a link shares one editor buffer and Axiom changes wait for that buffer's composition", async (t) => {
  const main = await mainFixture(t);
  const r = renderer(main);
  const draft = manuscript();
  await main.write("main.tex", draft);
  await fsp.symlink("main.tex", path.join(main.root, "alias.tex"));
  await r.open("main.tex");
  await r.open("alias.tex");
  assert.equal(r.group.currentFilePath, "main.tex");
  assert.deepEqual([...r.runtime.monacoModels.keys()], ["main.tex"]);
  r.group.isComposing = true;
  r.group.composingFilePath = "main.tex";
  const changed = draft + "\nAxiom edit.";
  await main.write("main.tex", changed);
  const result = r.agent("alias.tex", changed, {
    fileIdentity: "main.tex", updateSaved: true, expectedContent: draft,
  });
  assert.equal(result.handled, true);
  assert.equal(r.model("main.tex").getValue(), draft);
  r.group.isComposing = false;
  r.group.composingFilePath = null;
  await r.advance(100);
  assert.equal(r.model("main.tex").getValue(), changed);
});

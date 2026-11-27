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
const { MAX_UNKNOWN_TEXT_FILE_BYTES } = require("../electron/services/text-file-types.cjs");
const { SearchService } = require("../electron/services/search.cjs");
const { WorkspaceManifest } = require("../electron/services/collab/manifest.cjs");

const noop = () => {};
const fixture = async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-text-open-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  const messages = [];
  let receiver = noop;
  const ctx = createWorkspaceContext({
    fs, fsp, path, workspace, WorkspaceError, state: {},
    sendToRenderer: (type, payload) => { messages.push({ type, payload }); receiver(type, payload); },
    sendIssues: noop,
  });
  ctx.updateWorkspaceIfNeeded = async () => {};
  ctx.requestIndex = noop;
  const handlers = createWorkspaceFileHandlers(ctx);
  return {
    root, workspace, handlers, messages,
    receive: (fn) => { receiver = fn; },
    write: (name, content) => fsp.writeFile(path.join(root, name), content),
    open: async (name) => {
      await handlers.handleOpenFile(name);
      return messages.at(-1).payload;
    },
  };
};

// Exercise the production renderer session modules without requiring Chromium.
// Monaco's getValue hides a BOM, as the real editor does.
const renderer = (fixture) => {
  const window = { setTimeout, clearTimeout, dispatchEvent: noop };
  const cache = new Map();
  const load = (file) => {
    file = path.resolve(__dirname, "../web-src/app", file);
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
  const makeGroup = (key) => {
    let model = null;
    let mode = "hidden";
    return {
      key, currentFilePath: null, currentFileSavedContent: null, openTabs: [],
      isDirty: false, isComposing: false, viewStates: new Map(),
      editor: { setModel: (value) => { model = value; }, getModel: () => model,
        getValue: () => model.getValue(), focus: noop, saveViewState: () => ({ cursor: 1 }) },
      viewer: { getViewerMode: () => mode, getUnbuiltPdfPath: () => null, hideViewer: () => { mode = "hidden"; },
        showUnsupportedViewer: () => { mode = "unsupported"; },
        showPdfViewer: () => { mode = "pdf"; }, showImageViewer: () => { mode = "image"; } },
    };
  };
  const monaco = {
    // Deliberately include an unfamiliar extension/name registered as LaTeX:
    // sniffed files must still be forced to plaintext.
    languages: { getLanguages: () => [{ id: "latex", extensions: [".ltjruby"], filenames: ["latexmkrc"] }] },
    editor: {
      createModel: (content, language) => ({
        content: content.replace(/^\uFEFF/, ""), bom: content.startsWith("\uFEFF") ? "\uFEFF" : "", language,
        getValue(_eol, preserveBOM = false) { return (preserveBOM ? this.bom : "") + this.content; },
        setValue(value) { this.bom = value.startsWith("\uFEFF") ? "\uFEFF" : ""; this.content = value.replace(/^\uFEFF/, ""); },
        edit(value) { this.content = value; }, getLanguageId() { return this.language; },
      }),
      setModelLanguage: (model, language) => { model.language = language; },
    },
  };
  const issues = [];
  const pending = [];
  const runtime = {
    editorGroups: { primary: makeGroup("primary"), secondary: makeGroup("secondary") },
    monacoModels: new Map(), dirtyFiles: new Set(),
    state: { activeEditorGroup: "primary", splitViewEnabled: false },
    deps: {
      getMonacoApi: () => monaco, updateIssues: (...args) => issues.push(args),
      updateFallback: (message) => assert.fail(message),
      setBlockPreviewActive: noop, setAutoDetectedUi: noop,
      fileTree: { setSelection: noop, render: noop, setTreeFocus: noop },
      outline: { render: noop }, editorTabs: { render: noop },
      buildOps: { updateSynctexButtonState: noop },
      postToNative: (message) => {
        pending.push(message.type === "openFile"
          ? fixture.handlers.handleOpenFile(message.path, message.previewRequestId, message.openRequestId)
          : fixture.handlers.handleSaveFile(message.path, message.content, message));
        return true;
      },
    },
  };
  const core = load("editor-session/core-ops.ts").createEditorSessionCoreOps(runtime);
  const buffer = load("editor-session/buffer-ops.ts").createEditorSessionBufferOps(runtime, core);
  const tabs = load("editor-session/tab-state-ops.ts").createEditorSessionTabStateOps(runtime);
  const ops = load("editor-session-file-ops.ts").createEditorSessionFileOps({
    ...runtime, ...core, ...buffer, ...tabs,
    state: { pendingOpenRequests: [], pendingReveal: null, pendingSave: null, autoSaveTimer: null },
    setSplitViewEnabled: noop, clearJumpHighlight: noop,
    updateBreadcrumbs: noop, updateMiniOutline: noop, revealLine: noop,
  });
  fixture.receive((type, payload) => {
    if (type === "openFileResult") ops.handleOpenFileResult(payload);
    if (type === "saveResult") ops.handleSaveResult(payload);
  });
  return { runtime, core, buffer, tabs, ops, issues,
    finishRequests: () => Promise.all(pending.splice(0)),
    open: async (name) => { ops.requestOpenFile(name, "primary"); await Promise.all(pending.splice(0)); },
  };
};

test("a late automatic PDF read cannot claim the tab of a newer manuscript", async (t) => {
  const f = await fixture(t);
  const r = renderer(f);
  await f.write("main.pdf", "%PDF-main");
  await f.write("letter.pdf", "%PDF-letter");
  const read = f.workspace.readBinaryFile.bind(f.workspace);
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  f.workspace.readBinaryFile = async name => {
    if (name === "main.pdf") await delayed;
    return read(name);
  };
  r.ops.openFirstPreview("main.pdf", true);
  const first = r.finishRequests();
  r.ops.cancelPendingFirstPreview();
  r.ops.openFirstPreview("letter.pdf", true);
  await r.finishRequests();
  release();
  await first;
  assert.deepEqual(r.runtime.editorGroups.secondary.openTabs, ["letter.pdf"]);
  assert.equal(r.runtime.editorGroups.secondary.currentFilePath, "letter.pdf");
  assert.deepEqual(r.issues, []);
});

// Pause after capturing the bytes, as a delayed IPC reply would.
const delayFirstRead = (workspace, method, file) => {
  const read = workspace[method].bind(workspace);
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let count = 0;
  workspace[method] = async (name, ...args) => {
    const result = await read(name, ...args);
    if (name === file && ++count === 1) {
      started.resolve();
      await gate.promise;
    }
    return result;
  };
  return { started: started.promise, release: gate.resolve, count: () => count };
};

test("reopening a manuscript uses its newest bytes even if an older read returns last", async (t) => {
  const f = await fixture(t);
  const r = renderer(f);
  await f.write("main.tex", "old");
  await f.write("other.tex", "other");
  const delay = delayFirstRead(f.workspace, "readFile", "main.tex");
  const first = r.open("main.tex");
  await delay.started;
  await r.open("other.tex");
  await f.write("main.tex", "new");
  await r.open("main.tex");
  delay.release();
  await first;
  assert.equal(r.core.getActiveFileSnapshot().path, "main.tex");
  assert.equal(r.runtime.monacoModels.get("main.tex").model.getValue(), "new");
  assert.deepEqual(r.issues, []);
});

test("reselecting the current source preserves a paper edit's shared background read", async (t) => {
  const f = await fixture(t);
  const r = renderer(f);
  await f.write("main.tex", "root");
  await f.write("chapter.tex", "chapter");
  await r.open("main.tex");
  const delay = delayFirstRead(f.workspace, "readFile", "chapter.tex");
  const first = r.open("chapter.tex");
  await delay.started;
  r.ops.requestOpenFile("chapter.tex", "primary");
  r.ops.requestOpenFileInBackground("chapter.tex", "primary", false);
  r.ops.requestOpenFile("main.tex", "primary");
  delay.release();
  await first;
  await r.finishRequests();
  assert.equal(delay.count(), 1);
  assert.equal(r.core.getActiveFileSnapshot().path, "main.tex");
  assert.deepEqual(r.runtime.editorGroups.primary.openTabs, ["main.tex"]);
  assert.equal(r.runtime.monacoModels.get("chapter.tex").model.getValue(), "chapter");
});

test("turning off Live restores the saved PDF only while that PDF remains selected", async (t) => {
  const f = await fixture(t);
  const r = renderer(f);
  await f.write("main.pdf", "%PDF-main");
  await f.write("other.pdf", "%PDF-other");
  const group = r.runtime.editorGroups.secondary;
  group.currentFilePath = "main.pdf";
  group.viewer.getUnbuiltPdfPath = () => "main.pdf";
  const delay = delayFirstRead(f.workspace, "readBinaryFile", "main.pdf");
  assert.equal(r.ops.requestOpenFile("main.pdf", "secondary", true), true);
  const restore = r.finishRequests();
  await delay.started;
  r.ops.requestOpenFile("other.pdf", "secondary");
  await r.finishRequests();
  delay.release();
  await restore;
  assert.equal(group.currentFilePath, "other.pdf");
  assert.equal(group.viewer.getViewerMode(), "pdf");
  assert.deepEqual(r.issues, []);
});

test("unknown extension, extensionless and dotfiles open through main and renderer; binary stays unsupported", async (t) => {
  const f = await fixture(t);
  const r = renderer(f);
  for (const name of ["canon.ltjruby", "latexmkrc", "extensionless", ".arbitrary", "file.IDX"]) {
    const content = "日本語\r\n\\documentclass{article}\r\n";
    await f.write(name, content);
    await r.open(name);
    assert.equal(r.runtime.editorGroups.primary.viewer.getViewerMode(), "hidden");
    const entry = r.runtime.monacoModels.get(name);
    assert.equal(entry.model.getValue(), content);
    assert.equal(entry.model.getLanguageId(), "plaintext");
    assert.equal(r.core.getActiveFileSnapshot().path, name);
    assert.equal(r.runtime.dirtyFiles.size, 0);
  }
  await f.write("blob.unknown", Buffer.from([0x41, 0, 0xff]));
  await r.open("blob.unknown");
  assert.equal(r.runtime.editorGroups.primary.viewer.getViewerMode(), "unsupported");
  assert.equal(r.runtime.monacoModels.has("blob.unknown"), false);
  assert.equal(r.core.getActiveFileSnapshot(), null);
  const { openRequestId, ...unsupported } = f.messages.at(-1).payload;
  assert.ok(Number.isSafeInteger(openRequestId));
  assert.deepEqual(unsupported, { path: "blob.unknown", kind: "unsupported" });
  assert.deepEqual(r.issues, []);
  assert.equal(await f.workspace.detectRootFile(), null);
});

test("unknown text is editable, autosaved, reopened and temporary; UTF-8 BOM and CRLF survive saves", async (t) => {
  const f = await fixture(t);
  const r = renderer(f);
  for (const bom of ["", "\uFEFF"]) {
    const name = bom ? "bom.ltjruby" : "canon.ltjruby";
    await f.write(name, bom + "日本語\r\n");
    await r.open(name);
    assert.equal(r.runtime.dirtyFiles.has(name), false);
    const entry = r.runtime.monacoModels.get(name);
    // A literal leading U+FEFF is document content, distinct from the encoding
    // BOM. Both must survive (including when there was no encoding BOM).
    entry.model.edit("\uFEFF日本語・編集\r\n");
    r.buffer.cacheCurrentBuffer(r.core.getActiveGroup());
    assert.equal(r.runtime.dirtyFiles.has(name), true);
    assert.equal(r.ops.getSaveStatus().kind, "dirty");
    assert.equal(await r.ops.saveCurrentFile(), true);
    assert.deepEqual(await fsp.readFile(path.join(f.root, name)), Buffer.from(bom + "\uFEFF日本語・編集\r\n"));
    assert.equal(r.runtime.dirtyFiles.has(name), false);
    entry.model.edit("日本語・自動保存\r\n");
    r.buffer.cacheCurrentBuffer(r.core.getActiveGroup());
    assert.equal(await r.ops.saveDirtyFiles(), true);
    assert.deepEqual(await fsp.readFile(path.join(f.root, name)), Buffer.from(bom + "日本語・自動保存\r\n"));
    await f.write("main.tex", "document");
    await r.open("main.tex");
    assert.equal(r.core.getActiveGroup().openTabs.includes(name), false);
    await r.open(name);
    assert.equal(r.runtime.monacoModels.get(name).model.getLanguageId(), "plaintext");
    assert.equal(r.core.getActiveGroup().openTabs.includes("main.tex"), true);
  }
  assert.deepEqual(r.issues, []);
});

test("known source files reject invalid UTF-8 without losing bytes; special viewers and unknown files keep their own handling", async (t) => {
  const f = await fixture(t);
  const invalid = Buffer.from([0xff, 0x41]);
  for (const name of ["known.tex", "known.lua", "known.md"]) {
    await f.write(name, invalid);
    const result = await f.open(name);
    assert.deepEqual(result, { path: name, error: WorkspaceError.invalidEncoding });
    assert.deepEqual(await fsp.readFile(path.join(f.root, name)), invalid);
    const valid = "A literal replacement character: \uFFFD";
    await f.write(name, valid);
    assert.deepEqual(await f.open(name), { path: name, kind: "text", content: valid });
  }
  for (const [name, kind] of [["figure.svg", "image"], ["figure.pdf", "pdf"]]) {
    await f.write(name, "valid UTF-8 text");
    assert.equal((await f.open(name)).kind, kind);
  }
  await f.write("invalid.unknown", invalid);
  assert.deepEqual(await f.open("invalid.unknown"), { path: "invalid.unknown", kind: "unsupported" });
  await f.write("huge.unknown", "");
  await fsp.truncate(path.join(f.root, "huge.unknown"), MAX_UNKNOWN_TEXT_FILE_BYTES + 1);
  assert.deepEqual(await f.open("huge.unknown"), { path: "huge.unknown", kind: "unsupported" });
  await f.write("known.lua", Buffer.from([0]));
  assert.equal((await f.open("known.lua")).kind, "unsupported");
});

test("opening unknown text leaves file listing, search and collaboration classification unchanged", async (t) => {
  const f = await fixture(t);
  for (const name of ["main.tex", "canon.ltjruby", "latexmkrc", ".arbitrary", "hidden.aux", "skip.idx"]) {
    await f.write(name, "needle\n");
  }
  const listed = await f.workspace.listFiles();
  assert.equal(listed.includes("hidden.aux"), false);
  assert.equal(listed.includes("canon.ltjruby"), true);
  const manifest = new WorkspaceManifest(f.root);
  await manifest.scan();
  assert.equal(manifest.get("canon.ltjruby").kind, "binary");
  assert.equal(manifest.get("latexmkrc").kind, "binary");
  assert.equal(manifest.get("skip.idx"), null);
  const before = JSON.stringify([...manifest.entries]);
  await f.open("canon.ltjruby");
  await f.open("latexmkrc");
  assert.deepEqual(await f.workspace.listFiles(), listed);
  assert.deepEqual((await new SearchService().search(f.root, "needle")).map((entry) => entry.path), ["main.tex"]);
  await manifest.scan();
  assert.equal(JSON.stringify([...manifest.entries]), before);
});

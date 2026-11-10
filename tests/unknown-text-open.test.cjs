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
      viewer: { getViewerMode: () => mode, hideViewer: () => { mode = "hidden"; },
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
          ? fixture.handlers.handleOpenFile(message.path)
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
    open: async (name) => { ops.requestOpenFile(name, "primary"); await Promise.all(pending.splice(0)); },
  };
};

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
  assert.deepEqual(f.messages.at(-1).payload, { path: "blob.unknown", kind: "unsupported" });
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

test("legacy text decoding and special viewers stay unchanged; unknown invalid or oversized files stay unsupported", async (t) => {
  const f = await fixture(t);
  const invalid = Buffer.from([0xff, 0x41]);
  for (const name of ["known.tex", "known.lua", "known.md"]) {
    await f.write(name, invalid);
    const result = await f.open(name);
    assert.equal(result.kind, "text");
    assert.equal(result.content, invalid.toString("utf8"));
    assert.equal(result.languageId, undefined);
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

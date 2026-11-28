"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const monacoRoot = path.join(root, "Resources/web/monaco");
const moduleNames = [
  "build-ops-ui", "bridge-handlers", "jump-build-rules", "editor-session-file-ops",
  "editor-session/core-ops", "editor-session/buffer-ops", "editor-session/tab-state-ops",
  "files", "diff", "save-status", "viewer", "editor-session/model-path",
  "editor-session/issue-ops", "editor-session/issue-focus", "editor-session/navigation-ops",
  "editor-session/live-edit-history", "editor-session/text-merge",
];
const modules = Object.fromEntries(moduleNames.map((name) => [name, ts.transpileModule(
  fs.readFileSync(path.join(root, "web-src/app", `${name}.ts`), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText]));

test("Build saves both buffers, ignores a double click, and shows the root PDF beside an active right-hand child", async (t) => {
  const browser = await chromium.launch({
    headless: true,
    args: process.env.TEX64_TEST_CHROMIUM_SINGLE_PROCESS ? ["--single-process", "--disable-gpu"] : [],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  await page.route("http://child-build.test/**", (route) => {
    const rel = new URL(route.request().url()).pathname;
    if (rel === "/") {
      return route.fulfill({ contentType: "text/html", body: `
        <!doctype html><button id="build">Build</button><button id="jump">Jump</button>
        <button id="format">Format</button><button id="save">Save</button><input id="other">
        <div id="primary" style="width:500px;height:250px"></div>
        <div id="secondary" style="width:500px;height:250px"></div>
        <script src="/vs/loader.js"></script>` });
    }
    if (rel === "/pdf-viewer.html") return route.fulfill({ contentType: "text/html", body: "" });
    const file = path.join(monacoRoot, rel);
    if (!file.startsWith(monacoRoot + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ path: file });
  });
  await page.goto("http://child-build.test/");
  await page.evaluate(async (sources) => {
    window.MonacoEnvironment = { getWorkerUrl: () => "data:text/javascript,;" };
    require.config({ paths: { vs: "/vs" } });
    await new Promise((resolve) => require(["vs/editor/editor.main"], resolve));
    const noop = () => {};
    const notices = [];
    const stubs = {
      i18n: { uiText: (en) => en, getUiLocale: () => "en" },
      "collab/session": { collabSession: { getState: () => ({ active: false }) } },
      "build-log-view": {},
      "editor-notice": { hideEditorNotice: noop, showEditorNotice: (_at, text) => notices.push(text) },
      explain: {},
      "monaco-setup": {},
    };
    const loaded = new Map();
    const load = (name) => {
      if (stubs[name]) return stubs[name];
      if (loaded.has(name)) return loaded.get(name);
      if (!sources[name]) throw new Error(`Unexpected module ${name}`);
      const exports = {};
      loaded.set(name, exports);
      const importModule = (rel) => {
        const url = new URL(rel, `http://modules.test/${name}.js`);
        return load(url.pathname.slice(1, -3));
      };
      new Function("exports", "require", sources[name])(exports, importModule);
      return exports;
    };
    const child = "book/chapters/child.tex";
    const other = "book/main.tex";
    const pdf = "output/print.pdf";
    const opened = [];
    const messages = [];
    const makeGroup = (key, file) => {
      const model = monaco.editor.createModel(Array.from({ length: 160 }, (_, i) => `Line ${i + 1}`).join("\n"));
      const editor = monaco.editor.create(document.getElementById(key), { model });
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const viewer = load("viewer").createViewer({ editorViewerPdf: frame });
      return {
        key, editor, currentFilePath: file, currentFileSavedContent: "old",
        openTabs: [file], viewStates: new Map(), isDirty: true, isComposing: false,
        viewer: {
          ...viewer,
          showPdfViewer: (path, data, mime, preserveFocus) => {
            viewer.showPdfViewer(path, btoa(data), mime, preserveFocus);
            opened.push([key, path, data]);
          },
          syncPdf: (payload) => opened.push([key, payload.pdfPath, payload.page]),
        },
      };
    };
    const groups = { primary: makeGroup("primary", other), secondary: makeGroup("secondary", child) };
    // A PDF once opened in the now-active source group must not draw Jump there.
    groups.secondary.openTabs.push(pdf);
    const send = (message) => { messages.push(message); return true; };
    const runtime = {
      editorGroups: groups,
      monacoModels: new Map(Object.values(groups).map((group) => [
        group.currentFilePath, { model: group.editor.getModel(), savedContent: "old" },
      ])),
      dirtyFiles: new Set([child, other]),
      state: { activeEditorGroup: "secondary", splitViewEnabled: true, issueDecorations: [] },
      fileOpsState: { pendingOpenRequests: [], pendingReveal: null, pendingSave: null, autoSaveTimer: null },
      jumpDecorations: { primary: [], secondary: [] },
      jumpDecorationClassNames: { primary: null, secondary: null },
      issueHighlightClassNames: new Set(),
      deps: {
        getMonacoApi: () => monaco, updateIssues: noop, updateFallback: noop,
        setBlockPreviewActive: noop, setAutoDetectedUi: noop,
        fileTree: { setSelection: noop, render: noop, setTreeFocus: noop },
        outline: { render: noop }, editorTabs: { render: noop },
        buildOps: { updateSynctexButtonState: noop }, postToNative: send,
      },
    };
    const core = load("editor-session/core-ops").createEditorSessionCoreOps(runtime);
    const buffer = load("editor-session/buffer-ops").createEditorSessionBufferOps(runtime, core);
    const tabs = load("editor-session/tab-state-ops").createEditorSessionTabStateOps(runtime);
    const issueOps = load("editor-session/issue-ops").createEditorSessionIssueOps(runtime, core);
    const files = load("editor-session-file-ops").createEditorSessionFileOps({
      ...runtime, ...core, ...buffer, ...tabs,
      state: runtime.fileOpsState,
      setSplitViewEnabled: noop, clearJumpHighlight: noop, updateBreadcrumbs: noop, updateMiniOutline: noop,
      revealLine: issueOps.revealLine,
    });
    const navigation = load("editor-session/navigation-ops").createEditorSessionNavigationOps(runtime, core, issueOps, files);
    const { focusIssue } = load("editor-session/issue-focus").createEditorSessionIssueFocusOps(runtime, core, issueOps, navigation, files);
    let lastBuilt = null;
    let autoJump = false;
    const build = load("build-ops-ui").initBuildOpsUi({ dom: {
      buildButton: document.getElementById("build"), synctexButton: document.getElementById("jump"),
      saveButton: document.getElementById("save"), formatButton: document.getElementById("format"),
    } }, {
      ...core, postToNative: send, saveDirtyFiles: files.saveDirtyFiles, requestOpenFile: files.requestOpenFile,
      getWorkspaceRootKey: () => "project", getRootFilePath: () => other, getLastBuildMainFile: () => lastBuilt,
      getEditorGroups: () => Object.values(groups), getStoredCursorPosition: () => null, getWorkspaceFiles: () => [],
      cacheCurrentBuffer: buffer.cacheCurrentBuffer, getSplitViewEnabled: () => true,
      updateIssues: noop, setPendingBuildIssuesFocus: noop,
      settings: {
        getRuntimeStatusSummary: () => ({ hasAnyResult: true, runtimeReady: true }),
        getPdfViewerMode: () => "tab", buildFormatSettingsPayload: () => ({}),
        getAutoSynctexOnBuildEnabled: () => autoJump,
      },
    });
    build.setupActionButtons();
    let receive;
    load("bridge-handlers").initBridgeHandlers({
      bridgeWindow: { tex64Bridge: { onMessage: (callback) => { receive = callback; } } },
      build: { ...build, setBuildTarget: (file) => { lastBuilt = file; } },
      editorSession: files,
    });
    const editor = groups.secondary.editor;
    editor.setPosition({ lineNumber: 60, column: 4 });
    editor.setScrollTop(950);
    const view = () => ({
      file: core.getActiveFilePath(), group: runtime.state.activeEditorGroup,
      position: editor.getPosition(), scrollTop: editor.getScrollTop(),
    });
    window.harness = {
      messages, opened, view, notices,
      enableAutoJump: () => { autoJump = true; },
      save: (file) => files.handleSaveResult({ path: file, ok: true }),
      lastBuilt: () => lastBuilt,
      focusEditor: () => editor.focus(),
      editorFocused: () => document.getElementById("secondary").contains(document.activeElement),
      editorLine: () => editor.getModel().getLineContent(editor.getPosition().lineNumber),
      show: (buildPreview, data) => receive({
        type: "openFileResult", payload: { path: pdf, kind: "pdf", buildPreview, data },
      }),
      buildState: (state) => receive({ type: "setBuildState", payload: { state, targetFile: other } }),
      activate: (file, key = "primary") => {
        runtime.state.activeEditorGroup = key;
        groups[key].currentFilePath = file;
        build.updateSynctexButtonState();
      },
      focusIssue: (path, line, column) => focusIssue({ severity: "error", path, line, column, message: "Error." }),
      openText: ({ path, openRequestId }) => files.handleOpenFileResult({
        path, openRequestId, kind: "text", content: "First line\nSecond line\nThird line",
      }),
      jumpResult: (requestId) => build.handleSynctexForwardResult({ ok: true, requestId, pdfPath: pdf, page: 3 }),
      jumpFailure: (payload) => build.handleSynctexForwardResult({
        requestId: messages.at(-1).requestId, ok: false, ...payload,
      }),
    };
  }, modules);

  const before = await page.evaluate(() => harness.view());
  await page.evaluate(() => harness.focusEditor());
  await page.locator("#build").dblclick();
  assert.equal(await page.evaluate(() => harness.editorFocused()), true);
  // Two distinct Chromium click events can both have detail=1.
  await page.locator("#build").click();
  await page.keyboard.type("!");
  assert.equal(await page.evaluate(() => harness.editorLine()), "Lin!e 60");
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => harness.messages.some((message) => message.type === "saveFile"));
  assert.deepEqual(await page.evaluate(() => harness.messages.map(({ type, path }) => [type, path])), [
    ["saveFile", "book/chapters/child.tex"],
  ]);
  await page.evaluate(() => harness.save("book/chapters/child.tex"));
  await page.waitForFunction(() => harness.messages.length === 2);
  assert.equal(await page.evaluate(() => harness.messages[1].path), "book/main.tex");
  await page.evaluate(() => harness.save("book/main.tex"));
  await page.waitForFunction(() => harness.messages.some((message) => message.type === "build"));
  assert.deepEqual(await page.evaluate(() => harness.messages.map(({ type }) => type)), ["saveFile", "saveFile", "build"]);
  assert.equal(await page.evaluate(() => harness.messages[2].mainFile), "book/chapters/child.tex");
  await page.evaluate(() => harness.buildState("building"));
  assert.equal(await page.evaluate(() => harness.lastBuilt()), null);

  assert.equal(await page.evaluate(() => {
    document.getElementById("other").focus();
    harness.show("previous", "old PDF");
    harness.show("built", "fresh PDF");
    harness.buildState("success");
    return document.activeElement.id;
  }), "other");
  // A very fast Build can finish before the second click is delivered.
  await page.locator("#build").click();
  assert.equal(await page.evaluate(() => harness.messages.filter(({ type }) => type === "build").length), 1);
  assert.equal(await page.evaluate(() => harness.lastBuilt()), "book/main.tex");
  assert.deepEqual(await page.evaluate(() => harness.opened), [
    ["primary", "output/print.pdf", "old PDF"],
    ["primary", "output/print.pdf", "fresh PDF"],
  ]);
  assert.deepEqual(await page.evaluate(() => harness.view()), before);

  await page.evaluate(() => harness.focusEditor());
  await page.locator("#jump").click();
  const jump = await page.evaluate(() => harness.messages.at(-1));
  assert.equal(jump.type, "synctex:forward");
  assert.equal(jump.path, "book/chapters/child.tex");
  assert.equal(jump.line, 60);
  await page.evaluate((requestId) => harness.jumpResult(requestId), jump.requestId);
  assert.equal(await page.evaluate(() => harness.editorFocused()), true);
  assert.deepEqual(await page.evaluate(() => harness.opened.at(-1)), ["primary", "output/print.pdf", 3]);
  assert.deepEqual(await page.evaluate(() => harness.view()), before);

  // A second source can submit while the first Build is still running.
  await page.waitForTimeout(510);
  await page.locator("#build").click();
  await page.waitForFunction(() => harness.messages.filter((message) => message.type === "build").length === 2);
  await page.locator("#build").click();
  assert.equal(await page.evaluate(() => harness.messages.some((message) => message.type === "build:cancel")), false);
  await page.evaluate(() => harness.activate("slides/deck.tex"));
  assert.equal(await page.locator("#build").getAttribute("aria-label"), "Build");
  await page.locator("#build").click();
  await page.waitForFunction(() => harness.messages.filter((message) => message.type === "build").length === 3);
  assert.equal(await page.evaluate(() => harness.messages.at(-1).mainFile), "slides/deck.tex");
  assert.equal(await page.evaluate(() => harness.messages.some((message) => message.type === "build:cancel")), false);
  await page.waitForTimeout(510);
  await page.locator("#build").click();
  assert.equal(await page.evaluate(() => harness.messages.at(-1).type), "build:cancel");

  await page.evaluate(() => {
    harness.buildState("success");
    harness.activate("book/chapters/child.tex", "secondary");
    harness.focusIssue("book/chapters/child.tex", 9, 3);
  });
  assert.deepEqual(await page.evaluate(() => harness.view().position), { lineNumber: 9, column: 3 });
  await page.evaluate(() => harness.focusIssue("book/chapters/other.tex", 2, 4));
  const issueOpen = await page.evaluate(() => harness.messages.at(-1));
  assert.equal(issueOpen.type, "openFile");
  assert.equal(issueOpen.path, "book/chapters/other.tex");
  await page.evaluate((request) => harness.openText(request), issueOpen);
  assert.equal(await page.evaluate(() => harness.view().file), "book/chapters/other.tex");
  assert.deepEqual(await page.evaluate(() => harness.view().position), { lineNumber: 2, column: 4 });

  for (const button of ["format", "save", "jump"]) {
    await page.evaluate(() => harness.focusEditor());
    const original = await page.evaluate(() => harness.editorLine());
    await page.locator(`#${button}`).click();
    await page.keyboard.type("!");
    assert.equal(await page.evaluate(() => harness.editorLine()), original.slice(0, 3) + "!" + original.slice(3), button);
    await page.keyboard.press("Backspace");
  }
  await page.evaluate(() => harness.jumpResult(harness.messages.at(-1).requestId));

  // A failed Live pass shows the existing notice. A missing sidecar without
  // a failed pass returns NEEDS_BUILD, which the UI follows exactly once.
  await page.evaluate(() => { harness.messages.length = 0; harness.enableAutoJump(); });
  await page.locator("#jump").click();
  await page.evaluate(() => harness.jumpFailure({ error: "SyncTeX data was not found." }));
  assert.equal(await page.evaluate(() => harness.notices.length), 1);
  assert.deepEqual(await page.evaluate(() => harness.messages.map(({ type }) => type)), ["synctex:forward"]);

  await page.locator("#jump").click();
  await page.evaluate(() => harness.jumpFailure({ code: "NEEDS_BUILD", targetFile: "book/main.tex" }));
  const save = await page.evaluate(() => harness.messages.findLast(({ type }) => type === "saveFile")?.path);
  if (save) await page.evaluate((file) => harness.save(file), save);
  await page.waitForFunction(() => harness.messages.some(({ type }) => type === "build"));
  await page.evaluate(() => harness.buildState("success"));
  await page.waitForFunction(() => harness.messages.filter(({ type }) => type === "synctex:forward").length === 3);
  await page.evaluate(() => harness.jumpResult(harness.messages.at(-1).requestId));
  assert.deepEqual(await page.evaluate(() => harness.opened.at(-1)), ["primary", "output/print.pdf", 3]);
  assert.equal(await page.evaluate(() => harness.messages.filter(({ type }) => type === "build").length), 1);
  assert.equal(await page.evaluate(() => harness.notices.length), 1);
});

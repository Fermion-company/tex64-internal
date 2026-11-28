"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { chromium } = require("playwright");
const { createWorkspaceFileHandlers } = require("../electron/handlers/workspace/file-handlers.cjs");

const root = path.join(__dirname, "..");
const compiled = new Map();
async function setup(t) {
  const browser = await chromium.launch({
    headless: true,
    args: process.env.TEX64_TEST_CHROMIUM_SINGLE_PROCESS ? ["--single-process", "--disable-gpu"] : [],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://editor.test/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/") {
      const group = (key) => `<div class="editor-group" data-key="${key}">
        <div class="editor-tabs"><div class="editor-tabs-list"></div></div><div class="editor-host"></div>
      </div>`;
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/theme.css">
          <style>body{display:block;overflow:auto} #tree{width:350px}
          .editor-group{width:510px;height:210px;margin:8px;grid-template-rows:34px minmax(0,1fr)}
          .editor-host{min-height:0}</style>
          <div id="tree"></div>${group("primary")}${group("secondary")}
          <script src="/vs/loader.js"></script>`,
      });
    }
    if (pathname.startsWith("/app/")) {
      if (!compiled.has(pathname)) {
        const sourcePath = path.join(root, "web-src", pathname.replace(/\.js$/, ".ts"));
        compiled.set(pathname, ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2019 },
        }).outputText);
      }
      return route.fulfill({ contentType: "text/javascript", body: compiled.get(pathname) });
    }
    const asset = path.join(root, "Resources/web", pathname.startsWith("/vs/") ? "monaco" : "", pathname);
    return fs.existsSync(asset) ? route.fulfill({ path: asset }) : route.fulfill({ status: 404 });
  });
  await page.goto("http://editor.test/");
  await page.evaluate(async () => {
    const modules = await Promise.all([
      import("/app/editor-tabs-ui.js"),
      import("/app/editor-session-file-ops.js"),
      import("/app/editor-session/tab-state-ops.js"),
      import("/app/editor-session/buffer-ops.js"),
      import("/app/file-tree-render.js"),
      import("/app/editor-session/navigation-ops.js"),
    ]);
    const [{ initEditorTabsUi }, { createEditorSessionFileOps }, { createEditorSessionTabStateOps },
      { createEditorSessionBufferOps }, { createFileTreeRenderer }, { createEditorSessionNavigationOps }] = modules;
    await new Promise((resolve) => {
      window.MonacoEnvironment = { getWorkerUrl: () => "data:text/javascript,;" };
      require.config({ paths: { vs: "/vs" } });
      require(["vs/editor/editor.main"], resolve);
    });

    const noop = () => {};
    const groups = {};
    for (const root of document.querySelectorAll(".editor-group")) {
      const key = root.dataset.key;
      const editorHost = root.querySelector(".editor-host");
      groups[key] = {
        key, root, tabs: root.querySelector(".editor-tabs"), tabsList: root.querySelector(".editor-tabs-list"),
        editorHost, openTabs: [], currentFilePath: null, isComposing: false, viewStates: new Map(),
        viewer: {
          mode: "hidden",
          getViewerMode() { return this.mode; },
          hideViewer() { this.mode = "hidden"; },
          showPdfViewer() { this.mode = "pdf"; },
        },
        editor: monaco.editor.create(editorHost, { value: "", minimap: { enabled: false } }),
      };
    }

    let active = "primary";
    let treeDrag = null;
    let tabs;
    const dirtyFiles = new Set();
    const monacoModels = new Map();
    const sent = [];
    const moved = [];
    const revealed = [];
    const state = { pendingOpenRequests: [], pendingReveal: null, pendingSave: null };
    const getGroup = (key) => groups[key];
    const getActiveGroup = () => groups[active];
    const isActiveGroup = (group) => group.key === active;
    const setActiveGroup = (key) => {
      if (active === key) return;
      active = key;
      tabs.render(groups[key]); // setActiveGroup's updateBreadcrumbs path.
    };
    const forEachEditorGroup = (fn) => Object.values(groups).forEach(fn);
    const revealLine = (group, line, options) => {
      revealed.push([group.currentFilePath, line, options.column]);
    };
    const deps = {
      getMonacoApi: () => monaco, postToNative: (payload) => (sent.push(payload), true),
      updateFallback: (message) => { throw Error(message); },
      updateIssues: noop,
      search: {}, settings: {}, editorTabs: { render: (group) => tabs.render(group) },
      fileTree: { setSelection: noop, setTreeFocus: noop, render: noop },
      outline: { render: noop }, setBlockPreviewActive: noop, setAutoDetectedUi: noop,
      buildOps: { updateSynctexButtonState: noop },
    };
    const runtime = { deps, editorGroups: groups, dirtyFiles, monacoModels };
    const tabState = createEditorSessionTabStateOps(runtime);
    const buffers = createEditorSessionBufferOps(runtime, { forEachEditorGroup });
    const fileOps = createEditorSessionFileOps({
      ...runtime, ...tabState, ...buffers, state,
      getActiveEditorGroupKey: () => active, getActiveGroup, getEditorGroup: getGroup, isActiveGroup,
      resolveAutoOpenGroupKey: (key) => key,
      findGroupKeyByPath: (path) => Object.keys(groups).find((key) => groups[key].openTabs.includes(path)) ?? null,
      setSplitViewEnabled: noop, clearJumpHighlight: noop, updateMiniOutline: noop, forEachEditorGroup,
      updateBreadcrumbs: () => tabs.render(getActiveGroup()), revealLine,
      getLanguageIdForPath: () => "plaintext",
    });
    const closeTab = (group, path) => {
      group.openTabs = group.openTabs.filter((entry) => entry !== path);
      tabs.render(group);
    };
    tabs = initEditorTabsUi({}, {
      ...tabState, ...buffers, getGroup, isActiveGroup, setActiveGroup, closeTab,
      getGroups: () => Object.values(groups),
      requestOpenFile: fileOps.requestOpenFile, getTreeDragPayload: () => treeDrag,
      getDirtyPaths: () => dirtyFiles, setEditorEmptyState: noop, updateSynctexButtonState: noop,
      getSplitViewEnabled: () => true, setSplitViewEnabled: noop,
    });
    tabs.setupInteractions();

    const tree = createFileTreeRenderer({
      fileTree: document.getElementById("tree"),
      deps: {
        getWorkspaceFiles: () => ["drop.tex", "pane.tex"], getWorkspaceFolders: () => ["folder"],
        getActiveFilePath: () => null, getDirtyPaths: () => dirtyFiles, isAnyGroupComposing: () => false,
      },
      actions: {
        getSelection: () => ({}), getInitialFolderOpenState: () => true,
        getDragPayload: () => treeDrag, setDragPayload: (payload) => { treeDrag = payload; },
        requestMoveItem: (payload, folder) => moved.push([payload.path, folder]),
      },
    });
    tree.render();

    const { primary, secondary } = groups;
    const navigation = createEditorSessionNavigationOps({ fileOpsState: state }, {
      getEditorGroup: getGroup, resolveOpenTargetGroupKey: (_path, key) => key,
    }, { revealLine }, fileOps);
    const seed = (group, paths) => {
      for (const path of paths) {
        monacoModels.set(path, { model: monaco.editor.createModel(path, "plaintext"), savedContent: path });
      }
      group.openTabs = paths;
      group.currentFilePath = paths[0];
      group.editor.setModel(monacoModels.get(paths[0]).model);
      tabs.render(group);
    };
    seed(primary, ["ch1.tex", "ch2.tex", "ch3.tex", "ch4.tex"]);
    seed(secondary, ["notes.tex", "appendix.tex"]);
    const click = (group, path) =>
      groups[group].tabsList.querySelector(`.editor-tab[data-path="${path}"]`).click();
    window.fixture = {
      primary, secondary, tabs, fileOps, buffers, state, sent, moved, dirtyFiles, monacoModels, navigation, revealed, click,
    };
  });
  return page;
}

const tab = (page, group, path) => page.locator(`[data-key="${group}"] .editor-tab[data-path="${path}"]`);

test("a small pointer movement on a tab in the inactive pane preserves the click", async (t) => {
  const page = await setup(t);
  const box = await tab(page, "secondary", "appendix.tex").boundingBox();
  await page.mouse.move(box.x + 30, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 32, box.y + 13);
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => {
    const { secondary, sent } = fixture;
    return [secondary.currentFilePath, secondary.editor.getValue(), secondary.editor.hasTextFocus(), sent];
  }), ["appendix.tex", "appendix.tex", true, []]);
});

test("loaded tabs switch within the click and keep buffer, view and strip position during a save", async (t) => {
  const page = await setup(t);
  assert.deepEqual(await page.evaluate(() => {
    const { click, primary, state, sent, monacoModels, dirtyFiles } = fixture;
    primary.editor.setValue("Unsaved typing");
    primary.editor.setPosition({ lineNumber: 1, column: 4 });
    state.pendingSave = { path: "ch1.tex" };
    const strip = primary.tabsList;
    strip.scrollLeft = 40;
    const beforeScroll = strip.scrollLeft;
    click("primary", "ch2.tex");
    const second = primary.editor.getModel() === monacoModels.get("ch2.tex").model;
    click("primary", "ch3.tex");
    const third = primary.editor.getValue();
    click("primary", "ch1.tex");
    return [second, third, primary.editor.getValue(), primary.editor.getPosition().column,
      dirtyFiles.has("ch1.tex"), primary.editor.hasTextFocus(), strip.scrollLeft === beforeScroll, sent];
  }), [true, "ch3.tex", "Unsaved typing", 4, true, true, true, []]);
});

test("a late file reply cannot replace the last clicked tab, even when that tab was already active", async (t) => {
  const page = await setup(t);
  assert.deepEqual(await page.evaluate(() => {
    const { click, primary, monacoModels, tabs, sent, fileOps } = fixture;
    for (const path of ["one.pdf", "two.pdf"]) primary.openTabs.push(path);
    tabs.render(primary);
    click("primary", "one.pdf");
    click("primary", "two.pdf");
    const [one, two] = sent;
    fileOps.handleOpenFileResult({ ...two, kind: "pdf" });
    fileOps.handleOpenFileResult({ ...one, kind: "pdf" });
    const order = primary.currentFilePath;
    click("primary", "ch1.tex");
    click("primary", "one.pdf");
    click("primary", "ch1.tex");
    const result = sent.at(-1);
    fileOps.handleOpenFileResult({ ...result, kind: "pdf" });
    return [order, primary.currentFilePath, primary.editor.getModel() === monacoModels.get("ch1.tex").model];
  }), ["two.pdf", "ch1.tex", true]);
});

test("composition defers only the safe model swap and the latest tab intent wins", async (t) => {
  const page = await setup(t);
  assert.deepEqual(await page.evaluate(async () => {
    const { click, primary, buffers, sent } = fixture;
    primary.isComposing = true;
    let waitingSaveResumed = false;
    buffers.scheduleAfterComposition(primary, () => { waitingSaveResumed = true; });
    click("primary", "ch2.tex");
    const during = primary.editor.getValue();
    primary.editor.setValue("Committed IME text");
    primary.isComposing = false;
    buffers.handleCompositionEnd(primary);
    click("primary", "ch3.tex");
    await new Promise(requestAnimationFrame);
    click("primary", "ch1.tex");
    const original = primary.editor.getValue();
    click("primary", "ch3.tex");
    return [during, original, primary.editor.getValue(), waitingSaveResumed, sent];
  }), ["ch1.tex", "Committed IME text", "ch3.tex", true, []]);
});

test("a real Monaco IME composition releases the selected tab after the user leaves the editor", async (t) => {
  const page = await setup(t);
  await page.evaluate(async () => {
    const { trackComposition } = await import("/app/editor-composition.js");
    const { primary, buffers } = fixture;
    trackComposition(primary.editor, primary.editorHost, primary, {
      onEnd: () => buffers.handleCompositionEnd(primary),
      recover: () => {},
    });
    primary.editor.focus();
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "漢", selectionStart: 1, selectionEnd: 1 });
  await page.waitForFunction(() => fixture.primary.isComposing, null, { timeout: 3000 });
  await tab(page, "primary", "ch2.tex").click();
  await page.waitForFunction(() => fixture.primary.currentFilePath === "ch2.tex", null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => fixture.primary.editor.getValue()), "ch2.tex");
});

test("jumping to a cached tab also reveals the requested line and column", async (t) => {
  const page = await setup(t);
  assert.deepEqual(await page.evaluate(() => {
    const { navigation, primary, revealed, sent, state } = fixture;
    navigation.jumpToFileLine("ch2.tex", 2, "primary", { column: 3 });
    return [primary.currentFilePath, revealed, state.pendingReveal, sent];
  }), ["ch2.tex", [["ch2.tex", 2, 3]], null, []]);
});

test("tree drops insert at the strip position, open in the pane under the pointer and reject folders", async (t) => {
  const page = await setup(t);
  const result = await page.evaluate(() => {
    const { primary, secondary, sent, fileOps, moved } = fixture;
    const drag = (source, target, fraction = 0.25) => {
      const transfer = new DataTransfer();
      const box = target.getBoundingClientRect();
      const dispatch = (type, el) => el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: transfer,
        clientX: box.left + box.width * fraction, clientY: box.top + box.height / 2,
      }));
      dispatch("dragstart", source);
      const accepted = !dispatch("dragover", target);
      const indicator = target.dataset.dropPosition;
      if (accepted) dispatch("drop", target);
      dispatch("dragend", source);
      return [accepted, indicator, target.dataset.dropPosition];
    };
    const source = document.querySelector('.file-item[data-path="drop.tex"]');
    const target = primary.tabsList.querySelector('[data-path="ch2.tex"]');
    const strip = drag(source, target);
    const stripOpenCount = sent.length;
    if (sent.length) fileOps.handleOpenFileResult({ ...sent.at(-1), content: "Dropped on strip" });
    const folder = document.querySelector(".file-folder summary");
    const rejected = drag(folder, secondary.editorHost);
    const pane = drag(document.querySelector('.file-item[data-path="pane.tex"]'), secondary.editorHost);
    if (sent.length > stripOpenCount) fileOps.handleOpenFileResult({ ...sent.at(-1), content: "Dropped on pane" });
    const treeMove = drag(source, folder);
    return { strip, stripOpenCount, order: primary.openTabs, primary: primary.currentFilePath,
      rejected, pane, secondary: secondary.currentFilePath, treeMove, moved };
  });
  assert.deepEqual(result, {
    strip: [true, "before", undefined], stripOpenCount: 1,
    order: ["ch1.tex", "drop.tex", "ch2.tex", "ch3.tex", "ch4.tex"], primary: "drop.tex",
    rejected: [false, undefined, undefined], pane: [true, undefined, undefined], secondary: "pane.tex",
    treeMove: [true, undefined, undefined], moved: [["drop.tex", "folder"]],
  });
});

test("pointer drags can reorder tabs, move them across panes and open a file over Monaco", async (t) => {
  const page = await setup(t);
  const destination = tab(page, "primary", "ch3.tex");
  await tab(page, "primary", "ch2.tex").dragTo(destination, { targetPosition: { x: 112, y: 12 } });
  assert.deepEqual(await page.evaluate(() => fixture.primary.openTabs),
    ["ch1.tex", "ch3.tex", "ch2.tex", "ch4.tex"]);
  await tab(page, "primary", "ch2.tex").dragTo(tab(page, "secondary", "appendix.tex"), {
    targetPosition: { x: 15, y: 12 },
  });
  assert.deepEqual(await page.evaluate(() => {
    const { primary, secondary } = fixture;
    return [primary.openTabs, secondary.openTabs, secondary.editor.getValue()];
  }), [["ch1.tex", "ch3.tex", "ch4.tex"], ["notes.tex", "ch2.tex", "appendix.tex"], "ch2.tex"]);
  await page.locator('.file-item[data-path="pane.tex"]').dragTo(
    page.locator('[data-key="secondary"] .view-lines'));
  assert.deepEqual(await page.evaluate(() => {
    const { secondary, fileOps, moved, sent } = fixture;
    const request = sent.at(-1);
    if (request) fileOps.handleOpenFileResult({ ...request, content: "Dropped on Monaco" });
    return [sent.map(({ path }) => path), secondary.currentFilePath, secondary.editor.getValue(), moved];
  }), [["pane.tex"], "pane.tex", "Dropped on Monaco", []]);
});

test("main echoes the renderer request ID on both successful and failed file reads", async () => {
  const replies = [];
  const handlers = createWorkspaceFileHandlers({
    workspace: { readFile: async () => "chapter text" },
    ensureWorkspace: () => "/workspace",
    updateWorkspaceIfNeeded: async () => {},
    isPdfFilePath: () => false,
    isImageFilePath: () => false,
    isTextFilePath: () => true,
    isExtendedTextFilePath: () => false,
    sendToRenderer: (type, payload) => replies.push([type, payload]),
  });
  await handlers.handleOpenFile("ch2.tex", { openRequestId: 42 });
  assert.deepEqual(replies[0], ["openFileResult", {
    path: "ch2.tex", kind: "text", content: "chapter text", openRequestId: 42,
  }]);

  const withoutWorkspace = createWorkspaceFileHandlers({
    ensureWorkspace: () => null,
    sendToRenderer: (type, payload) => replies.push([type, payload]),
  });
  await withoutWorkspace.handleOpenFile("ch2.tex", { openRequestId: 43 });
  assert.equal(replies[1][0], "openFileResult");
  assert.equal(replies[1][1].openRequestId, 43);
  assert.ok(replies[1][1].error);
});

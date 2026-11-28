"use strict";

// Build's target from the renderer's side, answered by the real resolver:
// the chooser's pick is reused while ownership stays ambiguous (A2), and a
// non-TeX tab builds the other pane's TeX file, the last document built or
// the workspace root (A3), as in v0.1.32.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { chromium } = require("playwright");
const { resolveBuildTarget, BUILD_TARGET_CHOICE } = require("../electron/services/tex-build-target.cjs");

const root = path.resolve(__dirname, "..");
const modules = Object.fromEntries(["build-ops-ui", "jump-build-rules"].map((name) => [name, ts.transpileModule(
  fs.readFileSync(path.join(root, "web-src/app", `${name}.ts`), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText]));
const doc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

// In-memory workspace; `recorded` stands in for the build recorder: a
// document's reads are proof only while the files it read are unchanged.
const workspaceOf = (files, state) => ({
  getRootPath: () => "/ws",
  resolvePath: (file) => path.posix.join("/ws", file),
  readFile: async (file) => { if (file in files) return files[file]; throw new Error("ENOENT"); },
  listFiles: async () => Object.keys(files).sort(),
  getRecentBuildTargets: () => [],
  rootInfo: async () => (state.root ? { path: state.root, source: "auto" } : null),
  resolveTexRootFromMagic: async (file) => state.magic[file] ?? null,
});
const recorder = (files) => {
  const recorded = new Map();
  return {
    note: (document) => recorded.set(document, Object.fromEntries(Object.entries(files))),
    reads: async ({ mainFileName, requiredFiles }) => {
      const snapshot = recorded.get(mainFileName);
      if (!snapshot || !requiredFiles.every((file) => snapshot[file] === files[file])) return null;
      return new Set(requiredFiles);
    },
  };
};

const openPage = async (t) => {
  const browser = await chromium.launch({
    headless: true,
    args: process.env.TEX64_TEST_CHROMIUM_SINGLE_PROCESS ? ["--single-process", "--disable-gpu"] : [],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  // (an http origin: Build reads the engine from localStorage)
  await page.route("http://build-target.test/**", (route) => route.fulfill({ contentType: "text/html", body: `
    <!doctype html><button id="build"><span class="build-button-label">Build</span></button>
    <button id="jump">Jump</button><button id="format">Format</button><button id="save">Save</button>` }));
  await page.goto("http://build-target.test/");
  await page.evaluate((sources) => {
    const noop = () => {};
    const stubs = {
      i18n: { uiText: (en) => en, getUiLocale: () => "en" },
      "collab/session": { collabSession: { getState: () => ({ active: false }), onChange: () => noop } },
      "build-log-view": { countMarkedLines: () => 0, renderBuildLog: () => null, segmentBuildLog: () => [] },
      "editor-notice": { hideEditorNotice: noop, showEditorNotice: noop },
      explain: { explainedHeading: (heading) => [heading] },
    };
    const loaded = new Map();
    const load = (name) => {
      if (stubs[name]) return stubs[name];
      if (loaded.has(name)) return loaded.get(name);
      const exports = {};
      loaded.set(name, exports);
      new Function("exports", "require", sources[name])(exports, (rel) => load(rel.replace(/^\.\//, "").replace(/\.js$/, "")));
      return exports;
    };
    const messages = [];
    const groups = {
      primary: { key: "primary", currentFilePath: null, openTabs: [], editor: null, viewer: { getViewerMode: () => "editor", syncPdf: noop } },
      secondary: { key: "secondary", currentFilePath: null, openTabs: [], editor: null, viewer: { getViewerMode: () => "editor", syncPdf: noop } },
    };
    const state = { files: [], root: null, lastBuilt: null, active: "primary" };
    const build = load("build-ops-ui").initBuildOpsUi({ dom: {
      buildButton: document.getElementById("build"), synctexButton: document.getElementById("jump"),
      saveButton: document.getElementById("save"), formatButton: document.getElementById("format"),
    } }, {
      getActiveGroup: () => groups[state.active],
      getActiveFilePath: () => groups[state.active].currentFilePath,
      getWorkspaceFiles: () => state.files,
      getRootFilePath: () => state.root,
      getWorkspaceRootKey: () => "project",
      getLastBuildMainFile: () => state.lastBuilt,
      getStoredCursorPosition: () => null,
      cacheCurrentBuffer: noop,
      postToNative: (message) => { messages.push(message); return true; },
      updateIssues: noop, setPendingBuildIssuesFocus: noop,
      getEditorGroups: () => Object.values(groups),
      getSplitViewEnabled: () => true, setSplitViewEnabled: noop,
      settings: {
        getRuntimeStatusSummary: () => ({ hasAnyResult: true, runtimeReady: true }),
        getPdfViewerMode: () => "tab", buildFormatSettingsPayload: () => ({}),
        getAutoSynctexOnBuildEnabled: () => false,
      },
    });
    build.setupActionButtons();
    window.harness = {
      messages,
      set: (next) => {
        if ("files" in next) state.files = next.files;
        if ("root" in next) state.root = next.root;
        if ("lastBuilt" in next) state.lastBuilt = next.lastBuilt;
        if ("active" in next) state.active = next.active;
        if ("primary" in next) groups.primary.currentFilePath = next.primary;
        if ("secondary" in next) groups.secondary.currentFilePath = next.secondary;
      },
      // main's replies (bridge-handlers: the success names the built target first)
      succeed: (target) => { state.lastBuilt = target; build.setBuildState("success"); },
      choose: (payload) => { build.setBuildState("idle"); build.chooseBuildTarget(payload); },
      startBuild: (target) => build.startBuild(target),
      documentFor: (file) => build.documentFor(file) ?? null,
      chooser: () => {
        const dialog = document.querySelector("dialog.build-target-dialog");
        return dialog ? [...dialog.querySelectorAll(".build-target-row")].map((row) => row.textContent) : null;
      },
      pick: (file) => [...document.querySelectorAll("dialog .build-target-row")].find((row) => row.textContent === file).click(),
      cancelChooser: () => document.querySelector("dialog.build-target-dialog")?.close(),
      busy: () => document.getElementById("build").getAttribute("aria-busy"),
    };
  }, modules);
  return page;
};

// Main for the renderer's "build" message: an exact target builds as named;
// otherwise the resolver decides, or asks.
const answerBuilds = (page, files, state, record) => {
  let handled = 0;
  return async () => {
    const messages = await page.evaluate(() => harness.messages.filter(({ type }) => type === "build"));
    const outcomes = [];
    for (const message of messages.slice(handled)) {
      handled += 1;
      let target = message.targetFile;
      if (!target) {
        try {
          target = await resolveBuildTarget(workspaceOf(files, state), message.mainFile ?? null, { recordedReads: record.reads });
        } catch (error) {
          if (error.code !== BUILD_TARGET_CHOICE) throw error;
          await page.evaluate((payload) => harness.choose(payload), { requested: error.requested, candidates: error.candidates });
          outcomes.push({ message, chooser: await page.evaluate(() => harness.chooser()) });
          continue;
        }
      }
      record.note(target);
      await page.evaluate((file) => harness.succeed(file), target);
      outcomes.push({ message, built: target });
    }
    return outcomes;
  };
};

const click = async (page) => {
  // (the button ignores a second click on the same tab within 500 ms)
  await page.waitForTimeout(520);
  await page.locator("#build").click();
};

test("the chooser's pick is reused while ownership is ambiguous, and yields to a missing target and a magic root", async (t) => {
  const page = await openPage(t);
  const files = { "A.tex": doc("\\input{ch}"), "B.tex": doc("\\input{ch}"), "ch.tex": "Shared." };
  const state = { root: null, magic: {} };
  const record = recorder(files);
  const answer = answerBuilds(page, files, state, record);
  const sync = () => page.evaluate((list) => harness.set({ files: list }), Object.keys(files).sort());
  await sync();
  await page.evaluate(() => harness.set({ primary: "ch.tex" }));

  // First Build: two documents read the chapter, so it asks. Choose B.
  await click(page);
  let [outcome] = await answer();
  assert.deepEqual(outcome.chooser, ["A.tex", "B.tex"]);
  assert.equal(outcome.message.mainFile, "ch.tex");
  await page.evaluate(() => harness.pick("B.tex"));
  assert.deepEqual((await answer()).map(({ message, built }) => [message.targetFile, built]), [["B.tex", "B.tex"]]);
  assert.equal(await page.evaluate(() => harness.documentFor("ch.tex")), "B.tex");

  // Edit the shared chapter (B's recorded reads no longer prove anything),
  // then Build twice: B both times, with no chooser.
  for (const edit of ["Shared, edited.", "Shared, edited again."]) {
    files["ch.tex"] = edit;
    await click(page);
    const outcomes = await answer();
    assert.equal(await page.evaluate(() => harness.chooser()), null);
    // main asks again; the renderer answers with the pick, without a dialog
    const followUp = await answer();
    assert.deepEqual([...outcomes, ...followUp].filter(({ built }) => built).map(({ message, built }) => [message.targetFile ?? message.mainFile, built]),
      [["B.tex", "B.tex"]]);
  }
  // Unchanged since B's Build: the recorder settles it, still B.
  await click(page);
  assert.deepEqual((await answer()).map(({ message, built }) => [message.mainFile, built]), [["ch.tex", "B.tex"]]);

  // Rename B: the pick names a document that is gone, so the chooser returns
  // (and Jump, word count and citations stop naming B as well).
  files["B2.tex"] = files["B.tex"];
  delete files["B.tex"];
  await sync();
  assert.equal(await page.evaluate(() => harness.documentFor("ch.tex")), null);
  files["ch.tex"] = "Shared, after the rename.";
  await click(page);
  [outcome] = await answer();
  assert.deepEqual(outcome.chooser, ["A.tex", "B2.tex"]);
  await page.evaluate(() => harness.pick("B2.tex"));
  assert.deepEqual((await answer()).map(({ built }) => built), ["B2.tex"]);

  // An explicit choice (Build's context menu) builds exactly that document.
  await page.waitForTimeout(520);
  await page.evaluate(() => harness.startBuild("A.tex"));
  assert.deepEqual((await answer()).map(({ message, built }) => [message.targetFile, built]), [["A.tex", "A.tex"]]);
  assert.equal(await page.evaluate(() => harness.documentFor("ch.tex")), "B2.tex");

  // A magic root set afterwards wins over the pick, and replaces it.
  state.magic["ch.tex"] = "A.tex";
  files["ch.tex"] = "% !TEX root = A.tex\nShared.";
  await click(page);
  assert.deepEqual((await answer()).map(({ message, built }) => [message.mainFile, message.targetFile, built]),
    [["ch.tex", undefined, "A.tex"]]);
  assert.equal(await page.evaluate(() => harness.documentFor("ch.tex")), null);
});

test("Build from a non-TeX tab uses the other pane's TeX file, then the last document built, then the root", async (t) => {
  for (const withMain of [false, true]) {
    await t.test(withMain ? "with main.tex" : "without main.tex", async (st) => {
      const page = await openPage(st);
      const files = { "hw1.tex": doc("One."), "hw2.tex": doc("Two."), "hw2.bib": "@book{x,}" };
      if (withMain) files["main.tex"] = doc("Main.");
      const state = { root: withMain ? "main.tex" : null, magic: {} };
      const answer = answerBuilds(page, files, state, recorder(files));
      await page.evaluate(({ list, root }) => harness.set({ files: list, root, primary: "hw2.bib" }), {
        list: Object.keys(files).sort(), root: state.root,
      });

      // No TeX pane, nothing built yet: the workspace root, or main's question.
      await click(page);
      let [outcome] = await answer();
      if (withMain) {
        assert.deepEqual([outcome.message.mainFile, outcome.built], ["main.tex", "main.tex"]);
      } else {
        assert.equal(outcome.message.mainFile, undefined);
        assert.deepEqual(outcome.chooser, ["hw1.tex", "hw2.tex"]);
        await page.evaluate(() => harness.cancelChooser());
      }

      // A TeX file in the other pane: that file's document.
      await page.evaluate(() => harness.set({ secondary: "hw2.tex" }));
      await click(page);
      [outcome] = await answer();
      assert.deepEqual([outcome.message.mainFile, outcome.built], ["hw2.tex", "hw2.tex"]);

      // After building hw2.tex, with no TeX pane: the last document built.
      await page.evaluate(() => harness.set({ secondary: null }));
      await click(page);
      [outcome] = await answer();
      assert.deepEqual([outcome.message.mainFile, outcome.built], ["hw2.tex", "hw2.tex"]);

      // The other pane comes first; a .tex tab of its own comes before both.
      await page.evaluate(() => harness.set({ secondary: "hw1.tex" }));
      await click(page);
      [outcome] = await answer();
      assert.deepEqual([outcome.message.mainFile, outcome.built], ["hw1.tex", "hw1.tex"]);
      await page.evaluate(() => harness.set({ primary: "hw2.tex" }));
      await click(page);
      [outcome] = await answer();
      assert.deepEqual([outcome.message.mainFile, outcome.built], ["hw2.tex", "hw2.tex"]);

      // A last-built document that is gone is skipped for the root.
      delete files["hw2.tex"];
      await page.evaluate((list) => harness.set({ files: list, primary: "hw2.bib", secondary: null, lastBuilt: "hw2.tex" }),
        Object.keys(files).sort());
      await click(page);
      [outcome] = await answer();
      if (withMain) assert.deepEqual([outcome.message.mainFile, outcome.built], ["main.tex", "main.tex"]);
      else assert.deepEqual([outcome.message.mainFile, outcome.built], [undefined, "hw1.tex"]);
    });
  }
});

test("the busy button follows the tab that started the Build and the TeX file it named", async (t) => {
  const page = await openPage(t);
  await page.evaluate(() => harness.set({
    files: ["hw1.tex", "hw2.tex", "hw2.bib"], primary: "hw2.bib", secondary: "hw2.tex",
  }));
  await click(page);
  assert.equal(await page.evaluate(() => harness.messages.at(-1).mainFile), "hw2.tex");
  assert.equal(await page.evaluate(() => harness.busy()), "true");
  // the TeX file this Build is building: Cancel, not a second Build
  await page.evaluate(() => harness.set({ active: "secondary" }));
  await page.evaluate(() => harness.startBuild());
  assert.equal(await page.evaluate(() => harness.messages.filter(({ type }) => type === "build").length), 1);
  // another TeX file: a Build of its own
  await page.evaluate(() => harness.set({ secondary: "hw1.tex" }));
  await page.evaluate(() => harness.startBuild());
  assert.deepEqual(await page.evaluate(() => harness.messages.filter(({ type }) => type === "build").map(({ mainFile }) => mainFile)),
    ["hw2.tex", "hw1.tex"]);
});

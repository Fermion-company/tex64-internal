"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createBuildCoreHandlers } = require("../electron/handlers/build/build-core.cjs");
const { createBuildPathResolvers } = require("../electron/handlers/build/path-resolvers.cjs");
const { BuildService } = require("../electron/services/build/service.cjs");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const doc = (body) => String.raw`\documentclass{article}\begin{document}${body}\end{document}`;

const setup = ({ sharedChild = false } = {}) => {
  const root = path.join(__dirname, "fixtures/child-build");
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  const files = {
    "book/main.tex": doc(String.raw`\input{child}\input{only-in-book}\subfile{sub}`),
    "book/child.tex": "Chapter",
    "book/only-in-book.tex": "Just the book",
    "book/sub.tex": String.raw`\documentclass[main.tex]{subfiles}\begin{document}Chapter\end{document}`,
    "slides/deck.tex": doc(String.raw`\input{book/slide-body}`),
    "book/slide-body.tex": "Slide body",
    "other.tex": doc("Other"),
  };
  if (sharedChild) files["slides/deck.tex"] = doc(String.raw`\input{book/child}`);
  workspace.resolvePath = (file) => path.resolve(root, file);
  workspace.readFile = async (file) => files[file] ?? null;
  workspace.listFiles = workspace.listBuildTexFiles = async () => Object.keys(files);
  workspace.rootInfo = async () => null;
  workspace.resolveTexRootFromMagic = async () => null;
  workspace.loadSettings = async () => ({
    buildProfileId: "print",
    buildProfiles: [{ id: "print", engine: "pdflatex", extraArgs: "-jobname=print -outdir=output" }],
  });
  const builtFiles = new Set();
  const stat = (file) => {
    if (!builtFiles.has(file)) throw new Error("ENOENT");
    return { isFile: () => true, isSymbolicLink: () => false };
  };
  const io = { existsSync: (file) => builtFiles.has(file), statSync: stat, lstatSync: stat };
  const buildService = new BuildService();
  const events = [];
  const core = createBuildCoreHandlers({
    fs: io, workspace, buildService, state: {},
    ensureWorkspace: () => workspace.getRootPath(),
    updateWorkspaceIfNeeded: async () => {},
    sendBuildState: (state, message, context) => events.push({ state, ...context }),
    sendIssues: () => {},
    sendBuildLog: () => {},
    sendToRenderer: (type, payload) => { if (type === "build:chooseTarget") events.push({ choice: payload }); },
    handleOpenFile: async (file, options) => events.push({ open: file, preview: options?.buildPreview }),
    pdfWindowManager: {},
  }, createBuildPathResolvers({ fs, path }));
  const success = (target, profile) => {
    const { pdfPath } = buildService.resolveBuildOutputProfile(root, target, profile);
    builtFiles.add(pdfPath);
    builtFiles.add(pdfPath.replace(/\.pdf$/, ".synctex.gz"));
    return { kind: "success", pdfPath, summary: "Built", issues: [] };
  };
  return { root, workspace, buildService, core, events, success };
};

test("Build publishes the resolved root's configured PDF and remembers it for subsequent Jump", async () => {
  const { root, core, workspace, buildService, events, success } = setup();
  buildService.build = async (cwd, target, engine, profile) => {
    assert.equal(cwd, root);
    assert.equal(target, "slides/deck.tex");
    assert.equal(engine, "pdflatex");
    return success(target, profile);
  };
  await core.handleBuild("slides/deck.tex", { exactTarget: true, pdfViewerMode: "tab" });
  assert.deepEqual(workspace.getRecentBuildTargets(), ["slides/deck.tex"]);
  assert.deepEqual(await core.resolveJumpDocument("book/slide-body.tex"), {
    targetFile: "slides/deck.tex",
    pdfPath: path.join(root, "output/print.pdf"),
    built: true,
  });
  await core.handleBuild("book/slide-body.tex", { pdfViewerMode: "tab" });
  assert.deepEqual(events.filter((entry) => entry.open), [
    { open: "output/print.pdf", preview: "built" },
    { open: "output/print.pdf", preview: "previous" },
    { open: "output/print.pdf", preview: "built" },
  ]);
  assert.equal(events.at(-1).targetFile, "slides/deck.tex");
});

test("Build sends the release chooser event for a shared child and honours the answer", async () => {
  const { core, workspace, buildService, success, events } = setup({ sharedChild: true });
  workspace.noteBuildTarget("slides/deck.tex");
  const targets = [];
  buildService.build = async (_cwd, target, _engine, profile) => {
    targets.push(target);
    return success(target, profile);
  };
  await core.handleBuild("book/child.tex", { pdfViewerMode: "tab" });
  assert.deepEqual(targets, []);
  assert.deepEqual(events.find(({ choice }) => choice)?.choice, {
    requested: "book/child.tex", candidates: ["book/main.tex", "slides/deck.tex"],
  });
  await core.handleBuild("book/main.tex", { exactTarget: true, pdfViewerMode: "tab" });
  assert.deepEqual(targets, ["book/main.tex"]);
});

test("direct Build invocations serialize while busy, and a newer pending root replaces its duplicate", async () => {
  const { core, buildService, events, success } = setup();
  const started = deferred();
  const release = deferred();
  const targets = [];
  buildService.build = async (_cwd, target, _engine, profile) => {
    targets.push(target);
    if (targets.length === 1) {
      started.resolve();
      await release.promise;
    }
    return success(target, profile);
  };
  const first = core.handleBuild("book/child.tex", { pdfViewerMode: "tab" });
  await started.promise;
  try {
    await core.handleBuild("book/child.tex", { pdfViewerMode: "tab" });
    await core.handleBuild("other.tex", { pdfViewerMode: "tab" });
    assert.deepEqual(targets, ["book/main.tex"]);
  } finally {
    release.resolve();
    await first;
    assert.equal(await core.waitForBuildIdle(), true);
  }
  assert.deepEqual(targets, ["book/main.tex", "other.tex"]);
  assert.equal(events.at(-1).targetFile, "other.tex");
  assert.equal(events.at(-1).state, "success");
});

test("errors in the current or another chapter use the built document's directory and line", () => {
  const { root, buildService } = setup();
  const log = [
    "chapters/child.tex:9:3: Undefined control sequence.",
    "chapters/other.tex:30: Package foo Error: Invalid value.",
    "./chapters/other.tex:2: Undefined control sequence.",
  ].join("\n");
  assert.deepEqual(buildService.parseIssues(log, root, "book/main.tex").map(({ path, line, column }) => [path, line, column]), [
    ["book/chapters/child.tex", 9, 3],
    ["book/chapters/other.tex", 30, null],
    ["chapters/other.tex", 2, null],
  ]);
});

test("the release on-disk chooser works without open tabs", async () => {
  const { root } = setup();
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  assert.equal(await workspace.resolveBuildTarget("book/chapters/child.tex"), "book/main.tex");
  assert.equal(await workspace.resolveBuildTarget("book/chapters/other.tex"), "book/main.tex");
  assert.equal(await workspace.resolveBuildTarget("chapters/other.tex"), "book/main.tex");
});

test("a shared output directory and jobname do not make another root's PDF current", async () => {
  const { core, buildService, events, success } = setup();
  buildService.build = async (_cwd, target, _engine, profile) => success(target, profile);
  await core.handleBuild("book/main.tex", { pdfViewerMode: "tab" });
  await core.handleBuild("slides/deck.tex", { pdfViewerMode: "tab" });
  assert.equal(events.some(({ preview }) => preview === "previous"), false);
  assert.equal((await core.resolveJumpDocument("book/slide-body.tex")).built, true);
  const book = await core.resolveJumpDocument("book/only-in-book.tex");
  assert.equal(book.targetFile, "book/main.tex");
  assert.equal(book.built, false);
});

test("an older request that encounters a busy compiler does not displace a newer root", async () => {
  const { core, buildService, success } = setup();
  const started = deferred();
  const release = deferred();
  const targets = [];
  buildService.build = async (_cwd, target, _engine, profile) => {
    targets.push(target);
    if (targets.length === 1) {
      started.resolve();
      await release.promise;
      return { kind: "busy" };
    }
    return success(target, profile);
  };
  const first = core.handleBuild("book/child.tex", { pdfViewerMode: "tab" });
  await started.promise;
  try {
    await core.handleBuild("other.tex", { pdfViewerMode: "tab" });
  } finally {
    release.resolve();
    await first;
    assert.equal(await core.waitForBuildIdle(), true);
  }
  assert.deepEqual(targets, ["book/main.tex", "other.tex"]);
});

test("Build and Jump keep the release choice for a self-compilable subfile", async () => {
  const { core, workspace, buildService, success } = setup();
  workspace.loadSettings = async () => null;
  buildService.build = async (_cwd, target, _engine, profile) => success(target, profile);
  await core.handleBuild("book/sub.tex", { exactTarget: true, pdfViewerMode: "none" });
  assert.equal((await core.resolveJumpDocument("book/sub.tex")).targetFile, "book/sub.tex");
  await core.handleBuild("book/sub.tex", { pdfViewerMode: "none" });
  assert.equal((await core.resolveJumpDocument("book/sub.tex")).targetFile, "book/sub.tex");
});

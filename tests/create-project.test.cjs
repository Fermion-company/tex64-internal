"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceManager, WorkspaceError } = require("../electron/services/workspace.cjs");
const { IndexerService } = require("../electron/services/indexer.cjs");
const { createWorkspaceContext } = require("../electron/handlers/workspace/context.cjs");
const { createWorkspaceProjectHandlers } = require("../electron/handlers/workspace/project-handlers.cjs");
const { createWorkspaceFileHandlers } = require("../electron/handlers/workspace/file-handlers.cjs");

// Include hidden/nested entries and file bytes: a new .tex64 directory, a
// numbered main file, or an overwritten existing document must all fail.
const snapshot = async (root) => {
  const entries = (await fsp.readdir(root, { recursive: true })).sort();
  return Promise.all(entries.map(async (name) => {
    const absolute = path.join(root, name);
    const stat = await fsp.lstat(absolute);
    return [name, stat.isDirectory() ? null : (await fsp.readFile(absolute)).toString("base64")];
  }));
};

const fixture = async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-create-project-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // The native dialog has already created/selected the directory when the
  // handler receives it. Only the dialog boundary is replaced here.
  const workspace = new WorkspaceManager();
  const state = { mainWindow: {}, lastBuildPdfPath: "previous.pdf" };
  const messages = [], issues = [], dialogs = [], recent = [], changes = [];
  const pendingIndexes = [];
  const indexer = new IndexerService();
  let canceled = false;
  const ctx = createWorkspaceContext({
    fs, fsp, path, workspace, WorkspaceError, state,
    dialog: { showOpenDialog: async (_window, options) => {
      dialogs.push(options);
      return { canceled, filePaths: canceled ? [] : [root] };
    } },
    sendToRenderer: (type, payload) => messages.push({ type, payload }),
    sendIssues: (...args) => issues.push(args),
    beforeWorkspaceChange: async (change) => changes.push(change),
    userSettings: { addRecentProject: async (value) => { recent.push(value); return recent; } },
    indexerService: { requestIndex: (value, callback) => {
      pendingIndexes.push(indexer.buildIndex(value).then(callback));
    } },
  });
  const projects = createWorkspaceProjectHandlers(ctx);
  const files = createWorkspaceFileHandlers(ctx);
  return {
    root, workspace, state, messages, issues, dialogs, recent, changes, projects, files,
    cancel: () => { canceled = true; },
    indexed: () => Promise.all(pendingIndexes.splice(0)),
    latest: (type) => messages.findLast((message) => message.type === type)?.payload,
    create: async (locale = "en") => {
      await projects.handleCreateProject({ locale });
      await Promise.all(pendingIndexes.splice(0));
    },
  };
};

const assertOpened = (f) => {
  assert.equal(f.workspace.getRootPath(), f.root);
  assert.equal(f.state.currentWorkspacePath, f.root);
  assert.equal(f.state.lastBuildPdfPath, null);
  assert.equal(f.latest("updateWorkspace").rootPath, f.root);
  assert.ok(f.latest("updateWorkspace").workspaceId);
  assert.equal(f.changes.at(-1).reason, "create");
  assert.equal(f.changes.at(-1).toRootPath, f.root);
  assert.equal(f.recent.at(-1), f.root);
  assert.deepEqual(f.latest("launcherStatus"), { isBusy: false, message: null });
  assert.deepEqual(f.issues, []);
  assert.ok(f.latest("updateIndex"));
};

test("Create New opens an empty folder without writing anything in every dialog locale", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  for (const locale of ["en", "ja", "zh", "ko", "de", "fr", "es", "unknown"]) {
    await f.create(locale);
    assertOpened(f);
    assert.deepEqual(f.dialogs.at(-1).properties, ["openDirectory", "createDirectory"]);
    assert.deepEqual(await snapshot(f.root), before);
    assert.deepEqual(f.latest("updateWorkspace").files, []);
    assert.deepEqual(f.latest("updateWorkspace").folders, []);
    assert.equal(f.latest("updateWorkspace").rootFile, "");
    assert.equal(f.latest("updateWorkspace").rootSource, "");
    assert.equal(await f.workspace.rootInfo(), null);
  }
  const created = f.latest("updateWorkspace");
  await f.projects.handleOpenWorkspace({ locale: "en" });
  await f.indexed();
  assert.deepEqual(f.latest("updateWorkspace"), {
    ...created, workspaceGeneration: created.workspaceGeneration + 1,
  });
  assert.deepEqual(await snapshot(f.root), before);
  assert.deepEqual(f.issues, []);
});

for (const hasTex of [false, true]) {
  test(`Create New preserves and opens a non-empty folder ${hasTex ? "with main.tex and main2.tex" : "without TeX files"}`, async (t) => {
    const f = await fixture(t);
    await fsp.mkdir(path.join(f.root, "assets"));
    await fsp.writeFile(path.join(f.root, "assets", "data.bin"), Buffer.from([0, 1, 255]));
    await fsp.writeFile(path.join(f.root, ".keep"), "hidden file\n");
    await fsp.writeFile(path.join(f.root, "README.md"), "Existing project\n");
    if (hasTex) {
      await fsp.writeFile(path.join(f.root, "main.tex"), "\\documentclass{article}\n\\begin{document}Original\\end{document}\n");
      await fsp.writeFile(path.join(f.root, "main2.tex"), "% keep this too\n");
    }
    const before = await snapshot(f.root);
    await f.create("ja");
    assertOpened(f);
    assert.deepEqual(await snapshot(f.root), before);
    assert.equal(f.latest("updateWorkspace").rootFile, hasTex ? "main.tex" : "");
    assert.ok(f.latest("updateWorkspace").files.includes("README.md"));
  });
}

test("canceling Create New leaves the current workspace and selected folder untouched", async (t) => {
  const f = await fixture(t);
  f.workspace.setRootPath(f.root);
  f.cancel();
  await f.create();
  assert.equal(f.workspace.getRootPath(), f.root);
  assert.equal(f.state.workspaceGeneration, 0);
  assert.equal(f.state.lastBuildPdfPath, "previous.pdf");
  assert.deepEqual(await snapshot(f.root), []);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.recent, []);
  assert.equal(f.latest("updateWorkspace"), undefined);
  assert.deepEqual(f.latest("launcherStatus"), { isBusy: false, message: null });
  assert.deepEqual(f.issues, []);
});

test("New File and Save turn an empty project into a detected buildable document", async (t) => {
  const f = await fixture(t);
  await f.create();
  assert.equal(await f.workspace.rootInfo(), null);
  await f.files.handleCreateFile("main.tex");
  await f.indexed();
  assert.deepEqual(f.latest("openFileResult"), { path: "main.tex", content: "" });
  assert.equal(await f.workspace.readFile("main.tex"), "");
  assert.deepEqual(f.latest("updateWorkspace").files, ["main.tex"]);
  assert.equal(f.latest("updateWorkspace").rootFile, "main.tex");
  const content = "\\documentclass{article}\n\\begin{document}\nHello, world.\n\\end{document}\n";
  await f.files.handleSaveFile("main.tex", content);
  await f.indexed();
  assert.equal(f.latest("saveResult").ok, true);
  assert.equal(await f.workspace.readFile("main.tex"), content);
  assert.deepEqual(await f.workspace.rootInfo(), { path: "main.tex", source: "auto" });
  assert.equal(await f.workspace.resolveBuildTarget("main.tex"), "main.tex");
  assert.equal(await f.workspace.resolveBuildTarget(null), "main.tex");
  assert.equal(f.issues.some(([count]) => count > 0), false);
});

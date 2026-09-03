const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { WorkspaceFileWatcher } = require("../electron/services/workspace-file-watcher.cjs");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");

test("watcher tracks replacement/deletion, suppresses own saves, and isolates workspace generations", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-watcher-"));
  const workspace = new WorkspaceManager(); workspace.setRootPath(root);
  const changes = []; let treeChanges = 0;
  const watcher = new WorkspaceFileWatcher({
    resolvePath: (file) => workspace.resolvePath(file),
    onChange: (change) => changes.push(change), onTree: () => { treeChanges++; },
    debounceMs: 20, pollMs: 50,
  });
  t.after(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, "main.tex");
  fs.writeFileSync(file, "original"); watcher.start(root, 1); watcher.track("main.tex", "original");
  fs.writeFileSync(file, "external"); await watcher.flush();
  assert.equal(changes[0].expectedContent, "original"); assert.equal(changes[0].content, "external");
  fs.writeFileSync(file, "mine"); watcher.track("main.tex", "mine"); await watcher.flush();
  assert.equal(changes.length, 1);
  fs.writeFileSync(path.join(root, "replacement"), "atomic"); fs.renameSync(path.join(root, "replacement"), file);
  await watcher.flush(); assert.equal(changes[1].content, "atomic");
  fs.unlinkSync(file); await watcher.flush(); assert.equal(changes[2].fileDeleted, true);
  fs.writeFileSync(path.join(root, "new.tex"), "new");
  const deadline = Date.now() + 3000;
  while (!treeChanges && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(treeChanges > 0);
  watcher.start(root, 2); fs.writeFileSync(file, "new session"); await watcher.flush();
  assert.equal(changes.length, 3);
  watcher.stop(); assert.equal(watcher.tracked.size, 0);
});

test("autosave renames do not refresh the whole tree, but additions and deletions do", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-watcher-tree-"));
  const workspace = new WorkspaceManager(); workspace.setRootPath(root);
  let treeChanges = 0;
  const watcher = new WorkspaceFileWatcher({
    resolvePath: (file) => workspace.resolvePath(file),
    onChange: () => {}, onTree: () => { treeChanges++; },
    debounceMs: 10000, pollMs: 10000,
  });
  t.after(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, "main.tex");
  fs.writeFileSync(file, "saved"); watcher.start(root, 1); watcher.track("main.tex", "saved");
  watcher.watcher.emit("change", "rename", ".main.tex.tmp-123-456");
  watcher.watcher.emit("change", "rename", "main.tex");
  await watcher.flush();
  assert.equal(treeChanges, 0);
  watcher.watcher.emit("change", "rename", "new.tex");
  await watcher.flush();
  assert.equal(treeChanges, 1);
  fs.unlinkSync(file);
  await watcher.flush();
  assert.equal(treeChanges, 2);
});

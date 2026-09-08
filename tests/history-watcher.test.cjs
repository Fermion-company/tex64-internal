const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceFileWatcher } = require("../electron/services/workspace-file-watcher.cjs");
test("history pause retains watcher baseline and reconciles external edits on release", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-watch-history-"));
  let paused = true; const changes = []; let trees = 0;
  const watcher = new WorkspaceFileWatcher({ resolvePath: (file) => path.join(root, file), isPaused: () => paused, onChange: (change) => changes.push(change), onTree: () => trees++ });
  t.after(async () => { watcher.stop(); await fs.rm(root, { recursive: true, force: true }); });
  watcher.root = root; watcher.generation = 3;
  watcher.track("main.tex", "old"); watcher.treeDirty = true;
  await fs.writeFile(path.join(root, "main.tex"), "external");
  await watcher.flush();
  assert.equal(changes.length, 0); assert.equal(watcher.tracked.get("main.tex").content, "old"); assert.equal(watcher.treeDirty, true);
  paused = false; await watcher.flush();
  assert.equal(changes.length, 1); assert.equal(changes[0].expectedContent, "old"); assert.equal(changes[0].content, "external"); assert.equal(trees, 1);
});

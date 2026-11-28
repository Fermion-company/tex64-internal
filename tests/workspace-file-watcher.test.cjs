"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceFileWatcher } = require("../electron/services/workspace-file-watcher.cjs");

// Another program (ChatGPT/Codex, an editor, git) often writes in place:
// truncate, then write, then close. A poll can land between those steps.
// The editor must never be handed that half-written text as the new file.
const fixture = async (t, options = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-watch-settle-"));
  const changes = [];
  const watcher = new WorkspaceFileWatcher({
    resolvePath: (file) => path.join(root, file),
    onChange: (change) => changes.push(change),
    onTree: () => {},
    ...options,
  });
  t.after(async () => { watcher.stop(); await fs.rm(root, { recursive: true, force: true }); });
  // Exercise flush() directly; no fs.watch / poll timers.
  watcher.root = root; watcher.generation = 1;
  const file = (name) => path.join(root, name);
  const age = async (name, ms) => { const at = new Date(Date.now() - ms); await fs.utimes(file(name), at, at); };
  return { root, watcher, changes, file, age };
};

test("a file another program is still writing is reported only after it settles", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file("main.tex"), "\\section{A}\nold body\n");
  f.watcher.track("main.tex", "\\section{A}\nold body\n");
  // The truncate step of a non-atomic write: empty file, modified just now.
  await fs.writeFile(f.file("main.tex"), "");
  await f.watcher.flush();
  assert.deepEqual(f.changes, [], "a just-truncated file must not reach the editor");
  // Half of the new text, still fresh.
  await fs.writeFile(f.file("main.tex"), "\\section{A}\nne");
  await f.watcher.flush();
  assert.deepEqual(f.changes, []);
  // The writer finished a while ago: now it is reported, once, against the
  // last content the editor knew.
  await fs.writeFile(f.file("main.tex"), "\\section{A}\nnew body\n");
  await f.age("main.tex", 2000);
  await f.watcher.flush();
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].content, "\\section{A}\nnew body\n");
  assert.equal(f.changes[0].expectedContent, "\\section{A}\nold body\n");
  assert.equal(f.watcher.tracked.get("main.tex").content, "\\section{A}\nnew body\n");
});

test("a deferred file schedules its own re-check", async (t) => {
  const f = await fixture(t, { debounceMs: 5, settleMs: 40 });
  await fs.writeFile(f.file("main.tex"), "old");
  f.watcher.track("main.tex", "old");
  await fs.writeFile(f.file("main.tex"), "new");
  await f.watcher.flush();
  assert.equal(f.changes.length, 0);
  assert.ok(f.watcher.timer, "the watcher must come back for the deferred file");
  const deadline = Date.now() + 3000;
  while (f.changes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].content, "new");
});

test("a file that keeps changing (or has a clock-skewed mtime) is still reported", async (t) => {
  const f = await fixture(t, { maxSettleWaits: 3 });
  await fs.writeFile(f.file("log.tex"), "a");
  f.watcher.track("log.tex", "a");
  await fs.writeFile(f.file("log.tex"), "b");
  for (let i = 0; i < 3; i += 1) {
    await f.watcher.flush();
    assert.equal(f.changes.length, 0);
  }
  await f.watcher.flush();
  assert.equal(f.changes.length, 1);
  // An mtime in the future (network volume clock skew) is not "fresh".
  await fs.writeFile(f.file("log.tex"), "c");
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(f.file("log.tex"), future, future);
  await f.watcher.flush();
  assert.equal(f.changes.length, 2);
  assert.equal(f.changes[1].content, "c");
});

test("a delete-and-recreate (git checkout) is not reported as a deletion", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file("main.tex"), "one");
  f.watcher.track("main.tex", "one");
  await fs.rm(f.file("main.tex"));
  await f.watcher.flush();
  assert.deepEqual(f.changes, [], "a file that just vanished may be coming back");
  await fs.writeFile(f.file("main.tex"), "two");
  await f.age("main.tex", 2000);
  await f.watcher.flush();
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].fileDeleted, false);
  assert.equal(f.changes[0].content, "two");
});

test("a deletion that stays is reported", async (t) => {
  const f = await fixture(t, { settleMs: 30 });
  await fs.writeFile(f.file("main.tex"), "one");
  f.watcher.track("main.tex", "one");
  await fs.rm(f.file("main.tex"));
  await f.watcher.flush();
  assert.equal(f.changes.length, 0);
  await new Promise((r) => setTimeout(r, 40));
  await f.watcher.flush();
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].fileDeleted, true);
  assert.equal(f.changes[0].expectedContent, "one");
});

test("our own save (content equal to the baseline) is never deferred or reported", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file("main.tex"), "saved by TeX64");
  f.watcher.track("main.tex", "saved by TeX64");
  await f.watcher.flush();
  assert.deepEqual(f.changes, []);
  assert.equal(f.watcher.timer ?? null, null);
});

test("while an open file's disappearance is unsettled the tree waits, so the editor hears about the file first", async (t) => {
  const order = [];
  const f = await fixture(t, { settleMs: 30, onChange: (change) => order.push(`change:${change.fileDeleted ? "deleted" : "content"}`) });
  f.watcher.onTree = () => order.push("tree");
  await fs.writeFile(f.file("main.tex"), "one");
  await fs.writeFile(f.file("other.tex"), "x");
  f.watcher.track("main.tex", "one");
  await fs.rm(f.file("main.tex"));
  // Something else in the folder changed too (git checkout touches many files).
  f.watcher.treeDirty = true;
  await f.watcher.flush();
  assert.deepEqual(order, [], "no tree refresh while main.tex may be coming back");
  assert.equal(f.watcher.treeDirty, true);
  await new Promise((r) => setTimeout(r, 40));
  await f.watcher.flush();
  assert.deepEqual(order, ["change:deleted", "tree"]);
});

test("watcher aliases share the last save and produce one change for the target", async (t) => {
  const f = await fixture(t, { settleMs: 0 });
  await fs.writeFile(f.file("chapter.tex"), "draft");
  await fs.symlink("chapter.tex", f.file("link.tex"));
  f.watcher.track("chapter.tex", "draft");
  await fs.writeFile(f.file("chapter.tex"), "saved");
  f.watcher.track("link.tex", "saved");
  await f.watcher.flush();
  assert.deepEqual(f.changes, []);
  await fs.writeFile(f.file("chapter.tex"), "external");
  await f.watcher.flush();
  assert.deepEqual(f.changes.map(({ path, expectedContent }) => [path, expectedContent]), [["chapter.tex", "saved"]]);
});

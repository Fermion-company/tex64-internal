/**
 * The workspace watcher behind "changes made outside TeX64 reach the editor"
 * (issue #38). What matters is what it stays quiet about: build artifacts and
 * the app's own writes, so a build or an autosave never turns into a reload
 * storm — while a genuine external write always gets through.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  WorkspaceWatcher,
  isIgnoredRelativePath,
} = require("../electron/services/file-watcher.cjs");

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "tex64-watch-"));

const collect = (root, { debounceMs = 40 } = {}) => {
  const seen = [];
  const watcher = new WorkspaceWatcher({
    debounceMs,
    onChanges: (changes) => seen.push(...changes),
  });
  const result = watcher.watch(root);
  return { watcher, seen, result };
};

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("build artifacts and tool directories are never reported", () => {
  for (const ignored of [
    "main.aux",
    "main.log",
    "main.fdb_latexmk",
    "main.synctex.gz",
    "main.run.xml",
    "main.pdf",
    ".git/HEAD",
    ".tex64/settings.json",
    "node_modules/pkg/index.js",
    ".DS_Store",
  ]) {
    assert.equal(isIgnoredRelativePath(ignored), true, ignored);
  }
  for (const reported of ["main.tex", "sub/main.tex", "refs.bib", "figures/plot.png", ".latexmkrc"]) {
    assert.equal(isIgnoredRelativePath(reported), false, reported);
  }
});

test("an external write is reported", async (t) => {
  const root = makeRoot();
  const { watcher, seen } = collect(root);
  t.after(() => watcher.stop());
  fs.writeFileSync(path.join(root, "main.tex"), "one\n");
  await settle(400);
  assert.ok(
    seen.some((change) => change.path === "main.tex" && change.kind === "changed"),
    `expected main.tex, saw ${JSON.stringify(seen)}`
  );
});

test("a deletion is reported as removed", async (t) => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "main.tex"), "one\n");
  const { watcher, seen } = collect(root);
  t.after(() => watcher.stop());
  await settle(120);
  fs.unlinkSync(path.join(root, "main.tex"));
  await settle(400);
  assert.ok(seen.some((change) => change.path === "main.tex" && change.kind === "removed"));
});

test("TeX64's own write is skipped, and the next external one is not", async (t) => {
  const root = makeRoot();
  const { watcher, seen } = collect(root);
  t.after(() => watcher.stop());

  watcher.suppress("main.tex", "saved by tex64\n");
  fs.writeFileSync(path.join(root, "main.tex"), "saved by tex64\n");
  await settle(400);
  assert.deepEqual(seen, [], `own write leaked: ${JSON.stringify(seen)}`);

  // Suppression is keyed on the bytes written, not a time window, so a write by
  // anything else right afterwards still comes through.
  fs.writeFileSync(path.join(root, "main.tex"), "changed by a script\n");
  await settle(400);
  assert.ok(
    seen.some((change) => change.path === "main.tex" && change.kind === "changed"),
    `external write was swallowed: ${JSON.stringify(seen)}`
  );
});

test("stopping releases the watch", async (t) => {
  const root = makeRoot();
  const { watcher, seen } = collect(root);
  t.after(() => watcher.stop());
  watcher.stop();
  fs.writeFileSync(path.join(root, "main.tex"), "one\n");
  await settle(300);
  assert.deepEqual(seen, []);
});

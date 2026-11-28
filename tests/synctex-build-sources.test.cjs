"use strict";
// What each Build read, and the caret's line in that Build's numbering
// (electron/services/synctex/build-sources.cjs).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBuildSourceTracker, mapSourceLine } = require("../electron/services/synctex/build-sources.cjs");

const lines = (count, label = "line") => Array.from({ length: count }, (_, i) => `${label} ${i + 1}`);

test("unchanged text maps every line to itself", () => {
  const text = lines(20);
  for (const line of [1, 7, 20]) assert.deepEqual(mapSourceLine(text, text, line), { line, exact: true });
});

test("lines added or removed above move the caret's line back to the Build's", () => {
  const built = lines(50);
  const added = [...built.slice(0, 10), "new a", "new b", "new c", ...built.slice(10)];
  assert.deepEqual(mapSourceLine(added, built, 20), { line: 17, exact: true });
  assert.deepEqual(mapSourceLine(added, built, 5), { line: 5, exact: true });
  const removed = [...built.slice(0, 10), ...built.slice(14)];
  assert.deepEqual(mapSourceLine(removed, built, 20), { line: 24, exact: true });
});

test("edits in several places are matched line by line", () => {
  const built = lines(40);
  const now = [...built];
  now.splice(30, 1);              // removes "line 31"
  now.splice(20, 0, "x", "y");    // two lines before "line 21"
  now.splice(5, 0, "z");          // one before "line 6"
  // "line 25" is now at 25 + 1 + 2 = 28
  assert.deepEqual(mapSourceLine(now, built, 28), { line: 25, exact: true });
  assert.deepEqual(mapSourceLine(now, built, now.indexOf("line 35") + 1), { line: 35, exact: true });
});

test("a line written since stands where the Build had the next unchanged line; it is not exact", () => {
  const built = lines(30);
  const now = [...built.slice(0, 12), "written since", ...built.slice(12)];
  assert.deepEqual(mapSourceLine(now, built, 13), { line: 13, exact: false });
  const rewritten = [...built.slice(0, 12), "line 13, edited", ...built.slice(13)];
  assert.deepEqual(mapSourceLine(rewritten, built, 13), { line: 13, exact: false });
});

test("a change too large to compare line by line maps proportionally and says so", () => {
  const built = lines(300, "old");
  const now = ["head", ...lines(300, "new"), "tail"];
  const mapped = mapSourceLine(now, ["head", ...built, "tail"], 151, { maxCells: 100 });
  assert.equal(mapped.exact, false);
  assert.ok(mapped.line > 100 && mapped.line < 200);
});

const project = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-build-sources-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "ch"));
  return dir;
};
const touch = (file, mtimeMs) => fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);

test("a Build's text is what the files held when it ran, not what they hold at the Jump", async (t) => {
  const dir = project(t);
  const main = path.join(dir, "main.tex");
  const chapter = path.join(dir, "ch", "one.tex");
  const base = Date.now() - 60_000;
  fs.writeFileSync(main, "built main\n");
  fs.writeFileSync(chapter, "built chapter\n");
  touch(main, base);
  touch(chapter, base);
  let clock = base + 1_000;
  const tracker = createBuildSourceTracker({ now: () => clock });
  tracker.observe("building", { pdfPath: "main.pdf" }, dir);
  tracker.observe("building", { pdfPath: "main.pdf" }, dir); // progress, same run
  // the Build's output
  fs.writeFileSync(path.join(dir, "main.pdf"), "%PDF-1.5\n");
  fs.writeFileSync(path.join(dir, "main.synctex.gz"), "x");
  touch(path.join(dir, "main.synctex.gz"), base + 5_000);
  clock = base + 6_000;
  tracker.observe("success", { pdfPath: "main.pdf" }, dir);
  assert.equal(await tracker.sourceFor({ pdfPath: path.join(dir, "main.pdf"), sourcePath: main }), "built main\n");
  // edited (and autosaved) after the Build
  fs.writeFileSync(main, "edited\nbuilt main\n");
  assert.equal(await tracker.sourceFor({ pdfPath: path.join(dir, "main.pdf"), sourcePath: main }), "built main\n");
  assert.equal(await tracker.sourceFor({ pdfPath: path.join(dir, "main.pdf"), sourcePath: chapter }), "built chapter\n");
  // another Build of that PDF replaces its SyncTeX: the old text no longer applies
  touch(path.join(dir, "main.synctex.gz"), Date.now() + 1_000);
  assert.equal(await tracker.sourceFor({ pdfPath: path.join(dir, "main.pdf"), sourcePath: main }), "edited\nbuilt main\n");
});

test("a file written while the Build ran is not known; a failed Build changes nothing", async (t) => {
  const dir = project(t);
  const main = path.join(dir, "main.tex");
  const base = Date.now() - 60_000;
  fs.writeFileSync(main, "first\n");
  touch(main, base);
  let clock = base + 1_000;
  const tracker = createBuildSourceTracker({ now: () => clock });
  tracker.observe("building", {}, dir);
  fs.writeFileSync(main, "typed during the Build\n");
  touch(main, base + 2_000);
  fs.writeFileSync(path.join(dir, "main.pdf"), "%PDF-1.5\n");
  fs.writeFileSync(path.join(dir, "main.synctex"), "x");
  touch(path.join(dir, "main.synctex"), base + 3_000);
  clock = base + 4_000;
  tracker.observe("success", { pdfPath: "main.pdf" }, dir);
  assert.equal(await tracker.sourceFor({ pdfPath: path.join(dir, "main.pdf"), sourcePath: main }), null);

  tracker.observe("building", {}, dir);
  tracker.observe("failed", { pdfPath: "main.pdf" }, dir);
  assert.equal(await tracker.sourceFor({ pdfPath: path.join(dir, "main.pdf"), sourcePath: main }), null);
});

test("a Build of an earlier session: a file not written since its SyncTeX is what it read", async (t) => {
  const dir = project(t);
  const main = path.join(dir, "main.tex");
  const base = Date.now() - 60_000;
  fs.writeFileSync(main, "as built\n");
  touch(main, base);
  fs.writeFileSync(path.join(dir, "main.pdf"), "%PDF-1.5\n");
  fs.writeFileSync(path.join(dir, "main.synctex.gz"), "x");
  touch(path.join(dir, "main.synctex.gz"), base + 1_000);
  const tracker = createBuildSourceTracker();
  assert.equal(await tracker.sourceFor({ pdfPath: path.join(dir, "main.pdf"), sourcePath: main }), "as built\n");
  fs.writeFileSync(main, "edited since\n");
  assert.equal(await tracker.sourceFor({ pdfPath: path.join(dir, "main.pdf"), sourcePath: main }), null);
  // no SyncTeX: nothing to number lines for
  assert.equal(await tracker.sourceFor({ pdfPath: path.join(dir, "other.pdf"), sourcePath: main }), null);
});

test("which Build is running, and when it has ended", async (t) => {
  const dir = project(t);
  const tracker = createBuildSourceTracker();
  assert.equal(tracker.running(), false);
  assert.equal(await tracker.whenSettled({ timeoutMs: 50 }), true, "nothing running: settled already");
  tracker.observe("building", {}, dir);
  assert.equal(tracker.running(path.join(dir, "main.pdf")), true, "a Build whose PDF is not named yet may write any");
  tracker.observe("building", { pdfPath: "main.pdf" }, dir);
  assert.equal(tracker.running(path.join(dir, "main.pdf")), true);
  assert.equal(tracker.running(path.join(dir, "other.pdf")), false);
  assert.equal(await tracker.whenSettled({ timeoutMs: 30 }), false, "still running at the limit");
  const settled = tracker.whenSettled({ timeoutMs: 5_000 });
  tracker.observe("failed", { pdfPath: "main.pdf" }, dir);
  assert.equal(await settled, true);
  assert.equal(tracker.running(), false);
});

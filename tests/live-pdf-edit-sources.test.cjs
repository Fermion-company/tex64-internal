const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { captureEditSources, INLINE_EDIT_BYTES } = require("../electron/services/live-pdf-edit-sources.cjs");

test("the printed revision keeps the staged root and oversized dirty chapter after autosave", async t => {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-edit-sources-test-"));
  t.after(() => fs.rm(stage, { recursive: true, force: true }));
  const original = "\uFEFFfirst\r\n";
  const chapter = "x".repeat(INLINE_EDIT_BYTES + 1);
  const root = path.join(stage, "main.tex");
  const child = path.join(stage, "chapter.tex");
  const sync = path.join(stage, "main.synctex.gz");
  await Promise.all([fs.writeFile(root, original), fs.writeFile(child, chapter), fs.writeFile(sync, "map")]);
  const capture = await captureEditSources(new Map([["main.tex", null], ["chapter.tex", chapter]]), stage, sync);
  t.after(() => fs.rm(capture.directory, { recursive: true, force: true }));
  await Promise.all([fs.writeFile(root, "second"), fs.writeFile(child, "saved later")]);
  assert.equal(capture.files.get("main.tex"), original);
  assert.equal(await fs.readFile(capture.files.get("chapter.tex").snapshot, "utf8"), chapter);
});

test("a failed dirty snapshot keeps the map usable for other sources", async t => {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-edit-sources-test-"));
  t.after(() => fs.rm(stage, { recursive: true, force: true }));
  const sync = path.join(stage, "main.synctex.gz");
  await fs.writeFile(sync, "map");
  const files = new Map([["main.tex", "root"], ["missing.tex", "x".repeat(INLINE_EDIT_BYTES + 1)]]);
  const capture = await captureEditSources(files, stage, sync);
  t.after(() => fs.rm(capture.directory, { recursive: true, force: true }));
  assert.equal(capture.sync.toString(), "map");
  assert.equal(capture.files.get("main.tex"), "root");
  assert.deepEqual(capture.files.get("missing.tex"), { unavailable: true });
});

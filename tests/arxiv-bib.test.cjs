"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");
const { BUILD_TARGET_CHOICE } = require("../electron/services/tex-build-target.cjs");
const { appendBibEntry, resolveBibTarget } = require("../electron/services/arxiv-bib.cjs");
const { buildArxivKey, buildArxivBibtex } = require("../electron/services/openprism/arxiv-service.cjs");
const { parseBibEntries } = require("../electron/services/bib-append.cjs");

const doc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

const tempWorkspace = async (t, files = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-arxiv-bib-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content, "utf8");
  }
  return workspace;
};

const paper = (arxivId, title, author = "Ada Smith", year = "2023") => ({ arxivId, title, authors: [author], year });
const cite = (workspace, entry, extra = {}) =>
  appendBibEntry(workspace, { activeFilePath: "main.tex", key: buildArxivKey(entry), bibtex: buildArxivBibtex(entry), ...extra });

test("simultaneous arXiv citations keep every entry", async (t) => {
  const workspace = await tempWorkspace(t, { "main.tex": doc("\\bibliography{refs}"), "refs.bib": "@misc{keep, title={Keep}}\n" });
  const papers = [paper("2301.00001", "One", "Ann One"), paper("2301.00002", "Two", "Bob Two"), paper("2301.00003", "Three", "Cy Three")];
  const results = await Promise.all(papers.map((entry) => cite(workspace, entry)));
  assert.deepEqual(results.map((result) => result.duplicate), [false, false, false]);
  const keys = parseBibEntries(await workspace.readFile("refs.bib")).map((entry) => entry.key).sort();
  assert.deepEqual(keys, ["keep", "one20230001", "three20230003", "two20230002"]);
});

test("simultaneous first citations into a .bib that does not exist yet keep both", async (t) => {
  const workspace = await tempWorkspace(t, { "main.tex": doc("\\bibliography{refs}") });
  const results = await Promise.all([cite(workspace, paper("2301.00001", "One", "Ann One")), cite(workspace, paper("2301.00002", "Two", "Bob Two"))]);
  assert.equal(results.filter((result) => result.created).length, 1);
  const keys = parseBibEntries(await workspace.readFile("refs.bib")).map((entry) => entry.key).sort();
  assert.deepEqual(keys, ["one20230001", "two20230002"]);
});

test("two papers whose keys share the last four id digits get distinct keys; a repeat finds its entry", async (t) => {
  const workspace = await tempWorkspace(t, { "main.tex": doc("\\bibliography{refs}"), "refs.bib": "" });
  const first = paper("2301.01234", "First paper");
  const second = paper("2311.01234", "Second paper");
  assert.equal(buildArxivKey(first), buildArxivKey(second));
  const a = await cite(workspace, first);
  const b = await cite(workspace, second);
  assert.deepEqual([a.key, a.duplicate], ["smith20231234", false]);
  assert.deepEqual([b.key, b.duplicate], ["smith20231234a", false]);
  assert.match(b.bibtex, /^@article\{smith20231234a,/);
  const again = await cite(workspace, second);
  assert.deepEqual([again.key, again.duplicate], ["smith20231234a", true]);
  const againFirst = await cite(workspace, first);
  assert.deepEqual([againFirst.key, againFirst.duplicate], ["smith20231234", true]);
  const entries = parseBibEntries(await workspace.readFile("refs.bib"));
  assert.equal(entries.length, 2);
});

test("a paper already in the .bib under another key (eprint or url) is not added again", async (t) => {
  const workspace = await tempWorkspace(t, {
    "main.tex": doc("\\bibliography{refs}"),
    "refs.bib": "@article{mine,\n  title={Mine},\n  url={https://arxiv.org/abs/2301.04567v2}\n}\n",
  });
  const result = await cite(workspace, paper("2301.04567", "Mine"));
  assert.deepEqual([result.key, result.duplicate], ["mine", true]);
});

test("arXiv citations go to the active document's bibliography, or the one chosen for it", async (t) => {
  const workspace = await tempWorkspace(t, {
    "main.tex": doc("\\bibliography{main-refs}"),
    "notes.tex": doc("\\bibliography{notes-refs}"),
    "main-refs.bib": "",
    "notes-refs.bib": "",
    "a.tex": doc("\\input{part}\n\\bibliography{a-refs}"),
    "b.tex": doc("\\input{part}\n\\bibliography{b-refs}"),
    "part.tex": "Part.",
  });
  await workspace.setRootFile("main.tex");
  assert.equal((await resolveBibTarget(workspace, "notes.tex")).bibPath, "notes-refs.bib");
  const result = await appendBibEntry(workspace, {
    activeFilePath: "notes.tex", key: "x2023", bibtex: "@article{x2023,\n  title={X},\n  eprint={2301.09999}\n}",
  });
  assert.equal(result.bibPath, "notes-refs.bib");
  assert.equal(await workspace.readFile("main-refs.bib"), "");
  await assert.rejects(resolveBibTarget(workspace, "part.tex"), (error) => error.code === BUILD_TARGET_CHOICE);
  assert.equal((await resolveBibTarget(workspace, "part.tex", { documentMainFile: "b.tex" })).bibPath, "b-refs.bib");
});

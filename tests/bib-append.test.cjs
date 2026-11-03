"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");
const { BUILD_TARGET_CHOICE } = require("../electron/services/tex-build-target.cjs");
const {
  parseBibEntries,
  appendEntry,
  replaceEntries,
  resolveBibTarget,
  resolveCitationDocument,
  sameZoteroItem,
} = require("../electron/services/bib-append.cjs");

const doc = (body, preamble = "") => `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;

const tempWorkspace = async (t, files = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-bib-append-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content, "utf8");
  }
  return workspace;
};

// ---- parsing -----------------------------------------------------------------

test("a parenthesized entry ends after its quoted title, not at the ) inside it", () => {
  const text = '@article(foo,title="Example (case)",year={2026})\n@book{bar, title={B}}\n';
  const entries = parseBibEntries(text);
  assert.deepEqual(entries.map((entry) => entry.key), ["foo", "bar"]);
  assert.equal(entries[0].body, '@article(foo,title="Example (case)",year={2026})');
});

test("a refresh replaces a parenthesized entry with quoted parentheses whole", async (t) => {
  const workspace = await tempWorkspace(t, {
    "refs.bib": '% zotero: bbt:1/AAAA1111\n@article(foo,title="Example (case)",year={2026})\n\n@book{bar, title={B}}\n',
  });
  const fresh = new Map([["foo", "@article{foo,\n  title={Example (case), revised},\n  year={2026}\n}"]]);
  const result = await replaceEntries({ workspace, bibPath: "refs.bib", fresh });
  assert.equal(result.updated, 1);
  const after = await workspace.readFile("refs.bib");
  assert.equal(after, "% zotero: bbt:1/AAAA1111\n@article{foo,\n  title={Example (case), revised},\n  year={2026}\n}\n\n@book{bar, title={B}}\n");
  assert.ok(!after.includes('",year='));
});

// ---- identity ------------------------------------------------------------------

test("Zotero notes name one item only within one library (across doors for groups)", () => {
  assert.equal(sameZoteroItem("users:0/ABCD1234", "users:555/ABCD1234"), true);
  assert.equal(sameZoteroItem("bbt:1/ABCD1234", "users:0/ABCD1234"), true);
  assert.equal(sameZoteroItem("bbt:7/ABCD1234", "groups:4242/ABCD1234"), true);
  assert.equal(sameZoteroItem("users:0/ABCD1234", "groups:4242/ABCD1234"), false);
  assert.equal(sameZoteroItem("groups:1/ABCD1234", "groups:2/ABCD1234"), false);
  assert.equal(sameZoteroItem("bbt:1/ABCD1234", "bbt:7/ABCD1234"), false);
  assert.equal(sameZoteroItem("users:0/ABCD1234", "users:0/EFGH5678"), false);
});

test("two Zotero items that generate the same key both get cited, under distinct keys", async (t) => {
  const workspace = await tempWorkspace(t);
  const first = await appendEntry({
    workspace, bibPath: "refs.bib", zoteroRef: "users:0/JPN00001",
    bibtex: "@article{anon2026,\n  title={量子計算の基礎},\n  year={2026}\n}",
  });
  const second = await appendEntry({
    workspace, bibPath: "refs.bib", zoteroRef: "users:0/JPN00002",
    bibtex: "@article{anon2026,\n  title={確率論入門},\n  year={2026}\n}",
  });
  assert.deepEqual([first.key, first.appended, first.created], ["anon2026", true, true]);
  assert.deepEqual([second.key, second.appended], ["anon2026a", true]);
  const entries = parseBibEntries(await workspace.readFile("refs.bib"));
  assert.deepEqual(entries.map((entry) => [entry.key, entry.zoteroRef]), [
    ["anon2026", "users:0/JPN00001"],
    ["anon2026a", "users:0/JPN00002"],
  ]);
  // Citing the second item again finds its entry under the allocated key.
  const again = await appendEntry({
    workspace, bibPath: "refs.bib", zoteroRef: "users:0/JPN00002",
    bibtex: "@article{anon2026,\n  title={確率論入門},\n  year={2026}\n}",
  });
  assert.deepEqual([again.key, again.appended], ["anon2026a", false]);
  // And through Better BibTeX (bbt:1 is the same personal library).
  const viaBbt = await appendEntry({
    workspace, bibPath: "refs.bib", zoteroRef: "bbt:1/JPN00002",
    bibtex: "@article{kakuritsu2026,\n  title={確率論入門}\n}",
  });
  assert.deepEqual([viaBbt.key, viaBbt.appended], ["anon2026a", false]);
});

test("the same item key in two libraries is two items", async (t) => {
  const workspace = await tempWorkspace(t);
  await appendEntry({
    workspace, bibPath: "refs.bib", zoteroRef: "groups:1111/SAMEKEY1",
    bibtex: "@article{smith2020deep,\n  title={Deep nets},\n  doi={10.1000/one}\n}",
  });
  const other = await appendEntry({
    workspace, bibPath: "refs.bib", zoteroRef: "users:0/SAMEKEY1",
    bibtex: "@article{smith2020deep,\n  title={Deep trees},\n  doi={10.1000/two}\n}",
  });
  assert.deepEqual([other.key, other.appended], ["smith2020deepa", true]);
  // A Better BibTeX note for a group and the API note for that group are one item.
  const sameGroupItem = await appendEntry({
    workspace, bibPath: "refs.bib", zoteroRef: "bbt:7/SAMEKEY1",
    bibtex: "@article{smith2020deep,\n  title={Deep nets},\n  doi={10.1000/one}\n}",
  });
  assert.deepEqual([sameGroupItem.key, sameGroupItem.appended], ["smith2020deep", false]);
});

test("a hand-written entry under the generated key is reused only when it cites the same work", async (t) => {
  const workspace = await tempWorkspace(t, {
    "refs.bib": "@article{vaswani2017attention,\n  title={Attention Is All You Need},\n  year={2017}\n}\n",
  });
  const same = await appendEntry({
    workspace, bibPath: "refs.bib", zoteroRef: "users:0/VASWANI1",
    bibtex: "@inproceedings{vaswani2017attention,\n  title={{Attention} is all you need},\n  year={2017}\n}",
  });
  assert.deepEqual([same.key, same.appended], ["vaswani2017attention", false]);
  const different = await appendEntry({
    workspace, bibPath: "refs.bib", zoteroRef: "users:0/VASWANI2",
    bibtex: "@article{vaswani2017attention,\n  title={Attention mechanisms revisited},\n  year={2017}\n}",
  });
  assert.deepEqual([different.key, different.appended], ["vaswani2017attentiona", true]);
  const content = await workspace.readFile("refs.bib");
  assert.match(content, /% zotero: users:0\/VASWANI2\n@article\{vaswani2017attentiona,/);
});

test("a DOI already in the file is the same work under any key", async (t) => {
  const workspace = await tempWorkspace(t, {
    "refs.bib": "@article{mykey,\n  title={Something},\n  doi={https://doi.org/10.1000/XYZ}\n}\n",
  });
  const result = await appendEntry({
    workspace, bibPath: "refs.bib", zoteroRef: "users:0/DOIITEM1",
    bibtex: "@article{other2020,\n  title={Something},\n  doi={10.1000/xyz}\n}",
  });
  assert.deepEqual([result.key, result.appended], ["mykey", false]);
});

// ---- target document -------------------------------------------------------------

test("independent documents cite into their own bibliographies, whatever the root", async (t) => {
  const workspace = await tempWorkspace(t, {
    "main.tex": doc("\\cite{a}\n\\bibliography{main-refs}"),
    "notes.tex": doc("\\cite{b}\n\\bibliography{notes-refs}"),
    "main-refs.bib": "",
    "notes-refs.bib": "",
  });
  await workspace.setRootFile("main.tex");
  const bibOf = async (mainFile) => (await resolveBibTarget({ workspace, mainFile })).relativePath;
  const notes = await resolveCitationDocument(workspace, { activeFilePath: "notes.tex" }, bibOf);
  assert.equal(notes, "notes.tex");
  assert.equal(await bibOf(notes), "notes-refs.bib");
  assert.equal(await resolveCitationDocument(workspace, { activeFilePath: "main.tex" }, bibOf), "main.tex");
  // The document the renderer names for the file wins.
  assert.equal(await resolveCitationDocument(workspace, { activeFilePath: "notes.tex", documentMainFile: "main.tex" }, bibOf), "main.tex");
  // A named document that is gone is ignored.
  assert.equal(await resolveCitationDocument(workspace, { activeFilePath: "notes.tex", documentMainFile: "gone.tex" }, bibOf), "notes.tex");
});

test("a fragment of two documents: one shared .bib is fine, two .bib files are the user's choice", async (t) => {
  const shared = await tempWorkspace(t, {
    "a.tex": doc("\\input{part}\n\\bibliography{refs}"),
    "b.tex": doc("\\input{part}\n\\bibliography{refs}"),
    "part.tex": "Part.",
    "refs.bib": "",
  });
  const bibOfShared = async (mainFile) => (await resolveBibTarget({ workspace: shared, mainFile })).relativePath;
  const owner = await resolveCitationDocument(shared, { activeFilePath: "part.tex" }, bibOfShared);
  assert.ok(["a.tex", "b.tex"].includes(owner));

  const split = await tempWorkspace(t, {
    "a.tex": doc("\\input{part}\n\\bibliography{a-refs}"),
    "b.tex": doc("\\input{part}\n\\bibliography{b-refs}"),
    "part.tex": "Part.",
  });
  const bibOfSplit = async (mainFile) => (await resolveBibTarget({ workspace: split, mainFile })).relativePath;
  await assert.rejects(resolveCitationDocument(split, { activeFilePath: "part.tex" }, bibOfSplit), (error) => {
    assert.equal(error.code, BUILD_TARGET_CHOICE);
    assert.deepEqual([...error.candidates].sort(), ["a.tex", "b.tex"]);
    return true;
  });
  assert.equal(await resolveCitationDocument(split, { activeFilePath: "part.tex", documentMainFile: "b.tex" }, bibOfSplit), "b.tex");
});

test("no workspace or no .tex at all is NO_MAIN_FILE", async (t) => {
  const none = new WorkspaceManager();
  await assert.rejects(resolveCitationDocument(none, { activeFilePath: "main.tex" }), (error) => error.code === "NO_MAIN_FILE");
  const empty = await tempWorkspace(t, { "readme.txt": "x" });
  await assert.rejects(resolveCitationDocument(empty, { activeFilePath: "" }), (error) => error.code === "NO_MAIN_FILE");
});

test("two different zotero.org accounts are two libraries; a conflicting DOI outweighs a matching note", async (t) => {
  assert.equal(sameZoteroItem("users:111/ABCD1234", "users:222/ABCD1234"), false);
  assert.equal(sameZoteroItem("users:111/ABCD1234", "users:111/ABCD1234"), true);
  // This computer's library (local API / Better BibTeX) is anyone's web library.
  assert.equal(sameZoteroItem("users:0/ABCD1234", "users:111/ABCD1234"), true);
  assert.equal(sameZoteroItem("bbt:1/ABCD1234", "users:111/ABCD1234"), true);
  const workspace = await tempWorkspace(t);
  await appendEntry({ workspace, bibPath: "refs.bib", zoteroRef: "users:111/ABCD1234", bibtex: "@article{first,\n  title={One},\n  doi={10.1000/one}\n}" });
  const second = await appendEntry({ workspace, bibPath: "refs.bib", zoteroRef: "users:222/ABCD1234", bibtex: "@article{first,\n  title={Two},\n  doi={10.1000/two}\n}" });
  assert.deepEqual([second.key, second.appended], ["firsta", true]);
  const third = await appendEntry({ workspace, bibPath: "refs.bib", zoteroRef: "users:0/ABCD1234", bibtex: "@article{first,\n  title={Three},\n  doi={10.1000/three}\n}" });
  assert.deepEqual([third.key, third.appended], ["firstb", true]);
});

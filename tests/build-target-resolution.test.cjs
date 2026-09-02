/**
 * The build button must compile the document the writer is actually editing.
 *
 * Issue #38: a workspace with main.tex at the top and a second main.tex in a
 * subfolder always built the top-level one, so the PDF that appeared belonged
 * to a file the user had not opened.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { WorkspaceManager } = require("../electron/services/workspace.cjs");
const { isStandaloneDocument, parseTexIncludes } = require("../electron/services/tex-build-target.cjs");

const DOC = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

const makeWorkspace = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-build-target-"));
  for (const [relative, content] of Object.entries(files)) {
    const abs = path.join(root, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  const workspace = new WorkspaceManager();
  workspace.setRootPath(root);
  return { root, workspace };
};

test("a self-contained document in a subfolder builds itself, not the root", async () => {
  const { workspace } = makeWorkspace({
    "main.tex": DOC("ROOT"),
    "sub/main.tex": DOC("SUB"),
  });
  const resolved = await workspace.resolveBuildTarget("sub/main.tex");
  assert.equal(resolved.target, "sub/main.tex");
  assert.equal(resolved.reason, "standalone-document");
});

test("an included chapter still builds the document that includes it", async () => {
  const { workspace } = makeWorkspace({
    "main.tex": DOC("\\input{chapters/intro}"),
    "chapters/intro.tex": "Chapter one.\n",
  });
  const resolved = await workspace.resolveBuildTarget("chapters/intro.tex");
  assert.equal(resolved.target, "main.tex");
  assert.equal(resolved.reason, "included-by-root");
});

test("a chapter of a sibling document builds that sibling", async () => {
  const { workspace } = makeWorkspace({
    "main.tex": DOC("ROOT"),
    "paper/paper.tex": DOC("\\include{paper/body}"),
    "paper/body.tex": "Body text.\n",
  });
  const resolved = await workspace.resolveBuildTarget("paper/body.tex");
  assert.equal(resolved.target, "paper/paper.tex");
  assert.equal(resolved.reason, "included-by-sibling");
});

test("a % !TEX root comment wins over everything else", async () => {
  const { workspace } = makeWorkspace({
    "main.tex": DOC("ROOT"),
    "sub/main.tex": `% !TEX root = ../main.tex\n${DOC("SUB")}`,
  });
  const resolved = await workspace.resolveBuildTarget("sub/main.tex");
  assert.equal(resolved.target, "main.tex");
  assert.equal(resolved.reason, "magic-comment");
});

test("opening the workspace root builds the workspace root", async () => {
  const { workspace } = makeWorkspace({
    "main.tex": DOC("\\input{chapters/intro}"),
    "chapters/intro.tex": "Chapter one.\n",
  });
  const resolved = await workspace.resolveBuildTarget("main.tex");
  assert.equal(resolved.target, "main.tex");
});

test("a non-tex file falls back to the workspace root", async () => {
  const { workspace } = makeWorkspace({
    "main.tex": DOC("ROOT"),
    "refs.bib": "@book{a, title={T}}\n",
  });
  const resolved = await workspace.resolveBuildTarget("refs.bib");
  assert.equal(resolved.target, "main.tex");
});

test("an explicitly chosen root still wins for the files it includes", async () => {
  const { workspace, root } = makeWorkspace({
    "main.tex": DOC("ROOT"),
    "book/book.tex": DOC("\\input{book/ch1}"),
    "book/ch1.tex": "One.\n",
  });
  await workspace.setRootFile("book/book.tex");
  const resolved = await workspace.resolveBuildTarget("book/ch1.tex");
  assert.equal(resolved.target, "book/book.tex");
  assert.equal(resolved.reason, "included-by-root");
  await fsp.rm(path.join(root, ".tex64"), { recursive: true, force: true });
});

test("a commented-out documentclass does not make a child look standalone", () => {
  assert.equal(isStandaloneDocument("% \\documentclass{book}\n% \\begin{document}\nHi\n"), false);
  assert.equal(isStandaloneDocument(DOC("Hi")), true);
});

test("include directives are read in every common spelling", () => {
  const includes = parseTexIncludes(
    "\\input{a}\n\\include{b/c}\n\\subfile{d.tex}\n\\subimport{sec/}{e}\n\\input f\n% \\input{skipped}\n"
  );
  assert.deepEqual(includes, ["a", "b/c", "d.tex", "sec/e", "f"]);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { resolveBuildTarget, resolveIncludingDocuments, BUILD_TARGET_CHOICE } = require("../electron/services/tex-build-target.cjs");

// A workspace made of in-memory files. rootFile is what .tex64/settings.json
// or auto-detection would name; null means "nothing decided".
const fakeWorkspace = (files, rootFile = null, source = "manual", recent = []) => ({
  getRootPath: () => "/ws",
  resolvePath: (file) => path.posix.join("/ws", file),
  readFile: async (file) => { if (file in files) return files[file]; throw new Error("ENOENT"); },
  listFiles: async () => Object.keys(files),
  getRecentBuildTargets: () => recent,
  rootInfo: async () => (rootFile ? { path: rootFile, source } : null),
  resolveTexRootFromMagic: async () => null,
});
const doc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

test("a fragment included by one document builds that document", async () => {
  const ws = fakeWorkspace({ "report.tex": doc("\\include{chapters/intro}"), "chapters/intro.tex": "Intro." },
    "report.tex");
  assert.equal(await resolveBuildTarget(ws, "chapters/intro.tex"), "report.tex");
});

test("a standalone document builds itself even when another root is set", async () => {
  const ws = fakeWorkspace({ "main.tex": doc("A"), "notes.tex": doc("B") }, "main.tex");
  assert.equal(await resolveBuildTarget(ws, "notes.tex"), "notes.tex");
});

test("shared fragments use the existing chooser regardless of build recency or distance", async () => {
  const files = {
    "slides/deep/deck.tex": doc(String.raw`\input{book/shared}`),
    "book/z.tex": doc(String.raw`\include{shared}`),
    "book/a.tex": doc(String.raw`\input{shared}`),
    "book/shared.tex": "Shared.",
    "unrelated.tex": doc("Unrelated."),
  };
  const child = "book/shared.tex";
  const choice = { code: BUILD_TARGET_CHOICE, candidates: ["slides/deep/deck.tex", "book/z.tex", "book/a.tex"], requested: child };
  await assert.rejects(resolveBuildTarget(fakeWorkspace(files), child), choice);
  await assert.rejects(resolveBuildTarget(fakeWorkspace(files, "slides/deep/deck.tex", "auto"), child), choice);
  await assert.rejects(resolveBuildTarget(fakeWorkspace(files, null, "auto", [
    "unrelated.tex", "old-name.tex", "slides/deep/deck.tex", "book/a.tex",
  ]), child), choice);
  assert.equal(await resolveBuildTarget(fakeWorkspace(files, "book/z.tex", "manual", [
    "slides/deep/deck.tex",
  ]), child), "book/z.tex");
  await assert.rejects(resolveBuildTarget(fakeWorkspace(files, "unrelated.tex", "manual"), child), choice);
});

test("a detached fragment follows the release default or chooser", async () => {
  const files = { "a.tex": doc("A"), "loose.tex": "Loose." };
  assert.equal(await resolveBuildTarget(fakeWorkspace(files, "a.tex"), "loose.tex"), "a.tex");
  await assert.rejects(resolveBuildTarget(fakeWorkspace({ ...files, "b.tex": doc("B") }), "loose.tex"),
    { code: BUILD_TARGET_CHOICE, candidates: ["a.tex", "b.tex"] });
});

test("non-TeX editor tabs keep the release manual-root precedence over build recency", async () => {
  const files = { "a.tex": doc("A"), "b.tex": doc("B"), "refs.bib": "", "theme.sty": "", "custom.cls": "" };
  for (const active of ["refs.bib", "theme.sty", "custom.cls"]) {
    assert.equal(await resolveBuildTarget(fakeWorkspace(files, "a.tex", "manual", ["b.tex"]), active), "a.tex");
    assert.equal(await resolveBuildTarget(fakeWorkspace(files, "deleted.tex", "manual", ["b.tex"]), active), "deleted.tex");
  }
});

test("no active file: root, then main.tex, then the only document, else asks", async () => {
  assert.equal(await resolveBuildTarget(fakeWorkspace({ "x.tex": doc("X") }, "x.tex"), null), "x.tex");
  assert.equal(await resolveBuildTarget(fakeWorkspace({ "main.tex": doc("M"), "x.tex": doc("X") }), null), "main.tex");
  assert.equal(await resolveBuildTarget(fakeWorkspace({ "only.tex": doc("O") }), null), "only.tex");
  await assert.rejects(resolveBuildTarget(fakeWorkspace({ "a.tex": doc("A"), "b.tex": doc("B") }), null), (error) => error.code === BUILD_TARGET_CHOICE);
  await assert.rejects(resolveBuildTarget(fakeWorkspace({ "a.tex": doc("A"), "b.tex": doc("B") }, "a.tex", "auto"), null), (error) => error.code === BUILD_TARGET_CHOICE);
});

test("a fragment named from the workspace root by a document in a subfolder belongs to that document", async () => {
  const ws = fakeWorkspace({
    "main.tex": doc("Main."),
    "notes/draft.tex": doc("\\input{notes/body}"),
    "notes/body.tex": "Body.",
  }, "main.tex", "auto");
  assert.equal(await resolveBuildTarget(ws, "notes/body.tex"), "notes/draft.tex");
});

test("a chapter that prints a complete document as an example is still a fragment of the book", async () => {
  const { isStandaloneDocument } = require("../electron/services/tex-build-target.cjs");
  const chapter = [
    "\\chapter{First steps}",
    "\\begin{KKfbox9}[input]",
    "\\KKcodeS+",
    "\\documentclass{article}",
    "\\begin{document}",
    "Hello",
    "\\end{document}",
    "\\KKcodeE",
    "\\end{KKfbox9}",
    "\\begin{verbatim}",
    "\\documentclass{book}\\begin{document}",
    "\\end{verbatim}",
    "Use \\verb|\\documentclass{x}\\begin{document}| like this.",
  ].join("\n");
  assert.equal(isStandaloneDocument(chapter), false);
  // Even without a verbatim wrapper, a class line after body material is quoted text.
  assert.equal(isStandaloneDocument("\\section{A}\n\\documentclass{article}\n\\begin{document}"), false);
  assert.equal(isStandaloneDocument("\\RequirePackage{x}\n\\documentclass{article}\n\\begin{document}\nA"), true);
  const ws = fakeWorkspace({ "book.tex": doc("\\input{chapters/first}"), "chapters/first.tex": chapter });
  assert.equal(await resolveBuildTarget(ws, "chapters/first.tex"), "book.tex");
});

test("a self-compilable subfile builds itself and its parent remains discoverable", async () => {
  const files = {
    "all.tex": "\\documentclass{book}\n\\usepackage{subfiles}\n\\begin{document}\n\\subfile{tex/chap1}\n\\end{document}\n",
    "tex/chap1.tex": "\\documentclass[../all]{subfiles}\n\\begin{document}\n\\chapter{One}\n\\end{document}\n",
    "other.tex": doc("Unrelated"),
  };
  const ws = fakeWorkspace(files);
  assert.equal(await resolveBuildTarget(ws, "tex/chap1.tex"), "tex/chap1.tex");
  assert.equal(await resolveBuildTarget(fakeWorkspace({ ...files, "all.tex": doc("Detached") }), "tex/chap1.tex"), "tex/chap1.tex");
  assert.deepEqual(await resolveIncludingDocuments(ws, "tex/chap1.tex"), ["all.tex"]);
  assert.deepEqual(await resolveIncludingDocuments(ws, "other.tex"), []);
});

test("the include graph discovers a moved root beyond the release fallback depth", async () => {
  const files = {
    "main.tex": doc("Unrelated"),
    "moved/new-main.tex": doc(String.raw`\include{new-chapters/one}`),
    "moved/new-chapters/one.tex": String.raw`\input new-chapters/two`,
  };
  for (let index = 2; index < 24; index++) {
    files[`moved/new-chapters/${index === 2 ? "two" : index}.tex`] =
      String.raw`\input{new-chapters/one}\input{new-chapters/${index + 1}}`;
  }
  files["moved/new-chapters/24.tex"] = "Leaf";
  const workspace = fakeWorkspace(files, "old-main.tex", "manual", ["old-main.tex"]);
  assert.equal(await resolveBuildTarget(workspace, "moved/new-chapters/24.tex"), "old-main.tex");
  assert.deepEqual(await resolveIncludingDocuments(workspace, "moved/new-chapters/24.tex"), ["moved/new-main.tex"]);
});

test("import and subimport establish directories, including for a filename with its own subfolder", async () => {
  const files = {
    "book/main.tex": doc(String.raw`\import{sections}{part/intro}`),
    "book/sections/part/intro.tex": String.raw`\subimport{sub}{body}\input{footnote}`,
    "book/sections/sub/body.tex": String.raw`\input{last}`,
    "book/sections/sub/last.tex": "Last",
    "book/sections/footnote.tex": "Footnote",
    "book/sections/part/sub/body.tex": "Unrelated",
  };
  const workspace = fakeWorkspace(files);
  for (const child of ["book/sections/sub/last.tex", "book/sections/footnote.tex"]) {
    assert.equal(await resolveBuildTarget(workspace, child), "book/main.tex");
  }
  assert.equal(await resolveBuildTarget(workspace, "book/sections/part/sub/body.tex"), "book/main.tex");
});

test("subfile paths follow the import context and nested chapters resolve to the top document", async () => {
  const files = {
    "book/main.tex": doc(String.raw`\input{scripts/loader}`),
    "book/scripts/loader.tex": String.raw`\subfile{chapters/one}`,
    "book/chapters/one.tex": String.raw`\documentclass[../main]{subfiles}\begin{document}\subfileinclude{inner/two}\end{document}`,
    "book/chapters/inner/two.tex": String.raw`\documentclass[../one]{subfiles}\begin{document}\input{paragraph}\end{document}`,
    "book/chapters/inner/paragraph.tex": "Body",
  };
  const workspace = fakeWorkspace(files);
  for (const child of ["book/chapters/one.tex", "book/chapters/inner/two.tex", "book/chapters/inner/paragraph.tex"]) {
    assert.ok((await resolveIncludingDocuments(workspace, child)).includes("book/main.tex"));
  }
  assert.equal(await resolveBuildTarget(workspace, "book/chapters/one.tex"), "book/chapters/one.tex");
  assert.equal(await resolveBuildTarget(workspace, "book/chapters/inner/two.tex"), "book/chapters/inner/two.tex");
});

test("commented, escaped, verbatim and after-document inputs cannot claim a fragment", async () => {
  const files = {
    "a.tex": doc(String.raw`% \input{child}
\\input{child}
\begin{verbatim}\include{child}\end{verbatim}`) + String.raw`\input{child}`,
    "b.tex": doc(String.raw`\input{child}`),
    "child.tex": "Body",
  };
  const workspace = fakeWorkspace(files);
  assert.deepEqual(await resolveIncludingDocuments(workspace, "child.tex"), ["b.tex"]);
  await assert.rejects(resolveBuildTarget(workspace, "child.tex"), { code: BUILD_TARGET_CHOICE, candidates: ["a.tex", "b.tex"] });
});

test("magic roots take precedence, and listing owners still returns the graph", async () => {
  const workspace = fakeWorkspace({
    "a.tex": doc(String.raw`\input{child}`),
    "b.tex": doc("B"),
    "child.tex": "% !TEX root = b.tex\nBody",
  }, "a.tex");
  workspace.resolveTexRootFromMagic = async () => "b.tex";
  assert.equal(await resolveBuildTarget(workspace, "child.tex"), "b.tex");
  assert.deepEqual(await resolveIncludingDocuments(workspace, "child.tex"), ["a.tex"]);
});

test("a plain dot-relative input uses the compiler's workspace directory", async () => {
  const files = {
    "book/main.tex": doc(String.raw`\input{./shared/child}`),
    "book/shared/child.tex": "Different file",
    "shared/child.tex": "The file read by TeX",
  };
  const workspace = fakeWorkspace(files);
  assert.equal(await resolveBuildTarget(workspace, "shared/child.tex"), "book/main.tex");
  assert.equal(await resolveBuildTarget(workspace, "book/shared/child.tex"), "book/main.tex");
});

test("a preamble macro containing an end marker does not hide inputs in the body", async () => {
  const files = {
    "main.tex": String.raw`\documentclass{article}
\newcommand{\finishDoc}{\end{document}}
\begin{document}
\input{child}
\end{document}`,
    "child.tex": "Body",
  };
  assert.equal(await resolveBuildTarget(fakeWorkspace(files), "child.tex"), "main.tex");
});

test("a nested plain input follows the document's recursive TEXINPUTS before the workspace directory", async () => {
  const files = {
    "book/main.tex": doc(String.raw`\input{chapters/part}`),
    "book/chapters/part.tex": String.raw`\input{leaf}`,
    "book/chapters/leaf.tex": "The file read by TeX",
    "leaf.tex": "Unrelated",
  };
  const workspace = fakeWorkspace(files);
  assert.equal(await resolveBuildTarget(workspace, "book/chapters/leaf.tex"), "book/main.tex");
  assert.equal(await resolveBuildTarget(workspace, "leaf.tex"), "book/main.tex");
});

test("a recursively searched input with duplicate basenames requires a literal disambiguating path", async () => {
  const files = {
    "book/main.tex": doc(String.raw`\input{leaf}`),
    "book/one/leaf.tex": "First",
    "book/two/leaf.tex": "Second",
    "leaf.tex": "Unrelated",
  };
  const workspace = fakeWorkspace(files);
  assert.deepEqual(await resolveIncludingDocuments(workspace, "leaf.tex"), []);
  assert.deepEqual(await resolveIncludingDocuments(workspace, "book/one/leaf.tex"), []);
});

test("dot-relative import directories stay anchored to the workspace", async () => {
  const files = {
    "book/main.tex": doc(String.raw`\import{./parts}{chapter}`),
    "parts/chapter.tex": String.raw`\subimport{inner}{leaf}`,
    "parts/inner/leaf.tex": "The file read by TeX",
    "book/parts/chapter.tex": "Other chapter",
    "book/parts/inner/leaf.tex": "Other leaf",
  };
  const workspace = fakeWorkspace(files);
  assert.equal(await resolveBuildTarget(workspace, "parts/inner/leaf.tex"), "book/main.tex");
  assert.equal(await resolveBuildTarget(workspace, "book/parts/chapter.tex"), "book/main.tex");
});

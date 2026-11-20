"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { resolveBuildTarget, BUILD_TARGET_CHOICE } = require("../electron/services/tex-build-target.cjs");

// A workspace made of in-memory files. rootFile is what .tex64/settings.json
// or auto-detection would name; null means "nothing decided".
const fakeWorkspace = (files, rootFile = null, source = "manual") => ({
  getRootPath: () => "/ws",
  resolvePath: (file) => path.posix.join("/ws", file),
  readFile: async (file) => { if (file in files) return files[file]; throw new Error("ENOENT"); },
  listFiles: async () => Object.keys(files),
  rootInfo: async () => (rootFile ? { path: rootFile, source } : null),
  resolveTexRootFromMagic: async () => null,
});
const doc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

test("a fragment included by one document builds that document", async () => {
  const ws = fakeWorkspace({ "report.tex": doc("\\include{chapters/intro}"), "chapters/intro.tex": "Intro." });
  assert.equal(await resolveBuildTarget(ws, "chapters/intro.tex"), "report.tex");
});

test("a standalone document builds itself even when another root is set", async () => {
  const ws = fakeWorkspace({ "main.tex": doc("A"), "notes.tex": doc("B") }, "main.tex");
  assert.equal(await resolveBuildTarget(ws, "notes.tex"), "notes.tex");
});

test("a fragment included by two documents asks which one", async () => {
  const ws = fakeWorkspace({ "a.tex": doc("\\include{shared}"), "b.tex": doc("\\input{shared}"), "shared.tex": "Shared." });
  await assert.rejects(resolveBuildTarget(ws, "shared.tex"), (error) => {
    assert.equal(error.code, BUILD_TARGET_CHOICE);
    assert.deepEqual(error.candidates.sort(), ["a.tex", "b.tex"]);
    assert.equal(error.requested, "shared.tex");
    return true;
  });
});

test("a fragment included by two documents follows a root the user set, not an auto-detected one", async () => {
  const files = { "a.tex": doc("\\include{shared}"), "b.tex": doc("\\include{shared}"), "shared.tex": "Shared." };
  assert.equal(await resolveBuildTarget(fakeWorkspace(files, "b.tex", "manual"), "shared.tex"), "b.tex");
  await assert.rejects(resolveBuildTarget(fakeWorkspace(files, "a.tex", "auto"), "shared.tex"), (error) => error.code === BUILD_TARGET_CHOICE);
});

test("a fragment nobody includes falls back to the only document, else asks", async () => {
  const one = fakeWorkspace({ "a.tex": doc("A"), "loose.tex": "Loose." });
  assert.equal(await resolveBuildTarget(one, "loose.tex"), "a.tex");
  const two = fakeWorkspace({ "a.tex": doc("A"), "b.tex": doc("B"), "loose.tex": "Loose." });
  await assert.rejects(resolveBuildTarget(two, "loose.tex"), (error) => error.code === BUILD_TARGET_CHOICE && error.candidates.length === 2);
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

test("a subfiles chapter builds itself but names the book that includes it", async () => {
  const { resolveIncludingDocuments } = require("../electron/services/tex-build-target.cjs");
  const files = {
    "all.tex": "\\documentclass{book}\n\\usepackage{subfiles}\n\\begin{document}\n\\subfile{tex/chap1}\n\\end{document}\n",
    "tex/chap1.tex": "\\documentclass[../all]{subfiles}\n\\begin{document}\n\\chapter{One}\n\\end{document}\n",
    "other.tex": doc("Unrelated"),
  };
  const ws = fakeWorkspace(files);
  assert.equal(await resolveBuildTarget(ws, "tex/chap1.tex"), "tex/chap1.tex");
  assert.deepEqual(await resolveIncludingDocuments(ws, "tex/chap1.tex"), ["all.tex"]);
  assert.deepEqual(await resolveIncludingDocuments(ws, "other.tex"), []);
});

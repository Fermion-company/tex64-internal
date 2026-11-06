"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { countLatex, countDocument, resolveCountTarget } = require("../electron/services/word-count.cjs");

const tex = String.raw;

test("prose words only: comments, math, command names and non-prose arguments are left out", () => {
  const counts = countLatex(tex`\documentclass{article}
\usepackage{amsmath}
\newcommand{\foo}[1]{preamble words}
\begin{document}
\section{Intro duction}\label{sec:intro}
Hello, world! This is Schr\"{o}dinger's cat~\cite{dirac} and \textbf{bold}text 50\%.
% a comment with words
\href{http://x.y}{link text} \url{http://a.b} \includegraphics[width=3cm]{fig/a.png}
\section*[short]{Long Title}
\end{document}`);
  // Intro duction Hello world This is Schrodinger's cat and boldtext 50 link text Long Title
  assert.equal(counts.words, 15);
  assert.equal(counts.headings, 2);
});

test("math is counted as inline or display, never as words", () => {
  const counts = countLatex(tex`Let $x+y$ and \(a\) be given.
$$E=mc^2$$ and \[F=ma\]
\begin{align}a&=b\\c&=d\end{align}
\begin{equation*}z\end{equation*}
\begin{math}q\end{math}`);
  // Let and be given and
  assert.equal(counts.words, 5);
  assert.equal(counts.inlineMath, 3);
  assert.equal(counts.displayMath, 4);
});

test("Japanese prose: characters without spaces, punctuation included", () => {
  const counts = countLatex("日本語の文章です。数式$x$を含む、\\textbf{太字}。\n\n次の段落 ABC。");
  // 日本語の文章です。(9) 数式(2) を含む、(4) 太字(2) 。(1) 次の段落(4) ABC(3) 。(1)
  assert.equal(counts.characters, 26);
  assert.equal(counts.words, 1);
  assert.equal(counts.inlineMath, 1);
});

test("verbatim-like environments and \\verb are skipped whole", () => {
  const counts = countLatex(tex`Before.
\begin{verbatim}
not counted words
\end{verbatim}
\begin{lstlisting}[language=C]
int main() {}
\end{lstlisting}
\verb|also not| after \lstinline{x = 1} end
\begin{tikzpicture}\node {label};\end{tikzpicture}
\begin{thebibliography}{9}\bibitem{a} Reference text.\end{thebibliography}`);
  assert.equal(counts.words, 3);
});

test("a commented-out \\begin{document} does not start the body", () => {
  const counts = countLatex("% \\begin{document}\n\\documentclass{article}\n\\title{Skipped}\n\\begin{document}\nOne two.\n\\end{document}");
  assert.equal(counts.words, 2);
});

test("a file without \\begin{document} (an included fragment) is counted whole", () => {
  assert.equal(countLatex("\\section{Results}\nThree words here.").words, 4);
});

test("selection text is counted as it is, preamble or not", () => {
  assert.equal(countLatex("\\usepackage{x} plain words", { body: false }).words, 2);
});

test("a document counts its main file and every file it reads, unsaved buffers first", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-wc-"));
  try {
    fs.mkdirSync(path.join(root, "sections"));
    fs.writeFileSync(path.join(root, "main.tex"), "\\documentclass{article}\n\\begin{document}\nMain words.\n\\input{sections/a}\n% \\input{sections/hidden}\n\\end{document}\n");
    fs.writeFileSync(path.join(root, "sections/a.tex"), "\\section{A}\nSaved text of a.\n\\input{sections/b}\n");
    fs.writeFileSync(path.join(root, "sections/b.tex"), "Bee $x$.\n");
    fs.writeFileSync(path.join(root, "sections/hidden.tex"), "Never read.\n");
    const workspace = {
      getRootPath: () => root,
      resolvePath: (relative) => path.join(root, relative),
      readFile: async (relative) => fs.readFileSync(path.join(root, relative), "utf8"),
      listFiles: async () => ["main.tex", "sections/a.tex", "sections/b.tex", "sections/hidden.tex"],
      rootInfo: async () => ({ path: "main.tex", source: "auto" }),
      resolveTexRootFromMagic: async () => null,
    };
    const result = await countDocument({ workspace, mainFile: "main.tex", buffers: { "sections/a.tex": "\\section{A}\nUnsaved longer text of a.\n\\input{sections/b}\n" } });
    assert.deepEqual(result.files.map((file) => file.path).sort(), ["main.tex", "sections/a.tex", "sections/b.tex"]);
    assert.equal(result.files.find((file) => file.path === "sections/a.tex").words, 6);
    assert.equal(result.total.words, 2 + 6 + 1);
    assert.equal(result.total.headings, 1);
    assert.equal(result.total.inlineMath, 1);
    // A fragment counts as the document that reads it.
    assert.equal(await resolveCountTarget(workspace, { activeFilePath: "sections/b.tex" }), "main.tex");
    assert.equal(await resolveCountTarget(workspace, { activeFilePath: "sections/b.tex", documentMainFile: "sections/a.tex" }), "sections/a.tex");
    assert.equal(await resolveCountTarget(workspace, { activeFilePath: "notes.md" }), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nothing after \\end{document}; every argument of a length or colour command is left out", () => {
  const counts = countLatex(tex`\begin{document}
\setlength{\parindent}{12pt}\addtolength{\textwidth}{-1cm}\setcounter{page}{3}
\definecolor{accent}{HTML}{0F766E}\textcolor{accent}{Coloured words}\kern3pt\vskip 1em plus 2pt
\newcommand{\x}[1]{defined body}\def\y#1{also defined}\rule{1pt}{2pt}
Kept.
\end{document}
Notes after the end are not printed.`);
  // Coloured words Kept
  assert.equal(counts.words, 3);
  assert.equal(counts.characters, "ColouredwordsKept.".length);
});

test("characters are code points: a supplementary kanji is one character", () => {
  assert.equal(countLatex("𠮷野家").characters, 3);
});

test("the files of a document come from the unsaved buffers first", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-wc-"));
  try {
    fs.writeFileSync(path.join(root, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{old}\n\\end{document}\n");
    fs.writeFileSync(path.join(root, "old.tex"), "Old words here.\n");
    fs.mkdirSync(path.join(root, "parts"));
    fs.writeFileSync(path.join(root, "parts/inner.tex"), "Inner text.\n");
    const workspace = {
      getRootPath: () => root,
      resolvePath: (relative) => path.join(root, relative),
      readFile: async (relative) => fs.readFileSync(path.join(root, relative), "utf8"),
    };
    // Unsaved: main now reads new.tex (never saved) instead of old.tex, and
    // new.tex imports parts/inner.tex.
    const buffers = {
      "main.tex": "\\documentclass{article}\n\\begin{document}\n\\input{new}\n\\end{document}\n",
      "new.tex": "New.\n\\import{parts/}{inner}\n",
    };
    const result = await countDocument({ workspace, mainFile: "main.tex", buffers });
    assert.deepEqual(result.files.map((file) => file.path), ["main.tex", "new.tex", "parts/inner.tex"]);
    assert.equal(result.total.words, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("files read after \\end{document} are not part of the document", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-wc-"));
  try {
    fs.writeFileSync(path.join(root, "main.tex"), "\\documentclass{article}\n\\input{macros}\n\\begin{document}\nVisible.\n\\end{document}\n\\input{discarded}\n");
    fs.writeFileSync(path.join(root, "macros.tex"), "\\newcommand{\\x}{y}\n");
    fs.writeFileSync(path.join(root, "discarded.tex"), "These words never print.\n");
    const workspace = { getRootPath: () => root, resolvePath: (r) => path.join(root, r), readFile: async (r) => fs.readFileSync(path.join(root, r), "utf8") };
    const result = await countDocument({ workspace, mainFile: "main.tex" });
    assert.deepEqual(result.files.map((file) => file.path), ["main.tex", "macros.tex"]);
    assert.equal(result.total.words, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a preamble macro that contains \\end{document} does not end the document early", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-wc-"));
  try {
    fs.writeFileSync(path.join(root, "main.tex"), "\\documentclass{article}\n\\newcommand{\\finish}{\\end{document}}\n\\begin{document}\n\\input{chapter}\n\\end{document}\n");
    fs.writeFileSync(path.join(root, "chapter.tex"), "These words are printed.\n");
    const workspace = { getRootPath: () => root, resolvePath: (r) => path.join(root, r), readFile: async (r) => fs.readFileSync(path.join(root, r), "utf8") };
    const result = await countDocument({ workspace, mainFile: "main.tex" });
    assert.deepEqual(result.files.map((file) => file.path), ["main.tex", "chapter.tex"]);
    assert.equal(result.total.words, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

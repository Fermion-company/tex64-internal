import test from "node:test";
import assert from "node:assert/strict";
import { extractStructureHeadings } from "../Resources/web/app/pro-structure-ui.js";

test("extracts supported headings with levels and one-based lines", () => {
  const source = String.raw`\part{Start}
\chapter[Short]{A Chapter}
\section*{First}
  \subsection {Nested}
\subsubsection{Deep}
\paragraph{Detail}`;
  assert.deepEqual(extractStructureHeadings(source, "main.tex"), [
    { kind: "part", title: "Start", path: "main.tex", line: 1, level: 1 },
    { kind: "chapter", title: "A Chapter", path: "main.tex", line: 2, level: 2 },
    { kind: "section", title: "First", path: "main.tex", line: 3, level: 3 },
    { kind: "subsection", title: "Nested", path: "main.tex", line: 4, level: 4 },
    { kind: "subsubsection", title: "Deep", path: "main.tex", line: 5, level: 5 },
    { kind: "paragraph", title: "Detail", path: "main.tex", line: 6, level: 6 },
  ]);
});

test("ignores commented commands and content after an unescaped percent", () => {
  const source = String.raw`% \section{Hidden}
\section{Visible} % \subsection{Hidden too}
\section{100\% Real}`;
  assert.deepEqual(extractStructureHeadings(source), [
    { kind: "section", title: "Visible", path: "", line: 2, level: 3 },
    { kind: "section", title: String.raw`100\% Real`, path: "", line: 3, level: 3 },
  ]);
});

test("returns an empty array when no supported heading is present", () => {
  assert.deepEqual(extractStructureHeadings(String.raw`\begin{document}\nText\n\end{document}`), []);
});

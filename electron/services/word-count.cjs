"use strict";

// Word count of a LaTeX document, the way Prism and Overleaf show it: the
// prose that ends up on the page, without comments, math, command names and
// non-prose arguments (labels, citations, file names, lengths). Words are
// Latin-script words (texcount's measure); characters are every printed
// character of the prose except white space (the measure Japanese
// manuscripts use). Headings and math are counted, not their contents.

const { scanDocument } = require("./agent-document-map.cjs");
const { resolveBuildTarget } = require("./tex-build-target.cjs");

// One optional [..] and one {..} after these are not prose.
const SKIP_ARG_COMMANDS = new Set([
  "label", "ref", "eqref", "pageref", "autoref", "cref", "Cref", "vref", "nameref", "Nameref",
  "cite", "citep", "citet", "citeauthor", "citeyear", "citealp", "citealt", "parencite",
  "textcite", "footcite", "autocite", "supercite", "nocite", "Cite", "Citep", "Citet",
  "input", "include", "includeonly", "includegraphics", "includestandalone", "subfile", "InputIfFileExists",
  "usepackage", "RequirePackage", "documentclass", "bibliography", "bibliographystyle",
  "addbibresource", "url", "href", "hyperref", "hypersetup", "geometry", "pagestyle",
  "thispagestyle", "definecolor", "color", "textcolor", "colorbox", "pagecolor",
  "lstinputlisting", "bibitem", "newcommand", "renewcommand", "providecommand",
  "newenvironment", "renewenvironment", "DeclareMathOperator", "setlength", "addtolength",
  "setcounter", "addtocounter", "vspace", "hspace", "rule", "graphicspath", "begin", "end",
  "newtheorem", "numberwithin", "linespread", "fontsize", "selectfont", "kern", "raisebox",
]);

// Their bodies are not prose and are skipped whole.
const SKIP_ENVIRONMENTS = new Set([
  "verbatim", "verbatim*", "Verbatim", "BVerbatim", "lstlisting", "minted", "comment",
  "tikzpicture", "pgfpicture", "picture", "thebibliography", "filecontents", "filecontents*",
]);

const DISPLAY_MATH_ENVIRONMENTS = new Set([
  "equation", "equation*", "align", "align*", "alignat", "alignat*", "gather", "gather*",
  "multline", "multline*", "eqnarray", "eqnarray*", "displaymath", "flalign", "flalign*",
  "dmath", "dmath*", "IEEEeqnarray", "IEEEeqnarray*",
]);

const HEADING_COMMANDS = new Set(["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"]);

// \% \& \$ \# \_ \{ \} print one character.
const PRINTED_SYMBOLS = new Set(["%", "&", "$", "#", "_", "{", "}"]);

const WORD_PATTERN = /[A-Za-z0-9À-ɏ]+(?:['’\-][A-Za-z0-9À-ɏ]+)*/g;

const emptyCounts = () => ({ words: 0, characters: 0, headings: 0, inlineMath: 0, displayMath: 0 });

// Index just past a balanced group that opens at `start` (`open` there),
// or the end of the text when it never closes.
const skipGroup = (text, start, open, close) => {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "%") {
      const newline = text.indexOf("\n", i);
      if (newline < 0) return text.length;
      i = newline;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
};

const skipSpaces = (text, index) => {
  let i = index;
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i += 1;
  return i;
};

// The body of a document: what follows \begin{document} when the file has one.
const documentBody = (text) => {
  const pattern = /\\begin\s*\{document\}/g;
  let match;
  while ((match = pattern.exec(text))) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const before = text.slice(lineStart, match.index);
    if (!/(^|[^\\])%/.test(before)) return text.slice(match.index + match[0].length);
  }
  return text;
};

// Prose text plus the counts that are not read from it.
const extractProse = (text) => {
  const counts = emptyCounts();
  let prose = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "%") {
      const newline = text.indexOf("\n", i);
      i = newline < 0 ? n : newline;
      continue;
    }
    if (ch === "$") {
      const display = text[i + 1] === "$";
      const closer = display ? "$$" : "$";
      let j = i + closer.length;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text.startsWith(closer, j)) break;
        j += 1;
      }
      if (display) counts.displayMath += 1;
      else counts.inlineMath += 1;
      prose += " ";
      i = Math.min(n, j + closer.length);
      continue;
    }
    if (ch === "{" || ch === "}") {
      i += 1;
      continue;
    }
    if (ch === "~") {
      prose += " ";
      i += 1;
      continue;
    }
    if (ch !== "\\") {
      prose += ch;
      i += 1;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) break;
    if (next === "(" || next === "[") {
      const closer = next === "(" ? "\\)" : "\\]";
      const end = text.indexOf(closer, i + 2);
      if (next === "(") counts.inlineMath += 1;
      else counts.displayMath += 1;
      prose += " ";
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (!/[A-Za-z@]/.test(next)) {
      // Control symbol: \% prints %, \\ and \, are breaks or space, accents
      // (\'e, \"{o}) join the letters around them.
      if (PRINTED_SYMBOLS.has(next)) prose += next;
      else if (next === "\\" || next === "," || next === " " || next === ";" || next === ":" || next === "!" || next === "\n") prose += " ";
      i += 2;
      if (next === "\\") {
        // \\[2pt] and \\* take an optional star and length.
        if (text[i] === "*") i += 1;
        const after = skipSpaces(text, i);
        if (text[after] === "[") i = skipGroup(text, after, "[", "]");
      }
      continue;
    }
    let j = i + 1;
    while (j < n && /[A-Za-z@]/.test(text[j])) j += 1;
    const name = text.slice(i + 1, j);
    i = j;
    if (text[i] === "*") i += 1;
    if (name === "begin") {
      const open = skipSpaces(text, i);
      if (text[open] === "{") {
        const close = skipGroup(text, open, "{", "}");
        const environment = text.slice(open + 1, close - 1).trim();
        i = close;
        if (SKIP_ENVIRONMENTS.has(environment) || DISPLAY_MATH_ENVIRONMENTS.has(environment) || environment === "math") {
          const endPattern = new RegExp(`\\\\end\\s*\\{${environment.replace(/[*]/g, "\\*")}\\}`, "g");
          endPattern.lastIndex = i;
          const end = endPattern.exec(text);
          i = end ? end.index + end[0].length : n;
          if (DISPLAY_MATH_ENVIRONMENTS.has(environment)) counts.displayMath += 1;
          else if (environment === "math") counts.inlineMath += 1;
        }
        prose += " ";
      }
      continue;
    }
    if (name === "verb" || name === "lstinline") {
      // \verb|...| and \lstinline{...}: the delimiter is the next character.
      let k = i;
      if (name === "lstinline" && text[k] === "[") k = skipGroup(text, k, "[", "]");
      const delimiter = text[k];
      if (delimiter === "{") i = skipGroup(text, k, "{", "}");
      else if (delimiter) {
        const end = text.indexOf(delimiter, k + 1);
        i = end < 0 ? n : end + 1;
      }
      prose += " ";
      continue;
    }
    if (HEADING_COMMANDS.has(name)) counts.headings += 1;
    // Optional arguments are short titles and options, never counted.
    let k = skipSpaces(text, i);
    while (text[k] === "[") {
      i = skipGroup(text, k, "[", "]");
      k = skipSpaces(text, i);
    }
    if (SKIP_ARG_COMMANDS.has(name)) {
      if (text[k] === "{") i = skipGroup(text, k, "{", "}");
      // \href{url}{text}, \newcommand{\x}[1]{body}: the second group too.
      if (name === "newcommand" || name === "renewcommand" || name === "providecommand" || name === "DeclareMathOperator" || name === "newenvironment" || name === "renewenvironment") {
        let m = skipSpaces(text, i);
        while (text[m] === "[") {
          i = skipGroup(text, m, "[", "]");
          m = skipSpaces(text, i);
        }
        while (text[m] === "{") {
          i = skipGroup(text, m, "{", "}");
          m = skipSpaces(text, i);
        }
      }
    }
    prose += " ";
  }
  return { prose, counts };
};

const countProse = (prose) => {
  const words = prose.match(WORD_PATTERN);
  const characters = prose.replace(/\s+/g, "").length;
  return { words: words ? words.length : 0, characters };
};

// Counts for one file. A file with \begin{document} is counted from there.
const countLatex = (content, { body = true } = {}) => {
  const text = String(content ?? "");
  const source = body ? documentBody(text) : text;
  const { prose, counts } = extractProse(source);
  const measured = countProse(prose);
  return { ...counts, words: measured.words, characters: measured.characters };
};

const addCounts = (total, part) => {
  for (const key of Object.keys(total)) total[key] += part[key] || 0;
  return total;
};

const normalizeRelative = (value) => (typeof value === "string" ? value.replace(/\\/g, "/").replace(/^\.\//, "") : "");

// The document's files (main first) with their counts. `buffers` holds the
// unsaved editor contents by workspace-relative path.
const countDocument = async ({ workspace, mainFile, buffers = {} }) => {
  const main = normalizeRelative(mainFile);
  const map = main ? await scanDocument({ workspace }, main) : null;
  const paths = map ? map.files.map((file) => file.path) : main ? [main] : [];
  const files = [];
  const total = emptyCounts();
  for (const relative of paths) {
    let content = typeof buffers[relative] === "string" ? buffers[relative] : null;
    if (content === null) {
      try {
        content = await require("node:fs/promises").readFile(workspace.resolvePath(relative), "utf8");
      } catch {
        continue;
      }
    }
    const counts = countLatex(content);
    files.push({ path: relative, ...counts });
    addCounts(total, counts);
  }
  return { mainFile: main, files, total };
};

// The document a file belongs to: the renderer's choice, else the build
// target, else the file itself when the owner is ambiguous.
const resolveCountTarget = async (workspace, { documentMainFile, activeFilePath }) => {
  const chosen = normalizeRelative(documentMainFile);
  if (chosen.toLowerCase().endsWith(".tex")) return chosen;
  const active = normalizeRelative(activeFilePath);
  if (!active.toLowerCase().endsWith(".tex")) return "";
  try {
    const target = await resolveBuildTarget(workspace, active);
    const path = normalizeRelative(target?.path || target?.targetPath || target);
    return path.toLowerCase().endsWith(".tex") ? path : active;
  } catch {
    return active;
  }
};

module.exports = { countLatex, countDocument, resolveCountTarget, extractProse, documentBody };

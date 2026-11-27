"use strict";

// Word count of a LaTeX document, the way Prism and Overleaf show it: the
// prose that ends up on the page, without comments, math, command names and
// non-prose arguments (labels, citations, file names, lengths). Words are
// Latin-script words (texcount's measure); characters are every printed
// character of the prose except white space (the measure Japanese
// manuscripts use). Headings and math are counted, not their contents.

const path = require("node:path");
const { resolveBuildTarget, parseTexIncludes, includeCandidates, activeTexSource } = require("./tex-build-target.cjs");


// How many {..} arguments after these are not prose (optional [..] are
// always skipped). \href{url}{text}: the url only; \textcolor{red}{text}:
// the colour only.
const SKIP_ARGS = new Map([
  ...["label", "ref", "eqref", "pageref", "autoref", "cref", "Cref", "vref", "nameref", "Nameref",
    "cite", "citep", "citet", "citeauthor", "citeyear", "citealp", "citealt", "parencite",
    "textcite", "footcite", "autocite", "supercite", "nocite", "Cite", "Citep", "Citet",
    "input", "include", "includeonly", "includegraphics", "includestandalone", "subfile", "subfileinclude",
    "usepackage", "RequirePackage", "documentclass", "bibliography", "bibliographystyle",
    "addbibresource", "url", "href", "hyperref", "hypersetup", "geometry", "pagestyle",
    "thispagestyle", "color", "textcolor", "colorbox", "pagecolor", "lstinputlisting", "bibitem",
    "vspace", "hspace", "graphicspath", "begin", "end", "linespread", "raisebox", "numberwithin",
    "hyphenation", "pagenumbering", "setcitestyle", "bibliographystyle"].map((name) => [name, 1]),
  ...["setlength", "addtolength", "setcounter", "addtocounter", "fontsize", "rule", "fcolorbox",
    "InputIfFileExists", "import", "subimport", "includefrom", "inputfrom", "subincludefrom", "subinputfrom",
    "DeclareMathOperator", "settowidth", "settoheight", "settodepth"].map((name) => [name, 2]),
  ...["definecolor"].map((name) => [name, 3]),
  // Definitions: every following group belongs to the definition.
  ...["newcommand", "renewcommand", "providecommand", "newenvironment", "renewenvironment",
    "newtheorem", "def", "let"].map((name) => [name, Infinity]),
]);
// Primitives followed by a bare dimension (\kern3pt, \vskip 1em plus 2pt).
const DIMENSION_COMMANDS = new Set(["kern", "hskip", "vskip", "mskip", "hspace", "vspace"]);
const DIMENSION_PATTERN = /^\s*-?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|pc|in|bp|cm|mm|dd|cc|sp|em|ex|mu|fil{1,3})(?:\s+(?:plus|minus)\s*-?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|pc|in|bp|cm|mm|dd|cc|sp|em|ex|mu|fil{1,3}))*/;

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

// Locate the real document boundaries without matching examples in comments
// or verbatim. The mask preserves source offsets for slicing the original.
const documentRange = (masked) => {
  const begin = /\\begin\s*\{document\}/.exec(masked);
  const start = begin ? begin.index + begin[0].length : 0;
  const endPattern = /\\end\s*\{document\}/g;
  endPattern.lastIndex = start;
  return { start, end: endPattern.exec(masked)?.index ?? masked.length };
};

const documentBody = (text) => {
  const { start, end } = documentRange(activeTexSource(text));
  return text.slice(start, end);
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
    if (DIMENSION_COMMANDS.has(name) && text[skipSpaces(text, i)] !== "{") {
      const dimension = DIMENSION_PATTERN.exec(text.slice(i, i + 120));
      if (dimension) i += dimension[0].length;
    }
    if (name === "def" || name === "let") {
      // \def\x#1{body}, \let\a\b: the name, its parameters and its body.
      const after = /^\s*\\(?:[A-Za-z@]+|.)[^{\\]*/.exec(text.slice(i));
      if (after) i += after[0].length;
    }
    // Optional arguments are short titles and options, never counted.
    let k = skipSpaces(text, i);
    while (text[k] === "[") {
      i = skipGroup(text, k, "[", "]");
      k = skipSpaces(text, i);
    }
    let skip = SKIP_ARGS.get(name) || 0;
    while (skip > 0 && text[k] === "{") {
      i = skipGroup(text, k, "{", "}");
      skip -= 1;
      k = skipSpaces(text, i);
      while (text[k] === "[") {
        i = skipGroup(text, k, "[", "]");
        k = skipSpaces(text, i);
      }
    }
    prose += " ";
  }
  return { prose, counts };
};

const countProse = (prose) => {
  const words = prose.match(WORD_PATTERN);
  // Code points, so 𠮷 (two UTF-16 units) is one character.
  const characters = Array.from(prose.replace(/\s+/g, "")).length;
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

// The files a document reads, main first, found in the unsaved buffers
// before the disk and resolved the way Build resolves them (plain \input is
// relative to the main file's folder or the root; \import / \subfile set a
// new base).
const countDocument = async ({ workspace, mainFile, buffers = {} }) => {
  const main = normalizeRelative(mainFile);
  const cwd = path.posix.dirname(main);
  const root = workspace.getRootPath();
  const generation = workspace.rootGeneration;
  const files = [];
  const total = emptyCounts();
  const seen = new Set();
  const missing = new Set();
  const queue = main ? [[{ file: main, base: cwd }]] : [];
  for (let i = 0; i < queue.length; i++) {
    for (const candidate of queue[i]) {
      workspace.assertCurrentRoot?.(generation);
      let file;
      try {
        file = path.relative(root, workspace.resolvePath(candidate.file)).split(path.sep).join("/");
      } catch { continue; }
      if (!file || file === ".." || file.startsWith("../") || path.isAbsolute(file)) continue;
      if (seen.has(file)) break;
      if (missing.has(file)) continue;
      let content = buffers[file];
      if (typeof content !== "string") {
        try { content = await workspace.readFile(file); }
        catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
          missing.add(file);
          continue;
        }
      }
      workspace.assertCurrentRoot?.(generation);
      if (typeof content !== "string") { missing.add(file); continue; }
      seen.add(file);
      const masked = activeTexSource(content);
      const { start, end } = documentRange(masked);
      const counts = countLatex(content.slice(start, end), { body: false });
      files.push({ path: file, ...counts });
      addCounts(total, counts);
      for (const include of parseTexIncludes(masked.slice(0, end), { masked: true })) {
        queue.push(includeCandidates(include, file, candidate.base, cwd));
      }
      break;
    }
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

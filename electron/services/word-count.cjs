"use strict";

// Word count of a LaTeX document, the way Prism and Overleaf show it: the
// prose that ends up on the page, without comments, math, command names and
// non-prose arguments (labels, citations, file names, lengths). Words are
// Latin-script words (texcount's measure); characters are every printed
// character of the prose except white space (the measure Japanese
// manuscripts use). Headings and math are counted, not their contents.

const path = require("node:path");
const { resolveBuildTarget, parseTexIncludes } = require("./tex-build-target.cjs");

const MAX_FILES = 40;
const MAX_DEPTH = 16;

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

// First uncommented match of `pattern` (global) in `text`.
const firstUncommented = (text, pattern) => {
  let match;
  while ((match = pattern.exec(text))) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const before = text.slice(lineStart, match.index);
    if (!/(^|[^\\])%/.test(before)) return match;
  }
  return null;
};

// The body of a document: between \begin{document} and \end{document} when
// the file has them; nothing after \end{document} is printed.
const documentBody = (text) => {
  const begin = firstUncommented(text, /\\begin\s*\{document\}/g);
  const body = begin ? text.slice(begin.index + begin[0].length) : text;
  const end = firstUncommented(body, /\\end\s*\{document\}/g);
  return end ? body.slice(0, end.index) : body;
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
const documentFiles = async (workspace, main, buffers) => {
  const root = workspace.getRootPath();
  const normalize = (file) => {
    try {
      const relative = path.relative(root, workspace.resolvePath(file)).split(path.sep).join("/");
      return relative && !relative.startsWith("../") ? relative : null;
    } catch {
      return null;
    }
  };
  const cache = new Map();
  const read = async (file) => {
    if (!cache.has(file)) {
      cache.set(file, typeof buffers[file] === "string"
        ? Promise.resolve(buffers[file])
        : Promise.resolve(workspace.readFile(file)).then((content) => (typeof content === "string" ? content : null), () => null));
    }
    return cache.get(file);
  };
  const cwd = path.posix.dirname(main);
  const files = [];
  const seen = new Set();
  const queue = [{ file: main, base: cwd, depth: 0 }];
  while (queue.length && files.length < MAX_FILES) {
    const entry = queue.shift();
    if (seen.has(entry.file) || entry.depth > MAX_DEPTH) continue;
    seen.add(entry.file);
    const content = await read(entry.file);
    if (content === null) continue;
    files.push({ path: entry.file, content });
    for (const include of parseTexIncludes(content)) {
      const base = include.directory !== undefined
        ? path.posix.join(include.kind.startsWith("sub") ? entry.base : cwd, include.directory)
        : include.kind.startsWith("subfile") ? path.posix.dirname(entry.file) : entry.base;
      const withExt = (file) => (path.posix.extname(file) ? file : `${file}.tex`);
      const tries = [withExt(path.posix.join(base, include.file))];
      if (include.directory === undefined && !include.kind.startsWith("subfile")) tries.push(withExt(include.file));
      for (const attempt of tries) {
        const candidate = normalize(attempt);
        if (!candidate || seen.has(candidate)) continue;
        if ((await read(candidate)) === null) continue;
        queue.push({
          file: candidate,
          base: include.directory !== undefined || include.kind.startsWith("subfile") ? path.posix.dirname(candidate) : entry.base,
          depth: entry.depth + 1,
        });
        break;
      }
    }
  }
  return files;
};

// The document's files (main first) with their counts. `buffers` holds the
// unsaved editor contents by workspace-relative path.
const countDocument = async ({ workspace, mainFile, buffers = {} }) => {
  const main = normalizeRelative(mainFile);
  const files = [];
  const total = emptyCounts();
  for (const { path: relative, content } of main ? await documentFiles(workspace, main, buffers) : []) {
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

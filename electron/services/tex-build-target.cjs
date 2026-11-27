"use strict";

const path = require("node:path");

/** error.code when the build target is not unique; error.candidates lists the documents. */
const BUILD_TARGET_CHOICE = "BUILD_TARGET_CHOICE";
const stripTexComments = (content) => String(content ?? "").split(/\r?\n/).map((line) => {
  let result = "";
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\") { result += line.slice(i, i + 2); i += 1; }
    else if (line[i] === "%") break;
    else result += line[i];
  }
  return result;
}).join("\n");

// Source shown as an example is not the file's own structure: a chapter that
// prints a complete "\documentclass … \begin{document}" listing is still a
// fragment. Drop verbatim-like material before looking for the real preamble.
const VERBATIM_ENV = "(?:[A-Za-z@]*[Vv]erbatim[A-Za-z@*]*|lstlisting\\*?|minted\\*?|[A-Za-z@]*[Ll]isting[A-Za-z@*]*|filecontents\\*?|comment|luacode\\*?)";
const verbatimEnvironment = new RegExp(`^\\s*\\{(${VERBATIM_ENV})\\}`);
const skipGroup = (source, start, open, close) => {
  let depth = 1;
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return i + 1;
  }
  return source.length;
};

// Strip comments and literal examples in a single pass. A percent sign in a
// verbatim example is printed; it cannot comment out the real input after it.
const activeTexSource = (source) => {
  source = String(source ?? "");
  const tokens = /\\(?:[A-Za-z@]+|[\s\S])|%/g;
  let text = "", start = 0, token;
  while ((token = tokens.exec(source))) {
    const command = token[0];
    let end = tokens.lastIndex;
    if (command === "%") {
      const newline = source.indexOf("\n", end);
      end = newline < 0 ? source.length : newline;
    } else if (command === "\\begin") {
      const env = verbatimEnvironment.exec(source.slice(end));
      if (!env) continue;
      const close = new RegExp(`\\\\end\\s*\\{${env[1].replace(/\*/g, "\\*")}\\}`, "g");
      close.lastIndex = end + env[0].length;
      end = close.exec(source) ? close.lastIndex : source.length;
    } else if (command === "\\KKcodeS") {
      const close = source.indexOf("\\KKcodeE", end);
      end = close < 0 ? source.length : close + "\\KKcodeE".length;
    } else if (["\\verb", "\\lstinline", "\\mintinline", "\\KKverb"].includes(command)) {
      if (source[end] === "*") end++;
      if (command === "\\lstinline" || command === "\\mintinline") {
        if (source[end] === "[") end = skipGroup(source, end, "[", "]");
        if (command === "\\mintinline" && source[end] === "{") end = skipGroup(source, end, "{", "}");
      }
      const delimiter = source[end];
      if (!delimiter || /\s/u.test(delimiter)) continue;
      if ((command === "\\mintinline" || command === "\\lstinline") && delimiter === "{") {
        end = skipGroup(source, end, "{", "}");
      } else {
        const close = source.indexOf(delimiter, end + 1);
        const newline = source.indexOf("\n", end + 1);
        end = close >= 0 && (newline < 0 || close < newline) ? close + 1 : newline >= 0 ? newline : source.length;
      }
    } else if (command !== "\\\\") {
      continue;
    }
    text += source.slice(start, token.index) + source.slice(token.index, end).replace(/[^\r\n]/g, " ");
    start = end;
    tokens.lastIndex = end;
  }
  return text + source.slice(start);
};

const isStandaloneDocument = (content) => {
  const source = activeTexSource(content);
  const documentClass = /\\document(?:class|style)\s*(?:\[[^\]]*\])?\s*\{/.exec(source);
  if (!documentClass) return false;
  const body = /\\begin\s*\{document\}/.exec(source);
  if (!body || body.index < documentClass.index) return false;
  // A document starts with its class. Body material before \documentclass
  // (headings, environments) means the class line is quoted text.
  return !/\\(?:begin\s*\{|part\b|chapter\b|(?:sub)*section\b|input\b|include\b)/.test(source.slice(0, documentClass.index));
};

const parseTexIncludes = (content, { masked = false, withPosition = false, wholeLine = false } = {}) => {
  const source = masked ? content : activeTexSource(content);
  const pattern = /\\(input|include|subfile|subfileinclude|InputIfFileExists)\s*\{([^}]*)\}|\\(input)\s+([^\s{}\\%]+)|\\((?:sub)?(?:import|includefrom|inputfrom))\s*\*?\s*\{([^}]*)\}\s*\{([^}]*)\}/g;
  const matches = Array.from(source.matchAll(pattern));
  if (wholeLine && (matches.length !== 1 || source.trim() !== matches[0][0])) return [];
  return matches.map(match => {
    const entry = match[5]
      ? { kind: match[5], directory: match[6].trim(), file: match[7].trim() }
      : { kind: match[1] || match[3], file: (match[2] ?? match[4]).trim() };
    if (withPosition) entry.offset = match.index;
    return entry;
  });
};

// Build, the AI document map and source ownership use the same ordered search.
const includeCandidates = (include, file, base, mainDir) => {
  const subfile = include.kind.startsWith("subfile");
  const dir = include.directory !== undefined
    ? path.posix.join(include.kind.startsWith("sub") ? base : mainDir, include.directory)
    : subfile ? path.posix.dirname(file) : base;
  const withExt = name => path.posix.extname(name) ? name : `${name}.tex`;
  const candidates = [withExt(path.posix.join(dir, include.file))];
  if (include.directory === undefined && !subfile) candidates.push(withExt(path.posix.normalize(include.file)));
  return [...new Set(candidates)].map(candidate => ({
    file: candidate,
    base: include.directory !== undefined || subfile ? path.posix.dirname(candidate) : base,
  }));
};

// Follow TeX's search directory through plain includes and imported/subfile trees.
const findTexIncludeBase = async (document, requested, read) => {
  const cwd = path.posix.dirname(document);
  if (document === requested) return cwd;
  const queue = [{ file: document, base: cwd, depth: 0 }];
  const visited = new Set();
  for (let index = 0; index < queue.length && visited.size < 2000; index++) {
    const entry = queue[index];
    const key = entry.file + "\0" + entry.base;
    if (visited.has(key) || entry.depth > 16) continue;
    visited.add(key);
    for (const include of parseTexIncludes(await read(entry.file))) {
      for (const child of includeCandidates(include, entry.file, entry.base, cwd)) {
        if (await read(child.file) === null) continue;
        if (child.file === requested) return child.base;
        queue.push({ ...child, depth: entry.depth + 1 });
        break;
      }
    }
  }
  return null;
};

// Resolve ownership, not a filename ranking. An independent document wins over
// the workspace default; fragments follow their including document. Ambiguity
// requires an explicit magic root instead of silently compiling another PDF.
const resolveBuildTarget = async (workspace, requestedPath, options = {}) => {
  const root = workspace.getRootPath();
  const normalize = (file) => path.relative(root, workspace.resolvePath(file)).split(path.sep).join("/");
  const current = () => { if (workspace.getRootPath() !== root) throw new Error("Workspace changed."); };
  const readCache = new Map();
  const read = async (file) => {
    current();
    file = normalize(file); // retain WorkspaceManager's realpath/symlink guard
    if (!readCache.has(file)) readCache.set(file, workspace.readFile(file).catch(() => null));
    const content = await readCache.get(file);
    current();
    return content;
  };
  const rootInfo = await workspace.rootInfo().catch(() => null);
  const rootFile = rootInfo?.path;
  // A root the user set (Settings › Main TeX) decides ties; an auto-detected
  // one is a guess among the workspace's documents and does not.
  const rootIsManual = rootInfo?.source === "manual";
  current();
  // Every standalone document in the workspace (has \documentclass and
  // \begin{document}), for the cases where nothing names the target.
  const standaloneDocuments = async () => {
    const found = [];
    for (const candidate of await workspace.listFiles()) {
      if (!/\.tex$/i.test(candidate)) continue;
      if (isStandaloneDocument(await read(candidate))) found.push(candidate);
    }
    return found;
  };
  const choose = (candidates, requested) => {
    const error = new Error(requested
      ? `Several documents could be built for ${requested}. Choose one.`
      : "Several documents could be built. Choose one.");
    error.code = BUILD_TARGET_CHOICE;
    error.candidates = candidates;
    error.requested = requested || null;
    throw error;
  };
  if (!requestedPath || !/\.tex$/i.test(requestedPath)) {
    if (options.includingDocuments) return [];
    if (rootFile && rootIsManual) return rootFile;
    if (await read("main.tex") !== null) return "main.tex";
    const documents = await standaloneDocuments();
    if (documents.length === 1) return documents[0];
    if (documents.length > 1) choose(documents, null);
    return rootFile || "main.tex";
  }
  const requested = normalize(requestedPath);
  const source = await read(requested);
  if (source === null) throw new Error(`File not found: ${requested}`);
  if (!options.includingDocuments) {
    const magic = await workspace.resolveTexRootFromMagic(requested);
    current();
    if (magic) {
      options.onMagicRoot?.();
      return normalize(magic);
    }
    if (requested === rootFile) return requested;
  }

  const includes = async (document) => (await findTexIncludeBase(document, requested, async (file) => {
    try { return await read(file); } catch { current(); return null; }
  })) !== null;
  if (options.includingDocuments === true) {
    // Every other document that reads this file, whether or not the file
    // could also be built on its own (a subfiles chapter can).
    const including = [];
    for (const candidate of await standaloneDocuments()) {
      if (candidate !== requested && await includes(candidate)) including.push(candidate);
    }
    return including;
  }
  if (rootFile && rootIsManual && await includes(rootFile)) return rootFile;
  if (isStandaloneDocument(source)) return requested;
  const owners = [];
  for (const candidate of await standaloneDocuments()) {
    if (candidate === requested) continue;
    if (await includes(candidate)) owners.push(candidate);
  }
  // Two documents include the fragment: the caller asks which one to build
  // (a % !TEX root line in the fragment, or Settings › Main TeX, settles it).
  if (owners.length > 1) choose(owners, requested);
  if (owners.length === 1) return owners[0];
  if (rootFile) return rootFile;
  // Nothing includes the fragment and no root is set: the workspace's only
  // document is the best guess; several documents are a choice, none means
  // the fragment itself (its own error says what is missing).
  const documents = await standaloneDocuments();
  if (documents.length === 1) return documents[0];
  if (documents.length > 1) choose(documents, requested);
  return requested;
};

/** The other documents of the workspace that \\input / \\include / \\subfile this file. */
const resolveIncludingDocuments = (workspace, requestedPath) =>
  resolveBuildTarget(workspace, requestedPath, { includingDocuments: true });

module.exports = { BUILD_TARGET_CHOICE, resolveBuildTarget, resolveIncludingDocuments, stripTexComments, activeTexSource, isStandaloneDocument, parseTexIncludes, includeCandidates, findTexIncludeBase };

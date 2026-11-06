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

const isStandaloneDocument = (content) => {
  const source = stripTexComments(content);
  return /\\document(?:class|style)\s*(?:\[[^\]]*\])?\s*\{/.test(source)
    && /\\begin\s*\{document\}/.test(source);
};

const parseTexIncludes = (content) => {
  const source = stripTexComments(content);
  const result = [];
  for (const match of source.matchAll(/\\(input|include|subfile|subfileinclude)\s*\{([^}]*)\}|\\(input)\s+([^\s{}\\%]+)/g)) {
    result.push({ kind: match[1] || match[3], file: (match[2] || match[4]).trim() });
  }
  for (const match of source.matchAll(/\\((?:sub)?(?:import|includefrom|inputfrom))\s*\*?\s*\{([^}]*)\}\s*\{([^}]*)\}/g)) {
    result.push({ kind: match[1], directory: match[2].trim(), file: match[3].trim() });
  }
  return result;
};

// Resolve ownership, not a filename ranking. An independent document wins over
// the workspace default; fragments follow their including document. Ambiguity
// requires an explicit magic root instead of silently compiling another PDF.
const resolveBuildTarget = async (workspace, requestedPath) => {
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
  const magic = await workspace.resolveTexRootFromMagic(requested);
  current();
  if (magic) return normalize(magic);
  if (requested === rootFile) return requested;

  const includes = async (document) => {
    const cwd = path.posix.dirname(document);
    const queue = [{ file: document, base: cwd, depth: 0 }];
    const visited = new Set();
    while (queue.length && visited.size < 2000) {
      const entry = queue.shift();
      const key = `${entry.file}\0${entry.base}`;
      if (visited.has(key) || entry.depth > 16) continue;
      visited.add(key);
      for (const include of parseTexIncludes(await read(entry.file))) {
        // Plain input is relative to the build/import directory, not the
        // including file. import/subimport and subfiles establish a new base.
        const base = include.directory !== undefined
          ? path.posix.join(include.kind.startsWith("sub") ? entry.base : cwd, include.directory)
          : include.kind.startsWith("subfile") ? path.posix.dirname(entry.file) : entry.base;
        // TeX64 runs TeX from the workspace root with the main file's folder
        // on TEXINPUTS, so a plain \input resolves against either.
        const withExt = (file) => (path.posix.extname(file) ? file : `${file}.tex`);
        const tries = [withExt(path.posix.join(base, include.file))];
        if (include.directory === undefined && !include.kind.startsWith("subfile")) tries.push(withExt(include.file));
        let candidate = null;
        for (const attempt of tries) {
          try {
            const normalized = normalize(attempt);
            if (await read(normalized) !== null) { candidate = normalized; break; }
          } catch { current(); }
        }
        if (!candidate) continue;
        if (candidate === requested) return true;
        queue.push({
          file: candidate,
          base: include.directory !== undefined || include.kind.startsWith("subfile")
            ? path.posix.dirname(candidate) : entry.base,
          depth: entry.depth + 1,
        });
      }
    }
    return false;
  };
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

module.exports = { BUILD_TARGET_CHOICE, resolveBuildTarget, stripTexComments, isStandaloneDocument, parseTexIncludes };

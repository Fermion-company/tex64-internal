"use strict";

const path = require("node:path");
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
  const rootFile = (await workspace.rootInfo().catch(() => null))?.path;
  current();
  if (!requestedPath || !/\.tex$/i.test(requestedPath)) return rootFile || "main.tex";
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
        let candidate = path.posix.join(base, include.file);
        if (!path.posix.extname(candidate)) candidate += ".tex";
        try {
          candidate = normalize(candidate);
          if (await read(candidate) === null) continue;
        } catch { current(); continue; }
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
  if (rootFile && await includes(rootFile)) return rootFile;
  if (isStandaloneDocument(source)) return requested;
  const owners = [];
  for (const candidate of await workspace.listFiles()) {
    if (!/\.tex$/i.test(candidate) || candidate === requested || candidate === rootFile) continue;
    if (isStandaloneDocument(await read(candidate)) && await includes(candidate)) owners.push(candidate);
  }
  if (owners.length > 1) throw new Error(`Multiple documents include ${requested}. Set % !TEX root = path/to/main.tex in that file.`);
  return owners[0] || rootFile || requested;
};

module.exports = { resolveBuildTarget, stripTexComments, isStandaloneDocument, parseTexIncludes };

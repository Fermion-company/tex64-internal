// A line that only reads another file (\input{ch/one}, \include, \subfile)
// prints nothing itself: what the reader means by a Jump from it is the
// start of that file. SyncTeX has no record for the line, and its nearest
// one is the end of the chapter before, pages away once the new chapter
// opens on a fresh page.

const fs = require("fs");
const path = require("path");

const { activeTexSource, parseTexIncludes, includeCandidates, findTexIncludeBase } = require("./tex-build-target.cjs");

const isInside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

const projectFile = (root, relativePath) => {
  const file = path.resolve(root, relativePath);
  if (!isInside(root, file) || !isInside(fs.realpathSync(root), fs.realpathSync(file))) return null;
  return file;
};

/** 1-based number of the first line of `text` that prints something: after
 * \begin{document} in a chapter that is a document of its own, past blank
 * lines and comments. */
const firstContentLine = (text) => {
  const lines = String(text).split(/\r?\n/);
  let from = 0;
  const begin = lines.findIndex((line) => /^[^%]*\\begin\s*\{document\}/.test(line));
  if (begin >= 0 && lines.slice(0, begin).some((line) => /^[^%]*\\documentclass\b/.test(line))) from = begin + 1;
  for (let i = from; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && !trimmed.startsWith("%")) return i + 1;
  }
  return Math.min(lines.length, from + 1) || 1;
};

const includeOnLine = (root, file, line) => {
  if (!root || typeof file !== "string") return null;
  try {
    const source = projectFile(root, file);
    if (!source) return null;
    const text = fs.readFileSync(source, "utf8");
    const code = activeTexSource(text).split(/\r?\n/)[Number(line) - 1] ?? "";
    const [include] = parseTexIncludes(code, { masked: true, wholeLine: true });
    if (!include || /[\\#]/.test(include.file + (include.directory ?? ""))) return null;
    return include;
  } catch { return null; }
};

const targetAtBase = (root, file, include, base, mainDir) => {
  for (const candidate of includeCandidates(include, file, base, mainDir)) {
    try {
      const child = projectFile(root, candidate.file);
      if (!child || !/\.tex$/i.test(child) || !fs.statSync(child).isFile()) continue;
      return { path: candidate.file, line: firstContentLine(fs.readFileSync(child, "utf8")) };
    } catch { /* try the remaining TeX search paths */ }
  }
  return null;
};

// For callers working with a standalone source, its folder is the engine's cwd.
const resolveInputLineTarget = (root, file, line) => {
  const include = includeOnLine(root, file, line);
  if (!include) return null;
  const dir = path.posix.dirname(file);
  return targetAtBase(root, file, include, dir, dir);
};

const resolveDocumentInputLineTarget = async (root, file, line, getDocument) => {
  const include = includeOnLine(root, file, line);
  if (!include) return null;
  const document = getDocument();
  if (!document) return null;
  const sources = new Map();
  const read = async (name) => {
    if (!sources.has(name)) {
      try {
        const source = projectFile(root, name);
        sources.set(name, source ? await fs.promises.readFile(source, "utf8") : null);
      } catch { sources.set(name, null); }
    }
    return sources.get(name);
  };
  const base = await findTexIncludeBase(document, file, read);
  return base === null ? null : targetAtBase(root, file, include, base, path.posix.dirname(document));
};

module.exports = { resolveInputLineTarget, resolveDocumentInputLineTarget, firstContentLine };

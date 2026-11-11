// A line that only reads another file (\input{ch/one}, \include, \subfile)
// prints nothing itself: what the reader means by a Jump from it is the
// start of that file. SyncTeX has no record for the line, and its nearest
// one is the end of the chapter before, pages away once the new chapter
// opens on a fresh page.

const fs = require("fs");
const path = require("path");

const READS_FILE = /^\s*\\(input|include|subfile|subfileinclude)\s*\{([^{}]+)\}\s*(?:%.*)?$/;

const isInside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
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

/**
 * Where a Jump from line `line` of `relativePath` should look instead, or
 * null when that line does not read a file of the project.
 * Returns { path, line } with a workspace-relative path.
 */
const resolveInputLineTarget = (rootPath, relativePath, line) => {
  try {
    if (!rootPath || typeof relativePath !== "string") return null;
    const source = path.resolve(rootPath, relativePath);
    if (!isInside(rootPath, source)) return null;
    const lineNumber = Number.parseInt(line, 10);
    if (!Number.isFinite(lineNumber) || lineNumber < 1) return null;
    const text = fs.readFileSync(source, "utf8").split(/\r?\n/)[lineNumber - 1];
    const match = typeof text === "string" ? READS_FILE.exec(text) : null;
    if (!match) return null;
    const name = match[2].trim();
    if (!name || /[\\#]/.test(name)) return null;
    // TeX looks from the document's folder; \subfile from the file it is in.
    const bases = [path.dirname(source), rootPath];
    for (const base of bases) {
      for (const candidate of [name, `${name}.tex`]) {
        const file = path.resolve(base, candidate);
        if (!isInside(rootPath, file) || !/\.tex$/i.test(file)) continue;
        let stat = null;
        try { stat = fs.statSync(file); } catch { stat = null; }
        if (!stat?.isFile()) continue;
        return {
          path: path.relative(rootPath, file).split(path.sep).join("/"),
          line: firstContentLine(fs.readFileSync(file, "utf8")),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
};

module.exports = { resolveInputLineTarget, firstContentLine };

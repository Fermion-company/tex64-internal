// A line that only reads another file (\input{ch/one}, \include, \subfile)
// prints nothing itself: what the reader means by a Jump from it is the
// start of that file. SyncTeX has no record for the line, and its nearest
// one is the end of the chapter before, pages away once the new chapter
// opens on a fresh page.

const fs = require("fs");
const path = require("path");

const READS_FILE = /^\s*\\(input|include|subfile|subfileinclude)\s*\{([^{}]+)\}\s*(?:%.*)?$/;
// \import{dir}{file} and kin (import package): the file is read from `dir`.
const READS_IMPORT = /^\s*\\((?:sub)?(?:import|includefrom|inputfrom))\s*\*?\s*\{([^{}]*)\}\s*\{([^{}]+)\}\s*(?:%.*)?$/;

const isInside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

// Inside the project by its real path too: a symlink out of the workspace is
// not a project file.
const projectFile = (root, file) => {
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

/**
 * Where a Jump from line `line` of `relativePath` should look instead, or
 * null when that line does not read a file of the project.
 * Returns { path, line } with a workspace-relative path.
 *
 * `includes`: what this file reads as the Build of its document resolves it
 * (tex-build-target.cjs resolveIncludesOf: the document's own folder, the
 * bases \import, \subimport and \subfile set). Without it the name is looked
 * for beside this file and at the workspace root, which picks the wrong file
 * when the document sits in a sub-folder or reads this file through \import.
 */
const resolveInputLineTarget = (rootPath, relativePath, line, { lineText = null, includes = null } = {}) => {
  try {
    if (!rootPath || typeof relativePath !== "string") return null;
    const source = path.resolve(rootPath, relativePath);
    if (!isInside(rootPath, source)) return null;
    if (typeof lineText !== "string" && !projectFile(rootPath, source)) return null;
    const lineNumber = Number.parseInt(line, 10);
    if (!Number.isFinite(lineNumber) || lineNumber < 1) return null;
    // the line as the editor has it (the caret's line number is the buffer's)
    const text = typeof lineText === "string"
      ? lineText
      : fs.readFileSync(source, "utf8").split(/\r?\n/)[lineNumber - 1];
    const imported = typeof text === "string" ? READS_IMPORT.exec(text) : null;
    const match = imported ? null : typeof text === "string" ? READS_FILE.exec(text) : null;
    if (!match && !imported) return null;
    // (none known: the document's Build never reaches this file, so there is
    // no base to go by but the old guess below)
    if (Array.isArray(includes) && includes.length > 0) {
      const kind = (imported ?? match)[1];
      const directory = imported ? imported[2].trim() : undefined;
      const written = (imported ? imported[3] : match[2]).trim();
      const edge = includes.find((entry) => entry && entry.kind === kind && String(entry.file).trim() === written &&
        (entry.directory === undefined ? directory === undefined : String(entry.directory).trim() === directory));
      if (!edge || typeof edge.target !== "string") return null;
      const file = path.resolve(rootPath, edge.target);
      if (!/\.tex$/i.test(file) || !projectFile(rootPath, file)) return null;
      return {
        path: path.relative(rootPath, file).split(path.sep).join("/"),
        line: firstContentLine(fs.readFileSync(file, "utf8")),
      };
    }
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
        try { stat = projectFile(rootPath, file) && fs.statSync(file); } catch { stat = null; }
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

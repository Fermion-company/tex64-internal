/**
 * Append a BibTeX entry to the document's bibliography file.
 *
 * The target is the first file named by \addbibresource / \bibliography in
 * the main file (or in a file it \input/\include-s directly). Without one,
 * the workspace's only .bib is used; with none, `references.bib` next to the
 * main file is created. In both cases the document does not load the file,
 * so `referenced:false` and the lines to add come back as `suggestion`
 * (the document itself is left alone). An entry whose key already
 * exists is not appended.
 */

"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const { BIB_RESOURCE_PATTERN, stripComment } = require("./agent-document-map.cjs");
const { resolveBuildTarget, parseTexIncludes } = require("./tex-build-target.cjs");

const DEFAULT_BIB = "references.bib";

const normalizeRelative = (value) =>
  String(value || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");

const withBibExt = (target) => (/\.bib$/i.test(target) ? target : `${target}.bib`);

/** The bib resources a TeX source names, in order, comments removed. */
const bibResourcesOf = (content) => {
  const names = [];
  for (const line of String(content || "").split(/\r?\n/)) {
    for (const match of stripComment(line).matchAll(BIB_RESOURCE_PATTERN)) {
      for (const name of match[1].split(",")) {
        const cleaned = normalizeRelative(name);
        if (cleaned) names.push(cleaned);
      }
    }
  }
  return names;
};

/** Whether a BibTeX source already defines `key`. */
const hasBibKey = (content, key) => {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*@[A-Za-z]+\\s*[{(]\\s*${escaped}\\s*,`, "m").test(String(content || ""));
};

const readOrNull = (workspace, relativePath) => workspace.readFile(relativePath).catch(() => null);

const stripComments = (content) => String(content || "").split(/\r?\n/).map(stripComment).join("\n");

const listBibFiles = async (workspace) => {
  try {
    const files = await workspace.listFiles();
    return files.filter((file) => typeof file === "string" && /\.bib$/i.test(file)).map(normalizeRelative);
  } catch {
    return [];
  }
};

/** The main file of the document that contains `activeFilePath`. */
const resolveMainFile = async (workspace, activeFilePath) => {
  const active = normalizeRelative(activeFilePath);
  try {
    return normalizeRelative(await resolveBuildTarget(workspace, active));
  } catch {
    if (active && /\.tex$/i.test(active)) return active;
    const root = await workspace.rootInfo().catch(() => null);
    return normalizeRelative(root?.path || "main.tex");
  }
};

/**
 * Decide which .bib receives new entries.
 * Returns { bibPath, exists, mainFile } with workspace-relative paths.
 */
const resolveBibTarget = async (workspace, activeFilePath) => {
  const mainFile = await resolveMainFile(workspace, activeFilePath);
  const mainDir = path.posix.dirname(mainFile);
  const inMainDir = (file) => (mainDir === "." ? file : path.posix.join(mainDir, file));
  const sources = [mainFile];
  const mainContent = await readOrNull(workspace, mainFile);
  if (mainContent !== null) {
    for (const include of parseTexIncludes(mainContent)) {
      if (include.directory !== undefined) continue;
      let file = normalizeRelative(include.file);
      if (!path.posix.extname(file)) file += ".tex";
      sources.push(inMainDir(file));
    }
  }
  for (const source of sources.slice(0, 20)) {
    const content = source === mainFile ? mainContent : await readOrNull(workspace, source);
    if (content === null) continue;
    for (const name of bibResourcesOf(content)) {
      const file = withBibExt(name);
      // BibTeX/biber resolve relative to the build directory (the main file's).
      const candidates = [inMainDir(file), file];
      for (const candidate of candidates) {
        if ((await readOrNull(workspace, candidate)) !== null) return { bibPath: candidate, exists: true, mainFile, referenced: true };
      }
      return { bibPath: candidates[0], exists: false, mainFile, referenced: true };
    }
  }
  // No resource named: the workspace's only .bib, else a new references.bib
  // next to the main file (created when the workspace has none). Either way
  // the document does not load it yet, so say what to add.
  const existing = await listBibFiles(workspace);
  const target = existing.length === 1 ? existing[0] : inMainDir(DEFAULT_BIB);
  const biblatex = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bbiblatex\b/.test(stripComments(mainContent));
  const name = path.posix.basename(target);
  return {
    bibPath: target,
    exists: existing.includes(target),
    mainFile,
    referenced: false,
    suggestion: biblatex
      ? { place: "preamble", lines: [`\\addbibresource{${name}}`] }
      : { place: "end", lines: ["\\bibliographystyle{plain}", `\\bibliography{${name.replace(/\.bib$/i, "")}}`] },
  };
};

/**
 * Append `bibtex` (one entry with citation key `key`) to the document's bib.
 * Returns { bibPath, created, duplicate }.
 */
const appendBibEntry = async (workspace, { activeFilePath, key, bibtex }) => {
  if (!key || typeof key !== "string") throw new Error("Citation key is missing.");
  if (!bibtex || typeof bibtex !== "string") throw new Error("BibTeX entry is missing.");
  const target = await resolveBibTarget(workspace, activeFilePath);
  const existing = target.exists ? await readOrNull(workspace, target.bibPath) : null;
  const created = existing === null;
  if (!created && hasBibKey(existing, key)) {
    return { bibPath: target.bibPath, created: false, duplicate: true };
  }
  const entry = bibtex.replace(/\s+$/, "") + "\n";
  const head = created ? "" : existing.replace(/\s+$/, "");
  const next = head ? `${head}\n\n${entry}` : entry;
  if (created) await fsp.mkdir(path.dirname(workspace.resolvePath(target.bibPath)), { recursive: true });
  await workspace.writeFile(target.bibPath, next);
  return { bibPath: target.bibPath, created, duplicate: false, referenced: target.referenced !== false, ...(target.suggestion ? { suggestion: target.suggestion } : {}) };
};

module.exports = { appendBibEntry, resolveBibTarget, bibResourcesOf, hasBibKey };

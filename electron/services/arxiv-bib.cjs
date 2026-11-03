/**
 * Append a BibTeX entry to the document's bibliography file.
 *
 * The target is the first file named by \addbibresource / \bibliography in
 * the main file (or in a file it \input/\include-s directly). Without one,
 * the workspace's only .bib is used; with none, `references.bib` next to the
 * main file is created. In both cases the document does not load the file,
 * so `referenced:false` and the lines to add come back as `suggestion`
 * (the document itself is left alone). A paper already in the file (same
 * arXiv id, under any key) is not appended again; a key held by another
 * paper gets a, b, … appended.
 */

"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const { BIB_RESOURCE_PATTERN, stripComment } = require("./agent-document-map.cjs");
const { parseTexIncludes } = require("./tex-build-target.cjs");
const {
  resolveCitationDocument,
  parseBibEntries,
  entryIdentity,
  placeEntry,
  renameBibKey,
} = require("./bib-append.cjs");

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

/**
 * The main file of the document that contains `activeFilePath`, as Build
 * decides it (bib-append's resolveCitationDocument); `documentMainFile`, the
 * document chosen for that file, wins. Several owning documents with
 * different .bib files are the renderer's choice (BUILD_TARGET_CHOICE).
 */
const resolveMainFile = async (workspace, activeFilePath, documentMainFile = "") => {
  try {
    return await resolveCitationDocument(
      workspace,
      { documentMainFile, activeFilePath },
      async (candidate) => (await bibTargetFor(workspace, candidate)).bibPath
    );
  } catch (error) {
    if (error?.code === "NO_MAIN_FILE" && workspace.getRootPath()) return "main.tex";
    throw error;
  }
};

/**
 * Decide which .bib receives new entries.
 * Returns { bibPath, exists, mainFile } with workspace-relative paths.
 */
const resolveBibTarget = async (workspace, activeFilePath, { documentMainFile = "" } = {}) =>
  bibTargetFor(workspace, await resolveMainFile(workspace, activeFilePath, documentMainFile));

/** The .bib target of one main file. */
const bibTargetFor = async (workspace, mainFile) => {
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
 * `target` is a resolveBibTarget result decided earlier; without it the
 * target is resolved from `activeFilePath` / `documentMainFile`. The read,
 * the check and the write hold the file's mutation queue, which the Zotero
 * append and refresh share. Returns { bibPath, created, duplicate, key,
 * bibtex } with the key and entry actually in the file.
 */
const appendBibEntry = async (workspace, { activeFilePath, documentMainFile, target: decided, key, bibtex }) => {
  if (!key || typeof key !== "string") throw new Error("Citation key is missing.");
  if (!bibtex || typeof bibtex !== "string") throw new Error("BibTeX entry is missing.");
  const target = decided || (await resolveBibTarget(workspace, activeFilePath, { documentMainFile }));
  const incoming = entryIdentity({ body: bibtex });
  return workspace.withFileMutation(target.bibPath, async () => {
    const existing = await readOrNull(workspace, target.bibPath);
    const created = existing === null;
    const placed = placeEntry(parseBibEntries(existing ?? ""), key, incoming);
    if (placed.entry) {
      return { bibPath: target.bibPath, created: false, duplicate: true, key: placed.key, bibtex: placed.entry.body };
    }
    const written = renameBibKey(bibtex, placed.key).replace(/\s+$/, "");
    const entry = `${written}\n`;
    const head = created ? "" : existing.replace(/\s+$/, "");
    const next = head ? `${head}\n\n${entry}` : entry;
    if (created) await fsp.mkdir(path.dirname(workspace.resolvePath(target.bibPath)), { recursive: true });
    await workspace.writeFile(target.bibPath, next);
    return {
      bibPath: target.bibPath,
      created,
      duplicate: false,
      key: placed.key,
      bibtex: written,
      referenced: target.referenced !== false,
      ...(target.suggestion ? { suggestion: target.suggestion } : {}),
    };
  });
};

module.exports = { appendBibEntry, resolveBibTarget, bibResourcesOf, hasBibKey };

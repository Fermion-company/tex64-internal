/**
 * Document map — one deterministic scan of the paper the agent works on.
 *
 * The map is what a careful co-author keeps in their head: which files make
 * up the document, where every section starts and ends, which labels, figures
 * and citations exist, and which bib files hold the entries. It is computed
 * from workspace files and any current editor drafts, handed to the model with every turn
 * so it edits by section instead of re-reading whole files, and reused by the
 * consistency tools (check_references / check_bibliography) and the @ picker.
 */

"use strict";

const path = require("path");
const fsp = require("fs/promises");
const crypto = require("crypto");

// Keep the optional prompt profile within its former memory ceiling.
const MAX_PROFILE_BYTES = 80 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 6_000;

const { activeTexSource, parseTexIncludes, includeCandidates } = require("./tex-build-target.cjs");
const { parseLatexStructure, cleanTitle } = require("./agent-tools-latex.cjs");
const BIB_RESOURCE_PATTERN = /\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const LABEL_PATTERN = /\\label\s*\{([^}]+)\}/g;
const REF_PATTERN =
  /\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref|vref|Vref|labelcref|zref)\*?\s*\{([^}]+)\}/g;
const HYPERREF_PATTERN = /\\hyperref\s*\[([^\]]+)\]/g;
const CITE_PATTERN =
  /\\(?:[cC]ite(?:p|t|author|year|yearpar|alp|alt|num|title)?|parencite|textcite|autocite|footcite|footfullcite|fullcite|smartcite|supercite|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]+)\}/g;
const GRAPHICS_PATTERN = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const GRAPHICS_PATH_PATTERN = /\\graphicspath\s*\{((?:\s*\{[^}]*\}\s*)+)\}/g;
const CAPTION_PATTERN = /\\caption\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/;
const FLOAT_BEGIN_PATTERN = /\\begin\{(figure|table|algorithm|listing)\*?\}/;
const FLOAT_END_PATTERN = /\\end\{(figure|table|algorithm|listing)\*?\}/;
const MATH_ENV_PATTERN =
  /\\begin\{(equation|align|gather|multline|eqnarray|flalign|alignat)\*?\}/;
const GRAPHIC_EXTENSIONS = ["", ".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg", ".tikz"];

const stripComment = (line) => {
  let out = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\") {
      out += ch + (line[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === "%") break;
    out += ch;
  }
  return out;
};

const splitKeys = (raw) =>
  String(raw || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

const normalizeRelative = (value) =>
  String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/");

// Read and compile the same document: AI's paper has an explicit target;
// Code follows the same standalone/chapter/magic-root decision as Build.
const resolveMainTexFile = async (service, context) => {
  try {
    const target = context?.documentMainFile ||
      await service.workspace.resolveBuildTarget(context?.activeFilePath || null);
    if (!target || !/\.tex$/i.test(target)) return null;
    const resolved = service.workspace.resolvePath(target);
    if (!(await fsp.stat(resolved)).isFile()) return null;
    return normalizeRelative(path.relative(service.workspace.getRootPath(), resolved));
  } catch {
    // A missing file or an ambiguous chapter has no authoritative map.
    return null;
  }
};

const readWorkspaceText = async (service, relativePath, getSnapshot) => {
  try {
    const resolved = service.workspace.resolvePath(relativePath);
    const draft = getSnapshot?.(relativePath);
    if (draft?.isDirty) return draft.contentLength > MAX_FILE_BYTES ? null : draft.content;
    const stat = await fsp.stat(resolved);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return await fsp.readFile(resolved, "utf8");
  } catch {
    return null;
  }
};

const fileExists = async (service, relativePath) => {
  try {
    const resolved = service.workspace.resolvePath(relativePath);
    const stat = await fsp.stat(resolved);
    return stat.isFile();
  } catch {
    return false;
  }
};

/** Section outline of one .tex source, from the shared LaTeX parser. */
const mapOutline = (structure) => structure.nodes.map((node) => ({
  id: node.id,
  type: node.type,
  level: node.level,
  title: cleanTitle(node.title),
  line: node.headerLine,
  startLine: node.startLine,
  endLine: node.endLine,
}));
const outlineOf = (content) => mapOutline(parseLatexStructure(content));

const scanTexFile = (relativePath, content) => {
  const masked = activeTexSource(content);
  const structure = parseLatexStructure(content, masked);
  const active = masked.slice(0, structure.docEnd);
  const lines = active.split(/\r?\n/);
  const labels = [];
  const refs = [];
  const cites = [];
  const graphics = [];
  let previousOffset = 0;
  let includeLine = 1;
  const includes = parseTexIncludes(active, { masked: true, withPosition: true }).map(({ offset, ...entry }) => {
    for (let i = previousOffset; i < offset; i++) if (active[i] === "\n") includeLine++;
    previousOffset = offset;
    return { ...entry, target: entry.file, line: includeLine };
  });
  const bibResources = [];
  const bibItems = [];
  const floats = [];
  const graphicsPaths = [];
  let mathEnvironments = 0;
  let openFloat = null;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    for (const match of line.matchAll(LABEL_PATTERN)) {
      labels.push({ key: match[1].trim(), line: lineNumber });
    }
    for (const match of line.matchAll(REF_PATTERN)) {
      splitKeys(match[1]).forEach((key) => refs.push({ key, line: lineNumber }));
    }
    for (const match of line.matchAll(HYPERREF_PATTERN)) {
      refs.push({ key: match[1].trim(), line: lineNumber });
    }
    for (const match of line.matchAll(CITE_PATTERN)) {
      splitKeys(match[1]).forEach((key) => cites.push({ key, line: lineNumber }));
    }
    for (const match of line.matchAll(GRAPHICS_PATTERN)) {
      graphics.push({ target: match[1].trim(), line: lineNumber });
    }
    for (const match of line.matchAll(GRAPHICS_PATH_PATTERN)) {
      for (const dir of match[1].matchAll(/\{([^}]*)\}/g)) {
        graphicsPaths.push(normalizeRelative(dir[1]));
      }
    }
    for (const match of line.matchAll(BIB_RESOURCE_PATTERN)) {
      splitKeys(match[1]).forEach((target) => bibResources.push({ target, line: lineNumber }));
    }
    for (const match of line.matchAll(/\\bibitem\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)) {
      bibItems.push({ key: match[1].trim(), line: lineNumber, title: "", type: "bibitem", fields: [] });
    }
    if (MATH_ENV_PATTERN.test(line)) mathEnvironments += 1;
    const floatBegin = line.match(FLOAT_BEGIN_PATTERN);
    if (floatBegin) {
      openFloat = { kind: floatBegin[1], line: lineNumber, caption: "", label: "" };
    }
    if (openFloat) {
      const caption = line.match(CAPTION_PATTERN);
      if (caption && !openFloat.caption) openFloat.caption = cleanTitle(caption[1]).slice(0, 80);
      const label = line.match(/\\label\s*\{([^}]+)\}/);
      if (label && !openFloat.label) openFloat.label = label[1].trim();
      if (FLOAT_END_PATTERN.test(line)) {
        floats.push(openFloat);
        openFloat = null;
      }
    }
  });
  return {
    path: relativePath,
    lines: structure.total,
    sections: mapOutline(structure),
    labels,
    refs,
    cites,
    graphics,
    graphicsPaths,
    includes,
    bibResources,
    bibItems,
    floats,
    mathEnvironments,
    hasDocumentEnv: /\\begin\{document\}/.test(active),
  };
};

const scanBibFile = (relativePath, content) => {
  // The import and citation tools already parse nested groups, quoted fields
  // and multiple fields on one line. Use their entry offsets for the picker.
  const { parseBibEntries, bibFields } = require("./bib-append.cjs");
  const entries = [];
  let line = 1;
  let previousOffset = 0;
  for (const entry of parseBibEntries(content)) {
    for (let i = previousOffset; i < entry.bodyStart; i++) if (content[i] === "\n") line++;
    previousOffset = entry.bodyStart;
    const lineStart = content.lastIndexOf("\n", entry.bodyStart - 1) + 1;
    if (content.slice(lineStart, entry.bodyStart).trimStart().startsWith("%")) continue;
    if (entry.type === "string" || entry.type === "preamble") continue;
    const fields = bibFields(entry.body);
    entries.push({ key: entry.key, type: entry.type, line, fields: [...fields.keys()],
      title: cleanTitle(fields.get("title") ?? "").slice(0, 80) });
  }
  return { path: relativePath, entries };
};

/**
 * Scan the whole document starting at its main file. Follows \input and
 * \include, reads the bib files it names plus any other .bib in the
 * workspace, and returns everything the prompt, tools and pickers need.
 */
const scanDocument = async (service, mainFile, { includeWorkspaceBibs = false, includeProfile = true, getSnapshot } = {}) => {
  const partialDrafts = new Set();
  const unreadFiles = new Set();
  const readSource = (file) => readWorkspaceText(service, file, path => {
    const snapshot = getSnapshot?.(path);
    if (snapshot?.isDirty && (snapshot.truncated || snapshot.contentLength > MAX_FILE_BYTES)) partialDrafts.add(path);
    return snapshot;
  });
  const main = normalizeRelative(mainFile);
  if (!main) return null;
  const texFiles = [];
  let profileSources = includeProfile ? [] : null;
  let profileBytes = 0;
  const workspaceRoot = service.workspace.getRootPath?.();
  const generation = service.workspace.rootGeneration;
  const assertCurrent = () => {
    if (service.workspace.getRootPath?.() !== workspaceRoot || service.workspace.rootGeneration !== generation) {
      throw new Error("Workspace changed during the document scan.");
    }
  };
  const mainDir = path.posix.dirname(main);
  const queue = [{ file: main, base: mainDir }];
  const visited = new Set();
  const scannedFiles = new Map();
  for (let i = 0; i < queue.length; i++) {
    assertCurrent();
    const { file, base } = queue[i];
    const key = file + "\0" + base;
    if (visited.has(key)) continue;
    visited.add(key);
    let scanned = scannedFiles.get(file);
    if (!scanned) {
      const content = await readSource(file);
      if (content === null) { unreadFiles.add(file); continue; }
      scanned = scanTexFile(file, content);
      scannedFiles.set(file, scanned);
      texFiles.push(scanned);
      if (profileSources) {
        profileBytes += Buffer.byteLength(content, "utf8");
        if (profileBytes <= MAX_PROFILE_BYTES) profileSources.push({ path: file, content });
        else profileSources = null;
      }
    }
    for (const include of scanned.includes) {
      for (const child of includeCandidates(include, file, base, mainDir)) {
        if (await fileExists(service, child.file)) {
          queue.push(child);
          break;
        }
      }
    }
  }
  assertCurrent();

  const bibCandidates = new Set();
  for (const file of texFiles) {
    for (const resource of file.bibResources) {
      const cleaned = normalizeRelative(resource.target);
      if (!cleaned) continue;
      const withExt = cleaned.toLowerCase().endsWith(".bib") ? cleaned : `${cleaned}.bib`;
      const directories = new Set([mainDir, ".", path.posix.dirname(file.path)]);
      for (const directory of directories) {
        const candidate = path.posix.join(directory, withExt);
        if (await fileExists(service, candidate)) {
          bibCandidates.add(candidate);
          break;
        }
      }
    }
  }
  const bibFiles = [];
  const otherBibFiles = [];
  const readBib = async (candidate, destination) => {
    const content = await readSource(candidate);
    if (content !== null) destination.push(scanBibFile(candidate, content));
    else if (destination === bibFiles) unreadFiles.add(candidate);
  };
  for (const candidate of bibCandidates) {
    assertCurrent();
    await readBib(candidate, bibFiles);
  }
  // Extra libraries are available to the @ picker; they are not citations
  // compiled into the current document and cannot satisfy a missing key.
  if (includeWorkspaceBibs) {
    const listed = await service.workspace.listFiles().catch(() => []);
    for (const file of listed) {
      assertCurrent();
      if (typeof file === "string" && /\.bib$/i.test(file) && !bibCandidates.has(normalizeRelative(file))) {
        await readBib(normalizeRelative(file), otherBibFiles);
      }
    }
  }

  assertCurrent();
  // What kind of document this is (Japanese text, teaching material), in one line.
  let profile = "";
  try {
    if (profileSources) profile = require("./agent-teaching-checks.cjs").describeProfile(profileSources);
  } catch {
    profile = "";
  }

  return {
    mainFile: main,
    files: texFiles,
    bibFiles,
    otherBibFiles,
    partialDrafts: [...partialDrafts],
    unreadFiles: [...unreadFiles],
    profile,
    scannedAt: Date.now(),
  };
};

/** The section (heading) that contains a line of a scanned file. */
const sectionAtLine = (file, line) => {
  if (!file || !Array.isArray(file.sections)) return null;
  let best = null;
  for (const section of file.sections) {
    if (section.type === "preamble" || section.type === "abstract") continue;
    if (section.line <= line && line <= section.endLine) {
      if (!best || section.level >= best.level) best = section;
    }
  }
  return best;
};

/**
 * The map as the model reads it: one line per section with its line range,
 * then labels, floats and citations per file, then the bib files.
 */
const formatDocumentMapForPrompt = (map, maxChars = MAX_PROMPT_CHARS) => {
  if (!map || !Array.isArray(map.files) || (!map.files.length && !map.unreadFiles?.length)) return "";
  const out = [];
  out.push(`DOCUMENT MAP (main file ${map.mainFile}).`);
  if (map.partialDrafts?.length) out.push("Only the available draft was scanned for: " + map.partialDrafts.join(", "));
  if (map.unreadFiles?.length) out.push("Could not scan these source files: " + map.unreadFiles.join(", "));
  if (map.profile) out.push(map.profile);
  for (const file of map.files) {
    out.push(`${file.path} (${file.lines} lines)`);
    for (const section of file.sections) {
      if (section.type === "preamble") {
        out.push(`  preamble L${section.startLine}-${section.endLine}`);
        continue;
      }
      if (section.type === "abstract") {
        out.push(`  abstract L${section.startLine}-${section.endLine}`);
        continue;
      }
      const indent = "  ".repeat(Math.min(3, Math.max(0, section.level)));
      out.push(
        `  ${indent}§${section.title || "(untitled)"} L${section.line}-${section.endLine} [id ${section.id}]`,
      );
    }
    if (file.floats.length > 0) {
      out.push(
        `  floats: ${file.floats
          .slice(0, 12)
          .map((f) => `${f.kind}@L${f.line}${f.label ? ` ${f.label}` : ""}`)
          .join(", ")}`,
      );
    }
    if (file.labels.length > 0) {
      out.push(
        `  labels: ${file.labels
          .slice(0, 40)
          .map((l) => `${l.key}@L${l.line}`)
          .join(", ")}${file.labels.length > 40 ? ", …" : ""}`,
      );
    }
    if (file.cites.length > 0) {
      const keys = [...new Set(file.cites.map((c) => c.key))];
      out.push(`  cites: ${keys.slice(0, 30).join(", ")}${keys.length > 30 ? ", …" : ""}`);
    }
    if (file.bibItems?.length) out.push(`  bibitems: ${file.bibItems.slice(0, 30).map(item => item.key).join(", ")}`);
    if (file.mathEnvironments > 0) out.push(`  display math environments: ${file.mathEnvironments}`);
  }
  for (const bib of map.bibFiles) {
    const keys = bib.entries.map((entry) => entry.key);
    out.push(
      `${bib.path}: ${keys.length} entries${keys.length > 0 ? ` (${keys.slice(0, 25).join(", ")}${keys.length > 25 ? ", …" : ""})` : ""}`,
    );
  }
  let text = out.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return text;
};

/** Compact outline of one file, attached to write results so line numbers stay known. */
const formatOutlineForResult = (content, limit = 40) => {
  const sections = outlineOf(content);
  const lines = content.split(/\r?\n/).length;
  const rows = sections
    .filter((section) => section.type !== "preamble")
    .slice(0, limit)
    .map((section) =>
      section.type === "abstract"
        ? `abstract L${section.startLine}-${section.endLine}`
        : `${"  ".repeat(Math.min(3, Math.max(0, section.level)))}${section.title || "(untitled)"} L${section.line}-${section.endLine} [id ${section.id}]`,
    );
  return { totalLines: lines, sections: rows };
};

/** A hash of every source the document is built from; equal means the PDF would be the same. */
const computeSourceFingerprint = async (service, map) => {
  const hash = crypto.createHash("sha256");
  const files = [
    ...(map?.files ?? []).map((file) => file.path),
    ...(map?.bibFiles ?? []).map((file) => file.path),
  ];
  if (files.length === 0 || map.unreadFiles?.length || map.partialDrafts?.length) return null;
  for (const relativePath of files.sort()) {
    const content = await readWorkspaceText(service, relativePath);
    if (content === null) return null;
    hash.update(relativePath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const resolveGraphicTarget = async (service, file, target) => {
  const cleaned = normalizeRelative(target);
  if (!cleaned) return false;
  const dirs = ["", ...file.graphicsPaths, path.posix.dirname(file.path)].filter(
    (dir, index, all) => all.indexOf(dir) === index,
  );
  for (const dir of dirs) {
    for (const ext of GRAPHIC_EXTENSIONS) {
      const candidate = normalizeRelative(path.posix.join(dir === "." ? "" : dir, `${cleaned}${ext}`));
      if (await fileExists(service, candidate)) return true;
    }
  }
  return false;
};

/** \label / \ref / \includegraphics consistency, deterministic. */
const checkReferences = async (service, map) => {
  const problems = [];
  const defined = new Map();
  for (const file of map.files) {
    for (const label of file.labels) {
      const existing = defined.get(label.key);
      if (existing) {
        problems.push({
          kind: "duplicate_label",
          key: label.key,
          path: file.path,
          line: label.line,
          message: `\\label{${label.key}} is also defined at ${existing.path}:${existing.line}.`,
        });
      } else {
        defined.set(label.key, { path: file.path, line: label.line });
      }
    }
  }
  const referenced = new Set();
  for (const file of map.files) {
    for (const ref of file.refs) {
      referenced.add(ref.key);
      if (!defined.has(ref.key)) {
        problems.push({
          kind: "missing_label",
          key: ref.key,
          path: file.path,
          line: ref.line,
          message: `\\ref{${ref.key}} has no matching \\label.`,
        });
      }
    }
  }
  for (const [key, where] of defined) {
    if (!referenced.has(key)) {
      problems.push({
        kind: "unused_label",
        key,
        path: where.path,
        line: where.line,
        message: `\\label{${key}} is never referenced.`,
      });
    }
  }
  for (const file of map.files) {
    for (const graphic of file.graphics) {
      if (!(await resolveGraphicTarget(service, file, graphic.target))) {
        problems.push({
          kind: "missing_graphic",
          key: graphic.target,
          path: file.path,
          line: graphic.line,
          message: `\\includegraphics{${graphic.target}} points to a file that does not exist.`,
        });
      }
    }
    for (const float of file.floats) {
      if (!float.label) {
        problems.push({
          kind: "float_without_label",
          key: float.caption || float.kind,
          path: file.path,
          line: float.line,
          message: `${float.kind} at line ${float.line} has no \\label, so it cannot be referenced.`,
        });
      }
    }
  }
  const order = { missing_label: 0, missing_graphic: 1, duplicate_label: 2, float_without_label: 3, unused_label: 4 };
  problems.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.path.localeCompare(b.path) || a.line - b.line);
  return {
    ok: true,
    files: map.files.map((file) => file.path),
    labels: defined.size,
    refs: map.files.reduce((sum, file) => sum + file.refs.length, 0),
    graphics: map.files.reduce((sum, file) => sum + file.graphics.length, 0),
    problems: problems.slice(0, 80),
    summary:
      problems.length === 0
        ? "Every \\ref has a \\label, every label is used, and every graphic exists."
        : `${problems.length} problem(s): ${Object.entries(
            problems.reduce((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + 1 }), {}),
          )
            .map(([kind, count]) => `${count} ${kind.replace(/_/g, " ")}`)
            .join(", ")}.`,
  };
};

const REQUIRED_BIB_FIELDS = {
  article: ["author", "title", "journal", "year"],
  book: ["title", "publisher", "year"],
  inproceedings: ["author", "title", "booktitle", "year"],
  incollection: ["author", "title", "booktitle", "year"],
  phdthesis: ["author", "title", "school", "year"],
  mastersthesis: ["author", "title", "school", "year"],
  techreport: ["author", "title", "institution", "year"],
  misc: ["title"],
  online: ["title", "url"],
  unpublished: ["author", "title", "note"],
};

/** \cite keys against the bib entries, unused and incomplete entries, deterministic. */
const checkBibliography = (map) => {
  const problems = [];
  const entries = new Map();
  const inline = map.files.filter(file => file.bibItems?.length)
    .map(file => ({ path: file.path, entries: file.bibItems }));
  for (const bib of [...map.bibFiles, ...inline]) {
    for (const entry of bib.entries) {
      const existing = entries.get(entry.key);
      if (existing) {
        problems.push({
          kind: "duplicate_entry",
          key: entry.key,
          path: bib.path,
          line: entry.line,
          message: `Entry ${entry.key} also appears at ${existing.path}:${existing.line}.`,
        });
        continue;
      }
      entries.set(entry.key, { ...entry, path: bib.path });
    }
  }
  const cited = new Map();
  for (const file of map.files) {
    for (const cite of file.cites) {
      if (cite.key === "*") continue;
      if (!cited.has(cite.key)) cited.set(cite.key, { path: file.path, line: cite.line });
      if (!entries.has(cite.key)) {
        problems.push({
          kind: "missing_entry",
          key: cite.key,
          path: file.path,
          line: cite.line,
          message: `\\cite{${cite.key}} has no entry in ${map.bibFiles.map((b) => b.path).join(", ") || "any bib file"}.`,
        });
      }
    }
  }
  const nociteAll = map.files.some((file) => file.cites.some((cite) => cite.key === "*"));
  for (const [key, entry] of entries) {
    if (!nociteAll && !cited.has(key)) {
      problems.push({
        kind: "unused_entry",
        key,
        path: entry.path,
        line: entry.line,
        message: `Entry ${key} is never cited.`,
      });
    }
    if (entry.type === "bibitem") continue;
    const required = REQUIRED_BIB_FIELDS[entry.type] ?? ["title"];
    const fields = new Set(entry.fields);
    const missing = required.filter((field) => {
      if (fields.has(field)) return false;
      if (field === "year" && fields.has("date")) return false;
      if (field === "journal" && fields.has("journaltitle")) return false;
      return true;
    });
    if (missing.length > 0) {
      problems.push({
        kind: "incomplete_entry",
        key,
        path: entry.path,
        line: entry.line,
        message: `Entry ${key} (@${entry.type}) lacks ${missing.join(", ")}.`,
      });
    }
  }
  const order = { missing_entry: 0, duplicate_entry: 1, incomplete_entry: 2, unused_entry: 3 };
  problems.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.path.localeCompare(b.path) || a.line - b.line);
  return {
    ok: true,
    bibFiles: map.bibFiles.map((bib) => ({ path: bib.path, entries: bib.entries.length })),
    cites: cited.size,
    problems: problems.slice(0, 80),
    summary:
      problems.length === 0
        ? "Every \\cite has an entry, every entry is cited, and the entries are complete."
        : `${problems.length} problem(s): ${Object.entries(
            problems.reduce((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + 1 }), {}),
          )
            .map(([kind, count]) => `${count} ${kind.replace(/_/g, " ")}`)
            .join(", ")}.`,
  };
};

/** What the @ picker in the chat offers: sections, labels, bib keys. */
const buildMentionIndex = (map) => {
  if (!map) return { sections: [], labels: [], bibKeys: [] };
  const sections = [];
  const labels = [];
  for (const file of map.files) {
    for (const section of file.sections) {
      if (section.type === "preamble") continue;
      sections.push({
        path: file.path,
        id: section.id,
        type: section.type,
        title: section.type === "abstract" ? "abstract" : section.title,
        line: section.line,
        endLine: section.endLine,
      });
    }
    for (const label of file.labels) {
      labels.push({ key: label.key, path: file.path, line: label.line });
    }
  }
  const bibKeys = [];
  const inline = map.files.filter(file => file.bibItems?.length)
    .map(file => ({ path: file.path, entries: file.bibItems }));
  for (const bib of [...map.bibFiles, ...inline, ...(map.otherBibFiles ?? [])]) {
    for (const entry of bib.entries) {
      bibKeys.push({ key: entry.key, path: bib.path, line: entry.line, title: entry.title });
    }
  }
  return { sections, labels, bibKeys };
};

module.exports = {
  BIB_RESOURCE_PATTERN,
  readWorkspaceText,
  resolveMainTexFile,
  scanDocument,
  sectionAtLine,
  formatDocumentMapForPrompt,
  formatOutlineForResult,
  computeSourceFingerprint,
  checkReferences,
  checkBibliography,
  buildMentionIndex,
  outlineOf,
  stripComment,
};

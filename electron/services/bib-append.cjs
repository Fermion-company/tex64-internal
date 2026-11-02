"use strict";

/**
 * The project's .bib file as a citation target.
 *
 * Shared by the Zotero and arXiv citation flows: both decide the same target
 * file from the main document, append an entry only when its key is new, and
 * replace an entry body when a library sync changes it. The preamble is never
 * edited; when no file is named, `references.bib` next to the main file is
 * created and the caller tells the user to add it.
 */

const path = require("path");
const { BIB_RESOURCE_PATTERN, stripComment } = require("./agent-document-map.cjs");

const DEFAULT_BIB_NAME = "references.bib";
const ZOTERO_NOTE_PATTERN = /^\s*%\s*zotero:\s*(\S+)\s*$/;

const toPosix = (value) => String(value || "").replace(/\\/g, "/");

const normalizeRelative = (value) =>
  toPosix(value)
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/");

/** The .bib file the main document names first, or null when it names none. */
const findNamedBib = (mainFile, content) => {
  const lines = String(content || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = stripComment(rawLine);
    const pattern = new RegExp(BIB_RESOURCE_PATTERN.source, "g");
    for (const match of line.matchAll(pattern)) {
      const first = String(match[1] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)[0];
      if (!first) continue;
      const withExt = first.toLowerCase().endsWith(".bib") ? first : `${first}.bib`;
      const fromDir = path.posix.dirname(normalizeRelative(mainFile));
      return normalizeRelative(fromDir && fromDir !== "." ? path.posix.join(fromDir, withExt) : withExt);
    }
  }
  return null;
};

/** How the main document expects to be told about a .bib: biblatex or BibTeX. */
const detectBibStyle = (content) => {
  const text = String(content || "").split(/\r?\n/).map(stripComment).join("\n");
  if (/\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bbiblatex\b[^}]*\}/.test(text)) return "biblatex";
  return "bibtex";
};

const listWorkspaceBibs = async (workspace) => {
  try {
    const listed = await workspace.listFiles();
    return listed
      .filter((entry) => typeof entry === "string" && entry.toLowerCase().endsWith(".bib"))
      .map(normalizeRelative)
      .filter((entry) => !entry.split("/").some((part) => part.startsWith(".")));
  } catch {
    return [];
  }
};

/**
 * Decide the target .bib for a main file: the first \addbibresource /
 * \bibliography target; else the workspace's only .bib (when there are
 * several, the one closest to the main file); else references.bib beside the
 * main file. Returns { relativePath, named, exists, style }.
 */
const resolveBibTarget = async ({ workspace, mainFile }) => {
  const main = normalizeRelative(mainFile);
  if (!main) throw Object.assign(new Error("No main document."), { code: "NO_MAIN_FILE" });
  const content = await workspace.readFile(main);
  const style = detectBibStyle(content);
  const named = findNamedBib(main, content);
  const dir = path.posix.dirname(main);
  const mainDir = dir && dir !== "." ? dir : "";
  let relativePath = named;
  if (!relativePath) {
    const bibs = (await listWorkspaceBibs(workspace)).sort((a, b) => {
      const depth = (value) => value.split("/").length;
      const near = (value) => (path.posix.dirname(value) === (mainDir || ".") ? 0 : 1);
      return near(a) - near(b) || depth(a) - depth(b) || a.localeCompare(b);
    });
    relativePath = bibs[0] || normalizeRelative(mainDir ? path.posix.join(mainDir, DEFAULT_BIB_NAME) : DEFAULT_BIB_NAME);
  }
  const exists = await workspace
    .readFile(relativePath)
    .then(() => true)
    .catch(() => false);
  return { relativePath, named: Boolean(named), exists, style };
};

/**
 * Entries of a .bib file with their character ranges. `start` covers a
 * preceding `% zotero: …` note line so a replacement keeps it in place.
 */
const parseBibEntries = (content) => {
  const text = String(content || "");
  const entries = [];
  const head = /@([A-Za-z]+)\s*([{(])\s*([^,\s]+)\s*,/g;
  let match;
  while ((match = head.exec(text))) {
    const type = match[1].toLowerCase();
    if (type === "comment") continue;
    const open = match[2];
    const close = open === "{" ? "}" : ")";
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < text.length && depth > 0) {
      const ch = text[index];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === close && close === ")" && depth === 1) depth = 0;
      index += 1;
    }
    const bodyStart = match.index;
    const bodyEnd = index;
    let start = bodyStart;
    let zoteroRef = null;
    const lineStart = text.lastIndexOf("\n", bodyStart - 1) + 1;
    const previousLineEnd = lineStart - 1;
    if (previousLineEnd > 0) {
      const previousStart = text.lastIndexOf("\n", previousLineEnd - 1) + 1;
      const previousLine = text.slice(previousStart, previousLineEnd);
      const note = previousLine.match(ZOTERO_NOTE_PATTERN);
      if (note) {
        zoteroRef = note[1];
        start = previousStart;
      }
    }
    entries.push({
      key: match[3],
      type,
      start,
      bodyStart,
      end: bodyEnd,
      body: text.slice(bodyStart, bodyEnd),
      zoteroRef,
    });
    head.lastIndex = bodyEnd;
  }
  return entries;
};

const extractBibKey = (bibtex) => {
  const match = String(bibtex || "").match(/@([A-Za-z]+)\s*[{(]\s*([^,\s]+)\s*,/);
  return match && match[1].toLowerCase() !== "comment" ? match[2] : null;
};

const renameBibKey = (bibtex, key) =>
  String(bibtex || "").replace(/(@[A-Za-z]+\s*[{(]\s*)[^,\s]+(\s*,)/, `$1${key}$2`);

const normalizeBody = (body) => String(body || "").replace(/\s+/g, " ").trim();

/**
 * Append one entry unless its key is already present. Creates the file when
 * missing. Returns { appended, created, key }.
 */
const appendEntry = async ({ workspace, bibPath, bibtex, zoteroRef }) => {
  const key = extractBibKey(bibtex);
  if (!key) throw Object.assign(new Error("The library returned no BibTeX entry."), { code: "NO_BIBTEX" });
  const itemKey = zoteroRef ? String(zoteroRef).split("/").pop() : "";
  return workspace.withFileMutation(bibPath, async () => {
    let existing = null;
    try {
      existing = await workspace.readFile(bibPath);
    } catch {
      existing = null;
    }
    const created = existing === null;
    const content = existing ?? "";
    const entries = parseBibEntries(content);
    // The same Zotero item under another key (added through another
    // transport, or renamed by hand) is one entry, not two.
    const sameItem = itemKey
      ? entries.find((entry) => entry.zoteroRef && String(entry.zoteroRef).split("/").pop() === itemKey)
      : null;
    if (sameItem) return { appended: false, created: false, key: sameItem.key };
    if (entries.some((entry) => entry.key === key)) {
      return { appended: false, created: false, key };
    }
    const note = zoteroRef ? `% zotero: ${zoteroRef}\n` : "";
    const entry = `${note}${String(bibtex).trim()}\n`;
    const separator = content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    await workspace.writeFile(bibPath, `${content}${separator}${entry}`);
    return { appended: true, created, key };
  });
};

/**
 * Replace entry bodies whose fresh text differs. `fresh` maps an existing key
 * to its new BibTeX (already keyed as the existing key). Returns counts.
 */
const replaceEntries = async ({ workspace, bibPath, fresh }) =>
  workspace.withFileMutation(bibPath, async () => {
    const content = await workspace.readFile(bibPath);
    const entries = parseBibEntries(content);
    let updated = 0;
    let unchanged = 0;
    let out = "";
    let cursor = 0;
    for (const entry of entries) {
      const next = fresh.get(entry.key);
      if (typeof next !== "string") continue;
      const body = String(next).trim();
      if (normalizeBody(body) === normalizeBody(entry.body)) {
        unchanged += 1;
        continue;
      }
      out += content.slice(cursor, entry.bodyStart) + body;
      cursor = entry.end;
      updated += 1;
    }
    if (updated > 0) {
      out += content.slice(cursor);
      await workspace.writeFile(bibPath, out);
    }
    return { updated, unchanged };
  });

module.exports = {
  DEFAULT_BIB_NAME,
  resolveBibTarget,
  detectBibStyle,
  findNamedBib,
  parseBibEntries,
  extractBibKey,
  renameBibKey,
  appendEntry,
  replaceEntries,
};

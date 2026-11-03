"use strict";

/**
 * The project's .bib file as a citation target.
 *
 * Shared by the Zotero and arXiv citation flows: both decide the same target
 * file from the main document, append an entry only when its key is new, and
 * replace an entry body when a library sync changes it. The preamble is never
 * edited; when no file is named, `references.bib` next to the main file is
 * created and the caller tells the user to add it.
 *
 * An entry is told apart by the work it cites (Zotero item, DOI, arXiv id),
 * not by its key: a key already used by another work gets a, b, … appended,
 * and the caller cites the key actually written.
 */

const path = require("path");
const { BIB_RESOURCE_PATTERN, stripComment } = require("./agent-document-map.cjs");
const { BUILD_TARGET_CHOICE, resolveBuildTarget } = require("./tex-build-target.cjs");

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

const noMainFile = () => Object.assign(new Error("No main document."), { code: "NO_MAIN_FILE" });

/**
 * The main file of the document a citation goes into, decided the way Build
 * decides it: `documentMainFile` (the document the user chose for this file)
 * wins; else the document that owns the active file. When several documents
 * own it and `bibOf(mainFile)` gives them all the same .bib, any of them will
 * do; otherwise the BUILD_TARGET_CHOICE error (with `candidates`) goes back to
 * the renderer. Without a .tex to start from, NO_MAIN_FILE.
 */
const resolveCitationDocument = async (workspace, { documentMainFile, activeFilePath } = {}, bibOf = null) => {
  if (!workspace.getRootPath()) throw noMainFile();
  const isTex = (value) => /\.tex$/i.test(value);
  const chosen = normalizeRelative(documentMainFile);
  if (isTex(chosen) && (await workspace.readFile(chosen).then(() => true, () => false))) return chosen;
  const active = normalizeRelative(activeFilePath);
  try {
    const owner = normalizeRelative(await resolveBuildTarget(workspace, isTex(active) ? active : ""));
    if (isTex(owner) && (await workspace.readFile(owner).then(() => true, () => false))) return owner;
  } catch (error) {
    if (error?.code === BUILD_TARGET_CHOICE) {
      const candidates = Array.isArray(error.candidates) ? error.candidates.map(normalizeRelative).filter(isTex) : [];
      if (bibOf && candidates.length > 0) {
        const bibs = await Promise.all(candidates.map((candidate) => Promise.resolve(bibOf(candidate)).catch(() => null)));
        if (bibs[0] && bibs.every((bib) => bib === bibs[0])) return candidates[0];
      }
      throw error;
    }
  }
  if (isTex(active)) return active;
  const info = await workspace.rootInfo().catch(() => null);
  if (info && typeof info.path === "string" && isTex(info.path)) return normalizeRelative(info.path);
  throw noMainFile();
};

/**
 * A citation request belongs to the workspace session it started in. The
 * network answer can arrive after a project switch, so `capture()` runs first
 * and `commit(session, operation)` runs the final read-modify-write under the
 * workspace mutation lease, only while the same root and generation are open.
 */
const createWorkspaceGuard = ({ workspace, state = null, withWorkspaceMutation = async (operation) => operation() }) => {
  const capture = () => ({ root: workspace.getRootPath(), generation: state?.workspaceGeneration });
  const assertCurrent = (session) => {
    const current =
      Boolean(session?.root) &&
      workspace.getRootPath() === session.root &&
      (!Number.isSafeInteger(session.generation) || state?.workspaceGeneration === session.generation);
    if (!current) {
      throw Object.assign(new Error("The workspace changed before the bibliography was written."), { code: "STALE_WORKSPACE" });
    }
  };
  const commit = (session, operation) =>
    withWorkspaceMutation(async () => {
      assertCurrent(session);
      return operation();
    });
  return { capture, assertCurrent, commit };
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
    let quoted = false;
    let index = match.index + match[0].length;
    while (index < text.length && depth > 0) {
      const ch = text[index];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      // A "…" value at the entry's top level may hold a `)`; inside braces a
      // quote is an ordinary character (BibTeX's own rule).
      else if (ch === '"' && depth === 1) quoted = !quoted;
      else if (ch === close && close === ")" && depth === 1 && !quoted) depth = 0;
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
 * Top-level fields of one entry: lower-case name → value without its outer
 * braces or quotes (`#` parts joined). Enough to compare identities; macros
 * stay as their names.
 */
const bibFields = (body) => {
  const text = String(body || "");
  const fields = new Map();
  const head = text.match(/^\s*@[A-Za-z]+\s*[{(]\s*[^,\s]+\s*,/);
  if (!head) return fields;
  const sticky = (source) => new RegExp(source, "y");
  const at = (pattern, index) => {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    return match ? { match, next: pattern.lastIndex } : null;
  };
  const NAME = sticky("\\s*([A-Za-z][\\w:.+-]*)\\s*=\\s*");
  const BARE = sticky("[^,#\\s})]+");
  const HASH = sticky("\\s*#\\s*");
  const COMMA = sticky("\\s*,");
  let index = head[0].length;
  while (index < text.length) {
    const name = at(NAME, index);
    if (!name) break;
    index = name.next;
    let value = "";
    for (;;) {
      const ch = text[index];
      if (ch === "{" || ch === '"') {
        let depth = 0;
        let cursor = index + 1;
        for (; cursor < text.length; cursor += 1) {
          const inner = text[cursor];
          if (inner === "{") depth += 1;
          else if (inner === "}" && depth > 0) depth -= 1;
          else if (depth === 0 && inner === (ch === "{" ? "}" : '"')) break;
        }
        value += text.slice(index + 1, cursor);
        index = cursor + 1;
      } else {
        const bare = at(BARE, index);
        if (!bare) break;
        value += bare.match[0];
        index = bare.next;
      }
      const hash = at(HASH, index);
      if (!hash) break;
      index = hash.next;
    }
    const field = name.match[1].toLowerCase();
    if (!fields.has(field)) fields.set(field, value);
    const comma = at(COMMA, index);
    if (!comma) break;
    index = comma.next;
  }
  return fields;
};

const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})$/i;
const ARXIV_IN_TEXT = /arxiv(?:\.org\/(?:abs|pdf)\/|:\s*|\.)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?/i;

const normalizeArxivId = (value) =>
  String(value || "").trim().toLowerCase().replace(/^arxiv:\s*/, "").replace(/v\d+$/, "");

const normalizeDoi = (value) =>
  String(value || "").trim().toLowerCase().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/, "");

// Case, accents, braces and TeX commands do not make another title.
const normalizeTitle = (value) =>
  String(value || "")
    .replace(/\\(?:[A-Za-z]+|.)/g, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

const arxivIdOf = (fields) => {
  const prefix = String(fields.get("archiveprefix") || fields.get("eprinttype") || "").trim().toLowerCase();
  const eprint = normalizeArxivId(fields.get("eprint"));
  if (eprint && (!prefix || prefix === "arxiv") && ARXIV_ID.test(eprint)) return eprint;
  for (const name of ["doi", "url", "journal", "journaltitle", "note", "howpublished"]) {
    const match = String(fields.get(name) || "").match(ARXIV_IN_TEXT);
    if (match) return normalizeArxivId(match[1]);
  }
  return "";
};

/** What an entry cites, for telling works apart: { zoteroRef, doi, arxivId, title }. */
const entryIdentity = ({ body, zoteroRef = null }) => {
  const fields = bibFields(body);
  return {
    zoteroRef: zoteroRef || null,
    doi: normalizeDoi(fields.get("doi")),
    arxivId: arxivIdOf(fields),
    title: normalizeTitle(fields.get("title")),
  };
};

const parseZoteroRef = (ref) => {
  const match = String(ref || "").match(/^(users|groups|bbt):(\d+)\/([A-Za-z0-9]+)$/);
  if (!match) return null;
  const [, kind, id, item] = match;
  // The personal library is bbt:1 through Better BibTeX and users:<id>
  // through the local and web APIs.
  return { kind, item, scope: kind === "users" || (kind === "bbt" && id === "1") ? "user" : `${kind}:${id}` };
};

/**
 * Whether two `<library>/<itemKey>` notes name one Zotero item. An item key
 * is unique only within its library. A Better BibTeX group libraryID and a
 * Zotero group id number the same group differently, so between those two the
 * item key decides.
 */
const sameZoteroItem = (a, b) => {
  const left = parseZoteroRef(a);
  const right = parseZoteroRef(b);
  if (!left || !right) return Boolean(a) && a === b;
  if (left.item !== right.item) return false;
  if (left.scope === right.scope) return true;
  return left.scope !== "user" && right.scope !== "user" && left.kind !== right.kind && (left.kind === "bbt" || right.kind === "bbt");
};

/** One work by an identifier: the same Zotero item, else DOI, else arXiv id. */
const sameIdentifiedWork = (a, b) => {
  if (a.zoteroRef && b.zoteroRef && sameZoteroItem(a.zoteroRef, b.zoteroRef)) return true;
  if (a.doi && b.doi) return a.doi === b.doi;
  return Boolean(a.arxivId && b.arxivId && a.arxivId === b.arxivId);
};

/**
 * Whether the entry holding a wanted key cites the same work. Identifiers
 * decide first, then titles; two different Zotero items with nothing else to
 * compare are different works. With nothing at all to compare the shared key
 * is trusted, as before.
 */
const sameWork = (a, b) => {
  if (a.zoteroRef && b.zoteroRef && sameZoteroItem(a.zoteroRef, b.zoteroRef)) return true;
  if (a.doi && b.doi) return a.doi === b.doi;
  if (a.arxivId && b.arxivId) return a.arxivId === b.arxivId;
  if (a.title && b.title) return a.title === b.title;
  return !(a.zoteroRef && b.zoteroRef);
};

const keySuffix = (index) => {
  const letter = (value) => String.fromCharCode(97 + value);
  return index < 26 ? letter(index) : `${letter(Math.floor(index / 26) - 1)}${letter(index % 26)}`;
};

/**
 * Where a new entry goes among `entries`: { key, entry } of an entry that
 * already cites the same work (under any key), else { key } of a free key —
 * `wanted`, then `wanted` + a, b, … (as Better BibTeX disambiguates). Keys
 * compare without case: BibTeX treats two such keys as one.
 */
const placeEntry = (entries, wanted, incoming) => {
  const identities = new Map();
  const identityOf = (entry) => {
    if (!identities.has(entry)) identities.set(entry, entryIdentity(entry));
    return identities.get(entry);
  };
  const cited = entries.find((entry) => sameIdentifiedWork(identityOf(entry), incoming));
  if (cited) return { key: cited.key, entry: cited };
  const byKey = new Map();
  for (const entry of entries) {
    const lower = entry.key.toLowerCase();
    if (!byKey.has(lower)) byKey.set(lower, entry);
  }
  for (let index = -1; index < 26 * 27; index += 1) {
    const candidate = index < 0 ? wanted : `${wanted}${keySuffix(index)}`;
    const holder = byKey.get(candidate.toLowerCase());
    if (!holder) return { key: candidate, entry: null };
    if (sameWork(identityOf(holder), incoming)) return { key: holder.key, entry: holder };
  }
  throw Object.assign(new Error(`No free citation key near ${wanted}.`), { code: "NO_FREE_KEY" });
};

/**
 * Append one entry unless the .bib already cites the same work. A key held
 * by another work is replaced by a free one. Creates the file when missing.
 * Returns { appended, created, key } with the key the document should cite.
 */
const appendEntry = async ({ workspace, bibPath, bibtex, zoteroRef }) => {
  const wanted = extractBibKey(bibtex);
  if (!wanted) throw Object.assign(new Error("The library returned no BibTeX entry."), { code: "NO_BIBTEX" });
  const incoming = entryIdentity({ body: String(bibtex).trim(), zoteroRef });
  return workspace.withFileMutation(bibPath, async () => {
    let existing = null;
    try {
      existing = await workspace.readFile(bibPath);
    } catch {
      existing = null;
    }
    const created = existing === null;
    const content = existing ?? "";
    // The same Zotero item under another key (added through another
    // transport, or renamed by hand) is one entry, not two.
    const placed = placeEntry(parseBibEntries(content), wanted, incoming);
    if (placed.entry) return { appended: false, created: false, key: placed.key };
    const note = zoteroRef ? `% zotero: ${zoteroRef}\n` : "";
    const entry = `${note}${renameBibKey(String(bibtex).trim(), placed.key)}\n`;
    const separator = content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    await workspace.writeFile(bibPath, `${content}${separator}${entry}`);
    return { appended: true, created, key: placed.key };
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
  resolveCitationDocument,
  createWorkspaceGuard,
  detectBibStyle,
  findNamedBib,
  parseBibEntries,
  bibFields,
  entryIdentity,
  sameZoteroItem,
  placeEntry,
  extractBibKey,
  renameBibKey,
  appendEntry,
  replaceEntries,
};

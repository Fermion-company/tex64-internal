"use strict";

// What Axiom knows of each file during an in-process (openprism) turn, while
// the person's saves keep landing (workspace-writer-coordinator.cjs).
//
// Axiom's edits are computed against a BASE and rebased onto the disk inside
// the per-file queue (agent-proposal-runtime.cjs). The base must never hold
// text of the person's that Axiom did not receive: a whole-file write composed
// from an earlier read would otherwise "remove" that text. So the base is:
//   - the full text a read tool delivered (untruncated), or
//   - Axiom's own last write as Axiom computed it (before any merge), or
//   - failing both, the text just before the person's first save of the file
//     in this turn (it holds none of their typing from this turn). Such a base
//     is not FULL: a whole-file write needs a full read first.
//
// Results that only give positions (a line range, a section, an outline, a
// diagnostic or build log naming the file) never replace the base. They record
// the text their line numbers refer to (`numbering`). A line-numbered edit is
// accepted only where all those versions agree on the lines it touches;
// otherwise Axiom may be counting in another version and must read again.
// Records exist only while the turn runs.

const path = require("path");
const { fileIdentity, relativeIdentity } = require("./file-identity.cjs");

const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const MAX_NUMBERINGS = 6;
const MAX_DELIVERY_CHARS = 20_000;

const viewsOf = (service, conversationId) =>
  service.modelViewsByConversation instanceof Map
    ? service.modelViewsByConversation.get(conversationId || "default") ?? null
    : null;

const beginModelViews = (service, conversationId) => {
  if (!(service.modelViewsByConversation instanceof Map)) service.modelViewsByConversation = new Map();
  service.modelViewsByConversation.set(conversationId || "default", new Map());
};

const endModelViews = (service, conversationId) => {
  if (service.modelViewsByConversation instanceof Map) {
    service.modelViewsByConversation.delete(conversationId || "default");
  }
};

// True during an in-process turn (the editor may save while it runs).
const hasModelViews = (service, conversationId) => viewsOf(service, conversationId) !== null;

const fits = (text) => typeof text === "string" && Buffer.byteLength(text, "utf8") <= MAX_VIEW_BYTES;

const viewPath = (service, file) => {
  if (typeof file !== "string" || !file.trim()) return "";
  try { return fileIdentity(service.workspace, file); } catch { return ""; }
};

const recordOf = (service, views, filename) => {
  const file = viewPath(service, filename);
  if (!file) return null;
  let record = views.get(file);
  if (!record) {
    record = { base: null, full: false, numbering: [], overflow: false, userSaved: false, unavailable: false, truncatedRead: false, names: new Set() };
    views.set(file, record);
  }
  record.names.add(filename);
  return record;
};

const addNumbering = (record, text) => {
  // Too many versions to compare: line-numbered edits need a fresh full read
  // (edits by content and by section still work).
  if (record.overflow || record.numbering.includes(text)) return;
  if (!fits(text) || record.numbering.length === MAX_NUMBERINGS) {
    record.numbering = [];
    record.overflow = true;
    return;
  }
  record.numbering.push(text);
};

const discardBase = (record) =>
  Object.assign(record, { base: null, full: false, numbering: [], unavailable: true });

// A read tool delivered `text` to Axiom in full.
const deliverFullText = (service, conversationId, relativePath, text) => {
  const views = viewsOf(service, conversationId);
  if (!views || !relativePath || typeof text !== "string") return;
  const record = recordOf(service, views, relativePath);
  if (!record) return;
  if (!fits(text)) {
    // Delivered, but not kept: there is no base to rebase from.
    discardBase(record);
    return;
  }
  Object.assign(record, { base: text, full: true, numbering: [text], overflow: false, unavailable: false, truncatedRead: false });
};

// Axiom received line numbers / positions that refer to `text` (the file as
// it was when the result was made), but not the whole of it.
const deliverPositions = (service, conversationId, relativePath, text, { truncatedRead = false } = {}) => {
  const views = viewsOf(service, conversationId);
  if (!views || !relativePath || typeof text !== "string") return;
  const record = recordOf(service, views, relativePath);
  if (!record) return;
  if (truncatedRead) record.truncatedRead = true;
  if (record.unavailable) return;
  if (record.base === null && !fits(text)) {
    discardBase(record);
    return;
  }
  addNumbering(record, text);
};

// Axiom wrote the file. `belief` is the text as Axiom computed it (its base
// with its edit); `written` is what reached the disk (with the person's
// typing merged in, if any). The tool result's outline counts in `written`.
const recordOwnWrite = (service, conversationId, relativePath, belief, written, fullBase) => {
  const views = viewsOf(service, conversationId);
  if (!views || !relativePath || typeof belief !== "string") return;
  const record = recordOf(service, views, relativePath);
  if (!record) return;
  if (record.unavailable) return;
  if (!fits(belief)) {
    discardBase(record);
    return;
  }
  Object.assign(record, { base: belief, full: fullBase === true, numbering: record.overflow ? [] : [belief] });
  if (typeof written === "string" && written !== belief) addNumbering(record, written);
};

// Axiom wrote the file but what it knows of it can no longer be told apart
// from the person's typing: a line-numbered or whole-file edit needs a read.
const markViewUnavailable = (service, conversationId, relativePath) => {
  const views = viewsOf(service, conversationId);
  if (!views || !relativePath) return;
  const record = recordOf(service, views, relativePath);
  if (record) discardBase(record);
};

// The person is saving `relativePath`; `previousText` is the disk before it.
const noteUserSaveInTurn = (service, conversationId, relativePath, previousText) => {
  const views = viewsOf(service, conversationId);
  if (!views || !relativePath) return;
  const record = recordOf(service, views, relativePath);
  if (!record) return;
  if (record.userSaved) return;
  record.userSaved = true;
  if (record.base !== null || record.unavailable) return;
  if (!fits(previousText)) {
    discardBase(record);
    return;
  }
  // None of this turn's typing is in the first save's previous text.
  // The document map Axiom started with counts in it too.
  record.base = previousText;
  addNumbering(record, previousText);
};

// The base an edit is computed against, or why there is none.
//   { text, full } — compute on text, rebase onto the disk
//   { text: null } — no in-turn knowledge: use the disk as before
//   { error }      — a needed base is missing
const editBaseOf = (service, conversationId, relativePath, { needFull = false, positionBase = false } = {}) => {
  const record = viewsOf(service, conversationId)?.get(viewPath(service, relativePath));
  if (!record) return { text: null };
  if (needFull && !record.full && record.userSaved && !record.unavailable) {
    return { error: `${relativePath} changed while you were working (the person is editing it) and you have not read the whole file since. Read it (read_file) before writing the whole file, or change only the part you need (apply_patch / replace_section); nothing was written.` };
  }
  if (record.unavailable || (needFull && record.truncatedRead && !record.full)) {
    return {
      unavailable: true,
      error: `${relativePath}'s edit base is unavailable. Read it again in full with read_file before editing it; nothing was written.`,
    };
  }
  const text = record.base ?? (positionBase && record.truncatedRead ? record.numbering[0] : null);
  return { text: text ?? null, full: record.full };
};

const linesOf = (text) => text.replace(/\r\n/g, "\n").split("\n");
const needsFullRead = (service, conversationId, relativePath) => {
  const record = viewsOf(service, conversationId)?.get(viewPath(service, relativePath));
  return record?.unavailable === true || record?.overflow === true;
};

// A line-numbered edit touches lines [first, last] (1-based) of the base. If
// Axiom has line numbers from another version that differs there, it may be
// counting in that one: refuse rather than guess.
const checkLineNumbers = (service, conversationId, relativePath, first, last) => {
  const record = viewsOf(service, conversationId)?.get(viewPath(service, relativePath));
  if (!record) return null;
  if (record.unavailable || record.overflow) {
    return `${relativePath} changed while you were working; read it again in full before a line-numbered edit, or change the text by content (apply_patch / replace_section). Nothing was written.`;
  }
  const editBase = record.base ?? (record.truncatedRead ? record.numbering[0] : null);
  if (editBase == null) return null;
  const base = linesOf(editBase);
  const from = Math.max(1, first) - 1;
  const to = Math.max(from, last);
  for (const version of record.numbering) {
    if (version === editBase) continue;
    const other = linesOf(version);
    for (let index = from; index < to; index += 1) {
      if (base[index] !== other[index]) {
        return (
          `${relativePath} changed while you were working (the person is editing it): line ` +
          `${index + 1} is not the same in the versions you have line numbers from. Read the lines ` +
          "again (read_file with startLine/endLine), or change the text by content (apply_patch / " +
          "replace_section). Nothing was written."
        );
      }
    }
  }
  return null;
};

// After a non-writing tool: every file the call named, or whose name appears
// in what it returned, may have been given to Axiom as positions in its
// current text. Record that numbering; the base stays as it is.
const recordMentionedPositions = async (service, conversationId, args, result) => {
  const views = viewsOf(service, conversationId);
  if (!views || views.size === 0) return;
  let text = "";
  let report = result;
  try {
    text = typeof result === "string" ? result : JSON.stringify(result ?? "");
    if (typeof result === "string" && /^\s*\{/.test(text)) report = JSON.parse(text);
  } catch {
    // Plain logs can still name paths in their text.
  }
  const named = new Set();
  const addPath = (filename) => {
    const file = viewPath(service, filename);
    if (!views.has(file)) return;
    named.add(file);
    views.get(file).names.add(filename);
  };
  addPath(args?.path);
  if (Array.isArray(args?.paths)) args.paths.forEach(addPath);
  addPath(report?.path);
  addPath(report?.targetFile);
  for (const issue of Array.isArray(report?.issues) ? report.issues : []) {
    addPath(issue?.path ?? issue?.file);
  }
  const root = service.workspace.getRootPath();
  for (const [file, record] of [...views]) {
    const relativePath = relativeIdentity(root, file);
    const mentioned = [relativePath, ...record.names].some((name) =>
      text.includes(name) || text.includes(path.posix.basename(name)));
    if (!named.has(file) && !mentioned) continue;
    try {
      deliverPositions(service, conversationId, relativePath, await service.workspace.readFile(relativePath));
    } catch {
      record.numbering = [];
      record.overflow = true;
    }
  }
};

module.exports = {
  MAX_DELIVERY_CHARS,
  beginModelViews,
  endModelViews,
  hasModelViews,
  deliverFullText,
  deliverPositions,
  recordOwnWrite,
  markViewUnavailable,
  noteUserSaveInTurn,
  editBaseOf,
  needsFullRead,
  checkLineNumbers,
  recordMentionedPositions,
};

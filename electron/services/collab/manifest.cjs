"use strict";

// What a session shares. The hub walks the workspace itself (the existing
// watcher only knows files the editor opened) and classifies each file:
//   text   — merged through a Y.Doc (10 MB limit)
//   binary — copied as bytes with a hash (50 MB limit; figures included)
// Excluded: VCS/internal folders, build intermediates, secrets, and the PDF
// that a \documentclass .tex of the same stem produces (each side builds its own).

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { isExtendedTextFileName, looksBinary } = require("../text-file-types.cjs");

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_BINARY_BYTES = 50 * 1024 * 1024;
const IGNORED_DIRS = new Set([".git", ".tex64", "node_modules", ".venv", "venv", "__pycache__", ".svn", ".hg", "DerivedData"]);
const INTERMEDIATE_RE = /\.(aux|log|fdb_latexmk|fls|synctex(?:\.gz)?|out|toc|bbl|blg|lof|lot|nav|snm|vrb|run\.xml|bcf|idx|ilg|ind|glo|gls|xdv|dvi)$/i;
const SECRET_RE = /(^|\/)(\.env(?:\..*)?|\.npmrc|\.netrc|credentials(?:\.json)?|secrets?(?:\..*)?|id_(rsa|ed25519|ecdsa)(?:\.pub)?)$|\.(pem|key|p12|pfx)$/i;
// .local-<stamp> copies are a guest's own offline edits kept aside on rejoin;
// they stay private to that mirror.
const TEMP_RE = /\.tmp-[^/]+$|\.local-\d{4}-\d{2}-\d{2}T[\d-]+(\.[^/]*)?$|(^|\/)\.DS_Store$|(^|\/)~\$|\.swp$/;
const TEXT_EXTENSIONS = new Set([
  "tex", "bib", "sty", "cls", "bst", "bbx", "cbx", "cfg", "def", "lbx", "ins", "dtx", "ltx", "txt",
  "tikz", "pgf", "mp", "asy", "lua", "bibtex", "md", "csv", "tsv", "json", "yaml", "yml", "xml", "svg",
]);

const extensionOf = (relative) => {
  const ext = path.extname(relative).toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : ext;
};

const isExcludedPath = (relative) => {
  const parts = relative.split("/");
  if (parts.some((part) => IGNORED_DIRS.has(part))) return true;
  if (INTERMEDIATE_RE.test(relative)) return true;
  if (SECRET_RE.test(relative)) return true;
  if (TEMP_RE.test(relative)) return true;
  return false;
};

const looksTextByName = (relative) => TEXT_EXTENSIONS.has(extensionOf(relative)) || isExtendedTextFileName(relative);

const hashBuffer = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

// A tiny, synchronous digest shared with the renderer (web-src/app/collab/session.ts)
// so the save ACK can be matched against the editor buffer without async crypto.
const contentDigest = (text) => {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
};

// Validates a relative path received from a peer: inside the root, no
// traversal, no absolute path, no control characters, no symlink component.
const safeRelativePath = (relative) => {
  if (typeof relative !== "string" || !relative || relative.length > 1024) return null;
  if (relative.includes("\0") || relative.includes("\\") || path.isAbsolute(relative)) return null;
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (isExcludedPath(relative)) return null;
  return relative;
};

const resolveInsideRoot = async (rootPath, relative) => {
  const safe = safeRelativePath(relative);
  if (!safe) return null;
  let current = rootPath;
  for (const part of safe.split("/")) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current).catch(() => null);
    if (stat?.isSymbolicLink()) return null;
  }
  return current;
};

class WorkspaceManifest {
  constructor(rootPath) {
    this.rootPath = rootPath;
    // relative path -> { kind, size, mtimeMs, hash? }
    this.entries = new Map();
    this.documentClassCache = new Map();
  }

  async hasDocumentClass(absolute, stat) {
    const cached = this.documentClassCache.get(absolute);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
    let value = false;
    try {
      const handle = await fsp.open(absolute, "r");
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
        await handle.read(buffer, 0, buffer.length, 0);
        value = /\\documentclass/.test(buffer.toString("utf8"));
      } finally {
        await handle.close();
      }
    } catch {
      value = false;
    }
    this.documentClassCache.set(absolute, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }

  async scan() {
    const next = new Map();
    const files = [];
    const walk = async (directory, relativeDirectory) => {
      let dirents;
      try {
        dirents = await fsp.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        const relative = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory()) {
          if (IGNORED_DIRS.has(dirent.name)) continue;
          await walk(path.join(directory, dirent.name), relative);
          continue;
        }
        if (!dirent.isFile()) continue;
        if (isExcludedPath(relative)) continue;
        files.push(relative);
        if (files.length > 20000) return;
      }
    };
    await walk(this.rootPath, "");
    const documentStems = new Set();
    const stats = new Map();
    for (const relative of files) {
      const absolute = path.join(this.rootPath, relative);
      const stat = await fsp.stat(absolute).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      stats.set(relative, stat);
      if (extensionOf(relative) === "tex" && stat.size <= MAX_TEXT_BYTES && (await this.hasDocumentClass(absolute, stat))) {
        documentStems.add(relative.replace(/\.tex$/i, ""));
      }
    }
    for (const [relative, stat] of stats) {
      if (extensionOf(relative) === "pdf" && documentStems.has(relative.replace(/\.pdf$/i, ""))) continue;
      const previous = this.entries.get(relative);
      if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
        next.set(relative, previous);
        continue;
      }
      const entry = await this.classify(relative, stat);
      if (entry) next.set(relative, entry);
    }
    const previousEntries = this.entries;
    this.entries = next;
    const added = [];
    const changed = [];
    const removed = [];
    for (const [relative, entry] of next) {
      const before = previousEntries.get(relative);
      if (!before) added.push(relative);
      else if (before !== entry) changed.push(relative);
    }
    for (const relative of previousEntries.keys()) if (!next.has(relative)) removed.push(relative);
    return { added, changed, removed };
  }

  async classify(relative, stat) {
    const absolute = path.join(this.rootPath, relative);
    if (looksTextByName(relative)) {
      if (stat.size > MAX_TEXT_BYTES) return null;
      let sample;
      try {
        const handle = await fsp.open(absolute, "r");
        try {
          sample = Buffer.alloc(Math.min(stat.size, 8192));
          await handle.read(sample, 0, sample.length, 0);
        } finally {
          await handle.close();
        }
      } catch {
        return null;
      }
      if (!looksBinary(sample)) return { kind: "text", size: stat.size, mtimeMs: stat.mtimeMs };
    }
    if (stat.size > MAX_BINARY_BYTES) return null;
    let hash;
    try {
      hash = hashBuffer(await fsp.readFile(absolute));
    } catch {
      return null;
    }
    return { kind: "binary", size: stat.size, mtimeMs: stat.mtimeMs, hash };
  }

  get(relative) {
    return this.entries.get(relative) || null;
  }

  // Re-stat one file right now (after our own write) so the next scan does not
  // report it as a change.
  async refresh(relative) {
    const absolute = path.join(this.rootPath, relative);
    const stat = await fsp.stat(absolute).catch(() => null);
    if (!stat || !stat.isFile()) {
      this.entries.delete(relative);
      return null;
    }
    const entry = await this.classify(relative, stat);
    if (entry) this.entries.set(relative, entry);
    else this.entries.delete(relative);
    return entry;
  }
}

module.exports = {
  WorkspaceManifest,
  MAX_TEXT_BYTES,
  MAX_BINARY_BYTES,
  isExcludedPath,
  looksTextByName,
  safeRelativePath,
  resolveInsideRoot,
  hashBuffer,
  contentDigest,
  fs,
};

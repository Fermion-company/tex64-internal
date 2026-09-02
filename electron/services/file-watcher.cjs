"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

// Watches the open workspace so edits made outside TeX64 (git checkout, a
// script, another editor, Finder) show up without closing and reopening the
// file — reported in issue #38 as "changes never reach the editor".
//
// Build artifacts are deliberately not reported: latexmk rewrites a dozen of
// them per run, and the build pipeline already refreshes the PDF it produced.

const ARTIFACT_EXTENSIONS = new Set([
  ".aux", ".bbl", ".bcf", ".blg", ".brf", ".dvi", ".fdb_latexmk", ".fls",
  ".idx", ".ilg", ".ind", ".lof", ".log", ".lot", ".nav", ".out", ".pdf",
  ".run.xml", ".snm", ".synctex", ".toc", ".vrb", ".xdv",
]);

const IGNORED_DIRECTORY_NAMES = new Set(["node_modules", "__pycache__"]);

const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

// ".synctex.gz" and ".run.xml" are two-part suffixes; path.extname only sees
// the last one, so match the tail of the name instead.
const isArtifactName = (name) => {
  const lower = name.toLowerCase();
  if (lower.endsWith(".synctex.gz") || lower.endsWith(".run.xml")) {
    return true;
  }
  return ARTIFACT_EXTENSIONS.has(path.extname(lower));
};

const isIgnoredRelativePath = (relativePath) => {
  if (!relativePath) {
    return true;
  }
  const segments = relativePath.split("/");
  const name = segments[segments.length - 1];
  if (IGNORED_FILE_NAMES.has(name)) {
    return true;
  }
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    // Dot-directories hold VCS and tool state (.git, .tex64); their churn is
    // never something the editor should react to.
    if (segment.startsWith(".") || IGNORED_DIRECTORY_NAMES.has(segment)) {
      return true;
    }
  }
  return isArtifactName(name);
};

const DEFAULT_DEBOUNCE_MS = 180;
// A file TeX64 just wrote itself comes back as a change event. Reloading it is
// harmless (the content matches what the editor already holds), but skipping
// the round trip keeps a busy save loop quiet.
//
// The suppression is keyed on the exact bytes written, not on a time window:
// a window swallows a real external write that lands moments after a save
// (autosave plus a script touching the same file), which is precisely the case
// this watcher exists for.
const DEFAULT_SUPPRESS_MS = 30_000;

const hashContent = (value) =>
  crypto.createHash("sha1").update(typeof value === "string" ? value : "", "utf8").digest("hex");

class WorkspaceWatcher {
  constructor({ onChanges, debounceMs, suppressMs } = {}) {
    this.onChanges = typeof onChanges === "function" ? onChanges : () => {};
    this.debounceMs = Number.isFinite(debounceMs) ? Math.max(0, debounceMs) : DEFAULT_DEBOUNCE_MS;
    this.suppressMs = Number.isFinite(suppressMs) ? Math.max(0, suppressMs) : DEFAULT_SUPPRESS_MS;
    this.rootPath = null;
    this.watcher = null;
    this.pending = new Set();
    this.timer = null;
    this.suppressed = new Map();
  }

  watch(rootPath) {
    const next = typeof rootPath === "string" && rootPath ? path.resolve(rootPath) : null;
    if (next === this.rootPath && this.watcher) {
      return true;
    }
    this.stop();
    if (!next) {
      return false;
    }
    try {
      // macOS and Windows support recursive watching natively. On a platform
      // without it the app still works; only this convenience is missing.
      this.watcher = fs.watch(next, { recursive: true }, (_eventType, fileName) => {
        this.#enqueue(fileName);
      });
    } catch (error) {
      this.watcher = null;
      this.rootPath = null;
      return { error: error && error.message ? error.message : "watch failed" };
    }
    this.watcher.on("error", () => {
      this.stop();
    });
    this.rootPath = next;
    return true;
  }

  // Called right before TeX64 writes a file itself, with the exact content it
  // is about to write.
  suppress(relativePath, content) {
    const normalized = this.#normalize(relativePath);
    if (!normalized || typeof content !== "string") {
      return;
    }
    this.suppressed.set(normalized, {
      hash: hashContent(content),
      expiresAt: Date.now() + this.suppressMs,
    });
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    this.suppressed.clear();
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* a watcher whose directory vanished is already closed */
      }
      this.watcher = null;
    }
    this.rootPath = null;
  }

  #normalize(value) {
    if (typeof value !== "string" || !value) {
      return null;
    }
    return value.split(path.sep).join("/").replace(/^\/+/, "");
  }

  #enqueue(fileName) {
    const relativePath = this.#normalize(fileName);
    if (!relativePath || isIgnoredRelativePath(relativePath)) {
      return;
    }
    this.pending.add(relativePath);
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.#flush();
    }, this.debounceMs);
  }

  // True only while the file on disk still holds exactly what TeX64 wrote. The
  // moment anything else writes it, the record is dropped and the change is
  // reported like any other.
  async #isOwnWrite(relativePath, absolutePath) {
    const record = this.suppressed.get(relativePath);
    if (!record) {
      return false;
    }
    if (record.expiresAt <= Date.now()) {
      this.suppressed.delete(relativePath);
      return false;
    }
    const content = await fsp.readFile(absolutePath, "utf8").catch(() => null);
    if (content === null) {
      return false;
    }
    if (hashContent(content) === record.hash) {
      return true;
    }
    this.suppressed.delete(relativePath);
    return false;
  }

  async #flush() {
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length === 0 || !this.rootPath) {
      return;
    }
    const changes = [];
    for (const relativePath of paths) {
      const absolute = path.resolve(this.rootPath, relativePath);
      // Anything that resolved outside the workspace came from a malformed
      // event name; drop it rather than reporting a path the renderer cannot use.
      if (absolute !== this.rootPath && !absolute.startsWith(this.rootPath + path.sep)) {
        continue;
      }
      const stat = await fsp.stat(absolute).catch(() => null);
      if (!stat) {
        // macOS opens an FSEvents stream by naming the watched directory
        // itself, which resolves to a nonexistent child with the root's own
        // name. Reporting that as a deletion would send the renderer chasing a
        // file that never existed.
        if (relativePath === path.basename(this.rootPath)) {
          continue;
        }
        this.suppressed.delete(relativePath);
        changes.push({ path: relativePath, kind: "removed" });
        continue;
      }
      if (stat.isDirectory()) {
        changes.push({ path: relativePath, kind: "directory" });
        continue;
      }
      if (await this.#isOwnWrite(relativePath, absolute)) {
        continue;
      }
      changes.push({ path: relativePath, kind: "changed", mtimeMs: stat.mtimeMs, size: stat.size });
    }
    if (changes.length > 0) {
      this.onChanges(changes);
    }
  }
}

module.exports = { WorkspaceWatcher, isIgnoredRelativePath, isArtifactName };

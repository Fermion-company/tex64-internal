"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { canonicalPath, relativeIdentity } = require("./file-identity.cjs");
const { isStagingName } = require("./project-file-writes.cjs");
const IGNORED = new Set([".git", ".tex64", "node_modules", ".venv", "__pycache__"]);

class WorkspaceFileWatcher {
  // settleMs: another program usually writes in place (truncate, write,
  // close), and a delete-then-create (git checkout) passes through "missing".
  // A changed file is reported only once it has not been modified for
  // settleMs, and a missing one only once it has stayed missing that long, so
  // the editor is never handed a half-written file. Below debounceMs, so the
  // flush that follows a write's own fs.watch event normally reports it.
  // maxSettleWaits bounds the wait for a file that never stops changing.
  constructor({ resolvePath, onChange, onTree, onError = () => {}, debounceMs = 180, pollMs = 1500, isPaused = () => false,
    settleMs = Math.round(debounceMs * 0.8), maxSettleWaits = 10 }) {
    Object.assign(this, { resolvePath, onChange, onTree, onError, debounceMs, pollMs, isPaused, settleMs, maxSettleWaits });
    this.root = null;
    this.generation = 0;
    this.tracked = new Map();
    this.settling = new Map();
  }

  // True while `file` should wait: modified within settleMs (file times can
  // run a little ahead of Date.now(); an mtime further in the future is clock
  // skew, not activity), changed during the read, or missing for less than
  // settleMs.
  unsettled(file, before, after) {
    const now = Date.now();
    const entry = this.settling.get(file) ?? { waits: 0, missingSince: null };
    let fresh;
    if (!before) {
      entry.missingSince ??= now;
      fresh = now - entry.missingSince < this.settleMs;
    } else {
      entry.missingSince = null;
      const age = now - before.mtimeMs;
      fresh = (age > -this.settleMs && age < this.settleMs) ||
        !after || after.size !== before.size || after.mtimeMs !== before.mtimeMs;
    }
    if (!fresh || entry.waits >= this.maxSettleWaits) {
      this.settling.delete(file);
      return false;
    }
    entry.waits += 1;
    this.settling.set(file, entry);
    return true;
  }

  start(root, generation) {
    if (root === this.root && generation === this.generation) return;
    const tracked = root === this.root ? new Map(this.tracked) : new Map();
    this.stop();
    this.tracked = tracked;
    this.root = root;
    this.generation = generation;
    if (!root) return;
    try {
      this.watcher = fs.watch(root, { recursive: true }, (kind, name) => {
        const relative = String(name || "").split(path.sep).join("/");
        if (relative.split("/").some((part) => IGNORED.has(part))) return;
        // A save stages its bytes (or a recovery copy) under a temporary name
        // next to an open file. Neither event changes the tree; do not
        // enumerate the entire project on every keystroke/autosave.
        if (isStagingName(relative)) return;
        if (kind === "rename") {
          let file = relative;
          try { file = relativeIdentity(root, canonicalPath(this.resolvePath(relative))); } catch {}
          if (!this.tracked.has(file)) this.treeDirty = true;
        }
        this.schedule();
      });
      this.watcher.on("error", (error) => {
        this.watcher?.close();
        this.watcher = null;
        this.onError(error);
      });
    } catch (error) { this.onError(error); }
    // Poll the open files as a safety net for atomic replacement and mounted
    // volumes whose native notifications are incomplete. Never read all files.
    this.poll = setInterval(() => {
      if (!this.watcher) this.treeDirty = true;
      this.schedule();
    }, this.pollMs);
    this.poll.unref?.();
  }

  track(file, content) {
    if (!this.root || typeof content !== "string") return;
    try {
      const key = relativeIdentity(this.root, canonicalPath(this.resolvePath(file)));
      this.tracked.set(key, { content });
    } catch {
      // Ignore a path that is no longer in this workspace.
    }
  }

  schedule() {
    if (this.timer || !this.root) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async flush() {
    if (this.isPaused()) return;
    if (this.flushing) { this.schedule(); return; }
    this.flushing = true;
    const root = this.root;
    const generation = this.generation;
    const current = () => root && root === this.root && generation === this.generation;
    let treeDirty = this.treeDirty;
    this.treeDirty = false;
    let waiting = false;
    // A tracked file that has just vanished may be coming back (an editor or
    // git replacing it). Until that settles the tree is not refreshed: the
    // editor hears about the file first, then sees the tree.
    let vanishing = false;
    try {
      for (const [file, baseline] of this.tracked) {
        if (!current()) return;
        let content;
        let absolute;
        let stat = null;
        try {
          absolute = this.resolvePath(file);
          stat = await fsp.stat(absolute);
          if (!stat.isFile() || stat.size > 10 * 1024 * 1024) continue;
          content = await fsp.readFile(absolute, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") continue;
          content = null;
          stat = null;
        }
        if (!current()) return;
        if (this.isPaused()) { this.treeDirty ||= treeDirty; return; }
        if (this.tracked.get(file) !== baseline || content === baseline.content) {
          this.settling.delete(file);
          continue;
        }
        const after = content === null ? null : await fsp.stat(absolute).catch(() => null);
        if (!current()) return;
        if (this.unsettled(file, stat, after)) {
          waiting = true;
          if (content === null) vanishing = true;
          continue;
        }
        if (this.isPaused()) { this.treeDirty ||= treeDirty; return; }
        if (this.tracked.get(file) !== baseline) continue;
        if (content === null || baseline.content === null) treeDirty = true;
        this.tracked.set(file, { content });
        await this.onChange({ root, generation, path: file, content, expectedContent: baseline.content, fileDeleted: content === null });
      }
      if (this.isPaused()) { this.treeDirty ||= treeDirty; return; }
      if (vanishing) { this.treeDirty ||= treeDirty; return; }
      if (treeDirty && current()) await this.onTree({ root, generation });
    } catch (error) { if (current()) this.onError(error); }
    finally {
      this.flushing = false;
      // Come back for a file that was still being written.
      if (waiting && current()) this.schedule();
    }
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
    clearInterval(this.poll);
    clearTimeout(this.timer);
    this.poll = null;
    this.timer = null;
    this.root = null;
    this.treeDirty = false;
    this.tracked.clear();
    this.settling.clear();
  }
}

module.exports = { WorkspaceFileWatcher };

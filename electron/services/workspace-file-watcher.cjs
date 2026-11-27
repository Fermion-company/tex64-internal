"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
// Filesystems with coarse or stale metadata still get a periodic content check.
const MAX_UNVERIFIED_MS = 30_000;
const IGNORED = new Set([".git", ".tex64", "node_modules", ".venv", "__pycache__"]);

class WorkspaceFileWatcher {
  constructor({ resolvePath, onChange, onTree, onPreviewPath, checkPreviewInputs, onError = () => {}, debounceMs = 180, pollMs = 1500, isPaused = () => false }) {
    Object.assign(this, { resolvePath, onChange, onTree, onPreviewPath, checkPreviewInputs, onError, debounceMs, pollMs, isPaused });
    this.root = null;
    this.generation = 0;
    this.tracked = new Map();
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
      const watcher = fs.watch(root, { recursive: true }, (kind, name) => {
        if (this.watcher !== watcher) return;
        const relative = String(name || "").split(path.sep).join("/");
        if (relative.split("/").some((part) => IGNORED.has(part))) return;
        // An autosave atomically renames .name.tmp-pid-time over an existing
        // open file. Neither event changes the tree; do not enumerate the
        // entire project on every keystroke/autosave.
        if (/\.[^/]+\.tmp-\d+-\d+$/.test(relative)) return;
        this.onPreviewPath?.(root, relative);
        const baseline = this.tracked.get(relative);
        if (baseline) this.tracked.set(relative, { content: baseline.content });
        else if (kind === "rename") this.treeDirty = true;
        this.schedule();
      });
      this.watcher = watcher;
      watcher.on("error", (error) => {
        if (this.watcher !== watcher) return;
        watcher.close();
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
    try { this.resolvePath(file); } catch { return; }
    this.tracked.set(file, { content });
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
    try {
      for (const [file, baseline] of this.tracked) {
        if (!current()) return;
        let content;
        let signature;
        try {
          const absolute = this.resolvePath(file);
          const stat = await fsp.stat(absolute, { bigint: true });
          if (!stat.isFile() || stat.size > 10n * 1024n * 1024n) continue;
          signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
          if (baseline.signature === signature && Date.now() - baseline.checkedAt < MAX_UNVERIFIED_MS) continue;
          content = await fsp.readFile(absolute, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") continue;
          content = null;
        }
        if (!current()) return;
        if (this.isPaused()) { this.treeDirty ||= treeDirty; return; }
        if (this.tracked.get(file) !== baseline) continue;
        if (content === baseline.content) {
          baseline.signature = signature;
          baseline.checkedAt = Date.now();
          continue;
        }
        if (content === null || baseline.content === null) treeDirty = true;
        this.tracked.set(file, { content, signature, checkedAt: Date.now() });
        await this.onChange({ root, generation, path: file, content, expectedContent: baseline.content, fileDeleted: content === null });
      }
      if (this.isPaused()) { this.treeDirty ||= treeDirty; return; }
      if (current()) await this.checkPreviewInputs?.(root);
      if (treeDirty && current()) await this.onTree({ root, generation });
    } catch (error) { if (current()) this.onError(error); }
    finally { this.flushing = false; }
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
  }
}

module.exports = { WorkspaceFileWatcher };

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { readFileUpTo } = require("./bounded-file-read.cjs");
const { isPathWithinRoot } = require("./build/utils.cjs");

const { originalInput } = require("./live-pdf-paths.cjs");

const keyFor = (relative) => {
  const name = path.normalize(relative);
  return process.platform === "win32" ? name.toLowerCase() : process.platform === "darwin" ? name.normalize("NFC") : name;
};
async function signature(file) {
  try {
    const s = await fs.stat(file, { bigint: true });
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  } catch { return null; }
}

// Only inputs actually opened by this TeX process count as dependencies.
async function recordedInputs(recorder, cwd) {
  const log = await readFileUpTo(recorder, 8 * 1024 * 1024).catch(() => null);
  if (!log) return [];
  const lines = log.toString().split(/\r?\n/);
  const pwd = lines.find(line => line.startsWith("PWD "))?.slice(4);
  const working = pwd && path.isAbsolute(pwd) ? pwd : cwd;
  const outputs = new Set(), inputs = new Set();
  for (const line of lines) {
    if (line.startsWith("OUTPUT ")) outputs.add(path.resolve(working, line.slice(7)));
    else if (line.startsWith("INPUT ")) inputs.add(path.resolve(working, line.slice(6)));
  }
  return [...inputs].filter(file => !outputs.has(file));
}

// The app already watches the workspace recursively. Keep only TeX's project
// inputs here. Do not read or hash images, or subscribe separately to each file.
class LivePdfInputs {
  constructor(notify) { this.notify = notify; }

  clear() { this.paper = null; this.attempt = null; }

  begin(root, rootFile) {
    if (this.paper?.root !== root || this.paper.rootFile !== rootFile) this.paper = null;
    const attempt = { root, rootFile, changes: new Set(), overflow: false };
    this.attempt = attempt;
    return attempt;
  }

  changed(root, name) {
    if (!name || (!this.paper && !this.attempt)) return;
    const absolute = path.resolve(root, name);
    if (!isPathWithinRoot(root, absolute)) return;
    const key = keyFor(path.relative(root, absolute));
    if (this.attempt?.root === root) {
      if (this.attempt.changes.size < 8192) this.attempt.changes.add(key);
      else this.attempt.overflow = true;
    }
    const paper = this.paper;
    if (paper?.root !== root) return;
    // graphicx can search directories specified by a class or macro. After a
    // failed lookup its diagnostic may only name the leaf, not the directory.
    if (!paper.files.has(key) && paper.missing.has(path.basename(key))) {
      paper.files.set(key, { path: absolute, stamp: null });
    }
    if (paper.files.has(key)) paper.pending.add(key);
  }

  treeUpdated(root, paths) {
    if (!this.paper || this.paper.root !== root || !this.paper.missing.size) return;
    // The workspace also enumerates files when recursive notifications are
    // unavailable. A newly supplied graphic can be in a class-defined path.
    for (const name of paths) {
      const key = keyFor(name);
      if (!this.paper.files.has(key) && this.paper.missing.has(path.basename(key))) this.changed(root, name);
    }
  }

  async flush(root) {
    const paper = this.paper;
    if (!paper || paper.root !== root) return;
    // Native events give immediate checks. A bounded rotating scan also
    // catches silent changes on a mounted volume and replacements of folders.
    const keys = new Set(paper.pending);
    paper.pending.clear();
    if (Date.now() >= paper.nextScan) {
      paper.nextScan = Date.now() + 2000;
      for (let i = 0; i < Math.min(24, paper.files.size); i++) {
        let next = paper.scan.next();
        if (next.done) { paper.scan = paper.files.keys(); next = paper.scan.next(); }
        keys.add(next.value);
      }
    }
    let changed = false;
    for (const key of keys) {
      const entry = paper.files.get(key);
      if (!entry) continue;
      const now = await signature(entry.path);
      if (this.paper !== paper) return;
      if (now === entry.stamp) continue;
      if (!entry.presenceOnly || (now === null) !== (entry.stamp === null)) changed = true;
      entry.stamp = now;
    }
    if (changed && this.paper === paper) this.notify(paper.root, paper.rootFile);
  }

  async finish(attempt, { recorder, aliases, cwd, stageRoot, rootPath, buffers, bibliographyFiles, complete, transcript }) {
    if (this.attempt !== attempt) return;
    const { root, rootFile } = attempt;
    const previous = this.paper?.files ?? new Map();
    const files = complete ? new Map() : new Map(previous);
    const missing = new Set();
    const realRoot = await fs.realpath(root);
    const sourceDir = path.dirname(rootPath);
    const stageDirs = stageRoot && sourceDir !== root ? [stageRoot, await fs.realpath(stageRoot)] : [];
    const add = (file, presenceOnly = false) => {
      const base = [root, realRoot].find(dir => isPathWithinRoot(dir, file));
      if (!base) return;
      const relative = path.relative(base, file);
      if (!relative || typeof buffers.get(relative) === "string") return;
      const key = keyFor(relative);
      if (presenceOnly && files.has(key)) return;
      files.set(key, { path: path.join(root, relative), stamp: previous.get(key)?.stamp, presenceOnly });
    };
    for (const file of bibliographyFiles ?? []) add(file);
    add(rootPath); // the compiler reads a private copy of the root manuscript
    // A recovered clean chapter was read from a private staging copy.
    for (const [relative, text] of buffers) if (text === null) add(path.resolve(root, relative));
    for (const recorded of await recordedInputs(recorder, cwd)) {
      const file = originalInput(aliases, recorded);
      add(file);
      // A workspace input can be shadowed later by a file beside the
      // root manuscript. The recorder can also name its unsaved copy.
      if (sourceDir !== root) {
        const base = [root, realRoot, ...stageDirs].find(dir => isPathWithinRoot(dir, file));
        if (!base) continue;
        const relative = path.relative(base, file);
        const logical = path.join(root, relative);
        if (!isPathWithinRoot(sourceDir, logical)) add(path.join(sourceDir, relative), true);
      }
    }
    // TeX cannot record an INPUT for a chapter or image that does not yet
    // exist. Watch the failed lookup as well, even on the very first build.
    for (const m of String(transcript || "").matchAll(/(?:File|file) [`'"]([^`'"\r\n]+)['"] (?:not found|could not be found)/g)) {
      const name = m[1];
      const names = path.extname(name) ? [name] :
        ["", ".tex", ".pdf", ".png", ".jpg", ".jpeg", ".eps"].map(ext => name + ext);
      for (const candidate of names) {
        missing.add(keyFor(path.basename(candidate)));
        for (const dir of [path.dirname(rootPath), root]) add(path.resolve(dir, candidate));
      }
    }
    for (const name of attempt.changes) {
      if (missing.has(path.basename(name))) add(path.resolve(root, name));
    }
    const entries = [...files.values()].filter(entry => entry.stamp === undefined);
    for (let i = 0; i < entries.length; i += 24) {
      if (this.attempt !== attempt) return;
      await Promise.all(entries.slice(i, i + 24).map(async entry => { entry.stamp = await signature(entry.path); }));
    }
    if (this.attempt !== attempt) return;
    const pending = new Set(this.paper?.pending);
    this.paper = { root, rootFile, files, pending, missing, nextScan: 0, scan: files.keys() };
    this.attempt = null;
    // An editor can replace a newly discovered input between the TeX read
    // and the first stat. The completed paper may have used its old bytes.
    if (attempt.overflow || [...attempt.changes].some(key => files.has(key) && !previous.has(key))) this.notify(root, rootFile);
  }
}

module.exports = { LivePdfInputs, recordedInputs };

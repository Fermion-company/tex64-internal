"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const isWithin = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// This records only invalidation caused by project restoration. It does not
// assert that a loaded PDF matches all current editor buffers or TeX inputs.
class PdfSourceState {
  constructor(directory) { this.directory = directory; this.roots = new Map(); }
  file(root) { return path.join(this.directory, `${crypto.createHash("sha256").update(root).digest("hex")}.json`); }
  status(rootPath) {
    if (!rootPath) return { rootPath: null, requiresRebuild: false, rebuiltPaths: [] };
    const root = path.resolve(rootPath);
    if (!this.roots.has(root)) {
      let value = { rootPath: root, requiresRebuild: false, rebuiltPaths: [] };
      try {
        const saved = JSON.parse(fs.readFileSync(this.file(root), "utf8"));
        if (saved.rootPath === root && saved.requiresRebuild === true && Array.isArray(saved.rebuiltPaths)) {
          value = { rootPath: root, requiresRebuild: true, restoreBoundary: typeof saved.restoreBoundary === "string" ? saved.restoreBoundary : null, rebuiltPaths: saved.rebuiltPaths.filter(p => typeof p === "string" && isWithin(root, p)) };
        } else { throw new Error("Invalid PDF source marker"); }
      } catch (error) {
        // A damaged marker cannot prove that rebuilding is unnecessary.
        if (error.code !== "ENOENT") value.requiresRebuild = true;
      }
      this.roots.set(root, value);
    }
    const value = this.roots.get(root);
    return { ...value, rebuiltPaths: [...value.rebuiltPaths] };
  }
  save(value) {
    fs.mkdirSync(this.directory, { recursive: true });
    const destination = this.file(value.rootPath);
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, destination);
      if (process.platform !== "win32") {
        const directory = fs.openSync(this.directory, "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
      this.roots.set(value.rootPath, value);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
    return this.status(value.rootPath);
  }
  restored(rootPath, restoreBoundary = null) {
    const current = this.status(rootPath);
    if (restoreBoundary && current.restoreBoundary === restoreBoundary) return current;
    return this.save({ rootPath: path.resolve(rootPath), requiresRebuild: true, restoreBoundary, rebuiltPaths: [] });
  }
  built(rootPath, pdfPath) {
    const value = this.status(rootPath);
    if (!value.rootPath || !value.requiresRebuild || !pdfPath) return value;
    const file = path.resolve(pdfPath);
    if (!isWithin(value.rootPath, file)) return value;
    if (!value.rebuiltPaths.includes(file)) value.rebuiltPaths.push(file);
    return this.save(value);
  }
  needsRebuild(rootPath, pdfPath) {
    const value = this.status(rootPath);
    if (!value.rootPath || !value.requiresRebuild || !pdfPath) return false;
    const file = path.resolve(pdfPath);
    return isWithin(value.rootPath, file) && !value.rebuiltPaths.includes(file);
  }
}
module.exports = { PdfSourceState };

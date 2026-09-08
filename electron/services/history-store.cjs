"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { hash, fail, validId, validPath, protectedReason, safePath, readRegular, atomicWrite, syncDirectory } = require("./history-files.cjs");

class HistoryStore {
  constructor({ root, directory, maxBytes = 2 * 1024 ** 3, maxFileBytes = 128 * 1024 ** 2, fault = async () => {} }) {
    this.requestedRoot = root;
    this.baseDirectory = directory;
    this.maxBytes = maxBytes;
    this.maxFileBytes = maxFileBytes;
    this.fault = fault;
    this.tail = Promise.resolve();
  }

  async initialize() {
    const root = await fsp.realpath(this.requestedRoot);
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) throw fail("INVALID_ROOT", "Open a project folder first.");
    const identity = `${root}\0${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    if (this.identity && this.identity !== identity) throw fail("STALE_WORKSPACE", "The project folder was replaced.");
    this.identity = identity;
    this.root = root;
    this.projectId = hash(identity);
    this.directory = path.join(this.baseDirectory, this.projectId);
    for (const name of ["", "blobs", "trees", "versions", "labels"]) {
      await fsp.mkdir(path.join(this.directory, name), { recursive: true, mode: 0o700 });
      if ((await fsp.lstat(path.join(this.directory, name))).isSymbolicLink()) throw fail("UNSAFE_STORE", "History storage cannot be a symbolic link.");
    }
    try {
      const settings = JSON.parse(await fsp.readFile(path.join(this.directory, "settings.json"), "utf8"));
      if (!Number.isSafeInteger(settings.maxBytes) || settings.maxBytes < 1024 ** 3 || settings.maxBytes > 100 * 1024 ** 3) throw fail("STORE_CORRUPT", "History capacity settings are damaged.");
      this.maxBytes = settings.maxBytes;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return this;
  }

  async setLimit(gib) {
    if (!Number.isInteger(gib) || gib < 1 || gib > 100) throw fail("INVALID_LIMIT", "Choose a history limit between 1 and 100 GiB.");
    return this.exclusive(async () => {
      const maxBytes = gib * 1024 ** 3;
      await atomicWrite(path.join(this.directory, "settings.json"), JSON.stringify({ schema: 1, maxBytes }));
      this.maxBytes = maxBytes;
      return { maxBytes };
    });
  }

  async exclusive(operation) {
    const run = this.tail.catch(() => {}).then(async () => {
      await this.initialize();
      const lock = path.join(this.directory, "writer.lock");
      const token = crypto.randomUUID();
      const ownerName = `owner-${token}.json`;
      const candidate = path.join(this.directory, `writer-candidate-${token}`);
      await fsp.mkdir(candidate, { mode: 0o700 });
      let acquired = false;
      try {
        // Publish a populated directory. A crash before publication leaves only
        // an unused candidate, never an ownerless lock that blocks all recovery.
        await atomicWrite(path.join(candidate, ownerName), JSON.stringify({ pid: process.pid, token }));
        await this.fault("lock-before-publish");
        for (let attempt = 0; ; attempt++) {
          try { await fsp.rename(candidate, lock); acquired = true; await syncDirectory(this.directory); break; }
          catch (error) {
            if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
            const names = await fsp.readdir(lock).catch(() => []);
            if (names.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(names[0]) || attempt > 0) throw fail("WORKSPACE_BUSY", "Another history operation is still running.");
            const owner = await fsp.readFile(path.join(lock, names[0]), "utf8").then(JSON.parse).catch(() => null);
            if (!owner || !Number.isSafeInteger(owner.pid) || names[0] !== `owner-${owner.token}.json`) throw fail("WORKSPACE_BUSY", "History lock ownership could not be verified.");
            try { process.kill(owner.pid, 0); throw fail("WORKSPACE_BUSY", "Another app instance is using this project history."); }
            catch (error) { if (error.code !== "ESRCH") throw error; }
            // Unlink the unique dead-owner name, never a generic owner.json.
            // A competing recovery cannot remove a newly published owner's file.
            try { await fsp.unlink(path.join(lock, names[0])); await fsp.rmdir(lock); }
            catch { throw fail("WORKSPACE_BUSY", "Another app instance is recovering this project history."); }
          }
        }
        this.usedBytes = await this.usage();
        return await operation();
      } finally {
        const ownedDirectory = acquired ? lock : candidate;
        await fsp.unlink(path.join(ownedDirectory, ownerName)).catch(() => {});
        await fsp.rmdir(ownedDirectory).catch(() => {});
      }
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  file(kind, id) {
    if (!validId(id)) throw fail("INVALID_ID", "Invalid history identifier.");
    return path.join(this.directory, kind, id + (kind === "blobs" ? "" : ".json"));
  }

  async readJson(kind, id) {
    let value;
    try { value = JSON.parse(await fsp.readFile(this.file(kind, id), "utf8")); }
    catch { throw fail("STORE_CORRUPT", "This history record is missing or damaged."); }
    return value;
  }

  async usage() {
    const names = await fsp.readdir(path.join(this.directory, "blobs"));
    let bytes = 0;
    for (const name of names) bytes += (await fsp.stat(path.join(this.directory, "blobs", name))).size;
    return bytes;
  }

  async putBlob(bytes) {
    const id = hash(bytes);
    const file = this.file("blobs", id);
    try {
      const existing = await fsp.readFile(file);
      if (hash(existing) !== id) throw fail("STORE_CORRUPT", "A stored file is damaged.");
      return id;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if ((this.usedBytes ?? await this.usage()) + bytes.length > this.maxBytes) throw fail("QUOTA_EXCEEDED", "Project history is full. Increase its limit before recording another version.");
    await atomicWrite(file, bytes, { exclusive: true });
    this.usedBytes = (this.usedBytes || 0) + bytes.length;
    return id;
  }

  async blob(id) {
    const bytes = await fsp.readFile(this.file("blobs", id)).catch(() => { throw fail("STORE_CORRUPT", "A stored file is missing."); });
    if (hash(bytes) !== id) throw fail("STORE_CORRUPT", "A stored file failed its integrity check.");
    return bytes;
  }

  async scan({ store = false, rootFile = null } = {}) {
    await this.verifyRoot();
    const entries = [];
    const excluded = [];
    const names = new Set();
    const walk = async (folder = "") => {
      const absolute = folder ? await safePath(this.root, folder, { allowMissing: false }) : this.root;
      const children = (await fsp.readdir(absolute)).sort();
      for (const name of children) {
        const relative = folder ? `${folder}/${name}` : name;
        const reason = protectedReason(relative);
        if (reason) { excluded.push({ path: relative, reason }); continue; }
        validPath(relative);
        const stat = await fsp.lstat(path.join(absolute, name));
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) { excluded.push({ path: relative, reason: "link-or-special" }); continue; }
        if (stat.isDirectory()) { await walk(relative); continue; }
        // Only the selected root's output PDF is known to be generated. Input PDFs are retained.
        if (rootFile && relative === rootFile.replace(/\.tex$/i, ".pdf")) { excluded.push({ path: relative, reason: "build-output" }); continue; }
        const key = relative.normalize("NFC").toLowerCase();
        if (names.has(key)) throw fail("PATH_COLLISION", "History contains file names that collide on another supported platform.");
        names.add(key);
        const file = await readRegular(this.root, relative, this.maxFileBytes);
        if (!file) throw fail("EXTERNAL_CHANGE", "A project file disappeared while recording history.");
        if (store) await this.putBlob(file.bytes);
        entries.push({ path: relative, blob: file.hash, size: file.size, mode: file.mode });
      }
    };
    await walk();
    await this.verifyRoot();
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { schema: 1, rootFile, entries, excluded, policy: 1 };
  }

  async verifyRoot() {
    const root = await fsp.realpath(this.requestedRoot);
    const stat = await fsp.stat(root);
    if (`${root}\0${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== this.identity) throw fail("STALE_WORKSPACE", "The project folder was replaced during a history operation.");
  }

  async capture({ persist = true, ...options } = {}) {
    if (options.rootFile) validPath(options.rootFile);
    const first = await this.scan({ ...options, store: persist });
    await this.fault("capture-between-scans");
    const second = await this.scan(options);
    if (JSON.stringify(first) !== JSON.stringify(second)) throw fail("EXTERNAL_CHANGE", "The project changed while recording history. Try again after external edits finish.");
    const bytes = JSON.stringify(first);
    const id = hash(bytes);
    if (persist) await atomicWrite(this.file("trees", id), bytes);
    return { id, ...first };
  }

  async tree(id) {
    const value = await this.readJson("trees", id);
    if (hash(JSON.stringify(value)) !== id || value.schema !== 1 || !Array.isArray(value.entries)) throw fail("STORE_CORRUPT", "The version manifest is damaged.");
    const paths = new Set();
    for (const entry of value.entries) {
      validPath(entry.path);
      if (protectedReason(entry.path) || !validId(entry.blob) || !/^[a-f0-9]{64}$/.test(entry.blob) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw fail("STORE_CORRUPT", "The version contains an unsafe file entry.");
      const normalized = entry.path.normalize("NFC").toLowerCase();
      if (paths.has(normalized)) throw fail("STORE_CORRUPT", "The version contains duplicate paths.");
      paths.add(normalized);
    }
    if (value.rootFile) validPath(value.rootFile);
    return { id, ...value };
  }

  async list() {
    const files = (await fsp.readdir(path.join(this.directory, "versions"))).filter((s) => s.endsWith(".json"));
    const records = [];
    for (const file of files) {
      const record = await this.readJson("versions", file.slice(0, -5));
      if (record.id !== file.slice(0, -5) || !validId(record.treeId) || !Number.isSafeInteger(record.sequence)) throw fail("STORE_CORRUPT", "A version record is damaged.");
      const label = await fsp.readFile(this.file("labels", record.id), "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw fail("STORE_CORRUPT", "A version name is damaged."); });
      records.push({ ...record, label: label?.text || record.label || "", labelRevision: label?.revision || 0 });
    }
    return records.sort((a, b) => b.sequence - a.sequence);
  }

  async publish(tree, { id = crypto.randomUUID(), kind = "manual", label = "", restoredFrom = null, preRestore = null } = {}) {
    const records = await this.list();
    const existing = records.find((record) => record.id === id);
    if (existing) return existing;
    const previous = records[0];
    const before = previous ? await this.tree(previous.treeId) : { entries: [] };
    const changes = HistoryStore.changes(before, tree);
    const record = { schema: 1, id, treeId: tree.id, sequence: (previous?.sequence || 0) + 1, createdAt: new Date().toISOString(), kind,
      label: String(label).trim().slice(0, 120), restoredFrom, preRestore, previous: previous?.id || null,
      summary: { added: changes.filter((c) => c.kind === "added").length, deleted: changes.filter((c) => c.kind === "deleted").length, changed: changes.filter((c) => c.kind === "changed").length } };
    await this.fault("before-version-publish");
    await atomicWrite(this.file("versions", id), JSON.stringify(record), { exclusive: true });
    await this.fault("after-version-publish");
    return record;
  }

  async label(id, text, expectedRevision) {
    const record = (await this.list()).find((entry) => entry.id === id);
    if (!record) throw fail("NOT_FOUND", "The version was not found.");
    if (record.labelRevision !== expectedRevision) throw fail("STALE_LABEL", "The version name changed. Refresh history first.");
    if (typeof text !== "string" || text.length > 120) throw fail("INVALID_LABEL", "Keep version names within 120 characters.");
    await atomicWrite(this.file("labels", id), JSON.stringify({ text: text.trim(), revision: expectedRevision + 1 }));
  }

  static changes(before, after) {
    const left = new Map(before.entries.map((entry) => [entry.path, entry]));
    const right = new Map(after.entries.map((entry) => [entry.path, entry]));
    return [...new Set([...left.keys(), ...right.keys()])].sort().flatMap((name) => {
      const original = left.get(name), modified = right.get(name);
      if (original?.blob === modified?.blob && original?.mode === modified?.mode) return [];
      return [{ path: name, kind: !original ? "added" : !modified ? "deleted" : "changed", original: original || null, modified: modified || null }];
    });
  }
}

module.exports = { HistoryStore };

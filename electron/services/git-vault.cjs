"use strict";

// Main-process only. The returned metadata and file bodies can contain secrets:
// never forward read()/confirmRestore() results to renderer, logs or diagnostics.
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const v8 = require("node:v8");
const MAGIC = Buffer.from("T64GVA01");
const ID = /^[a-f0-9]{32}$/;
const digest = (data) => crypto.createHash("sha256").update(data).digest("hex");
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function inside(root, candidate) { const rel = path.relative(root, candidate); return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)); }
function relativeName(name) {
  if (typeof name !== "string" || !name || name.includes("\0") || name.includes("\\") || path.posix.isAbsolute(name) || name.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw failure("VAULT_PATH", "Unsupported protection path.");
  }
  return name;
}
function stamp(stat) { return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":"); }
function descriptor(entry) {
  if (!entry) return null;
  const { path: name, type, mode, hash, size, target } = entry;
  return { path: name, type, mode, ...(type === "file" ? { hash, size } : {}), ...(type === "symlink" ? { target } : {}) };
}
async function canonicalLocation(directory) {
  try { return await fs.realpath(directory); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await canonicalLocation(parent), path.basename(directory));
  }
}
async function readExactFile(handle, size) {
  // readFile() can allocate without bound if another process grows the file.
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(content, offset, size - offset, offset);
    if (!bytesRead) throw failure("VAULT_CHANGED", "A project file changed while being protected.");
    offset += bytesRead;
  }
  const extra = await handle.read(Buffer.alloc(1), 0, 1, size);
  if (extra.bytesRead) throw failure("VAULT_CHANGED", "A project file changed while being protected.");
  return content;
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } catch (error) { if (!["EINVAL", "ENOTSUP"].includes(error.code)) throw error; }
  finally { await handle.close(); }
}

class GitVault {
  #key;
  #plans = new Map();
  constructor({ directory, key, maxCaptureBytes = 256 * 1024 * 1024, maxBytes = 2 * 1024 * 1024 * 1024, maxEntries = 100000 } = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw failure("VAULT_KEY", "A 32-byte protection key is required.");
    if (typeof directory !== "string" || !path.isAbsolute(directory)) throw failure("VAULT_PATH", "An absolute protection directory is required.");
    for (const value of [maxCaptureBytes, maxBytes, maxEntries]) if (!Number.isSafeInteger(value) || value < 1) throw failure("VAULT_LIMIT", "Invalid protection limit.");
    this.directory = directory;
    this.#key = Buffer.from(key);
    this.maxCaptureBytes = maxCaptureBytes;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.queue = Promise.resolve();
  }

  // One instance per user-data vault; the operation controller owns process-wide exclusion.
  exclusive(action) { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }

  async ready() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("VAULT_PATH", "Protection storage is not a regular directory.");
    await fs.chmod(this.directory, 0o700);
    return fs.realpath(this.directory);
  }

  async rootInfo(root) {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw failure("VAULT_PATH", "An absolute project root is required.");
    const stat = await fs.lstat(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("VAULT_STRUCTURE", "The project root must be a regular directory.");
    const canonical = await fs.realpath(root);
    const vault = await canonicalLocation(this.directory);
    if (inside(canonical, vault) || inside(vault, canonical)) throw failure("VAULT_PATH", "Protection storage must be outside the project.");
    await this.ready();
    return { root: canonical, identity: `${stat.dev}:${stat.ino}` };
  }

  async scan(root) {
    const info = await this.rootInfo(root);
    const entries = [];
    const stamps = [];
    let totalBytes = 0;
    const walk = async (directory, prefix) => {
      const before = await fs.lstat(directory, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) throw failure("VAULT_CHANGED", "The project changed while being protected.");
      if ((Number(before.mode) & 0o444) === 0 || (Number(before.mode) & 0o111) === 0) throw failure("VAULT_UNREADABLE", "A project directory cannot be read.");
      const names = (await fs.readdir(directory)).sort();
      const folded = new Set();
      for (const name of names) {
        const lower = name.normalize("NFC").toLowerCase();
        if (folded.has(lower)) throw failure("VAULT_STRUCTURE", "Case-colliding project paths are unsupported.");
        folded.add(lower);
        if (lower === ".git") {
          if (prefix || name !== ".git") throw failure("VAULT_STRUCTURE", "Nested repositories are unsupported.");
          const git = await fs.lstat(path.join(directory, name));
          if (!git.isDirectory() || git.isSymbolicLink()) throw failure("VAULT_STRUCTURE", "Linked worktrees are unsupported.");
          continue;
        }
        const rel = relativeName(prefix ? `${prefix}/${name}` : name);
        if (entries.length >= this.maxEntries) throw failure("VAULT_LIMIT", "The project has too many entries to protect.");
        const absolute = path.join(directory, name);
        const stat = await fs.lstat(absolute, { bigint: true });
        const entry = { path: rel, mode: Number(stat.mode) & 0o777 };
        if (stat.isDirectory()) {
          entry.type = "directory";
          entries.push(entry);
          await walk(absolute, rel);
        } else if (stat.isFile()) {
          if ((Number(stat.mode) & 0o444) === 0) throw failure("VAULT_UNREADABLE", "A project file cannot be read.");
          const size = Number(stat.size);
          totalBytes += size;
          if (!Number.isSafeInteger(size) || totalBytes > this.maxCaptureBytes) throw failure("VAULT_LIMIT", "The project exceeds the protection size limit.");
          const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            if (stamp(await handle.stat({ bigint: true })) !== stamp(stat)) throw failure("VAULT_CHANGED", "A project file changed while being protected.");
            const content = await readExactFile(handle, size);
            if (content.length !== size || stamp(await handle.stat({ bigint: true })) !== stamp(stat) || stamp(await fs.lstat(absolute, { bigint: true })) !== stamp(stat)) throw failure("VAULT_CHANGED", "A project file changed while being protected.");
            Object.assign(entry, { type: "file", size, hash: digest(content), content });
          } finally { await handle.close(); }
          entries.push(entry);
        } else if (stat.isSymbolicLink()) {
          const target = await fs.readlink(absolute);
          // Never copy a link target. Reject traversable directories and paths
          // escaping the root rather than depending on their external contents.
          const resolved = path.resolve(directory, target);
          if (!inside(info.root, resolved)) throw failure("VAULT_STRUCTURE", "Links outside the project are unsupported.");
          try {
            const realTarget = await fs.realpath(absolute);
            if (!inside(info.root, realTarget) || (await fs.stat(absolute)).isDirectory()) throw failure("VAULT_STRUCTURE", "Directory or escaping links are unsupported.");
          } catch (error) { if (error.code !== "ENOENT") throw error; }
          if (stamp(await fs.lstat(absolute, { bigint: true })) !== stamp(stat)) throw failure("VAULT_CHANGED", "A project link changed while being protected.");
          totalBytes += Buffer.byteLength(target);
          if (totalBytes > this.maxCaptureBytes) throw failure("VAULT_LIMIT", "The project exceeds the protection size limit.");
          Object.assign(entry, { type: "symlink", target });
          entries.push(entry);
        } else throw failure("VAULT_STRUCTURE", "Special project files are unsupported.");
        stamps.push([rel, stamp(stat)]);
      }
      if (stamp(await fs.lstat(directory, { bigint: true })) !== stamp(before)) throw failure("VAULT_CHANGED", "A project directory changed while being protected.");
      stamps.push([prefix, stamp(before)]);
    };
    try { await walk(info.root, ""); }
    catch (error) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) throw failure("VAULT_CHANGED", "The project changed while being protected.");
      if (["EACCES", "EPERM"].includes(error.code)) throw failure("VAULT_UNREADABLE", "A project file cannot be read.");
      throw error;
    }
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const fingerprint = digest(v8.serialize({ ...info, entries: entries.map(descriptor), stamps }));
    return { ...info, entries, totalBytes, fingerprint };
  }

  async usage() {
    await this.ready();
    let bytes = 0;
    for (const name of await fs.readdir(this.directory)) {
      const stat = await fs.lstat(path.join(this.directory, name));
      // Include unpublished encrypted files left by crashes in the capacity budget.
      if (!stat.isFile() || stat.isSymbolicLink()) throw failure("VAULT_STRUCTURE", "Unexpected entry in protection storage.");
      bytes += stat.size;
    }
    return bytes;
  }

  capture({ root, metadata = null }) {
    return this.exclusive(async () => {
      let metadataBytes;
      try { metadataBytes = v8.serialize(metadata); } catch { throw failure("VAULT_METADATA", "Protection metadata is not serializable."); }
      if (metadataBytes.length > this.maxCaptureBytes) throw failure("VAULT_LIMIT", "Protection metadata is too large.");
      // Clone now so a caller cannot mutate index/ref metadata during capture.
      const clonedMetadata = v8.deserialize(metadataBytes);
      const first = await this.scan(root);
      const second = await this.scan(root);
      if (first.fingerprint !== second.fingerprint) throw failure("VAULT_CHANGED", "The project changed while being protected.");
      const id = crypto.randomBytes(16).toString("hex");
      const createdAt = new Date().toISOString();
      const payload = v8.serialize({ version: 1, id, createdAt, ...first, metadata: clonedMetadata });
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", this.#key, iv);
      cipher.setAAD(Buffer.concat([MAGIC, Buffer.from(id)]));
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
      const output = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
      if ((await this.usage()) + output.length > this.maxBytes) throw failure("VAULT_FULL", "Protection storage is full; existing recovery data was retained.");
      const temporary = path.join(this.directory, `.${id}.tmp`);
      const destination = this.file(id);
      let published = false;
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try { await handle.writeFile(output); await handle.sync(); } finally { await handle.close(); }
        // Publish without replacing any existing record, then persist directory entries.
        await fs.link(temporary, destination);
        published = true;
        await fs.unlink(temporary);
        await syncDirectory(this.directory);
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        // Once published, retain a valid recovery record even if directory fsync failed.
        if (published) error.vaultId = id;
        throw error;
      }
      return { id, manifest: { id, createdAt, fingerprint: first.fingerprint, entries: first.entries.map(descriptor), totalBytes: first.totalBytes } };
    });
  }

  file(id) { if (!ID.test(id)) throw failure("VAULT_ID", "Invalid protection record."); return path.join(this.directory, `${id}.vault`); }

  async read(id) {
    await this.ready();
    const handle = await fs.open(this.file(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    let output;
    try {
      const stat = await handle.stat();
      // Payload contains base64-free binary bodies plus bounded path/metadata overhead.
      if (!stat.isFile() || stat.size > 2 * this.maxCaptureBytes + this.maxEntries * 4096) throw failure("VAULT_LIMIT", "Protection record exceeds the read limit.");
      output = await handle.readFile();
    } finally { await handle.close(); }
    try {
      if (output.length < 36 || !output.subarray(0, 8).equals(MAGIC)) throw new Error();
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.#key, output.subarray(8, 20));
      decipher.setAAD(Buffer.concat([MAGIC, Buffer.from(id)]));
      decipher.setAuthTag(output.subarray(20, 36));
      const value = v8.deserialize(Buffer.concat([decipher.update(output.subarray(36)), decipher.final()]));
      if (value.version !== 1 || value.id !== id || !Array.isArray(value.entries)) throw new Error();
      return value;
    } catch { throw failure("VAULT_AUTH", "Protection data could not be authenticated with this key."); }
  }

  async fingerprint({ root }) { const scan = await this.scan(root); return scan.fingerprint; }

  async planRestore({ id, root, paths }) {
    if (!Array.isArray(paths) || !paths.length || paths.length > this.maxEntries) throw failure("VAULT_PATH", "Explicit restoration paths are required.");
    const selected = [...new Set(paths.map(relativeName))].sort();
    const saved = await this.read(id);
    const current = await this.scan(root);
    if (current.root !== saved.root || current.identity !== saved.identity) throw failure("VAULT_ROOT", "This protection record belongs to another project.");
    const originals = new Map(saved.entries.map((entry) => [entry.path, entry]));
    const live = new Map(current.entries.map((entry) => [entry.path, entry]));
    const changes = selected.map((name) => ({ path: name, expected: descriptor(live.get(name)), desired: descriptor(originals.get(name)) }));
    const planId = crypto.randomBytes(16).toString("hex");
    this.#plans.clear(); // Latest confirmation only; no stale plan accumulation.
    this.#plans.set(planId, { id, root: current.root, fingerprint: current.fingerprint, paths: selected, originals, live, changes });
    return { planId, fingerprint: current.fingerprint, changes };
  }

  // Read-only CAS gate for the controller's journaled, path-scoped transaction.
  // This is NOT an OS filesystem lock. The controller must recheck immediately
  // before each mutation and retain displaced data; arbitrary external writers
  // cannot be made atomic with hash-check + rename on a portable filesystem.
  async confirmRestore(planId) {
    const plan = this.#plans.get(planId);
    if (!plan) throw failure("VAULT_PLAN", "The restoration plan has expired.");
    const current = await this.scan(plan.root);
    if (current.fingerprint !== plan.fingerprint) throw failure("VAULT_CHANGED", "The project changed; create a new restoration plan.");
    return v8.deserialize(v8.serialize({ id: plan.id, root: plan.root, fingerprint: plan.fingerprint, changes: plan.paths.map((name) => ({ path: name, expected: plan.live.get(name) || null, desired: plan.originals.get(name) || null })) }));
  }

  // Deliberately no bulk overwrite, deletion or implicit pruning API. Deletion
  // must be an explicit controller request after checking recovery references.
  remove(id, { explicit = false } = {}) {
    if (explicit !== true) return Promise.reject(failure("VAULT_DELETE", "Explicit deletion is required."));
    return this.exclusive(async () => { await this.ready(); await fs.unlink(this.file(id)); await syncDirectory(this.directory); });
  }
}

module.exports = { GitVault };

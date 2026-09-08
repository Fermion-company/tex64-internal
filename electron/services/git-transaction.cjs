"use strict";
// Main-only transaction protection. Git semantics and workspace writer leases
// belong to the caller; no data from vault.read() is a renderer response.
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const v8 = require("node:v8");
const { GitState } = require("./git-state.cjs");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const idPattern = /^[a-f0-9]{32}$/;
const metadataFiles = ["HEAD", "index", "ORIG_HEAD", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE", "CHERRY_PICK_HEAD", "REVERT_HEAD", "SQUASH_MSG", "index.lock"];
const terminal = new Set(["completed", "cancelled-before-action", "recovered", "shelved", "unshelved"]);
async function canonicalLocation(directory) {
  try { return await fs.realpath(directory); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await canonicalLocation(parent), path.basename(directory));
  }
}
async function syncDirectory(directory) { const fd = await fs.open(directory, "r"); try { await fd.sync(); } finally { await fd.close(); } }

class GitTransaction {
  #queue = Promise.resolve();
  #plans = new Map();
  #shelvePlans = new Map();
  constructor({ runner, vault, directory }) {
    if (!runner?.run || !vault?.capture || !path.isAbsolute(directory || "")) throw fail("GIT_TRANSACTION_CONFIG", "Transaction dependencies are required.");
    this.runner = runner; this.vault = vault; this.directory = directory;
    this.rootKey = hash(runner.root);
  }
  exclusive(action) { const result = this.#queue.then(action); this.#queue = result.catch(() => {}); return result; }
  async ready() {
    const rel = path.relative(this.runner.root, await canonicalLocation(this.directory));
    if (!rel || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`))) throw fail("GIT_TRANSACTION_CONFIG", "Transaction journals must be outside the project.");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("GIT_TRANSACTION_CONFIG", "Transaction journal storage is unsafe.");
    await fs.chmod(this.directory, 0o700);
  }
  journalPath(id) { if (!idPattern.test(id)) throw fail("GIT_TRANSACTION_ID", "Invalid transaction identifier."); return path.join(this.directory, `${id}.json`); }
  async write(journal) {
    await this.ready();
    const serialized = JSON.stringify(journal);
    if (Buffer.byteLength(serialized) > MAX_JOURNAL_BYTES) throw fail("GIT_JOURNAL_LIMIT", "The recovery journal exceeds its size limit.");
    const temp = path.join(this.directory, `.${journal.id}.${crypto.randomBytes(8).toString("hex")}.tmp`);
    try {
      const fd = await fs.open(temp, "wx", 0o600);
      try { await fd.writeFile(serialized); await fd.sync(); } finally { await fd.close(); }
      await fs.rename(temp, this.journalPath(journal.id));
      await syncDirectory(this.directory);
    } catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
  }
  async read(id) {
    const fd = await fs.open(this.journalPath(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES) throw fail("GIT_JOURNAL_INVALID", "Transaction journal is invalid.");
      const value = JSON.parse(await fd.readFile("utf8"));
      if (value.version !== 1 || value.id !== id || value.rootKey !== this.rootKey || typeof value.phase !== "string" || !idPattern.test(value.beforeVault || "")) throw fail("GIT_JOURNAL_INVALID", "Transaction journal does not match this project.");
      return value;
    } finally { await fd.close(); }
  }
  summary(journal) {
    // No Git metadata, raw error, filenames, file contents, or callback result.
    return { id: journal.id, kind: journal.kind, phase: journal.phase, createdAt: journal.createdAt, updatedAt: journal.updatedAt, outcome: journal.outcome || null, recoveryRequired: !terminal.has(journal.phase), hasBefore: Boolean(journal.beforeVault), hasAfter: Boolean(journal.afterVault), hasRecoveryProtection: Boolean(journal.recoveryVault), ...(journal.shelveBase ? { base: journal.shelveBase, paths: journal.shelvePaths || [] } : {}) };
  }
  async list() {
    await this.ready();
    const result = [];
    for (const name of (await fs.readdir(this.directory)).sort()) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
      const fd = await fs.open(path.join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      let rootKey;
      try { const stat = await fd.stat(); if (stat.size > MAX_JOURNAL_BYTES) throw fail("GIT_JOURNAL_INVALID", "Transaction journal is invalid."); rootKey = JSON.parse(await fd.readFile("utf8")).rootKey; } finally { await fd.close(); }
      if (rootKey !== this.rootKey) continue;
      result.push(this.summary(await this.read(name.slice(0, -5))));
    }
    return result;
  }

  async snapshotGit() {
    const state = await new GitState({ runner: this.runner }).read();
    // File protection does not execute configured filters/hooks. Their trust
    // checks remain mandatory in the command service before actionCallback.
    if (!state.repository || state.layout !== "standard") throw fail("GIT_TRANSACTION_UNSUPPORTED", "This repository structure cannot be protected.");
    if (state.operationMarkers.some((name) => ["rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"].includes(name))) throw fail("GIT_TRANSACTION_UNSUPPORTED", "This Git operation requires separate recovery support.");
    if ((await fs.readdir(state.gitDir)).some((name) => name.startsWith("sharedindex."))) throw fail("GIT_TRANSACTION_UNSUPPORTED", "Split-index repositories require separate recovery support.");
    const files = {};
    for (const name of metadataFiles) {
      let fd;
      try {
        fd = await fs.open(path.join(state.gitDir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await fd.stat();
        if (!stat.isFile() || stat.size > 3 * 1024 * 1024) throw fail("GIT_PROTECTION_LIMIT", "Git metadata exceeds the protection limit.");
        const content = Buffer.alloc(stat.size);
        let position = 0;
        while (position < content.length) { const { bytesRead } = await fd.read(content, position, content.length - position, position); if (!bytesRead) throw fail("STATE_CHANGED", "Git metadata changed while being protected."); position += bytesRead; }
        const end = await fd.read(Buffer.alloc(1), 0, 1, position);
        const after = await fd.stat();
        if (end.bytesRead || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw fail("STATE_CHANGED", "Git metadata changed while being protected.");
        files[name] = { content, mode: stat.mode & 0o777 };
      } catch (error) { if (error.code === "ENOENT") files[name] = null; else throw error; }
      finally { await fd?.close(); }
    }
    // Retain the immutable blob bodies referenced by every index stage; merely
    // retaining index bytes is insufficient if a later Git GC prunes its blobs.
    const staged = (await this.runner.run(["ls-files", "--stage", "-z"], { readOnly: true })).stdout.toString("utf8").split("\0").filter(Boolean);
    const indexBlobs = {};
    let blobBytes = 0;
    for (const record of staged) {
      const match = /^(\d+) ([a-f0-9]{40,64}) [0-3]\t/.exec(record);
      if (!match || match[1] === "160000") throw fail("GIT_TRANSACTION_UNSUPPORTED", "Submodule or unsupported index entries cannot be protected.");
      if (/^0+$/.test(match[2]) || indexBlobs[match[2]]) continue;
      const content = (await this.runner.run(["cat-file", "blob", match[2]], { readOnly: true })).stdout;
      blobBytes += content.length;
      if (blobBytes > this.vault.maxCaptureBytes) throw fail("GIT_PROTECTION_LIMIT", "Index blobs exceed the protection limit.");
      indexBlobs[match[2]] = content;
    }
    const value = { indexBlobs, repositoryId: state.repositoryId, gitDir: state.gitDir, head: state.head, branchRef: state.branchRef, refs: state.refs, configFingerprint: state.configFingerprint, operation: state.operation, files };
    return { ...value, fingerprint: hash(v8.serialize(value)) };
  }
  async stableGit() {
    const first = await this.snapshotGit(), second = await this.snapshotGit();
    if (first.fingerprint !== second.fingerprint) throw fail("STATE_CHANGED", "Git changed while being protected.");
    return first;
  }
  async protect(kind) {
    const git = await this.stableGit();
    const saved = await this.vault.capture({ root: this.runner.root, metadata: { kind, git } });
    const rechecked = await this.stableGit();
    if (rechecked.fingerprint !== git.fingerprint || await this.vault.fingerprint({ root: this.runner.root }) !== saved.manifest.fingerprint) throw fail("STATE_CHANGED", "The project changed while being protected.", { vaultId: saved.id });
    return { id: saved.id, git, filesFingerprint: saved.manifest.fingerprint };
  }

  run(meta, actionCallback) {
    meta = meta ? { ...meta, kind: meta.kind || meta.action } : meta;
    return this.exclusive(async () => {
      if (!meta || !/^[a-z][a-z0-9-]{0,63}$/.test(meta.kind || "") || typeof meta.verify !== "function" || typeof actionCallback !== "function") throw fail("GIT_VERIFY_REQUIRED", "An operation kind and result verifier are required.");
      const pending = (await this.list()).filter((item) => item.recoveryRequired);
      const resume = meta.resumeId ? pending.find((item) => item.id === meta.resumeId && item.phase === "conflict") : null;
      if (pending.some((item) => item !== resume) || (resume && !["resolution", "resolve-stage", "merge-finish", "merge-abort"].includes(meta.kind)) || (meta.resumeId && !resume)) throw fail("GIT_RECOVERY_REQUIRED", "Resolve the previous Git operation before starting another.");
      const before = await this.protect(meta.kind);
      if (before.git.files["index.lock"]) throw fail("GIT_LOCKED", "Another Git operation owns the index lock.");
      if ((meta.expectedGitFingerprint && before.git.fingerprint !== meta.expectedGitFingerprint) || (meta.expectedFilesFingerprint && before.filesFingerprint !== meta.expectedFilesFingerprint)) throw fail("STATE_CHANGED", "The operation plan is no longer current.");
      const journal = { ...(resume ? { resumeId: resume.id } : {}), version: 1, id: crypto.randomBytes(16).toString("hex"), rootKey: this.rootKey, kind: meta.kind, phase: "prepared", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), beforeVault: before.id, beforeGit: before.git.fingerprint, beforeFiles: before.filesFingerprint };
      await this.write(journal);
      try {
        if (meta.signal?.aborted) { journal.phase = "cancelled-before-action"; await this.write(journal); throw fail("GIT_CANCELLED", "Git operation was cancelled before execution."); }
        // Durable running precedes any child/process mutation. A crash from this
        // point onward is never interpreted as cancellation or success.
        journal.phase = "running"; await this.write(journal);
        const result = await actionCallback({ id: journal.id, before: before.git });
        Object.assign(journal, await this.read(journal.id));
        const after = await this.protect(`${meta.kind}-after`);
        Object.assign(journal, { afterVault: after.id, afterGit: after.git.fingerprint, afterFiles: after.filesFingerprint, phase: "verifying" });
        await this.write(journal);
        let outcome = await meta.verify({ before: before.git, after: after.git, result });
        if (outcome === "conflict" && after.git.operation !== "merge") throw fail("GIT_RESULT_UNVERIFIED", "Git is not in the expected merge state.");
        if (resume && ["resolution", "resolve-stage"].includes(meta.kind) && outcome === "conflict") outcome = "completed";
        if (!["completed", "conflict"].includes(outcome)) throw fail("GIT_RESULT_UNVERIFIED", "Git result did not pass verification.");
        // A verifier must not mutate state; detect external writes during it too.
        if ((await this.stableGit()).fingerprint !== after.git.fingerprint || await this.vault.fingerprint({ root: this.runner.root }) !== after.filesFingerprint) throw fail("STATE_CHANGED", "The project changed while verifying the Git result.");
        Object.assign(journal, { outcome, phase: outcome === "conflict" ? "conflict" : meta.kind === "shelve" ? "shelved" : "completed", updatedAt: new Date().toISOString() });
        await this.write(journal);
        if (resume && ["merge-finish", "merge-abort"].includes(meta.kind) && outcome === "completed") {
          const parent = await this.read(resume.id);
          parent.phase = "completed"; parent.outcome = meta.kind; parent.continuedBy = journal.id; parent.updatedAt = new Date().toISOString();
          await this.write(parent);
        }
        const oldFiles = new Map((await this.vault.read(before.id)).entries.map((entry) => [entry.path, entry]));
        const newFiles = new Map((await this.vault.read(after.id)).entries.map((entry) => [entry.path, entry]));
        const identity = (entry) => entry ? JSON.stringify([entry.type, entry.mode, entry.hash || null, entry.target || null]) : null;
        const changedPaths = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].filter((name) => identity(oldFiles.get(name)) !== identity(newFiles.get(name))).sort();
        return { transaction: this.summary(journal), result, changedPaths };
      } catch (error) {
        if (journal.phase === "cancelled-before-action") throw error;
        Object.assign(journal, await this.read(journal.id));
        journal.phase = "recovery-required"; journal.updatedAt = new Date().toISOString();
        // Raw errors can contain Git/file contents. Persist only a bounded code.
        journal.errorCode = /^[A-Z0-9_]{1,64}$/.test(error.code || "") ? error.code : "GIT_OPERATION_FAILED";
        try { const after = await this.protect(`${meta.kind}-interrupted`); Object.assign(journal, { recoveryVault: after.id, recoveryGit: after.git.fingerprint, recoveryFiles: after.filesFingerprint }); } catch { journal.protectionIncomplete = true; }
        await this.write(journal);
        throw fail("GIT_RECOVERY_REQUIRED", "Git operation needs verification before continuing.", { transactionId: journal.id, causeCode: journal.errorCode });
      }
    });
  }

  // Read-only diagnosis + additional durable protection. No automatic rollback:
  // an unknown post-crash state might include changes from an external writer.
  recover(id) {
    return this.exclusive(async () => {
      const journal = await this.read(id);
      if (terminal.has(journal.phase)) return { transaction: this.summary(journal), match: "terminal" };
      const current = await this.protect(`${journal.kind}-recovery`);
      const match = current.git.fingerprint === journal.beforeGit && current.filesFingerprint === journal.beforeFiles ? "before" : current.git.fingerprint === journal.afterGit && current.filesFingerprint === journal.afterFiles ? "after" : "different";
      Object.assign(journal, { phase: "recovery-required", recoveryVault: current.id, recoveryGit: current.git.fingerprint, recoveryFiles: current.filesFingerprint, updatedAt: new Date().toISOString() });
      await this.write(journal);
      return { transaction: this.summary(journal), match };
    });
  }
  entryIdentity(entry) { return entry ? JSON.stringify([entry.type, entry.mode, entry.hash || null, entry.target || null]) : null; }
  selectedPaths(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > this.vault.maxEntries) throw fail("GIT_PATH_INVALID", "Select restoration files explicitly.");
    return [...new Set(paths.map((name) => {
      if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0") || name.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw fail("GIT_PATH_INVALID", "Invalid project path.");
      return name;
    }))].sort();
  }
  async checkedPath(name, gitMetadata = false) {
    const root = gitMetadata ? path.join(this.runner.root, ".git") : this.runner.root;
    if (gitMetadata ? !metadataFiles.includes(name) || name === "index.lock" : this.selectedPaths([name]).length !== 1) throw fail("GIT_PATH_INVALID", "Invalid recovery target.");
    const parts = name.split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      directory = path.join(directory, part);
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("STATE_CHANGED", "A recovery directory changed.");
    }
    const real = await fs.realpath(directory);
    if (real !== directory) throw fail("STATE_CHANGED", "A recovery directory changed.");
    return path.join(root, ...parts);
  }
  async pathEntry(name, gitMetadata = false) {
    let absolute;
    try { absolute = await this.checkedPath(name, gitMetadata); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    let stat;
    try { stat = await fs.lstat(absolute); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (stat.isSymbolicLink()) return { path: name, type: "symlink", mode: stat.mode & 0o777, target: await fs.readlink(absolute) };
    if (stat.isDirectory()) return { path: name, type: "directory", mode: stat.mode & 0o777 };
    if (!stat.isFile() || stat.size > this.vault.maxCaptureBytes) throw fail("GIT_RECOVERY_UNSUPPORTED", "This recovery target is unsupported.");
    const fd = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const content = Buffer.alloc(stat.size); let offset = 0;
      while (offset < content.length) { const { bytesRead } = await fd.read(content, offset, content.length - offset, offset); if (!bytesRead) throw fail("STATE_CHANGED", "A recovery target changed while being read."); offset += bytesRead; }
      const extra = await fd.read(Buffer.alloc(1), 0, 1, offset), after = await fd.stat();
      if (extra.bytesRead || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw fail("STATE_CHANGED", "A recovery target changed while being read.");
      return { path: name, type: "file", mode: stat.mode & 0o777, size: content.length, hash: hash(content), content };
    } finally { await fd.close(); }
  }
  metadataEntry(name, value) { return value ? { path: name, type: "file", mode: value.mode, size: value.content.length, hash: hash(value.content), content: value.content } : null; }

  // Preserve any displaced inode until its contents have been checked. Creation
  // uses link/symlink/mkdir with EEXIST semantics, never an overwriting rename.
  // The journal records each path before mutation. This is a portable CAS guard,
  // not a filesystem-wide lock against arbitrary external processes.
  async replacePath(journal, name, expected, desired, gitMetadata = false) {
    const absolute = await this.checkedPath(name, gitMetadata);
    const actual = await this.pathEntry(name, gitMetadata);
    if (this.entryIdentity(actual) !== this.entryIdentity(expected)) throw fail("STATE_CHANGED", "A recovery target changed.");
    if (this.entryIdentity(expected) === this.entryIdentity(desired)) return;
    if (actual?.type === "directory" || desired?.type === "directory") {
      if (actual && desired) {
        if (actual.type !== "directory" || desired.type !== "directory") throw fail("GIT_RECOVERY_UNSUPPORTED", "Directory type changes require explicit child recovery.");
        journal.steps ||= []; const step = { path: name, gitMetadata, action: "chmod", phase: "prepared" }; journal.steps.push(step); await this.write(journal);
        const fd = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { if (!(await fd.stat()).isDirectory()) throw fail("STATE_CHANGED", "A recovery directory changed."); await fd.chmod(desired.mode); await fd.sync(); } finally { await fd.close(); }
        step.phase = "completed"; await this.write(journal); return;
      }
      journal.steps ||= []; const step = { path: name, gitMetadata, action: desired ? "mkdir" : "rmdir", phase: "prepared" }; journal.steps.push(step); await this.write(journal);
      if (desired) await fs.mkdir(absolute, { mode: desired.mode }); else await fs.rmdir(absolute);
      await syncDirectory(path.dirname(absolute)); step.phase = "completed"; await this.write(journal); return;
    }
    const suffix = crypto.randomBytes(16).toString("hex");
    const displaced = path.join(path.dirname(absolute), `.tex64-git-${suffix}.old`);
    const staging = path.join(path.dirname(absolute), `.tex64-git-${suffix}.new`);
    const step = { path: name, gitMetadata, action: "replace", displaced: path.basename(displaced), staging: path.basename(staging), phase: "prepared" };
    journal.steps ||= []; journal.steps.push(step); await this.write(journal);
    let lock;
    try {
      if (gitMetadata) lock = await fs.open(`${absolute}.lock`, "wx", 0o600);
      if (this.entryIdentity(await this.pathEntry(name, gitMetadata)) !== this.entryIdentity(expected)) throw fail("STATE_CHANGED", "A recovery target changed.");
      if (desired?.type === "file") {
        const fd = await fs.open(staging, "wx", desired.mode);
        try { await fd.writeFile(desired.content); await fd.chmod(desired.mode); await fd.sync(); } finally { await fd.close(); }
      }
      if (actual) {
        await fs.rename(absolute, displaced);
        step.phase = "displaced"; await this.write(journal);
        // Check after rename too: a write racing the initial comparison is kept
        // at the displaced path and never silently discarded.
        const movedStat = await fs.lstat(displaced);
        const moved = movedStat.isSymbolicLink() ? { type: "symlink", mode: movedStat.mode & 0o777, target: await fs.readlink(displaced) } : movedStat.isFile() ? { type: "file", mode: movedStat.mode & 0o777, hash: hash(await fs.readFile(displaced)) } : null;
        if (this.entryIdentity(moved) !== this.entryIdentity(expected)) {
          try { if (movedStat.isSymbolicLink()) await fs.symlink(await fs.readlink(displaced), absolute); else await fs.link(displaced, absolute); } catch (error) { if (error.code !== "EEXIST") throw error; }
          throw fail("STATE_CHANGED", "A concurrent edit was retained for recovery.");
        }
      }
      if (desired?.type === "file") await fs.link(staging, absolute);
      else if (desired?.type === "symlink") await fs.symlink(desired.target, absolute);
      if (this.entryIdentity(await this.pathEntry(name, gitMetadata)) !== this.entryIdentity(desired)) throw fail("STATE_CHANGED", "The restored path changed during recovery.");
      await syncDirectory(path.dirname(absolute));
      step.phase = "installed"; await this.write(journal);
      // The matching expected bytes are already durable in the current-state vault.
      if (actual) {
        const stat = await fs.lstat(displaced);
        const retained = stat.isSymbolicLink() ? { type: "symlink", mode: stat.mode & 0o777, target: await fs.readlink(displaced) } : stat.isFile() ? { type: "file", mode: stat.mode & 0o777, hash: hash(await fs.readFile(displaced)) } : null;
        if (this.entryIdentity(retained) !== this.entryIdentity(expected)) throw fail("STATE_CHANGED", "A concurrent edit was retained for recovery.");
        await fs.unlink(displaced);
      }
      if (desired?.type === "file") await fs.unlink(staging);
      await syncDirectory(path.dirname(absolute));
      step.phase = "completed"; await this.write(journal);
    } finally {
      if (lock) {
        const owned = await lock.stat(); await lock.close();
        try { const current = await fs.lstat(`${absolute}.lock`); if (current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(`${absolute}.lock`); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      // On failure, keep staging/displaced files: both can contain a racing
      // external edit. Recovery diagnosis captures them, never auto-deletes them.
    }
  }

  async planRecovery(id, { paths } = {}) {
    const journal = await this.read(id);
    if (terminal.has(journal.phase)) throw fail("GIT_RECOVERY_NOT_PENDING", "This operation does not require recovery.");
    const before = await this.vault.read(journal.beforeVault);
    const after = journal.afterVault ? await this.vault.read(journal.afterVault) : null;
    const live = await this.protect(`${journal.kind}-recovery-plan`);
    const current = await this.vault.read(live.id);
    const originals = new Map(before.entries.map((entry) => [entry.path, entry]));
    const expected = new Map((after?.entries || []).map((entry) => [entry.path, entry]));
    const actual = new Map(current.entries.map((entry) => [entry.path, entry]));
    const changed = [...new Set([...originals.keys(), ...expected.keys()])].filter((name) => this.entryIdentity(originals.get(name)) !== this.entryIdentity(expected.get(name)));
    const selected = paths ? this.selectedPaths(paths) : changed;
    if (selected.some((name) => !changed.includes(name))) throw fail("GIT_RECOVERY_SCOPE", "Select only paths owned by this operation.");
    const blockedPaths = [], changes = [];
    for (const name of selected) {
      if (this.entryIdentity(actual.get(name)) === this.entryIdentity(originals.get(name))) continue;
      if (!after || this.entryIdentity(actual.get(name)) !== this.entryIdentity(expected.get(name))) { blockedPaths.push(name); continue; }
      const wanted = originals.get(name), existing = actual.get(name);
      if (wanted && existing && (wanted.type === "directory" || existing.type === "directory") && wanted.type !== existing.type) { blockedPaths.push(name); continue; }
      if (!wanted && existing?.type === "directory" && [...actual.keys()].some((child) => child.startsWith(`${name}/`) && (!selected.includes(child) || originals.has(child)))) { blockedPaths.push(name); continue; }
      changes.push({ path: name, expected: existing || null, desired: wanted || null });
    }
    const desiredGit = before.metadata.git, expectedGit = after?.metadata.git;
    const gitChanges = [], refChanges = [];
    let blockedGit = expectedGit ? current.metadata.git.configFingerprint !== expectedGit.configFingerprint : !(live.filesFingerprint === before.fingerprint && live.git.fingerprint === before.metadata.git.fingerprint);
    if (expectedGit) {
      for (const name of metadataFiles.filter((name) => name !== "index.lock")) {
        const wanted = this.metadataEntry(name, desiredGit.files[name]), old = this.metadataEntry(name, expectedGit.files[name]), now = this.metadataEntry(name, current.metadata.git.files[name]);
        if (this.entryIdentity(wanted) === this.entryIdentity(old) || this.entryIdentity(wanted) === this.entryIdentity(now)) continue;
        if (this.entryIdentity(old) !== this.entryIdentity(now)) blockedGit = true;
        else gitChanges.push({ path: name, expected: now, desired: wanted });
      }
      const originalRefs = new Map(desiredGit.refs.map((ref) => [ref.name, ref.oid])), oldRefs = new Map(expectedGit.refs.map((ref) => [ref.name, ref.oid])), liveRefs = new Map(current.metadata.git.refs.map((ref) => [ref.name, ref.oid]));
      for (const name of new Set([...originalRefs.keys(), ...oldRefs.keys()])) {
        const wanted = originalRefs.get(name) || null, old = oldRefs.get(name) || null, now = liveRefs.get(name) || null;
        if (wanted === old || wanted === now) continue;
        if (old !== now) blockedGit = true;
        else refChanges.push({ name, expected: now, desired: wanted });
      }
    }
    if (current.metadata.git.files["index.lock"]) blockedGit = true;
    const planId = crypto.randomBytes(16).toString("hex");
    this.#plans.clear();
    const knownBefore = !after && live.filesFingerprint === before.fingerprint && live.git.fingerprint === before.metadata.git.fingerprint;
    this.#plans.set(planId, { id, before, current, ownedPaths: changed, knownBefore, canApply: !blockedGit && !blockedPaths.length && (Boolean(after) || knownBefore), currentVault: live.id, filesFingerprint: live.filesFingerprint, gitFingerprint: live.git.fingerprint, changes, gitChanges, refChanges, blockedPaths, blockedGit });
    return { planId, changes: changes.map(({ path: name, expected: old, desired: wanted }) => ({ path: name, action: !wanted ? "delete" : !old ? "add" : "replace" })), blockedPaths, blockedGit, requiresManualReview: !after && !knownBefore, canApply: !blockedGit && !blockedPaths.length && (Boolean(after) || knownBefore) };
  }

  applyRecovery(planId) {
    return this.exclusive(async () => {
      const plan = this.#plans.get(planId);
      if (!plan) throw fail("GIT_RECOVERY_PLAN", "Create a new recovery plan.");
      if (!plan.canApply) throw fail("GIT_RECOVERY_BLOCKED", "Compare or export the protected files before recovering this state.");
      if ((await this.stableGit()).fingerprint !== plan.gitFingerprint || await this.vault.fingerprint({ root: this.runner.root }) !== plan.filesFingerprint) throw fail("STATE_CHANGED", "The recovery plan is no longer current.");
      const journal = await this.read(plan.id);
      journal.phase = "recovering"; journal.recoveryVault = plan.currentVault; await this.write(journal);
      try {
        if (!plan.blockedGit) await this.restoreIndexBlobs(plan.before.metadata.git.indexBlobs || {});
        const rank = (change) => change.desired?.type === "directory" ? 0 : change.expected?.type === "directory" ? 2 : 1;
        const changes = [...plan.changes].sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.path.length - a.path.length : a.path.length - b.path.length));
        for (const change of changes) await this.replacePath(journal, change.path, change.expected, change.desired);
        const originalEntries = new Map(plan.before.entries.map((entry) => [entry.path, entry]));
        const currentEntries = new Map(plan.current.entries.map((entry) => [entry.path, entry]));
        const allFilesRestorable = plan.ownedPaths.every((name) => changes.some((change) => change.path === name) || this.entryIdentity(currentEntries.get(name)) === this.entryIdentity(originalEntries.get(name)));
        if (!plan.blockedGit && !plan.blockedPaths.length && allFilesRestorable) {
          for (const change of plan.refChanges) {
            journal.refStep = { ...change, phase: "prepared" }; await this.write(journal);
            const zero = "0".repeat((change.expected || change.desired).length);
            await this.runner.run(change.desired ? ["update-ref", "--no-deref", change.name, change.desired, change.expected || zero] : ["update-ref", "--no-deref", "-d", change.name, change.expected]);
            journal.refStep.phase = "completed"; await this.write(journal);
          }
          for (const change of plan.gitChanges) await this.replacePath(journal, change.path, change.expected, change.desired, true);
        }
        const after = await this.protect(`${journal.kind}-recovered`);
        // Partial selections or blocked paths cannot complete the operation.
        const current = await this.vault.read(after.id);
        const actual = new Map(current.entries.map((entry) => [entry.path, entry]));
        const original = new Map(plan.before.entries.map((entry) => [entry.path, entry]));
        const restored = plan.ownedPaths.every((name) => this.entryIdentity(actual.get(name)) === this.entryIdentity(original.get(name)));
        const refs = new Map(after.git.refs.map((ref) => [ref.name, ref.oid]));
        const gitRestored = !plan.blockedGit && !plan.blockedPaths.length && plan.gitChanges.every((change) => this.entryIdentity(this.metadataEntry(change.path, after.git.files[change.path])) === this.entryIdentity(change.desired)) && plan.refChanges.every((change) => (refs.get(change.name) || null) === change.desired);
        Object.assign(journal, { phase: restored && gitRestored ? "recovered" : "recovery-required", recoveryVault: after.id, recoveryGit: after.git.fingerprint, recoveryFiles: after.filesFingerprint, updatedAt: new Date().toISOString() });
        await this.write(journal); this.#plans.delete(planId);
        return { transaction: this.summary(journal), changedPaths: changes.map((change) => change.path) };
      } catch (error) {
        journal.phase = "recovery-required"; journal.errorCode = "GIT_RECOVERY_INTERRUPTED";
        try { const protectedCurrent = await this.protect(`${journal.kind}-recovery-interrupted`); journal.recoveryVault = protectedCurrent.id; } catch { journal.protectionIncomplete = true; }
        await this.write(journal);
        throw fail("GIT_RECOVERY_REQUIRED", "Recovery stopped; the protected data was retained.", { transactionId: journal.id });
      }
    });
  }

  async restoreIndexBlobs(blobs) {
    // Write only immutable content-addressed objects, never mutable .git trees.
    // zlib's loose-object encoding is Git's documented object representation.
    const zlib = require("node:zlib");
    const format = (await this.runner.run(["rev-parse", "--show-object-format"], { readOnly: true })).stdout.toString("utf8").trim();
    if (!["sha1", "sha256"].includes(format)) throw fail("GIT_RECOVERY_UNSUPPORTED", "Unsupported Git object format.");
    for (const [oid, content] of Object.entries(blobs)) {
      const full = Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]);
      if (crypto.createHash(format).update(full).digest("hex") !== oid) throw fail("GIT_PROTECTION_INVALID", "Protected index blob is invalid.");
      const exists = await this.runner.run(["cat-file", "-e", oid], { readOnly: true, allowFailure: true });
      if (exists.code === 0) continue;
      const objects = path.join(this.runner.root, ".git", "objects");
      if ((await fs.lstat(objects)).isSymbolicLink() || await fs.realpath(objects) !== objects) throw fail("GIT_RECOVERY_UNSUPPORTED", "External object storage is unsupported.");
      const directory = path.join(objects, oid.slice(0, 2));
      await fs.mkdir(directory, { recursive: true });
      if ((await fs.lstat(directory)).isSymbolicLink()) throw fail("GIT_RECOVERY_UNSUPPORTED", "External object storage is unsupported.");
      const target = path.join(directory, oid.slice(2)), temporary = path.join(directory, `.tex64-${crypto.randomBytes(16).toString("hex")}`);
      try {
        const fd = await fs.open(temporary, "wx", 0o444); try { await fd.writeFile(zlib.deflateSync(full)); await fd.sync(); } finally { await fd.close(); }
        try { await fs.link(temporary, target); } catch (error) { if (error.code !== "EEXIST") throw error; }
        await fs.unlink(temporary); await syncDirectory(directory);
      } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
      await this.runner.run(["cat-file", "-e", oid], { readOnly: true });
    }
  }

  async baselineEntries(head, selected) {
    const output = head ? (await this.runner.run(["ls-tree", "-r", "-z", head], { readOnly: true })).stdout.toString("utf8").split("\0").filter(Boolean) : [];
    const tree = new Map();
    for (const record of output) {
      const tab = record.indexOf("\t"); const [mode, type, oid] = record.slice(0, tab).split(" ");
      const name = record.slice(tab + 1);
      if (!selected.includes(name)) continue;
      if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) throw fail("GIT_SHELVE_UNSUPPORTED", "This selected entry cannot be shelved.");
      const content = (await this.runner.run(["cat-file", "blob", oid], { readOnly: true })).stdout;
      if (mode === "120000") {
        const target = content.toString("utf8"), resolved = path.resolve(path.dirname(path.join(this.runner.root, name)), target), rel = path.relative(this.runner.root, resolved);
        if (!rel || path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) throw fail("GIT_SHELVE_UNSUPPORTED", "This link target cannot be restored safely.");
        tree.set(name, { path: name, type: "symlink", mode: process.platform === "darwin" ? 0o755 : 0o777, target });
      } else tree.set(name, { path: name, type: "file", mode: mode === "100755" ? 0o755 : 0o644, content, hash: hash(content), size: content.length });
    }
    return tree;
  }

  async planShelve({ paths, ignoredPaths = [] } = {}) {
    const selected = this.selectedPaths(paths), allowedIgnored = new Set(ignoredPaths.length ? this.selectedPaths(ignoredPaths) : []);
    const ignored = new Set((await this.runner.run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { readOnly: true })).stdout.toString("utf8").split("\0").filter(Boolean));
    if (selected.some((name) => ignored.has(name) && !allowedIgnored.has(name)) || [...allowedIgnored].some((name) => !selected.includes(name))) throw fail("GIT_IGNORED_SELECTION", "Ignored files require an explicit selection.");
    const git = await this.stableGit();
    if (git.operation !== "idle") throw fail("GIT_SHELVE_OPERATION", "Finish the current Git operation before shelving changes.");
    const baseline = await this.baselineEntries(git.head, selected), current = await this.vault.scan(this.runner.root);
    const files = new Map(current.entries.map((entry) => [entry.path, entry]));
    const staged = new Map();
    for (const record of (await this.runner.run(["ls-files", "--stage", "-z"], { readOnly: true })).stdout.toString("utf8").split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t"), [mode, oid, stage] = record.slice(0, tab).split(" ");
      if (stage !== "0") throw fail("GIT_SHELVE_OPERATION", "Resolve the current conflicts before shelving changes.");
      const content = git.indexBlobs[oid];
      if (!content) continue;
      staged.set(record.slice(tab + 1), mode === "120000" ? { type: "symlink", mode: process.platform === "darwin" ? 0o755 : 0o777, target: content.toString("utf8") } : { type: "file", mode: mode === "100755" ? 0o755 : 0o644, hash: hash(content) });
    }
    const changes = [];
    for (const name of selected) {
      const actual = files.get(name), desired = baseline.get(name), index = staged.get(name);
      if (actual?.type === "directory") throw fail("GIT_SHELVE_UNSUPPORTED", "Select individual files rather than folders.");
      const hasStaged = this.entryIdentity(index) !== this.entryIdentity(desired), hasUnstaged = this.entryIdentity(actual) !== this.entryIdentity(index);
      if (!hasStaged && !hasUnstaged) continue;
      changes.push({ path: name, action: this.entryIdentity(actual) === this.entryIdentity(desired) ? "unstage" : !desired ? "delete" : !actual ? "add" : "replace", staged: hasStaged, unstaged: hasUnstaged, ignored: ignored.has(name) });
    }
    if (!changes.length) throw fail("GIT_NOTHING_TO_SHELVE", "The selected files have no changes to shelve.");
    if ((await this.stableGit()).fingerprint !== git.fingerprint || await this.vault.fingerprint({ root: this.runner.root }) !== current.fingerprint) throw fail("STATE_CHANGED", "The project changed while planning the shelving operation.");
    const planId = crypto.randomBytes(16).toString("hex");
    this.#shelvePlans.clear(); this.#shelvePlans.set(planId, { paths: changes.map((change) => change.path), ignoredPaths: [...allowedIgnored].filter((name) => changes.some((change) => change.path === name)), gitFingerprint: git.fingerprint, filesFingerprint: current.fingerprint });
    return { planId, changes, base: { branch: git.branchRef?.replace(/^refs\/heads\//, "") || null, commit: git.head } };
  }

  async shelve({ paths, ignoredPaths = [], planId } = {}) {
    const approved = planId ? this.#shelvePlans.get(planId) : null;
    if (planId && !approved) throw fail("GIT_SHELVE_PLAN", "Create a new shelving plan.");
    if (approved) { paths = approved.paths; ignoredPaths = approved.ignoredPaths; }
    const selected = this.selectedPaths(paths), allowedIgnored = new Set(ignoredPaths.length ? this.selectedPaths(ignoredPaths) : []);
    const ignored = new Set((await this.runner.run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { readOnly: true })).stdout.toString("utf8").split("\0").filter(Boolean));
    if (selected.some((name) => ignored.has(name) && !allowedIgnored.has(name)) || [...allowedIgnored].some((name) => !selected.includes(name))) throw fail("GIT_IGNORED_SELECTION", "Ignored files require an explicit selection.");
    const planned = await this.stableGit();
    if (planned.operation !== "idle") throw fail("GIT_SHELVE_OPERATION", "Finish the current Git operation before shelving changes.");
    if (approved && (planned.fingerprint !== approved.gitFingerprint || await this.vault.fingerprint({ root: this.runner.root }) !== approved.filesFingerprint)) throw fail("STATE_CHANGED", "The shelving plan is no longer current.");
    const baseline = await this.baselineEntries(planned.head, selected);
    for (const name of selected) if ((await this.pathEntry(name))?.type === "directory") throw fail("GIT_SHELVE_UNSUPPORTED", "Select individual files rather than folders.");
    return this.run({ kind: "shelve", expectedGitFingerprint: planned.fingerprint, ...(approved ? { expectedFilesFingerprint: approved.filesFingerprint } : {}), verify: async ({ before, after }) => {
      if (before.head !== after.head || before.branchRef !== after.branchRef || after.operation !== "idle") return false;
      for (const name of selected) if (this.entryIdentity(await this.pathEntry(name)) !== this.entryIdentity(baseline.get(name))) return false;
      return "completed";
    } }, async ({ id, before }) => {
      if (planId) this.#shelvePlans.delete(planId);
      const journal = await this.read(id), saved = await this.vault.read(journal.beforeVault);
      const originals = new Map(saved.entries.map((entry) => [entry.path, entry]));
      journal.shelvePaths = selected; journal.shelveBase = { branch: before.branchRef?.replace(/^refs\/heads\//, "") || null, commit: before.head }; journal.indexStep = "prepared"; await this.write(journal);
      if (before.head) await this.runner.run(["--literal-pathspecs", "reset", "--quiet", before.head, "--", ...selected]);
      else for (const name of selected) await this.runner.run(["update-index", "--force-remove", "--", name]);
      journal.indexStep = "completed"; await this.write(journal);
      for (const name of selected) await this.replacePath(journal, name, originals.get(name) || null, baseline.get(name) || null);
      return { shelveId: id, paths: selected };
    });
  }

  async unshelve(id) {
    const source = await this.read(id);
    if (source.phase !== "shelved" || !source.afterVault || !source.shelvePaths?.length) throw fail("GIT_SHELVE_INVALID", "This saved change cannot be restored automatically.");
    const before = await this.vault.read(source.beforeVault), after = await this.vault.read(source.afterVault);
    const planned = await this.stableGit();
    if (planned.head !== before.metadata.git.head || planned.branchRef !== before.metadata.git.branchRef || planned.operation !== "idle") throw fail("GIT_SHELVE_BASE_CHANGED", "Return to the original branch and commit before restoring these changes.");
    if (this.entryIdentity(this.metadataEntry("index", planned.files.index)) !== this.entryIdentity(this.metadataEntry("index", after.metadata.git.files.index))) throw fail("GIT_SHELVE_INDEX_CHANGED", "Staged changes differ; compare the saved changes before restoring.");
    const selected = this.selectedPaths(source.shelvePaths), desired = new Map(before.entries.map((entry) => [entry.path, entry])), expected = new Map(after.entries.map((entry) => [entry.path, entry]));
    for (const name of selected) if (this.entryIdentity(await this.pathEntry(name)) !== this.entryIdentity(expected.get(name))) throw fail("GIT_SHELVE_FILES_CHANGED", "A selected file changed; compare it before restoring.");
    const result = await this.run({ kind: "unshelve", expectedGitFingerprint: planned.fingerprint, verify: async ({ after: current }) => {
      if (current.head !== planned.head || current.branchRef !== planned.branchRef || this.entryIdentity(this.metadataEntry("index", current.files.index)) !== this.entryIdentity(this.metadataEntry("index", before.metadata.git.files.index))) return false;
      for (const name of selected) if (this.entryIdentity(await this.pathEntry(name)) !== this.entryIdentity(desired.get(name))) return false;
      return "completed";
    } }, async ({ id: transactionId }) => {
      const journal = await this.read(transactionId); journal.unshelveSource = id; await this.write(journal);
      // Revalidate selected paths after run() finishes its durable protection.
      for (const name of selected) if (this.entryIdentity(await this.pathEntry(name)) !== this.entryIdentity(expected.get(name))) throw fail("STATE_CHANGED", "A selected file changed before restoration.");
      await this.restoreIndexBlobs(before.metadata.git.indexBlobs || {});
      for (const name of selected) await this.replacePath(journal, name, expected.get(name) || null, desired.get(name) || null);
      await this.replacePath(journal, "index", this.metadataEntry("index", planned.files.index), this.metadataEntry("index", before.metadata.git.files.index), true);
      return { restoredShelveId: id, paths: selected };
    });
    source.phase = "unshelved"; source.continuedBy = result.transaction.id; source.updatedAt = new Date().toISOString(); await this.write(source);
    return result;
  }

  async recoveryFiles(id) {
    const journal = await this.read(id);
    const states = {};
    for (const [side, vaultId] of Object.entries({ before: journal.beforeVault, after: journal.afterVault, current: journal.recoveryVault || journal.afterVault })) {
      states[side] = vaultId ? new Map((await this.vault.read(vaultId)).entries.map((entry) => [entry.path, entry])) : new Map();
    }
    const names = [...new Set(Object.values(states).flatMap((entries) => [...entries.keys()]))].sort();
    return names.map((name) => ({ path: name, ...Object.fromEntries(Object.entries(states).map(([side, entries]) => {
      const entry = entries.get(name);
      return [side, entry ? { type: entry.type, size: entry.type === "file" ? entry.size : entry.type === "symlink" ? Buffer.byteLength(entry.target) : null, exportable: entry.type !== "directory" } : null];
    })) }));
  }

  // destination MUST originate in the main process's save dialog, never an
  // arbitrary renderer path. Only a deliberately selected single file leaves
  // the encrypted vault. Existing files and the active project are untouched.
  async exportRecoveryFile(id, { path: name, side, destination } = {}) {
    this.selectedPaths([name]);
    if (!["before", "after", "current"].includes(side) || !path.isAbsolute(destination || "")) throw fail("GIT_EXPORT_INVALID", "Select a protected file and an export destination.");
    const journal = await this.read(id);
    const vaultId = side === "before" ? journal.beforeVault : side === "after" ? journal.afterVault : journal.recoveryVault || journal.afterVault;
    if (!vaultId) throw fail("GIT_EXPORT_UNAVAILABLE", "That protected state is unavailable.");
    const source = (await this.vault.read(vaultId)).entries.find((entry) => entry.path === name);
    if (!source || !["file", "symlink"].includes(source.type)) throw fail("GIT_EXPORT_UNAVAILABLE", "Select an individual protected file.");
    const directory = await fs.realpath(path.dirname(destination)), target = path.join(directory, path.basename(destination));
    for (const protectedDirectory of [this.runner.root, await canonicalLocation(this.vault.directory), await canonicalLocation(this.directory)]) {
      const relative = path.relative(protectedDirectory, target);
      if (!relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) throw fail("GIT_EXPORT_INVALID", "Export outside the active project and protection storage.");
    }
    const fd = await fs.open(target, "wx", 0o600);
    try { await fd.writeFile(source.type === "file" ? source.content : Buffer.from(source.target)); await fd.sync(); }
    finally { await fd.close(); }
    await syncDirectory(directory);
    return { exported: true, type: source.type, size: source.type === "file" ? source.size : Buffer.byteLength(source.target) };
  }

}
module.exports = { GitTransaction };

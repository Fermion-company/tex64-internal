"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { HistoryStore } = require("./history-store.cjs");
const { hash, fail, validId, safePath, readRegular, atomicWrite, syncDirectory } = require("./history-files.cjs");

// Caller holds the history store lock AND the existing workspace writer lease.
// A durable restore record is the commit point. An unfinished journal is rolled
// back before the workspace is exposed to ordinary editing again.
class HistoryTransaction {
  constructor(store, { setRootFile = async () => {} } = {}) {
    this.store = store;
    this.setRootFile = setRootFile;
  }

  get journalFile() { return path.join(this.store.directory, "transaction.json"); }
  async writeJournal(journal) { await atomicWrite(this.journalFile, JSON.stringify(journal)); }

  async plan(targetVersionId, rootFile = null) {
    await this.assertReady();
    const record = (await this.store.list()).find((item) => item.id === targetVersionId);
    if (!record) throw fail("NOT_FOUND", "The requested version was not found.");
    const target = await this.store.tree(record.treeId);
    const current = await this.store.capture({ rootFile, persist: false });
    const operations = HistoryStore.changes(current, target);
    for (const operation of operations) {
      await safePath(this.store.root, operation.path);
      if (operation.modified) await this.store.blob(operation.modified.blob);
      if (current.excluded.some((item) => operation.path === item.path || operation.path.startsWith(item.path + "/"))) {
        throw fail("PROTECTED_PATH", "A protected path blocks this version. It will not be overwritten.");
      }
    }
    return { id: crypto.randomUUID(), projectId: this.store.projectId, targetVersionId,
      currentTreeId: current.id, targetTreeId: target.id, operations, rootFile, targetRootFile: target.rootFile,
      excluded: current.excluded, createdAt: Date.now() };
  }

  async assertReady() {
    try { await fsp.access(this.journalFile); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    throw fail("RECOVERY_REQUIRED", "An interrupted restore must be recovered before continuing.");
  }

  async restore(plan) {
    await this.assertReady();
    if (!plan || plan.projectId !== this.store.projectId || !validId(plan.id)) throw fail("STALE_WORKSPACE", "This restore belongs to a different project.");
    const current = await this.store.capture({ rootFile: plan.rootFile });
    if (current.id !== plan.currentTreeId) throw fail("PLAN_STALE", "The project changed after the restore preview. Review the updated changes first.");
    const target = await this.store.tree(plan.targetTreeId);
    const operations = HistoryStore.changes(current, target);
    // A safety version is fully published before the first workspace change.
    const safety = await this.store.publish(current, { kind: "safety", label: "Before restore" });
    const stageRelative = `.tex64/history-transactions/${plan.id}`;
    const stage = await safePath(this.store.root, stageRelative);
    await fsp.mkdir(stage, { recursive: true, mode: 0o700 });
    const journal = { schema: 1, id: plan.id, projectId: this.store.projectId, before: current.id,
      target: target.id, targetVersionId: plan.targetVersionId, safetyId: safety.id, phase: "prepared" };
    try {
      for (let index = 0; index < operations.length; index++) {
        const operation = operations[index];
        if (operation.modified) {
          const bytes = await this.store.blob(operation.modified.blob);
          await atomicWrite(path.join(stage, `${index}.new`), bytes, { exclusive: true });
          await fsp.chmod(path.join(stage, `${index}.new`), operation.modified.mode & 0o777);
        }
      }
      await this.writeJournal(journal);
      await this.store.fault("journal-prepared");
      for (let index = 0; index < operations.length; index++) {
        const operation = operations[index];
        journal.phase = "applying"; journal.index = index;
        await this.writeJournal(journal);
        await this.store.fault(`before-change-${index}`);
        await this.store.verifyRoot();
        const absolute = await safePath(this.store.root, operation.path);
        if (operation.original) {
          const existing = await readRegular(this.store.root, operation.path, this.store.maxFileBytes);
          if (!existing || existing.hash !== operation.original.blob) throw fail("EXTERNAL_CHANGE", "A file changed while the restore was being prepared.");
          await this.store.fault(`before-backup-${index}`);
          // Rename preserves the actual displaced bytes even when an external
          // writer raced the initial hash check. Verify the moved file again.
          await fsp.rename(absolute, path.join(stage, `${index}.old`));
          await syncDirectory(path.dirname(absolute));
          await syncDirectory(stage);
          await this.store.fault(`after-backup-${index}`);
          const moved = await readRegular(stage, `${index}.old`, this.store.maxFileBytes);
          if (!moved || moved.hash !== operation.original.blob) throw fail("EXTERNAL_CHANGE", "An external edit was preserved in the restore backup. Recovery is required.");
        }
        if (operation.modified) {
          await safePath(this.store.root, operation.path);
          await fsp.mkdir(path.dirname(absolute), { recursive: true });
          await this.store.fault(`before-install-${index}`);
          // Only a restore-specific copy is hard-linked, NEVER a history blob.
          // link fails if an external writer recreated the destination.
          await fsp.link(path.join(stage, `${index}.new`), absolute);
          await syncDirectory(path.dirname(absolute));
          await this.store.fault(`after-install-${index}`);
        }
        journal.completed = index;
        await this.writeJournal(journal);
      }
      await this.store.fault("before-verify");
      const actual = await this.store.scan({ rootFile: target.rootFile });
      if (JSON.stringify(actual.entries) !== JSON.stringify(target.entries)) throw fail("EXTERNAL_CHANGE", "The project changed during restore. Its previous version will be recovered.");
      await this.setRootFile(target.rootFile);
      journal.phase = "committing";
      await this.writeJournal(journal);
      await this.store.fault("before-restore-commit");
      const record = await this.store.publish(target, { id: plan.id, kind: "restore", restoredFrom: plan.targetVersionId, preRestore: safety.id });
      await this.store.fault("after-restore-commit");
      await this.cleanup(journal);
      return { record, operations, rootFile: target.rootFile };
    } catch (error) {
      // A fault after durable publication cannot turn a committed operation
      // into a rollback. Re-read the authority rather than trusting RAM flags.
      const committed = (await this.store.list()).find((record) => record.id === journal.id);
      if (committed) { await this.cleanup(journal); return { record: committed, operations, rootFile: target.rootFile }; }
      try {
        await this.rollback(journal);
      } catch (recoveryError) {
        throw Object.assign(fail("RECOVERY_REQUIRED", "Restore was interrupted. Your saved versions and displaced files are retained; recover the project before editing."), { cause: recoveryError, originalCode: error.code });
      }
      throw error;
    }
  }

  async rollback(journal) {
    this.validateJournal(journal);
    const before = await this.store.tree(journal.before);
    const target = await this.store.tree(journal.target);
    const operations = HistoryStore.changes(before, target);
    const stage = await safePath(this.store.root, `.tex64/history-transactions/${journal.id}`);
    journal.phase = "rolling-back";
    await this.writeJournal(journal);
    for (let index = operations.length - 1; index >= 0; index--) {
      await this.store.verifyRoot();
      const operation = operations[index];
      const absolute = await safePath(this.store.root, operation.path);
      const backup = await readRegular(stage, `${index}.old`, this.store.maxFileBytes);
      const fresh = await readRegular(stage, `${index}.new`, this.store.maxFileBytes);
      const existing = await readRegular(this.store.root, operation.path, this.store.maxFileBytes);
      if (existing && fresh && existing.identity === fresh.identity) {
        // An external write through the same inode is also protected.
        if (existing.hash !== operation.modified?.blob) throw fail("EXTERNAL_CHANGE", "The restored file was edited externally. Keep both versions before recovering.");
        await this.store.fault(`before-rollback-remove-${index}`);
        await fsp.unlink(absolute);
      } else if (existing && backup) {
        // A prior rollback may have already linked the backup into place.
        if (existing.identity !== backup.identity) throw fail("EXTERNAL_CHANGE", "An external file occupies a recovery path.");
      }
      if (backup) {
        await this.store.fault(`before-rollback-backup-${index}`);
        try { await fsp.link(path.join(stage, `${index}.old`), absolute); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const present = await readRegular(this.store.root, operation.path, this.store.maxFileBytes);
          if (present?.identity !== backup.identity) throw fail("EXTERNAL_CHANGE", "Recovery will not overwrite an external file.");
        }
        await syncDirectory(path.dirname(absolute));
      } else if (operation.original) {
        const present = await readRegular(this.store.root, operation.path, this.store.maxFileBytes);
        if (present?.hash !== operation.original.blob) throw fail("RECOVERY_REQUIRED", "A file needed for rollback is unavailable.");
      }
    }
    await this.setRootFile(before.rootFile);
    await this.cleanup(journal);
  }

  validateJournal(journal) {
    if (!journal || journal.schema !== 1 || !validId(journal.id) || !validId(journal.before) || !validId(journal.target) || journal.projectId !== this.store.projectId) {
      throw fail("RECOVERY_REQUIRED", "The recovery record is damaged. Keep the history and recovery files intact.");
    }
  }

  async recover() {
    let journal;
    try { journal = JSON.parse(await fsp.readFile(this.journalFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { recovered: false }; throw fail("RECOVERY_REQUIRED", "The recovery record is damaged."); }
    this.validateJournal(journal);
    const committed = (await this.store.list()).find((item) => item.id === journal.id);
    if (committed) {
      const target = await this.store.tree(committed.treeId);
      await this.setRootFile(target.rootFile);
      await this.cleanup(journal);
      return { recovered: true, committed: true };
    }
    await this.rollback(journal);
    return { recovered: true, committed: false };
  }

  async cleanup(journal) {
    const stage = await safePath(this.store.root, `.tex64/history-transactions/${journal.id}`);
    // Clean only files bearing this operation's known internal names. Never
    // recursively delete a project folder that could contain excluded data.
    for (const name of await fsp.readdir(stage).catch((error) => { if (error.code === "ENOENT") return []; throw error; })) {
      if (!/^\d+\.(old|new)$/.test(name)) continue;
      await fsp.unlink(path.join(stage, name));
    }
    await fsp.rmdir(stage).catch((error) => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
    await fsp.unlink(this.journalFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await syncDirectory(this.store.directory);
  }
}

module.exports = { HistoryTransaction };

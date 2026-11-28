"use strict";

// Y.Doc ⇄ disk for the text files of a session. The disk stays the record of
// truth for the user; the Y.Doc is how edits merge.
//
//   Y.Doc → disk: debounced (500 ms) writes through the workspace mutation
//   lease (same FIFO as editor saves, same History / Git / Axiom exclusion).
//   While a lease blocks writing, the file stays queued and is written once
//   the lease clears. Every completed write is acknowledged with the content
//   digest so the renderer can mark its buffer saved.
//
//   disk → Y.Doc: three-way. `baseline` is the content this layer last wrote
//   or read. A disk content C equal to the baseline is our own echo. Otherwise
//   the hunks baseline→C are relocated onto the current Y.Text B. Where a hunk
//   overlaps an unsaved edit in B, the shared document keeps the file's name
//   (B is written back, and the user is told once) and C, byte for byte, is
//   first kept beside it as <name>.local-<time><ext>: neither version is lost
//   and the file is never left unwritten. If that copy cannot be made, nothing
//   is written and the doc stays dirty (a flush fails) until it can.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { withProjectFileWrites, writeProjectFile } = require("../project-file-writes.cjs");
const { textHunks, applyHunks, applyTextDelta } = require("./text-delta.cjs");
const { contentDigest, hashBuffer, resolveInsideRoot } = require("./manifest.cjs");
const { isUnknownTextBuffer } = require("../text-file-types.cjs");

const DISK_ORIGIN = "disk";
const settleWaiters = (entry, saved) => {
  for (const resolve of entry.waiters) resolve(saved);
  entry.waiters.clear();
};
const WRITE_DEBOUNCE_MS = 500;
const BLOCKED_RETRY_MS = 500;
// Touching edits conflict too: an insertion at either edge of a replacement,
// or at another insertion's position, has no unambiguous external ordering.
const hunksConflict = (a, b) => a.start <= b.end && b.start <= a.end;

// Relocates baseline→disk hunks onto the current text. Returns the number of
// hunks dropped because they overlapped unsaved edits. `skipIdentical`: a
// disk hunk equal to one of ours is already in the text (not a conflict);
// `dryRun`: count only, change nothing.
const mergeThreeWay = (ytext, baseline, current, disk, origin, { skipIdentical = false, dryRun = false } = {}) => {
  if (current === baseline) {
    if (!dryRun) applyTextDelta(ytext, baseline, disk, origin);
    return 0;
  }
  const ours = textHunks(baseline, current);
  const theirs = textHunks(baseline, disk);
  const edits = [];
  let dropped = 0;
  for (const hunk of theirs) {
    if (skipIdentical && ours.some((mine) => mine.start === hunk.start && mine.end === hunk.end && mine.text === hunk.text)) continue;
    const overlaps = ours.some((mine) => hunksConflict(mine, hunk));
    if (overlaps) {
      dropped += 1;
      continue;
    }
    let shift = 0;
    for (const mine of ours) {
      if (mine.end < hunk.start) shift += mine.text.length - (mine.end - mine.start);
    }
    edits.push({ start: hunk.start + shift, end: hunk.end + shift, text: hunk.text });
  }
  if (!dryRun) applyHunks(ytext, edits, origin);
  return dropped;
};

// Keeps `bytes` (a version of `relative` that is about to be replaced) beside
// it as <name>.local-<time><ext>, never over an existing file, and synced to
// disk before this returns. The session's manifest leaves these copies out
// (manifest.cjs). Returns the copy's path relative to `rootPath`.
const keepLocalCopy = async (rootPath, relative, bytes) => {
  const absolute = path.join(rootPath, relative);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const extension = path.extname(relative);
  const base = absolute.slice(0, absolute.length - extension.length);
  for (let attempt = 1; ; attempt += 1) {
    const target = `${base}.local-${stamp}${attempt > 1 ? `-${attempt}` : ""}${extension}`;
    try {
      await writeProjectFile(target, bytes, { exclusive: true, durable: true });
      return path.relative(rootPath, target);
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt >= 100) throw error;
    }
  }
};

class DiskSync {
  // deps: rootPath(), withWorkspaceMutation(op), withFileMutation(path, op),
  //       onSaved(path, digest), onNotice(message), onMissing(path), trackSaved(path, content)
  constructor(deps) {
    this.deps = deps;
    this.docs = new Map();
    // Until the guest's mirror is open as the workspace, writes are plain
    // filesystem writes; afterwards they take the workspace lease.
    this.coordinated = false;
    this.stopped = false;
    // While paused (a guest joining onto an existing mirror), edits collect
    // in the Y.Docs and nothing is written until resume().
    this.paused = false;
    // View-only guest: the shared text always wins. A change on disk is
    // written over (and reported), never folded into the Y.Doc.
    this.readOnly = false;
  }

  resume() {
    this.paused = false;
    for (const docId of this.docs.keys()) this.noteUpdate(docId);
  }

  absolute(relative) {
    return path.join(this.deps.rootPath(), relative);
  }

  attach(docId, ytext, baselineContent, previousBinaryHash = null) {
    if (this.docs.has(docId)) return this.docs.get(docId);
    const entry = {
      docId,
      ytext,
      previousBinaryHash,
      baseline: baselineContent === null ? null : { content: baselineContent, digest: contentDigest(baselineContent) },
      timer: null,
      dirty: false,
      // the outside version last kept as a .local copy (one copy per version)
      keptDigest: null,
      queue: Promise.resolve(),
      waiters: new Set(),
    };
    this.docs.set(docId, entry);
    if (baselineContent === null || ytext.toString() !== baselineContent) this.noteUpdate(docId);
    return entry;
  }

  detach(docId) {
    const entry = this.docs.get(docId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    this.docs.delete(docId);
    settleWaiters(entry, true);
  }

  has(docId) {
    return this.docs.has(docId);
  }

  isDirty(docId) {
    return Boolean(this.docs.get(docId)?.dirty);
  }

  noteUpdate(docId) {
    const entry = this.docs.get(docId);
    if (!entry || this.stopped) return;
    entry.dirty = true;
    if (entry.timer || this.paused) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.writeNow(docId);
    }, WRITE_DEBOUNCE_MS);
    entry.timer.unref?.();
  }

  // Runs `operation` for a doc inside the write lease (coordinated) or directly.
  guarded(docId, operation) {
    const entry = this.docs.get(docId);
    if (!entry) return Promise.resolve();
    const run = entry.queue.catch(() => {}).then(async () => {
      if (!this.coordinated) return withProjectFileWrites([await this.safeAbsolute(docId)], operation);
      return this.deps.withWorkspaceMutation(() => this.deps.withFileMutation(docId, operation));
    });
    entry.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  // The file a doc is written to, checked on every access: inside the root,
  // not excluded, no symlinked component (a peer may name any text path).
  async safeAbsolute(docId) {
    const absolute = await resolveInsideRoot(this.deps.rootPath(), docId);
    if (!absolute) throw Object.assign(new Error(`Refusing to write outside the project: ${docId}`), { code: "UNSAFE_PATH" });
    return absolute;
  }

  // { text, bytes } of the file (null when it is not there). `text` is the
  // raw Buffer when the file still holds the exact binary this doc replaces.
  async readDiskVersion(docId, previousBinaryHash) {
    const absolute = await this.safeAbsolute(docId);
    try {
      const bytes = await fsp.readFile(absolute);
      if (isUnknownTextBuffer(bytes)) return { text: bytes.toString("utf8"), bytes };
      // A peer can convert a previously shared binary to UTF-8. Only replace
      // the exact bytes retained or backed up before attaching its text doc.
      if (previousBinaryHash && hashBuffer(bytes) === previousBinaryHash) return { text: bytes, bytes };
      throw new Error("The file on disk is not editable UTF-8. Its original bytes were kept.");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async readDisk(docId, previousBinaryHash) {
    return (await this.readDiskVersion(docId, previousBinaryHash))?.text ?? null;
  }

  async writeDisk(docId, content, entry) {
    const absolute = await this.safeAbsolute(docId);
    // A doc let go meanwhile is not written (the shared project-file writer
    // stages and replaces the file atomically).
    if (this.docs.get(docId) !== entry) return;
    await writeProjectFile(absolute, content);
  }

  // A doc whose path leads out of the project is never written: it is let go
  // before any guard sees it (the workspace's file guard would refuse it and
  // leave it dirty for ever). Returns whether the doc may be written.
  async keepIfSafe(docId, entry) {
    try {
      await this.safeAbsolute(docId);
      return this.docs.get(docId) === entry;
    } catch (error) {
      if (this.docs.get(docId) !== entry) return false;
      if (error?.code !== "UNSAFE_PATH") throw error;
      console.warn("[collab]", error.message);
      entry.dirty = false;
      this.detach(docId);
      return false;
    }
  }

  // Folds the disk version (text + its raw bytes) into the Y.Text and makes
  // it the baseline. Where it overlaps unsaved edits, the edits stay (the
  // document keeps the name) and the disk version is kept first as a .local
  // copy. Returns false, merging nothing, when that copy could not be made.
  async mergeDisk(docId, entry, disk, bytes) {
    const baseline = entry.baseline?.content ?? "";
    const digest = contentDigest(disk);
    const conflicts = mergeThreeWay(entry.ytext, baseline, entry.ytext.toString(), disk, DISK_ORIGIN, { skipIdentical: true, dryRun: true });
    if (conflicts > 0 && entry.keptDigest !== digest) {
      let kept;
      try {
        kept = await keepLocalCopy(this.deps.rootPath(), docId, bytes);
      } catch (error) {
        console.warn("[collab] could not keep the outside version", docId, error?.message || error);
        entry.dirty = true;
        return false;
      }
      // (a doc let go while the copy was written takes no merge)
      if (this.docs.get(docId) !== entry) return false;
      entry.keptDigest = digest;
      this.deps.onNotice?.(docId, conflicts, kept);
    }
    // (read again: peers may have typed while the copy was written; whatever
    // is dropped here is in that copy)
    mergeThreeWay(entry.ytext, baseline, entry.ytext.toString(), disk, DISK_ORIGIN, { skipIdentical: true });
    entry.baseline = { content: disk, digest };
    return true;
  }

  // One write of a doc's text to disk (merging what changed there first).
  // `rereads`: how many more times a disk version that changed again while
  // it was being merged (and kept) is read and merged before writing.
  async writeOperation(docId, entry, rereads = 3) {
    if (this.docs.get(docId) !== entry) return;
    let version;
    try {
      version = await this.readDiskVersion(docId, entry.previousBinaryHash);
      if (this.docs.get(docId) !== entry) return;
    } catch (error) {
      if (this.docs.get(docId) !== entry) return;
      if (error?.code !== "UNSAFE_PATH") throw error;
      // A path that leads out of the project is never written; the doc is let go.
      console.warn("[collab]", error.message);
      entry.dirty = false;
      this.detach(docId);
      return;
    }
    const current = version?.text ?? null;
    let target = entry.ytext.toString();
    if (current === null && entry.baseline !== null && !this.readOnly) {
      // Deleted underneath us. The manifest decides whether that is a
      // tombstone; recreating it here would resurrect a removed file.
      entry.dirty = false;
      this.deps.onMissing?.(docId);
      return;
    }
    if (!this.readOnly && typeof current === "string" && (entry.baseline === null || current !== entry.baseline.content) && current !== target) {
      // Something else wrote since the baseline: merge it in first.
      const merged = await this.mergeDisk(docId, entry, current, version.bytes);
      if (this.docs.get(docId) !== entry) return;
      if (!merged) {
        throw Object.assign(new Error(`Could not keep the outside version of ${docId}.`), { code: "COLLAB_KEEP_FAILED" });
      }
      // Written over only as merged: a newer outside version is merged first.
      if (rereads > 0 && (await this.readDisk(docId, entry.previousBinaryHash)) !== current) return this.writeOperation(docId, entry, rereads - 1);
      target = entry.ytext.toString();
    }
    if (current !== target) {
      await this.writeDisk(docId, target, entry);
      if (this.docs.get(docId) !== entry) return;
      this.deps.trackSaved?.(docId, target);
    }
    entry.previousBinaryHash = null;
    entry.baseline = { content: target, digest: contentDigest(target) };
    entry.dirty = entry.ytext.toString() !== target;
    this.deps.onSaved?.(docId, entry.baseline.digest);
    if (entry.dirty) this.noteUpdate(docId);
  }

  async writeNow(docId) {
    const entry = this.docs.get(docId);
    if (!entry || this.stopped) return;
    try {
      if (!(await this.keepIfSafe(docId, entry))) return;
      await this.guarded(docId, () => this.writeOperation(docId, entry));
    } catch (error) {
      if (this.docs.get(docId) !== entry || this.stopped) return;
      if (["HISTORY_BUSY", "AGENT_WORKSPACE_BUSY", "FILE_WRITE_BUSY"].includes(error?.code)) {
        // Keep the edit in the Y.Doc; retry once the lease clears.
        if (!entry.timer) {
          entry.timer = setTimeout(() => {
            entry.timer = null;
            void this.writeNow(docId);
          }, BLOCKED_RETRY_MS);
          entry.timer.unref?.();
        }
        return;
      }
      console.warn("[collab] write failed", docId, error?.message || error);
      // A failed write answers a waiting flush as well: the doc is still
      // dirty, so that flush reports the failure now, not at its timeout.
      settleWaiters(entry, false);
      this.deps.onError?.(docId, error);
    } finally {
      if (this.docs.get(docId) === entry && !entry.dirty) settleWaiters(entry, true);
    }
  }

  // Disk changed (watcher or manifest scan): fold it into the Y.Doc.
  async ingestDisk(docId) {
    const entry = this.docs.get(docId);
    if (!entry || this.stopped) return;
    try {
      await this.guarded(docId, async () => {
        if (this.docs.get(docId) !== entry) return;
        const version = await this.readDiskVersion(docId);
        if (this.docs.get(docId) !== entry) return;
        if (version === null) {
          this.deps.onMissing?.(docId);
          return;
        }
        const disk = version.text;
        const digest = contentDigest(disk);
        if (entry.baseline && digest === entry.baseline.digest && disk === entry.baseline.content) return;
        const current = entry.ytext.toString();
        if (disk === current) {
          entry.baseline = { content: disk, digest };
          entry.dirty = false;
          this.deps.onSaved?.(docId, digest);
          return;
        }
        if (this.readOnly) {
          entry.baseline = { content: disk, digest };
          this.deps.onReverted?.(docId);
          this.noteUpdate(docId);
          return;
        }
        // (a copy that could not be made: the doc stays dirty; its next
        // write, or a flush, merges again)
        const merged = await this.mergeDisk(docId, entry, disk, version.bytes);
        if (this.docs.get(docId) !== entry) return;
        if (!merged) {
          this.noteUpdate(docId);
          return;
        }
        if (entry.ytext.toString() !== disk) this.noteUpdate(docId);
        else {
          entry.dirty = false;
          this.deps.onSaved?.(docId, digest);
        }
      });
    } catch (error) {
      if (["HISTORY_BUSY", "AGENT_WORKSPACE_BUSY", "FILE_WRITE_BUSY"].includes(error?.code)) {
        setTimeout(() => void this.ingestDisk(docId), BLOCKED_RETRY_MS).unref?.();
        return;
      }
      console.warn("[collab] ingest failed", docId, error?.message || error);
    }
  }

  // Writes every dirty doc now and resolves when nothing is pending (or the
  // timeout passes, e.g. a long-held lease).
  async flush(timeoutMs = 15000) {
    const waiters = new Map();
    const pending = [];
    for (const [docId, entry] of this.docs) {
      if (!entry.dirty) continue;
      clearTimeout(entry.timer);
      entry.timer = null;
      pending.push(new Promise(resolve => {
        entry.waiters.add(resolve);
        waiters.set(entry, resolve);
      }));
      void this.writeNow(docId);
    }
    if (!pending.length) return true;
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      timer.unref?.();
    });
    try {
      const saved = await Promise.race([Promise.all(pending).then(results => results.every(Boolean)), timeout]);
      return saved && ![...this.docs.values()].some(entry => entry.dirty);
    } finally {
      clearTimeout(timer);
      for (const [entry, resolve] of waiters) entry.waiters.delete(resolve);
    }
  }

  // The caller already holds the workspace lease (a project switch): every
  // dirty doc is written now under its own file guard, ahead of any write
  // still queued behind that lease — those find the session gone and do
  // nothing. Returns whether everything reached the disk.
  async flushHeld() {
    let ok = true;
    for (const [docId, entry] of [...this.docs]) {
      if (!entry.dirty) continue;
      clearTimeout(entry.timer);
      entry.timer = null;
      try {
        if (!(await this.keepIfSafe(docId, entry))) continue;
        if (this.coordinated) await this.deps.withFileMutation(docId, () => this.writeOperation(docId, entry));
        else await withProjectFileWrites([await this.safeAbsolute(docId)], () => this.writeOperation(docId, entry));
      } catch (error) {
        ok = false;
        console.warn("[collab] write failed", docId, error?.message || error);
      }
    }
    return ok && ![...this.docs.values()].some((entry) => entry.dirty);
  }

  baselineOf(docId) {
    return this.docs.get(docId)?.baseline?.content ?? null;
  }

  stop() {
    this.stopped = true;
    for (const entry of this.docs.values()) {
      clearTimeout(entry.timer);
      entry.timer = null;
      settleWaiters(entry, false);
    }
    this.docs.clear();
  }
}

module.exports = { DiskSync, mergeThreeWay, applyTextDelta, keepLocalCopy, DISK_ORIGIN };

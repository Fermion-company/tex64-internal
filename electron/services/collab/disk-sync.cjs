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
//   the hunks baseline→C are relocated onto the current Y.Text B; a hunk that
//   overlaps an unsaved edit in B is dropped (B wins, B is written back, and
//   the user is told once).

const fsp = require("node:fs/promises");
const path = require("node:path");
const Diff = require("diff");
const { contentDigest } = require("./manifest.cjs");

const DISK_ORIGIN = "disk";
const WRITE_DEBOUNCE_MS = 500;
const BLOCKED_RETRY_MS = 500;

const splitLines = (text) => text.split("\n");

// Hunks of `from` → `to` as replacements of line ranges in `from`.
const lineHunks = (from, to) => {
  const parts = Diff.diffArrays(splitLines(from), splitLines(to));
  const hunks = [];
  let fromLine = 0;
  let pending = null;
  const flush = () => {
    if (pending) hunks.push(pending);
    pending = null;
  };
  for (const part of parts) {
    if (!part.added && !part.removed) {
      flush();
      fromLine += part.count;
      continue;
    }
    if (!pending) pending = { start: fromLine, end: fromLine, lines: [] };
    if (part.removed) {
      pending.end += part.count;
      fromLine += part.count;
    } else {
      pending.lines.push(...part.value);
    }
  }
  flush();
  return hunks;
};

const lineOffsets = (text) => {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) offsets.push(i + 1);
  return offsets;
};

// Replace the whole value with a minimal prefix/suffix edit.
const applyTextDelta = (ytext, from, to, origin) => {
  if (from === to) return;
  let prefix = 0;
  const max = Math.min(from.length, to.length);
  while (prefix < max && from.charCodeAt(prefix) === to.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && from.charCodeAt(from.length - 1 - suffix) === to.charCodeAt(to.length - 1 - suffix)) suffix++;
  ytext.doc.transact(() => {
    const deleteLength = from.length - prefix - suffix;
    if (deleteLength > 0) ytext.delete(prefix, deleteLength);
    const insert = to.slice(prefix, to.length - suffix);
    if (insert) ytext.insert(prefix, insert);
  }, origin);
};

// Relocates baseline→disk hunks onto the current text. Returns the number of
// hunks dropped because they overlapped unsaved edits.
const mergeThreeWay = (ytext, baseline, current, disk, origin) => {
  if (current === baseline) {
    applyTextDelta(ytext, baseline, disk, origin);
    return 0;
  }
  const ours = lineHunks(baseline, current);
  const theirs = lineHunks(baseline, disk);
  const offsets = lineOffsets(current);
  const currentLineCount = offsets.length;
  const edits = [];
  let dropped = 0;
  for (const hunk of theirs) {
    const overlaps = ours.some((mine) => {
      if (mine.start === mine.end && hunk.start === hunk.end) return mine.start === hunk.start;
      return hunk.start <= mine.end && mine.start <= hunk.end;
    });
    if (overlaps) {
      dropped += 1;
      continue;
    }
    let shift = 0;
    for (const mine of ours) {
      if (mine.end <= hunk.start) shift += mine.lines.length - (mine.end - mine.start);
    }
    const startLine = hunk.start + shift;
    const endLine = hunk.end + shift;
    if (startLine < 0 || endLine > currentLineCount || startLine > endLine) {
      dropped += 1;
      continue;
    }
    // Character range covering lines [startLine, endLine) including the
    // newline that separates them from what follows; a replacement supplies
    // its own separators.
    const startOffset = offsets[startLine] ?? current.length;
    let endOffset;
    let text;
    if (endLine < currentLineCount) {
      endOffset = offsets[endLine];
      text = hunk.lines.length ? `${hunk.lines.join("\n")}\n` : "";
    } else {
      endOffset = current.length;
      // Replacing through the last line: there is no trailing separator to
      // consume, and the preceding separator stays unless the file became empty.
      text = hunk.lines.join("\n");
      if (startLine > 0 && startLine === currentLineCount) {
        // Pure insertion after the final line.
        text = `\n${text}`;
        endOffset = startOffset = current.length;
      }
    }
    edits.push({ startOffset, endOffset, text });
  }
  edits.sort((a, b) => b.startOffset - a.startOffset);
  if (edits.length) {
    ytext.doc.transact(() => {
      for (const edit of edits) {
        if (edit.endOffset > edit.startOffset) ytext.delete(edit.startOffset, edit.endOffset - edit.startOffset);
        if (edit.text) ytext.insert(edit.startOffset, edit.text);
      }
    }, origin);
  }
  return dropped;
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
  }

  absolute(relative) {
    return path.join(this.deps.rootPath(), relative);
  }

  attach(docId, ytext, baselineContent) {
    if (this.docs.has(docId)) return this.docs.get(docId);
    const entry = {
      docId,
      ytext,
      baseline: baselineContent === null ? null : { content: baselineContent, digest: contentDigest(baselineContent) },
      timer: null,
      dirty: false,
      queue: Promise.resolve(),
      waiters: [],
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
    for (const waiter of entry.waiters.splice(0)) waiter();
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
    if (entry.timer) return;
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
      if (!this.coordinated) return operation();
      return this.deps.withWorkspaceMutation(() => this.deps.withFileMutation(docId, operation));
    });
    entry.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async readDisk(docId) {
    try {
      const buffer = await fsp.readFile(this.absolute(docId));
      return buffer.toString("utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeDisk(docId, content) {
    const absolute = this.absolute(docId);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fsp.writeFile(temporary, content, "utf8");
    await fsp.rename(temporary, absolute);
  }

  async writeNow(docId) {
    const entry = this.docs.get(docId);
    if (!entry || this.stopped) return;
    try {
      await this.guarded(docId, async () => {
        if (!this.docs.has(docId)) return;
        let target = entry.ytext.toString();
        const current = await this.readDisk(docId);
        if (current === null && entry.baseline !== null) {
          // Deleted underneath us. The manifest decides whether that is a
          // tombstone; recreating it here would resurrect a removed file.
          entry.dirty = false;
          this.deps.onMissing?.(docId);
          return;
        }
        if (current !== null && (entry.baseline === null || current !== entry.baseline.content) && current !== target) {
          // Something else wrote since the baseline: merge it in first.
          const dropped = mergeThreeWay(entry.ytext, entry.baseline?.content ?? "", target, current, DISK_ORIGIN);
          entry.baseline = { content: current, digest: contentDigest(current) };
          if (dropped > 0) this.deps.onNotice?.(docId, dropped);
          target = entry.ytext.toString();
        }
        if (current !== target) {
          this.deps.trackSaved?.(docId, target);
          await this.writeDisk(docId, target);
        }
        entry.baseline = { content: target, digest: contentDigest(target) };
        entry.dirty = entry.ytext.toString() !== target;
        this.deps.onSaved?.(docId, entry.baseline.digest);
        if (entry.dirty) this.noteUpdate(docId);
      });
    } catch (error) {
      if (!this.docs.has(docId) || this.stopped) return;
      if (error?.code === "HISTORY_BUSY" || error?.code === "AGENT_WORKSPACE_BUSY") {
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
      this.deps.onError?.(docId, error);
    } finally {
      const latest = this.docs.get(docId);
      if (latest && !latest.dirty) for (const waiter of latest.waiters.splice(0)) waiter();
    }
  }

  // Disk changed (watcher or manifest scan): fold it into the Y.Doc.
  async ingestDisk(docId) {
    const entry = this.docs.get(docId);
    if (!entry || this.stopped) return;
    try {
      await this.guarded(docId, async () => {
        if (!this.docs.has(docId)) return;
        const disk = await this.readDisk(docId);
        if (disk === null) {
          this.deps.onMissing?.(docId);
          return;
        }
        const digest = contentDigest(disk);
        if (entry.baseline && digest === entry.baseline.digest && disk === entry.baseline.content) return;
        const current = entry.ytext.toString();
        if (disk === current) {
          entry.baseline = { content: disk, digest };
          entry.dirty = false;
          this.deps.onSaved?.(docId, digest);
          return;
        }
        const dropped = mergeThreeWay(entry.ytext, entry.baseline?.content ?? "", current, disk, DISK_ORIGIN);
        entry.baseline = { content: disk, digest };
        if (dropped > 0) this.deps.onNotice?.(docId, dropped);
        if (entry.ytext.toString() !== disk) this.noteUpdate(docId);
        else {
          entry.dirty = false;
          this.deps.onSaved?.(docId, digest);
        }
      });
    } catch (error) {
      if (error?.code === "HISTORY_BUSY" || error?.code === "AGENT_WORKSPACE_BUSY") {
        setTimeout(() => void this.ingestDisk(docId), BLOCKED_RETRY_MS).unref?.();
        return;
      }
      console.warn("[collab] ingest failed", docId, error?.message || error);
    }
  }

  // Writes every dirty doc now and resolves when nothing is pending (or the
  // timeout passes, e.g. a long-held lease).
  async flush(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    const pending = [];
    for (const [docId, entry] of this.docs) {
      if (!entry.dirty) continue;
      clearTimeout(entry.timer);
      entry.timer = null;
      pending.push(new Promise((resolve) => entry.waiters.push(resolve)));
      void this.writeNow(docId);
    }
    if (!pending.length) return true;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())).unref?.());
    const result = await Promise.race([Promise.all(pending).then(() => true), timeout]);
    return result && ![...this.docs.values()].some((entry) => entry.dirty);
  }

  baselineOf(docId) {
    return this.docs.get(docId)?.baseline?.content ?? null;
  }

  stop() {
    this.stopped = true;
    for (const entry of this.docs.values()) {
      clearTimeout(entry.timer);
      entry.timer = null;
      for (const waiter of entry.waiters.splice(0)) waiter();
    }
    this.docs.clear();
  }
}

module.exports = { DiskSync, mergeThreeWay, applyTextDelta, lineHunks, DISK_ORIGIN };

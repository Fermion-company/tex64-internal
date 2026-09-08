"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { WorkspaceOperationCoordinator } = require("./workspace-operation.cjs");
const { HistoryStore } = require("./history-store.cjs");
const { HistoryTransaction } = require("./history-transaction.cjs");
const { fail, hash, protectedReason, readRegular } = require("./history-files.cjs");

// Storage snapshots retain their original direction; presentation can point
// from the comparison source to the selected version, including image bytes.
const orientComparison = (value, reversed) => {
  if (!reversed) return value;
  const result = { ...value, kind: value.kind === "added" ? "deleted" : value.kind === "deleted" ? "added" : value.kind };
  for (const [before, after] of [["original", "modified"], ["originalSize", "modifiedSize"], ["originalImage", "modifiedImage"]]) {
    if (before in value || after in value) { result[before] = value[after]; result[after] = value[before]; }
  }
  return result;
};

// null means close any text model for this path (deleted or now binary).
// Every changed path must participate in the synchronization acknowledgement.
const editorContent = (bytes) => bytes && !bytes.includes(0) && Buffer.from(bytes.toString("utf8")).equals(bytes) ? bytes.toString("utf8") : null;

class HistoryController {
  constructor(deps) {
    this.deps = deps;
    this.coordinator = deps.coordinator || new WorkspaceOperationCoordinator();
    this._operation = null;
    this.stores = new Map();
    this.plans = new Map();
    this.comparisons = new Map();
    this.preparedRoot = null;
    this.boundaries = new Map();
  }

  get operation() { return this._operation; }
  set operation(value) {
    if (value) this.coordinator.claim("history", value);
    else if (this._operation) this.coordinator.release("history", this._operation.id);
    this._operation = value;
  }

  boundary(root) { return this.boundaries.get(root) || null; }
  async refreshBoundary(store) {
    const latest = (await store.list()).find((record) => record.kind === "restore");
    this.boundaries.set(this.deps.workspace.getRootPath(), latest?.id || null);
  }

  identity() { return { workspaceId: this.deps.state.workspaceId, workspaceGeneration: this.deps.state.workspaceGeneration }; }
  validate(request) {
    const identity = this.identity();
    if (!this.deps.workspace.getRootPath() || !request?.workspaceId || request.workspaceId !== identity.workspaceId ||
        !Number.isSafeInteger(request.workspaceGeneration) || request.workspaceGeneration !== identity.workspaceGeneration) {
      throw fail("STALE_WORKSPACE", "The project changed. Reopen history and try again.");
    }
  }
  blocked() { return this.coordinator.blocked(); }
  assertWriterAllowed() { this.coordinator.assertWriterAllowed(); }
  run(token, action) { return this.coordinator.run(token, action); }
  status() { return { ...this.identity(), phase: this.operation?.phase || "idle", error: this.operation?.error || null }; }
  emit() { this.deps.notify("history:state", this.status()); this.coordinator.emit(); }

  async store() {
    const root = this.deps.workspace.getRootPath();
    if (!root) throw fail("NO_WORKSPACE", "Open a project folder first.");
    let store = this.stores.get(root);
    if (!store) {
      store = new HistoryStore({ root, directory: this.deps.directory() });
      this.stores.set(root, store);
    }
    await store.initialize();
    return store;
  }
  transaction(store) { return new HistoryTransaction(store, { setRootFile: (file) => this.deps.workspace.setRootFile(file || "") }); }
  async rootFile() { return (await this.deps.workspace.rootInfo())?.path || null; }

  async prepareWorkspace(root) {
    if (!root || root !== this.deps.workspace.getRootPath()) return;
    if (this.preparedRoot === root || this.blocked()) return;
    this.operation = { id: crypto.randomUUID(), phase: "recovery" };
    try {
      const store = await this.store();
      await store.exclusive(() => this.transaction(store).recover());
      await this.refreshBoundary(store);
      this.preparedRoot = root;
      this.operation = null;
    } catch (error) {
      this.operation.phase = "recovery-required";
      this.operation.error = error.message;
    }
    this.emit();
  }

  async begin(request) {
    this.validate(request);
    if (this.blocked()) throw fail("HISTORY_BUSY", "Finish the current project operation first.");
    if (this.deps.isAgentBusy()) throw fail("WORKSPACE_BUSY", "Axiom is editing this project. Wait for it to finish before recording or restoring a version.");
    if (request.purpose === "restore" && this.deps.hasTerminals()) throw fail("TERMINAL_BUSY", "Close the running terminal sessions before restoring this project.");
    const op = { id: crypto.randomUUID(), ...this.identity(), phase: "preparing", purpose: request.purpose };
    this.operation = op; this.emit();
    try {
      await this.deps.quiesce();
      this.validate(request);
      op.phase = "saving"; this.emit();
      return { token: op.id };
    } catch (error) { this.operation = null; this.emit(); throw error; }
  }

  async request(action, request) {
    this.validate(request);
    if (this.coordinator.current && this.coordinator.current.owner !== "history" &&
        !["status", "list", "inspect", "diff"].includes(action)) {
      throw fail("HISTORY_BUSY", "Finish the current project operation first.");
    }
    const store = await this.store();
    if (action === "status") return this.status();
    if (action === "begin") return this.begin(request);
    if (action === "release") {
      if (request.token !== this.operation?.id || this.operation.phase !== "saving") throw fail("HISTORY_BUSY", "This operation cannot be released yet.");
      this.operation = null; this.emit(); return {};
    }
    if (action === "ack") {
      const op = this.operation;
      if (!op || request.token !== op.id || op.phase !== "syncing") throw fail("HISTORY_BUSY", "There is no restored editor state to acknowledge.");
      const buffers = request.buffers;
      if (!Array.isArray(op.syncFiles) || !Array.isArray(buffers)) throw fail("SYNC_REQUIRED", "The editor must confirm the restored files before editing resumes.");
      for (const file of op.syncFiles || []) {
        const buffer = buffers.find((item) => item.path === file.path);
        if (buffer && (file.content === null || buffer.content !== file.content || buffer.savedContent !== file.content)) {
          throw fail("SYNC_REQUIRED", "An editor still contains the previous version. Keep this window open and retry synchronization.");
        }
      }
      this.operation = null; this.emit(); return {};
    }
    if (action === "sync") {
      const op = this.operation;
      if (!op || op.phase !== "syncing") throw fail("HISTORY_BUSY", "There is no restored state to synchronize.");
      if (!Array.isArray(op.syncFiles)) {
        if (!Array.isArray(op.syncOperations)) throw fail("SYNC_REQUIRED", "The restored files are not ready to synchronize. Keep this project protected.");
        const files = [];
        for (const item of op.syncOperations) {
          if (!item.modified) files.push({ path: item.path, content: null });
          else {
            const bytes = await store.blob(item.modified.blob);
            files.push({ path: item.path, content: editorContent(bytes) });
          }
        }
        op.syncFiles = files;
      }
      await this.deps.afterRestore(op.syncOperations || []);
      return { token: op.id, files: op.syncFiles };
    }
    if (action === "recover") {
      if (this.operation?.phase !== "recovery-required") throw fail("HISTORY_BUSY", "There is no interrupted restore to recover.");
      await this.run(this.operation.id, () => this.deps.withMutation(() => store.exclusive(() => this.transaction(store).recover())));
      const files = [];
      for (const buffer of request.buffers || []) {
        if (protectedReason(buffer.path)) continue;
        const file = await readRegular(store.root, buffer.path);
        files.push({ path: buffer.path, content: editorContent(file?.bytes) });
      }
      await this.refreshBoundary(store);
      this.operation.syncFiles = files;
      this.deps.advanceGeneration?.();
      await this.deps.afterRestore([]);
      this.preparedRoot = this.deps.workspace.getRootPath();
      this.operation.phase = "syncing";
      this.emit();
      return { token: this.operation.id, files };
    }
    if (action === "list") return store.exclusive(async () => ({ versions: await store.list(), bytes: await store.usage(), maxBytes: store.maxBytes, ...this.status() }));
    if (action === "inspect") return store.exclusive(async () => {
      const record = (await store.list()).find((item) => item.id === request.id);
      if (!record) throw fail("NOT_FOUND", "The selected version was not found.");
      return { excluded: (await store.tree(record.treeId)).excluded || [] };
    });
    if (action === "label") return store.exclusive(() => store.label(request.id, request.label, request.revision));
    if (action === "limit") return store.setLimit(request.gib);
    if (action === "diff") {
      const comparison = this.comparisons.get(request.comparisonId);
      const item = comparison?.changes.find((entry) => entry.path === request.path);
      if (!item || comparison.projectId !== store.projectId) throw fail("NOT_FOUND", "This comparison expired. Open it again.");
      // Large files have a size/hash comparison, without allocating preview bytes.
      if (Math.max(item.original?.size || 0, item.modified?.size || 0) > 10 * 1024 ** 2) {
        return orientComparison({ ...item, text: false, original: null, modified: null, originalImage: null, modifiedImage: null,
          originalSize: item.original?.size || 0, modifiedSize: item.modified?.size || 0 }, comparison.reversed);
      }
      const original = item.original ? await store.blob(item.original.blob) : Buffer.alloc(0);
      let modified = Buffer.alloc(0);
      if (item.modified) {
        if (!comparison.current) modified = await store.blob(item.modified.blob);
        else if (comparison.buffers.has(item.path)) modified = Buffer.from(comparison.buffers.get(item.path));
        else {
          const file = await readRegular(store.root, item.path, store.maxFileBytes);
          if (!file || file.hash !== item.modified.blob) throw fail("COMPARISON_STALE", "The file changed after comparison. Select the version again to refresh it.");
          modified = file.bytes;
        }
      }
      const text = (bytes) => bytes.length <= 2 * 1024 ** 2 && !bytes.includes(0) && Buffer.from(bytes.toString("utf8")).equals(bytes);
      const imageData = (bytes) => {
        if (bytes.length > 10 * 1024 ** 2) return null;
        const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
          : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii")) ? "image/gif"
          : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : null;
        return mime ? `data:${mime};base64,${bytes.toString("base64")}` : null;
      };
      return orientComparison({ ...item, text: text(original) && text(modified), original: text(original) ? original.toString("utf8") : null, modified: text(modified) ? modified.toString("utf8") : null,
        originalImage: imageData(original), modifiedImage: imageData(modified),
        originalSize: original.length, modifiedSize: modified.length }, comparison.reversed);
    }
    if (action === "compare") {
      if (this.blocked()) throw fail("HISTORY_BUSY", "Finish the current project operation first.");
      return this.deps.withMutation(() => store.exclusive(async () => {
        this.validate(request);
        const versions = await store.list();
        const leftRecord = versions.find((item) => item.id === request.left);
        if (!leftRecord) throw fail("NOT_FOUND", "The selected version was not found.");
        const left = await store.tree(leftRecord.treeId);
        let right;
        const buffers = new Map();
        let rightLabel = "";
        if (request.right) {
          const record = versions.find((item) => item.id === request.right);
          if (!record) throw fail("NOT_FOUND", "The comparison version was not found.");
          right = await store.tree(record.treeId);
          rightLabel = record.label || record.createdAt;
        } else {
          right = await store.capture({ rootFile: await this.rootFile(), persist: false });
          for (const buffer of request.buffers || []) {
            if (protectedReason(buffer.path)) continue;
            const entry = right.entries.find((item) => item.path === buffer.path);
            if (!entry || typeof buffer.content !== "string" || typeof buffer.savedContent !== "string") throw fail("DIRTY_CONFLICT", "An open file changed on disk. Resolve the conflict before comparing.");
            if (entry.blob !== hash(Buffer.from(buffer.savedContent))) throw fail("DIRTY_CONFLICT", "An open file changed on disk. Resolve the conflict before comparing.");
            const bytes = Buffer.from(buffer.content);
            entry.blob = hash(bytes); entry.size = bytes.length;
            // Unsaved text cannot be read back from disk. Keep only previewable
            // content; larger entries are compared by metadata without a preview.
            if (bytes.length <= 10 * 1024 ** 2) buffers.set(buffer.path, buffer.content);
          }
        }
        const comparison = { id: crypto.randomUUID(), projectId: store.projectId, current: !request.right, reversed: request.direction === "to-selected", buffers, changes: HistoryStore.changes(left, right), excluded: right.excluded };
        for (const file of buffers.keys()) if (!comparison.changes.some((item) => item.path === file)) buffers.delete(file);
        this.comparisons.clear();
        this.comparisons.set(comparison.id, comparison);
        return { leftLabel: leftRecord.label || leftRecord.createdAt, rightLabel, comparisonId: comparison.id, changes: comparison.changes.map(({ path, kind, original, modified }) => orientComparison({ path, kind, originalSize: original?.size || 0, modifiedSize: modified?.size || 0 }, comparison.reversed)), excluded: comparison.excluded };
      }));
    }
    const op = this.operation;
    if (!op || op.id !== request.token || op.phase !== "saving") throw fail("HISTORY_BUSY", "Prepare the history operation before changing this project.");
    if (action === "record" || action === "plan" || action === "restore") {
      op.phase = "working"; this.emit();
      try {
        return await this.run(op.id, () => this.deps.withMutation(() => store.exclusive(async () => {
          this.validate(request);
          const tx = this.transaction(store);
          let result;
          if (action === "record") result = { record: await store.publish(await store.capture({ rootFile: await this.rootFile() }), { label: request.label || "" }) };
          else if (action === "plan") {
            const plan = await tx.plan(request.id, await this.rootFile());
            this.plans.clear();
            this.plans.set(plan.id, { ...plan, workspaceGeneration: request.workspaceGeneration });
            result = { plan };
          } else {
            const plan = this.plans.get(request.planId);
            if (!plan || plan.workspaceGeneration !== request.workspaceGeneration) throw fail("PLAN_STALE", "The restore preview expired. Review it again.");
            result = await tx.restore(plan);
            this.plans.delete(request.planId);
            op.phase = "syncing";
            op.committed = true;
            this.boundaries.set(this.deps.workspace.getRootPath(), result.record.id);
            this.deps.advanceGeneration?.();
            op.syncOperations = result.operations;
            result.files = [];
            for (const item of result.operations) {
              if (!item.modified) result.files.push({ path: item.path, content: null });
              else {
                const bytes = await store.blob(item.modified.blob);
                result.files.push({ path: item.path, content: editorContent(bytes) });
              }
            }
            op.syncFiles = result.files;
            await this.deps.afterRestore(result.operations);
            result.token = op.id;
          }
          op.phase = action === "restore" ? "syncing" : "saving";
          this.emit(); return result;
        })));
      } catch (error) {
        let pending = false;
        try { await fsp.access(path.join(store.directory, "transaction.json")); pending = true; } catch {}
        op.phase = pending ? "recovery-required" : op.committed ? "syncing" : "saving";
        op.error = pending || op.committed ? error.message : null;
        this.emit(); throw error;
      }
    }
    throw fail("INVALID_ACTION", "Unknown history operation.");
  }
}

module.exports = { HistoryController };

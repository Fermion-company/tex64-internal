"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");

const busy = (message = "Finish the current project operation first.") =>
  Object.assign(new Error(message), { code: "HISTORY_BUSY" });

// One admission gate for operations that may replace project files. History
// and Git retain their own journals; this class only owns the writer lease.
class WorkspaceOperationCoordinator {
  constructor() {
    this.current = null;
    this.context = new AsyncLocalStorage();
    this.listeners = new Set();
  }

  claim(owner, operation) {
    if (!owner || !operation?.id) throw new TypeError("An operation owner and ID are required.");
    if (this.current) {
      if (this.current.owner !== owner || this.current.operation !== operation) throw busy();
      return operation;
    }
    this.current = { owner, operation };
    this.emit();
    return operation;
  }

  release(owner, id) {
    if (!this.current) return;
    if (this.current.owner !== owner || this.current.operation.id !== id) throw busy();
    this.current = null;
    this.emit();
  }

  blocked() { return this.current !== null; }

  assertWriterAllowed() {
    if (!this.current) return;
    const authorization = this.context.getStore();
    if (authorization !== this.current) throw busy("A project operation is protecting these files. Finish it before editing.");
  }

  run(token, action) {
    if (token == null) return this.context.run(null, action);
    const lease = this.current;
    if (!lease || token !== lease.operation.id) throw busy("The project operation has expired.");
    // Capture the lease object, not only its string ID. A callback from a
    // released operation must never gain access to a later operation.
    return this.context.run(lease, action);
  }

  status() {
    const lease = this.current;
    return { owner: lease?.owner || null, phase: lease?.operation.phase || "idle", error: lease?.operation.error || null };
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of this.listeners) listener(this.status()); }
}

module.exports = { WorkspaceOperationCoordinator };

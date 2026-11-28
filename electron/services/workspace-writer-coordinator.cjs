"use strict";

const { canonicalPath } = require("./file-identity.cjs");

class WorkspaceWriterCoordinator {
  constructor() {
    this.rendererMutationCounts = new Map();
    this.isAgentActive = () => false;
  }

  setAgentActiveCheck(check) {
    this.isAgentActive = typeof check === "function" ? check : () => false;
  }

  // `isAgentActive(root)` answers null/false (no Axiom run), "in-process"
  // (an Axiom turn whose writes go through this process's per-file queue) or
  // anything else truthy (Codex, a separate process; Undo/Apply runs). A save
  // of the person's own typing ("save") may go through during an in-process
  // turn: the save and Axiom's writes share the per-file queue and both
  // re-read the disk inside it. Everything else waits for the run to end.
  beginRendererMutation(rootPath, kind = "other") {
    const normalizedRoot = typeof rootPath === "string" && rootPath ? canonicalPath(rootPath) : "";
    const writer = normalizedRoot ? this.isAgentActive(normalizedRoot) : null;
    if (writer && !(kind === "save" && writer === "in-process")) {
      const error = new Error(
        "Axiom is updating this workspace. Your editor changes are still open and will be saved after it finishes.",
      );
      error.code = "AGENT_WORKSPACE_BUSY";
      throw error;
    }
    this.rendererMutationCounts.set(
      normalizedRoot,
      (this.rendererMutationCounts.get(normalizedRoot) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.rendererMutationCounts.get(normalizedRoot) ?? 1) - 1;
      if (next > 0) this.rendererMutationCounts.set(normalizedRoot, next);
      else this.rendererMutationCounts.delete(normalizedRoot);
    };
  }

  hasRendererMutation(rootPath) {
    return (this.rendererMutationCounts.get(rootPath ? canonicalPath(rootPath) : "") ?? 0) > 0;
  }
}

module.exports = { WorkspaceWriterCoordinator };

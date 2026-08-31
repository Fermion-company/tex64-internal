"use strict";

class WorkspaceWriterCoordinator {
  constructor() {
    this.rendererMutationCounts = new Map();
    this.isAgentActive = () => false;
  }

  setAgentActiveCheck(check) {
    this.isAgentActive = typeof check === "function" ? check : () => false;
  }

  beginRendererMutation(rootPath) {
    const normalizedRoot = typeof rootPath === "string" ? rootPath : "";
    if (normalizedRoot && this.isAgentActive(normalizedRoot)) {
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
    return (this.rendererMutationCounts.get(rootPath) ?? 0) > 0;
  }
}

module.exports = { WorkspaceWriterCoordinator };

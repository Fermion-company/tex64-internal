const { createWorkspaceContext } = require("./context.cjs");
const { createWorkspaceFileHandlers } = require("./file-handlers.cjs");
const { createWorkspaceProjectHandlers } = require("./project-handlers.cjs");
const { createWorkspaceAiDocumentHandlers } = require("./ai-documents.cjs");

const createWorkspaceHandlers = (deps) => {
  const ctx = createWorkspaceContext(deps);
  const projectHandlers = createWorkspaceProjectHandlers(ctx);
  const fileHandlers = createWorkspaceFileHandlers(ctx);
  const aiDocumentHandlers = createWorkspaceAiDocumentHandlers(ctx);

  return {
    sendWorkspace: ctx.sendWorkspace,
    updateWorkspaceIfNeeded: ctx.updateWorkspaceIfNeeded,
    requestIndex: ctx.requestIndex,
    sendLauncherStatus: ctx.sendLauncherStatus,
    ensureWorkspace: ctx.ensureWorkspace,
    resolveWorkspacePath: ctx.resolveWorkspacePath,
    openInTerminal: ctx.openInTerminal,
    revealInFinder: ctx.revealInFinder,
    ...projectHandlers,
    ...fileHandlers,
    ...aiDocumentHandlers,
  };
};

module.exports = { createWorkspaceHandlers };


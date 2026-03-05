const { createWorkspaceContext } = require("./context.cjs");
const { createWorkspaceFileHandlers } = require("./file-handlers.cjs");
const { createWorkspaceProjectHandlers } = require("./project-handlers.cjs");

const createWorkspaceHandlers = (deps) => {
  const ctx = createWorkspaceContext(deps);
  const projectHandlers = createWorkspaceProjectHandlers(ctx);
  const fileHandlers = createWorkspaceFileHandlers(ctx);

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
  };
};

module.exports = { createWorkspaceHandlers };


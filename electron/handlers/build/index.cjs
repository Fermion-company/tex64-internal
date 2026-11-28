const { createBuildCoreHandlers } = require("./build-core.cjs");
const { createBuildPathResolvers } = require("./path-resolvers.cjs");
const { createSynctexForwardHandler } = require("./synctex-forward.cjs");
const { createSynctexReverseHandler } = require("./synctex-reverse.cjs");
const { createBuildSourceTracker } = require("../../services/synctex/build-sources.cjs");

const createBuildHandlers = (deps) => {
  const { fs, path } = deps;
  const resolvers = createBuildPathResolvers({ fs, path });
  // What each Build read, so Jump can number the caret's line as that
  // Build's SyncTeX does (synctex/build-sources.cjs).
  const buildSources = deps.buildSources ?? createBuildSourceTracker();
  // `detail` (the build result) goes on to Axiom's record of recent builds (main.cjs).
  const sendBuildState = (state, message, extra, detail) => {
    try { buildSources.observe(state, extra, deps.ensureWorkspace?.()); } catch { /* Jump only */ }
    return deps.sendBuildState(state, message, extra, detail);
  };

  const core = createBuildCoreHandlers({ ...deps, sendBuildState }, resolvers);
  return {
    ...core,
    ...createSynctexForwardHandler({ ...deps, resolveJumpDocument: core.resolveJumpDocument, buildSources }, resolvers),
    ...createSynctexReverseHandler(deps, resolvers),
  };
};

module.exports = { createBuildHandlers };

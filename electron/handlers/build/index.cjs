const { createBuildCoreHandlers } = require("./build-core.cjs");
const { createBuildPathResolvers } = require("./path-resolvers.cjs");
const { createSynctexForwardHandler } = require("./synctex-forward.cjs");
const { createSynctexReverseHandler } = require("./synctex-reverse.cjs");

const createBuildHandlers = (deps) => {
  const { fs, path } = deps;
  const resolvers = createBuildPathResolvers({ fs, path });

  return {
    ...createBuildCoreHandlers(deps, resolvers),
    ...createSynctexForwardHandler(deps, resolvers),
    ...createSynctexReverseHandler(deps, resolvers),
  };
};

module.exports = { createBuildHandlers };


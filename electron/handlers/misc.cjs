const createMiscHandlers = (deps) => {
  const {
    envService,
    ensureUserSettings,
    workspace,
    sendToRenderer,
    blocksStore,
  } = deps;

  const handleEnvCheck = async (command) => {
    const result = await envService.checkCommand(command);
    sendToRenderer("env:checkResult", { command, available: result });
  };

  const handleEnvInstall = async (target) => {
    sendToRenderer("env:installStart", { target });
    const result = await envService.installEnvironment(target);
    sendToRenderer("env:installResult", { target, ...result });
    // Re-check relevant commands after install attempt
    if (target === "basictex") {
      const lualatex = await envService.checkCommand("lualatex");
      const latexmk = await envService.checkCommand("latexmk");
      sendToRenderer("env:checkResult", { command: "lualatex", available: lualatex });
      sendToRenderer("env:checkResult", { command: "latexmk", available: latexmk });
    } else if (target === "latexmk") {
      const available = await envService.checkCommand("latexmk");
      sendToRenderer("env:checkResult", { command: "latexmk", available });
    }
  };

  const handleAlchemySettingsGet = async () => {
    const settings = await ensureUserSettings().getAlchemySettings();
    sendToRenderer("alchemy:settings", { settings });
  };

  const handleAlchemySettingsSet = async (partial) => {
    const settings = await ensureUserSettings().updateAlchemySettings(partial);
    sendToRenderer("alchemy:settings", { settings });
  };

  const handleBlocksSave = async (entry) => {
    const rootPath = workspace.getRootPath();
    if (!rootPath) {
      return;
    }
    let blocks = [];
    try {
      blocks = await blocksStore.load(rootPath);
    } catch {
      blocks = [];
    }
    if (entry && typeof entry === "object") {
      blocks.push(entry);
    }
    await blocksStore.save(rootPath, blocks);
  };

  return {
    handleEnvCheck,
    handleEnvInstall,
    handleAlchemySettingsGet,
    handleAlchemySettingsSet,
    handleBlocksSave,
  };
};

module.exports = { createMiscHandlers };

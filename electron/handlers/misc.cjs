const path = require("path");
const os = require("os");
const { createUpdateHandlers } = require("./misc-update-handlers.cjs");
const { createPlatformHandlers } = require("./misc-platform-handlers.cjs");
const { createApiGhostCompletionHandler } = require("./misc-completion-handler.cjs");

const GHOST_COMPLETION_TEMP_DISABLED = true;

const createMiscHandlers = (deps) => {
  const {
    envService,
    ensureUserSettings,
    workspace,
    shell,
    Notification,
    sendToRenderer,
    blocksStore,
    apiUsageService,
    platformService,
    ensureProtocolClient,
    runtimeInfo,
  } = deps;
  const appVersion =
    typeof runtimeInfo?.version === "string" && runtimeInfo.version.trim()
      ? runtimeInfo.version.trim()
      : "0.0.0";
  const appPlatform =
    typeof runtimeInfo?.platform === "string" && runtimeInfo.platform.trim()
      ? runtimeInfo.platform.trim()
      : process.platform;
  const appArch =
    typeof runtimeInfo?.arch === "string" && runtimeInfo.arch.trim()
      ? runtimeInfo.arch.trim()
      : process.arch;
  const strictProduction = runtimeInfo?.packaged === true;
  const defaultUpdateChannel =
    typeof process.env.TEX64_UPDATE_CHANNEL === "string" &&
    process.env.TEX64_UPDATE_CHANNEL.trim()
      ? process.env.TEX64_UPDATE_CHANNEL.trim()
      : "stable";
  const updateDownloadDir = path.join(
    typeof runtimeInfo?.userDataPath === "string" && runtimeInfo.userDataPath.trim()
      ? runtimeInfo.userDataPath.trim()
      : os.tmpdir(),
    "updates"
  );

  const platformHandlers = createPlatformHandlers({
    platformService,
    shell,
    sendToRenderer,
    ensureProtocolClient,
    appVersion,
    appPlatform,
    appArch,
  });

  const updateHandlers = createUpdateHandlers({
    platformService,
    shell,
    Notification,
    sendToRenderer,
    appPlatform,
    appArch,
    appVersion,
    defaultUpdateChannel,
    updateDownloadDir,
  });

  const handleEnvCheck = async (command) => {
    const result = await envService.checkCommand(command);
    sendToRenderer("env:checkResult", { command, available: result });
  };

  const handleEnvInstall = async (target) => {
    sendToRenderer("env:installStart", { target });
    const result = await envService.installEnvironment(target);
    sendToRenderer("env:installResult", { target, ...result });
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

  const handleApiUsageGet = async () => {
    if (!apiUsageService) {
      return;
    }
    const snapshot = await apiUsageService.getSnapshot();
    sendToRenderer("api:usage", { snapshot });
  };

  const handleApiUsageReset = async () => {
    if (!apiUsageService) {
      return;
    }
    const snapshot = await apiUsageService.reset();
    sendToRenderer("api:usage", { snapshot });
  };

  const handleApiGhostCompletion = createApiGhostCompletionHandler({
    platformService,
    emitPlatformAiAccess: platformHandlers.emitPlatformAiAccess,
    ensureUserSettings,
    apiUsageService,
    sendToRenderer,
    strictProduction,
    ghostCompletionDisabled: GHOST_COMPLETION_TEMP_DISABLED,
  });

  return {
    handleEnvCheck,
    handleEnvInstall,
    handleBlocksSave,
    handleApiUsageGet,
    handleApiUsageReset,
    handlePlatformStateGet: platformHandlers.handlePlatformStateGet,
    handleFeatureCheck: platformHandlers.handleFeatureCheck,
    handlePlatformUsageGet: platformHandlers.handlePlatformUsageGet,
    handleUpdateCheck: updateHandlers.handleUpdateCheck,
    handleUpdateDownload: updateHandlers.handleUpdateDownload,
    handleUpdateInstall: updateHandlers.handleUpdateInstall,
    handleUpdateStatusGet: updateHandlers.handleUpdateStatusGet,
    handleAuthGoogleStart: platformHandlers.handleAuthGoogleStart,
    handleAuthGoogleCallback: platformHandlers.handleAuthGoogleCallback,
    handleAuthGoogleCancel: platformHandlers.handleAuthGoogleCancel,
    handleAuthSignOut: platformHandlers.handleAuthSignOut,
    handleOpenExternal: platformHandlers.handleOpenExternal,
    handleFeedbackSend: platformHandlers.handleFeedbackSend,
    handleErrorReportSend: platformHandlers.handleErrorReportSend,
    handleApiGhostCompletion,
  };
};

module.exports = { createMiscHandlers };

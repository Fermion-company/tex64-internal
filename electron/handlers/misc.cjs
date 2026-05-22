const path = require("path");
const os = require("os");
const { createUpdateHandlers } = require("./misc-update-handlers.cjs");
const { createPlatformHandlers } = require("./misc-platform-handlers.cjs");
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
    const result = await envService.installEnvironment(target, (progress) => {
      sendToRenderer("env:installProgress", { target, ...progress });
    });
    sendToRenderer("env:installResult", { target, ...result });
    const commands =
      target === "basictex" || target === "synctex"
        ? ["lualatex", "pdflatex", "xelatex", "uplatex", "latexmk", "latexindent", "synctex"]
        : target === "latexmk"
        ? ["latexmk"]
        : target === "latexindent"
        ? ["latexindent"]
        : [];
    for (const command of commands) {
      const available = await envService.checkCommand(command);
      sendToRenderer("env:checkResult", { command, available });
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

  const emitAnnouncementsForRenderer = async (
    fetchedAnnouncements,
    fetchedAt
  ) => {
    const settings = ensureUserSettings();
    const dismissed = new Set(await settings.getDismissedAnnouncementIds());
    const pending = fetchedAnnouncements.filter((entry) => !dismissed.has(entry.id));
    sendToRenderer("platform:announcements", {
      announcements: pending,
      fetchedAt,
    });
  };

  const handleAnnouncementsCheck = async () => {
    if (!platformService || typeof platformService.fetchAnnouncements !== "function") {
      return;
    }
    try {
      const result = await platformService.fetchAnnouncements();
      const announcements = Array.isArray(result?.announcements)
        ? result.announcements
        : [];
      const fetchedAt =
        typeof result?.fetchedAt === "number" ? result.fetchedAt : Date.now();
      await emitAnnouncementsForRenderer(announcements, fetchedAt);
    } catch {
      // Announcements are best-effort. Stay silent on failure.
    }
  };

  const handleAnnouncementDismiss = async (payload) => {
    const id =
      payload && typeof payload === "object" && typeof payload.id === "string"
        ? payload.id
        : "";
    if (!id.trim()) {
      return;
    }
    const settings = ensureUserSettings();
    await settings.addDismissedAnnouncementId(id.trim());
  };

  const handleApiUsageReset = async () => {
    if (!apiUsageService) {
      return;
    }
    const snapshot = await apiUsageService.reset();
    sendToRenderer("api:usage", { snapshot });
  };

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
    handleAnnouncementsCheck,
    handleAnnouncementDismiss,
    handleAuthGoogleStart: platformHandlers.handleAuthGoogleStart,
    handleAuthGoogleCallback: platformHandlers.handleAuthGoogleCallback,
    handleAuthGoogleCancel: platformHandlers.handleAuthGoogleCancel,
    handleAuthSignOut: platformHandlers.handleAuthSignOut,
    handleOpenExternal: platformHandlers.handleOpenExternal,
    handleFeedbackSend: platformHandlers.handleFeedbackSend,
  };
};

module.exports = { createMiscHandlers };

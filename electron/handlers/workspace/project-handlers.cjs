// Per-locale strings for native dialogs (file picker title/message/buttons).
// These show in OS-level chrome that bypasses the renderer's i18n DOM observer,
// so they must be localized here in the main process.
const DIALOG_STRINGS = {
  ja: {
    selectTitle: "プロジェクトを選択",
    selectMessage: "LaTeX プロジェクト用のフォルダを選択してください。",
    selectButton: "選択",
    newTitle: "新規プロジェクト",
    newMessage: "プロジェクト用のフォルダを作成または選択してください。",
    newButton: "作成",
  },
  en: {
    selectTitle: "Select project",
    selectMessage: "Select a folder for your LaTeX project.",
    selectButton: "Select",
    newTitle: "New project",
    newMessage: "Create or select a folder for your project.",
    newButton: "Create",
  },
  zh: {
    selectTitle: "选择项目",
    selectMessage: "请选择 LaTeX 项目所在的文件夹。",
    selectButton: "选择",
    newTitle: "新建项目",
    newMessage: "请创建或选择项目文件夹。",
    newButton: "创建",
  },
  ko: {
    selectTitle: "프로젝트 선택",
    selectMessage: "LaTeX 프로젝트 폴더를 선택하세요.",
    selectButton: "선택",
    newTitle: "새 프로젝트",
    newMessage: "프로젝트 폴더를 생성하거나 선택하세요.",
    newButton: "생성",
  },
  de: {
    selectTitle: "Projekt auswählen",
    selectMessage: "Wählen Sie einen Ordner für Ihr LaTeX-Projekt.",
    selectButton: "Auswählen",
    newTitle: "Neues Projekt",
    newMessage: "Erstellen oder wählen Sie einen Ordner für Ihr Projekt.",
    newButton: "Erstellen",
  },
  fr: {
    selectTitle: "Sélectionner un projet",
    selectMessage: "Sélectionnez un dossier pour votre projet LaTeX.",
    selectButton: "Sélectionner",
    newTitle: "Nouveau projet",
    newMessage: "Créez ou sélectionnez un dossier pour votre projet.",
    newButton: "Créer",
  },
  es: {
    selectTitle: "Seleccionar proyecto",
    selectMessage: "Selecciona una carpeta para tu proyecto LaTeX.",
    selectButton: "Seleccionar",
    newTitle: "Nuevo proyecto",
    newMessage: "Crea o selecciona una carpeta para tu proyecto.",
    newButton: "Crear",
  },
};

const SUPPORTED_DIALOG_LOCALES = new Set(Object.keys(DIALOG_STRINGS));

const resolveDialogStrings = (rawLocale) => {
  if (typeof rawLocale === "string" && SUPPORTED_DIALOG_LOCALES.has(rawLocale)) {
    return DIALOG_STRINGS[rawLocale];
  }
  return DIALOG_STRINGS.en;
};

const createWorkspaceProjectHandlers = (ctx) => {
  const {
    dialog,
    fsp,
    workspace,
    sendToRenderer,
    sendIssues,
    state,
    userSettings,
    sendLauncherStatus,
    updateWorkspaceIfNeeded,
    requestIndex,
    ensureWorkspace,
    sendWorkspace,
    searchService,
    fileAccess,
  } = ctx;

  const e2eDialogQueueState = {
    initialized: false,
    openWorkspace: [],
    createProject: [],
  };

  const initializeE2eDialogQueue = () => {
    if (e2eDialogQueueState.initialized) {
      return;
    }
    e2eDialogQueueState.initialized = true;
    const rawQueue = process.env.TEX64_E2E_DIALOG_QUEUE;
    if (typeof rawQueue !== "string" || !rawQueue.trim()) {
      return;
    }
    try {
      const parsed = JSON.parse(rawQueue);
      if (Array.isArray(parsed?.openWorkspace)) {
        e2eDialogQueueState.openWorkspace = parsed.openWorkspace;
      }
      if (Array.isArray(parsed?.createProject)) {
        e2eDialogQueueState.createProject = parsed.createProject;
      }
    } catch {
      // Ignore malformed queue; tests can still use single-path env overrides.
    }
  };

  const consumeE2eDialogResult = (kind) => {
    if (process.env.TEX64_E2E !== "1") {
      return null;
    }
    initializeE2eDialogQueue();
    let rawValue = null;
    const queue = e2eDialogQueueState[kind];
    if (Array.isArray(queue) && queue.length > 0) {
      rawValue = queue.shift();
    } else if (kind === "openWorkspace") {
      rawValue = process.env.TEX64_E2E_OPEN_WORKSPACE_PATH ?? "";
    } else if (kind === "createProject") {
      rawValue = process.env.TEX64_E2E_CREATE_PROJECT_PATH ?? "";
    }
    const selectedPath =
      typeof rawValue === "string" ? rawValue.trim() : "";
    if (!selectedPath) {
      return { canceled: true, filePaths: [] };
    }
    return { canceled: false, filePaths: [selectedPath] };
  };

  const handleOpenWorkspace = async (payload = {}) => {
    if (!state.mainWindow) {
      return;
    }
    const strings = resolveDialogStrings(payload && payload.locale);
    sendLauncherStatus({ isBusy: true, message: null });
    const result =
      consumeE2eDialogResult("openWorkspace") ??
      (await dialog.showOpenDialog(state.mainWindow, {
        title: strings.selectTitle,
        message: strings.selectMessage,
        properties: ["openDirectory"],
        buttonLabel: strings.selectButton,
      }));
    if (result.canceled || result.filePaths.length === 0) {
      sendLauncherStatus({ isBusy: false, message: null });
      return;
    }
    const rootPath = result.filePaths[0];
    workspace.setRootPath(rootPath);
    state.lastBuildPdfPath = null;
    state.currentWorkspacePath = null;
    await updateWorkspaceIfNeeded(rootPath, true);
    requestIndex(rootPath);
    // Track recent project
    if (userSettings) {
      userSettings
        .addRecentProject(rootPath)
        .then((projects) => {
          sendToRenderer("recentProjects", { projects });
        })
        .catch(() => {});
    }
    sendLauncherStatus({ isBusy: false, message: null });
  };

  const handleOpenRecentProject = async (projectPath) => {
    if (!state.mainWindow || !projectPath) {
      return;
    }
    sendLauncherStatus({ isBusy: true, message: null });
    if (!(await fileAccess.ensureAccess(projectPath))) {
      sendLauncherStatus({ isBusy: false, message: null });
      return;
    }
    // Verify the path exists
    try {
      const stats = await fsp.stat(projectPath);
      if (!stats.isDirectory()) {
        sendLauncherStatus({ isBusy: false, message: "Folder not found." });
        // Remove from recent projects if it doesn't exist
        if (userSettings) {
          userSettings
            .removeRecentProject(projectPath)
            .then((projects) => {
              sendToRenderer("recentProjects", { projects });
            })
            .catch(() => {});
        }
        return;
      }
    } catch {
      sendLauncherStatus({ isBusy: false, message: "Folder not found." });
      if (userSettings) {
        userSettings
          .removeRecentProject(projectPath)
          .then((projects) => {
            sendToRenderer("recentProjects", { projects });
          })
          .catch(() => {});
      }
      return;
    }
    workspace.setRootPath(projectPath);
    state.lastBuildPdfPath = null;
    state.currentWorkspacePath = null;
    await updateWorkspaceIfNeeded(projectPath, true);
    requestIndex(projectPath);
    // Track recent project (moves it to top)
    if (userSettings) {
      userSettings
        .addRecentProject(projectPath)
        .then((projects) => {
          sendToRenderer("recentProjects", { projects });
        })
        .catch(() => {});
    }
    sendLauncherStatus({ isBusy: false, message: null });
  };

  const handleCreateProject = async (payload = {}) => {
    if (!state.mainWindow) {
      return;
    }
    const strings = resolveDialogStrings(payload && payload.locale);
    sendLauncherStatus({ isBusy: true, message: null });
    const result =
      consumeE2eDialogResult("createProject") ??
      (await dialog.showOpenDialog(state.mainWindow, {
        title: strings.newTitle,
        message: strings.newMessage,
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: strings.newButton,
      }));
    if (result.canceled || result.filePaths.length === 0) {
      sendLauncherStatus({ isBusy: false, message: null });
      return;
    }
    const rootPath = result.filePaths[0];
    const SUPPORTED_TEMPLATE_LOCALES = new Set(["ja", "en", "zh", "ko", "de", "fr", "es"]);
    const requestedLocale = payload && typeof payload.locale === "string" ? payload.locale : null;
    const locale = SUPPORTED_TEMPLATE_LOCALES.has(requestedLocale) ? requestedLocale : "en";
    try {
      await workspace.initializeProject(rootPath, locale);
    } catch (error) {
      sendLauncherStatus({ isBusy: false, message: error.message });
      return;
    }
    workspace.setRootPath(rootPath);
    state.lastBuildPdfPath = null;
    state.currentWorkspacePath = null;
    await updateWorkspaceIfNeeded(rootPath, true);
    requestIndex(rootPath);
    // Track recent project
    if (userSettings) {
      userSettings
        .addRecentProject(rootPath)
        .then((projects) => {
          sendToRenderer("recentProjects", { projects });
        })
        .catch(() => {});
    }
    sendLauncherStatus({ isBusy: false, message: null });
  };

  const handleSetRoot = async (relativePath) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
      ]);
      return;
    }
    try {
      await workspace.setRootFile(relativePath);
      await sendWorkspace(rootPath);
      sendIssues(0, "Main TeX updated.", "success", []);
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleDetectRoot = async () => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
      ]);
      return;
    }
    try {
      await workspace.clearRootOverride();
      await sendWorkspace(rootPath);
      sendIssues(0, "Main TeX auto-detected.", "success", []);
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleBuildProfilesUpdate = async (profiles, activeId) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
      ]);
      return;
    }
    const normalized = Array.isArray(profiles) ? profiles : [];
    const cleaned = normalized
      .map((profile) => (profile && typeof profile === "object" ? profile : null))
      .filter(Boolean)
      .map((profile) => {
        const id =
          typeof profile.id === "string" ? profile.id.trim() : "";
        const name =
          typeof profile.name === "string" ? profile.name.trim() : "";
        const outDir =
          typeof profile.outDir === "string" ? profile.outDir.trim() : "";
        const extraArgs =
          typeof profile.extraArgs === "string" ? profile.extraArgs.trim() : "";
        if (!id) {
          return null;
        }
        return {
          id,
          name: name || id,
          outDir: outDir || null,
          extraArgs: extraArgs || null,
        };
      })
      .filter(Boolean)
      .slice(0, 20);

    const nextActive =
      typeof activeId === "string" ? activeId.trim() : "";
    const activeExists = cleaned.some((profile) => profile.id === nextActive);
    const resolvedActive = activeExists ? nextActive : "";

    try {
      await workspace.updateSettings((settings) => {
        if (cleaned.length > 0) {
          settings.buildProfiles = cleaned;
        } else {
          delete settings.buildProfiles;
        }
        if (resolvedActive) {
          settings.buildProfileId = resolvedActive;
        } else {
          delete settings.buildProfileId;
        }
        return settings;
      });
      await sendWorkspace(rootPath);
      sendIssues(0, "Build profile updated.", "success", []);
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleIndexRequest = () => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      return;
    }
    requestIndex(rootPath);
  };

  const handleSearch = async (query, requestId) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("updateSearch", {
        query,
        results: [],
        message: "No workspace is selected.",
        requestId,
      });
      return;
    }
    const results = await searchService.search(rootPath, query ?? "");
    sendToRenderer("updateSearch", { query, results, requestId });
  };

  return {
    handleOpenWorkspace,
    handleOpenRecentProject,
    handleCreateProject,
    handleSetRoot,
    handleDetectRoot,
    handleBuildProfilesUpdate,
    handleIndexRequest,
    handleSearch,
  };
};

module.exports = { createWorkspaceProjectHandlers };

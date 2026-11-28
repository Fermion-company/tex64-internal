// Per-locale strings for native dialogs (file picker title/buttons).
// These show in OS-level chrome that bypasses the renderer's i18n DOM observer,
// so they must be localized here in the main process.
const DIALOG_STRINGS = {
  ja: {
    selectTitle: "プロジェクト",
    selectButton: "選択",
    newTitle: "新規プロジェクト",
    newButton: "作成",
    missingFolder: "選択したフォルダが見つかりません。",
    inaccessibleFolder: "選択したフォルダを開けません。アクセス権を確認してください。",
  },
  en: {
    selectTitle: "Project",
    selectButton: "Select",
    newTitle: "New project",
    newButton: "Create",
    missingFolder: "The selected folder could not be found.",
    inaccessibleFolder: "The selected folder could not be opened. Check its permissions.",
  },
  zh: {
    selectTitle: "项目",
    selectButton: "选择",
    newTitle: "新建项目",
    newButton: "创建",
    missingFolder: "找不到所选文件夹。",
    inaccessibleFolder: "无法打开所选文件夹。请检查访问权限。",
  },
  ko: {
    selectTitle: "프로젝트",
    selectButton: "선택",
    newTitle: "새 프로젝트",
    newButton: "생성",
    missingFolder: "선택한 폴더를 찾을 수 없습니다.",
    inaccessibleFolder: "선택한 폴더를 열 수 없습니다. 접근 권한을 확인하세요.",
  },
  de: {
    selectTitle: "Projekt",
    selectButton: "Auswählen",
    newTitle: "Neues Projekt",
    newButton: "Erstellen",
    missingFolder: "Der ausgewählte Ordner wurde nicht gefunden.",
    inaccessibleFolder: "Der ausgewählte Ordner lässt sich nicht öffnen. Prüfen Sie die Zugriffsrechte.",
  },
  fr: {
    selectTitle: "Projet",
    selectButton: "Sélectionner",
    newTitle: "Nouveau projet",
    newButton: "Créer",
    missingFolder: "Le dossier sélectionné est introuvable.",
    inaccessibleFolder: "Impossible d’ouvrir le dossier sélectionné. Vérifiez les autorisations.",
  },
  es: {
    selectTitle: "Proyecto",
    selectButton: "Seleccionar",
    newTitle: "Nuevo proyecto",
    newButton: "Crear",
    missingFolder: "No se encuentra la carpeta seleccionada.",
    inaccessibleFolder: "No se puede abrir la carpeta seleccionada. Comprueba los permisos.",
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
    beforeWorkspaceChange,
    beginRendererWorkspaceMutation = () => () => {},
    beginWorkspaceSession,
    acquireWorkspaceMutation = async () => () => {},
    withWorkspaceMutation = async (operation) => operation(),
  } = ctx;

  const mutateCapturedWorkspace = (rootPath, operation) => {
    const generation = state.workspaceGeneration;
    return withWorkspaceMutation(async () => {
      if (ensureWorkspace() !== rootPath || state.workspaceGeneration !== generation) {
        throw new Error("The workspace changed before the operation finished.");
      }
      return operation();
    });
  };

  const prepareWorkspaceChange = async (toRootPath, reason) => {
    const releaseWorkspace = await acquireWorkspaceMutation();
    let releaseTransition = null;
    try {
      const fromRootPath = workspace.getRootPath();
      await beforeWorkspaceChange({
        fromRootPath,
        toRootPath,
        reason,
      });
      // `waitForIdle` is only an observation. A new turn can reserve the old
      // workspace immediately after it resolves, so synchronously acquire the
      // shared external-writer leases before changing root identity. Hold both
      // the old and new roots until the first new-root snapshot is complete.
      const transitionReleases = [];
      try {
        for (const rootPath of new Set([fromRootPath, toRootPath])) {
          if (typeof rootPath !== "string" || !rootPath) continue;
          transitionReleases.push(beginRendererWorkspaceMutation(rootPath));
        }
      } catch (error) {
        transitionReleases.reverse().forEach((release) => release?.());
        throw error;
      }
      releaseTransition = () => {
        transitionReleases.reverse().forEach((release) => release?.());
      };
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseTransition?.();
        releaseWorkspace();
      };
    } catch (error) {
      releaseTransition?.();
      releaseWorkspace();
      sendLauncherStatus({
        isBusy: false,
        message: error?.message || "Could not finish work in the current project.",
      });
      return null;
    }
  };

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

  const reportOpenError = (message) => {
    sendLauncherStatus({ isBusy: false, message });
    if (workspace.getRootPath()) {
      sendIssues(1, message, "error", [{ severity: "error", message }]);
    }
  };

  let activeSearch;
  const activateFolder = async (projectPath, reason, strings) => {
    try {
      // A picked folder can be removed, replaced by a file or made unreadable
      // while the dialog closes. Keep the current workspace until it can be opened.
      const directory = await fsp.opendir(projectPath);
      await directory.close();
    } catch (error) {
      const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
      reportOpenError(missing ? strings.missingFolder : strings.inaccessibleFolder);
      if (missing && reason === "recent" && userSettings) {
        const projects = await userSettings.removeRecentProject(projectPath).catch(() => null);
        if (projects) sendToRenderer("recentProjects", { projects });
      }
      return;
    }
    const releaseWorkspace = await prepareWorkspaceChange(projectPath, reason);
    if (!releaseWorkspace) return;
    try {
      activeSearch?.abort();
      workspace.setRootPath(projectPath);
      beginWorkspaceSession(projectPath);
      state.lastBuildPdfPath = null;
      await updateWorkspaceIfNeeded(projectPath, true);
      requestIndex(projectPath);
    } finally {
      releaseWorkspace();
    }
    if (userSettings) {
      userSettings.addRecentProject(projectPath)
        .then(projects => sendToRenderer("recentProjects", { projects }))
        .catch(() => {});
    }
    sendLauncherStatus({ isBusy: false, message: null });
  };

  const selectFolder = async (reason, payload = {}) => {
    if (!state.mainWindow) return;
    const strings = resolveDialogStrings(payload?.locale);
    const create = reason === "create";
    sendLauncherStatus({ isBusy: true, message: null });
    try {
      const result = consumeE2eDialogResult(create ? "createProject" : "openWorkspace")
        ?? await dialog.showOpenDialog(state.mainWindow, {
          title: create ? strings.newTitle : strings.selectTitle,
          properties: create ? ["openDirectory", "createDirectory"] : ["openDirectory"],
          buttonLabel: create ? strings.newButton : strings.selectButton,
        });
      const folder = result.filePaths?.[0];
      if (result.canceled || !folder) {
        sendLauncherStatus({ isBusy: false, message: null });
        return;
      }
      await activateFolder(folder, reason, strings);
    } catch (error) {
      reportOpenError(error?.message || strings.inaccessibleFolder);
    }
  };
  const handleOpenWorkspace = payload => selectFolder("open", payload);
  const handleCreateProject = payload => selectFolder("create", payload);

  // Recents and imports already have a path, without a fresh picker grant.
  const openWorkspacePath = async (projectPath, reason = "recent") => {
    if (!state.mainWindow || typeof projectPath !== "string" || !projectPath) return;
    const strings = resolveDialogStrings(state.uiLocale);
    sendLauncherStatus({ isBusy: true, message: null });
    try {
      if (!await fileAccess.ensureAccess(projectPath)) {
        reportOpenError(strings.inaccessibleFolder);
        return;
      }
      await activateFolder(projectPath, reason, strings);
    } catch (error) {
      reportOpenError(error?.message || strings.inaccessibleFolder);
    }
  };
  const handleOpenRecentProject = projectPath => openWorkspacePath(projectPath, "recent");

  const handleSetRoot = async (relativePath, guestRequest) => {
    const rootPath = ensureWorkspace();
    const reply = (ok) => {
      if (!guestRequest) return;
      sendToRenderer("workspace:chooseRootResult", {
        requestId: guestRequest.requestId,
        workspaceId: guestRequest.workspaceId,
        workspaceGeneration: guestRequest.workspaceGeneration,
        ok,
      });
    };
    try {
      if (!rootPath) throw new Error("No workspace is selected.");
      await mutateCapturedWorkspace(rootPath, async () => {
        if (guestRequest) {
          // The same directory can have been closed and reopened while the
          // request waited for the mutation lease. Check its session here.
          if (!state.workspaceId || guestRequest.workspaceId !== state.workspaceId ||
              !Number.isSafeInteger(guestRequest.workspaceGeneration) ||
              guestRequest.workspaceGeneration !== state.workspaceGeneration ||
              typeof relativePath !== "string" || !/\.tex$/i.test(relativePath) ||
              !(await workspace.listFiles()).includes(relativePath)) {
            throw new Error("The selected TeX file is not available in this workspace.");
          }
          const existingRoot = await workspace.rootInfo();
          if (existingRoot?.path && existingRoot.path !== relativePath) {
            throw new Error("The workspace root has already changed.");
          }
        }
        await workspace.setRootFile(relativePath);
        await sendWorkspace(rootPath);
        sendIssues(0, "Main TeX updated.", "success", []);
        reply(true);
      });
    } catch (error) {
      reply(false);
      if (!guestRequest) {
        sendIssues(1, error.message, "error", [
          { severity: "error", message: error.message, line: null },
        ]);
      }
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
      await mutateCapturedWorkspace(rootPath, async () => {
        await workspace.clearRootOverride();
        await sendWorkspace(rootPath);
        sendIssues(0, "Main TeX auto-detected.", "success", []);
      });
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleBuildProfilesUpdate = async (profiles, activeId, requestedRoot) => {
    const rootPath = ensureWorkspace();
    if (typeof requestedRoot === "string" && requestedRoot !== rootPath) return;
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
        const engine =
          typeof profile.engine === "string" && ["pdflatex", "lualatex", "xelatex", "uplatex"].includes(profile.engine.trim())
            ? profile.engine.trim()
            : null;
        if (!id) {
          return null;
        }
        return {
          id,
          name: name || id,
          outDir: outDir || null,
          extraArgs: extraArgs || null,
          ...(engine ? { engine } : {}),
        };
      })
      .filter(Boolean)
      .slice(0, 20);

    const nextActive =
      typeof activeId === "string" ? activeId.trim() : "";
    const activeExists = cleaned.some((profile) => profile.id === nextActive);
    const resolvedActive = activeExists ? nextActive : "";

    try {
      await mutateCapturedWorkspace(rootPath, async () => {
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
      });
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

  const handleSearch = async (query, requestId, drafts) => {
    activeSearch?.abort();
    const controller = new AbortController();
    activeSearch = controller;
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
    const generation = state.workspaceGeneration;
    try {
      const results = await searchService.search(rootPath, query ?? "", controller.signal, drafts);
      if (controller.signal.aborted || ensureWorkspace() !== rootPath || state.workspaceGeneration !== generation) return;
      sendToRenderer("updateSearch", { query, results, requestId });
    } finally {
      if (activeSearch === controller) activeSearch = null;
    }
  };

  return {
    handleOpenWorkspace,
    handleOpenRecentProject,
    openWorkspacePath,
    handleCreateProject,
    handleSetRoot,
    handleDetectRoot,
    handleBuildProfilesUpdate,
    handleIndexRequest,
    handleSearch,
  };
};

module.exports = { createWorkspaceProjectHandlers };

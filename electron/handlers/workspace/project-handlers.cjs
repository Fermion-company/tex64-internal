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

  const handleOpenWorkspace = async () => {
    if (!state.mainWindow) {
      return;
    }
    sendLauncherStatus({ isBusy: true, message: null });
    const result =
      consumeE2eDialogResult("openWorkspace") ??
      (await dialog.showOpenDialog(state.mainWindow, {
        title: "プロジェクトを選択",
        message: "LaTeXプロジェクトのフォルダを選択してください。",
        properties: ["openDirectory"],
        buttonLabel: "選択",
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
    // Verify the path exists
    try {
      const stats = await fsp.stat(projectPath);
      if (!stats.isDirectory()) {
        sendLauncherStatus({ isBusy: false, message: "フォルダが見つかりません。" });
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
      sendLauncherStatus({ isBusy: false, message: "フォルダが見つかりません。" });
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

  const handleCreateProject = async () => {
    if (!state.mainWindow) {
      return;
    }
    sendLauncherStatus({ isBusy: true, message: null });
    const result =
      consumeE2eDialogResult("createProject") ??
      (await dialog.showOpenDialog(state.mainWindow, {
        title: "新規プロジェクト",
        message: "プロジェクト用フォルダを作成または選択してください。",
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: "作成",
      }));
    if (result.canceled || result.filePaths.length === 0) {
      sendLauncherStatus({ isBusy: false, message: null });
      return;
    }
    const rootPath = result.filePaths[0];
    try {
      await workspace.initializeProject(rootPath);
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
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    try {
      await workspace.setRootFile(relativePath);
      await sendWorkspace(rootPath);
      sendIssues(0, "メインTeXを更新しました。", "success", []);
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleDetectRoot = async () => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    try {
      await workspace.clearRootOverride();
      await sendWorkspace(rootPath);
      sendIssues(0, "メインTeXを自動検出しました。", "success", []);
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleBuildProfilesUpdate = async (profiles, activeId) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
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
      sendIssues(0, "ビルドプロファイルを更新しました。", "success", []);
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
        message: "ワークスペースが未選択です。",
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

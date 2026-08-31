const path = require("path");

const createBuildCoreHandlers = (deps, resolvers) => {
  const {
    fs,
    buildService,
    envService,
    formatterService,
    workspace,
    pdfWindowManager,
    sendBuildState,
    sendIssues,
    sendBuildLog,
    ensureWorkspace,
    updateWorkspaceIfNeeded,
    handleOpenFile,
    state,
  } = deps;

  const { resolveWorkspaceRelativePath } = resolvers;

  const resolveWorkspaceBuildTarget = (rootPath, targetFile) => {
    if (typeof workspace?.resolvePath !== "function") {
      throw new Error("Workspace path validation is unavailable.");
    }
    const absolutePath = workspace.resolvePath(targetFile);
    const relativePath = path.relative(rootPath, absolutePath);
    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      path.extname(relativePath).toLowerCase() !== ".tex"
    ) {
      throw new Error("Invalid build target.");
    }
    return relativePath.split(path.sep).join("/");
  };

  const resolveBuildEngineCommand = (value) => {
    if (typeof value !== "string" || !value.trim()) {
      return "lualatex";
    }
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "lualatex" ||
      normalized === "pdflatex" ||
      normalized === "xelatex" ||
      normalized === "uplatex"
    ) {
      return normalized;
    }
    return "lualatex";
  };

  const buildEventContext = (options = {}, targetFile = null) => {
    const normalizedTarget =
      typeof targetFile === "string" && targetFile.trim() ? targetFile.trim() : null;
    const documentMainFile =
      typeof options.documentMainFile === "string" && options.documentMainFile.trim()
        ? options.documentMainFile.trim()
        : normalizedTarget;
    return {
      ...(typeof options.requestId === "string" && options.requestId.trim()
        ? { requestId: options.requestId }
        : {}),
      ...(Number.isSafeInteger(options.workspaceGeneration)
        ? { workspaceGeneration: options.workspaceGeneration }
        : {}),
      ...(typeof options.workspaceId === "string" && options.workspaceId.trim()
        ? { workspaceId: options.workspaceId.trim() }
        : {}),
      ...(normalizedTarget ? { targetFile: normalizedTarget } : {}),
      ...(documentMainFile ? { documentMainFile } : {}),
    };
  };

  let buildActivityGeneration = 0;

  const buildRequestIsCurrent = (
    rootPath,
    options = {},
    expectedActivityGeneration = buildActivityGeneration,
  ) => {
    if (expectedActivityGeneration !== buildActivityGeneration) return false;
    if (ensureWorkspace() !== rootPath) return false;
    if (
      Number.isSafeInteger(options.workspaceGeneration) &&
      Number.isSafeInteger(state?.workspaceGeneration) &&
      options.workspaceGeneration !== state.workspaceGeneration
    ) {
      return false;
    }
    if (
      typeof options.workspaceId === "string" &&
      options.workspaceId.trim() &&
      typeof state?.workspaceId === "string" &&
      state.workspaceId &&
      options.workspaceId.trim() !== state.workspaceId
    ) {
      return false;
    }
    return true;
  };

  const ensureRuntimeReadyForBuild = async (
    engine,
    eventContext = {},
    requestIsCurrent = () => true,
  ) => {
    if (!envService || typeof envService.checkCommand !== "function") {
      return false;
    }
    const targetEngine = resolveBuildEngineCommand(engine);
    const checks = [
      {
        key: "engine",
        command: targetEngine,
        label: `TeX Engine (${targetEngine})`,
      },
      { key: "latexmk", command: "latexmk", label: "latexmk" },
      { key: "synctex", command: "synctex", label: "synctex" },
    ];
    const results = await Promise.all(
      checks.map(async (entry) => ({
        ...entry,
        ok: await envService.checkCommand(entry.command),
      }))
    );
    const missing = results.filter((entry) => entry.ok !== true);
    if (!requestIsCurrent()) return true;
    if (missing.length === 0) {
      return false;
    }
    const labels = missing.map((entry) => entry.label);
    const summary =
      labels.length > 0 ? `Missing execution environment: ${labels.join(", ")}` : "Execution environment is insufficient.";
    sendBuildState("idle", summary, eventContext);
    sendIssues(missing.length, summary, "error", [
      ...missing.map((entry) => ({
        severity: "error",
        message: `${entry.label} is not detected. Please check Settings > Execution environment.`,
        action: "open-runtime",
      })),
    ]);
    return true;
  };

  const resolveBuildProfile = async () => {
    const settings = await workspace.loadSettings().catch(() => null);
    const activeId = typeof settings?.buildProfileId === "string" ? settings.buildProfileId.trim() : "";
    if (!activeId) {
      return null;
    }
    const profiles = Array.isArray(settings?.buildProfiles) ? settings.buildProfiles : [];
    const selected = profiles.find((profile) => profile && typeof profile === "object" && profile.id === activeId);
    if (!selected) {
      return null;
    }
    const outDir =
      typeof selected.outDir === "string" && selected.outDir.trim() ? selected.outDir.trim() : null;
    const extraArgs =
      typeof selected.extraArgs === "string" && selected.extraArgs.trim() ? selected.extraArgs.trim() : null;
    return { outDir, extraArgs };
  };

  const normalizeBuildProfile = (value) => {
    if (!value || typeof value !== "object") {
      return null;
    }
    const outDir = typeof value.outDir === "string" && value.outDir.trim() ? value.outDir.trim() : null;
    const extraArgs =
      typeof value.extraArgs === "string" && value.extraArgs.trim() ? value.extraArgs.trim() : null;
    return { outDir, extraArgs };
  };

  let activeBuildHandlers = 0;
  let activeCleanHandlers = 0;
  let nextBuildHandlerId = 0;
  const activeBuildRequests = new Map();
  let pendingQueuedBuild = null;
  let queuedBuildTimer = null;

  const announceQueuedBuild = (request) => {
    sendBuildState(
      "building",
      "Waiting for the current build…",
      buildEventContext(request.options, request.mainFile),
    );
  };

  const queueLatestBuild = (request, { announce = true } = {}) => {
    const replaced = pendingQueuedBuild;
    pendingQueuedBuild = request;
    if (replaced) {
      sendBuildState(
        "idle",
        "Build request superseded.",
        buildEventContext(replaced.options, replaced.mainFile),
      );
    }
    if (announce) announceQueuedBuild(request);
  };

  const scheduleQueuedBuild = () => {
    if (!pendingQueuedBuild || queuedBuildTimer) return;
    const tryRun = () => {
      queuedBuildTimer = null;
      const request = pendingQueuedBuild;
      if (!request) return;
      if (
        !buildRequestIsCurrent(
          request.rootPath,
          request.options,
          request.activityGeneration,
        )
      ) {
        pendingQueuedBuild = null;
        scheduleQueuedBuild();
        return;
      }
      if (activeBuildHandlers > 0 || activeCleanHandlers > 0 || buildService.isBuilding) {
        queuedBuildTimer = setTimeout(tryRun, 25);
        return;
      }
      pendingQueuedBuild = null;
      void handleBuild(request.mainFile, request.options, request.activityGeneration);
    };
    queuedBuildTimer = setTimeout(tryRun, 0);
  };

  const handleBuild = async (
    mainFile,
    options = {},
    activityGeneration = buildActivityGeneration,
  ) => {
    const rootPath = ensureWorkspace();
    let eventContext = buildEventContext(options, mainFile);
    if (!rootPath) {
      sendBuildState("idle", "cancel", buildEventContext(options, mainFile));
      sendIssues(0, "Build cancelled.", "info", []);
      return;
    }
    if (!buildRequestIsCurrent(rootPath, options, activityGeneration)) return;
    if (
      options.queueIfBusy === true &&
      (activeBuildHandlers > 0 || activeCleanHandlers > 0 || buildService.isBuilding)
    ) {
      queueLatestBuild({
        rootPath,
        mainFile,
        options: { ...options },
        activityGeneration,
      });
      scheduleQueuedBuild();
      return;
    }
    activeBuildHandlers += 1;
    nextBuildHandlerId += 1;
    const buildHandlerId = nextBuildHandlerId;
    activeBuildRequests.set(buildHandlerId, {
      mainFile,
      options,
      activityGeneration,
    });
    try {
      if (!buildRequestIsCurrent(rootPath, options, activityGeneration)) return;
      await updateWorkspaceIfNeeded(rootPath);
      if (!buildRequestIsCurrent(rootPath, options, activityGeneration)) return;
      const rootInfo = await workspace.rootInfo().catch(() => null);
      const requestedFile = mainFile && mainFile.trim() ? mainFile.trim() : null;
      let targetFile = rootInfo?.path || "main.tex";
      if (requestedFile && requestedFile.endsWith(".tex")) {
        if (options.exactTarget === true) {
          // AI mode deliberately owns an exact document selection. A magic
          // root inside that file must not silently move its PDF/state to a
          // different document; Code mode still follows magic roots below.
          targetFile = requestedFile;
        } else {
          const magicRoot = await workspace.resolveTexRootFromMagic(requestedFile).catch(() => null);
          if (magicRoot) {
            targetFile = magicRoot;
          } else if (!rootInfo?.path) {
            targetFile = requestedFile;
          }
        }
      } else if (requestedFile && !rootInfo?.path) {
        targetFile = requestedFile;
      }
      // Treat the renderer/webview target as untrusted. Besides rejecting
      // lexical traversal, WorkspaceManager.resolvePath verifies the nearest
      // existing ancestor's realpath so an in-workspace symlink cannot send
      // latexmk outside the workspace.
      targetFile = resolveWorkspaceBuildTarget(rootPath, targetFile);
      eventContext = buildEventContext(options, targetFile);
      const blockedByRuntime = await ensureRuntimeReadyForBuild(
        options?.engine,
        eventContext,
        () => buildRequestIsCurrent(rootPath, options, activityGeneration),
      );
      if (
        blockedByRuntime ||
        !buildRequestIsCurrent(rootPath, options, activityGeneration)
      ) {
        return;
      }
      const buildMessage = "Building...";
      sendBuildState("building", buildMessage, eventContext);
      sendIssues(0, buildMessage, "info", []);
      // Formatting removed from build — only runs via the Format button.
      const buildProfile = await resolveBuildProfile().catch(() => null);
      if (!buildRequestIsCurrent(rootPath, options, activityGeneration)) return;
      let result = await buildService.build(rootPath, targetFile, options.engine, buildProfile);
      if (!buildRequestIsCurrent(rootPath, options, activityGeneration)) return;
      const installedPackages = new Set();
      const recoveryNotes = [];
      for (let attempt = 0; attempt < 4 && result.kind === "failure"; attempt += 1) {
        if (!buildRequestIsCurrent(rootPath, options, activityGeneration)) return;
        if (!envService || typeof envService.installMissingPackagesFromLog !== "function") {
          break;
        }
        const recovery = await envService.installMissingPackagesFromLog(result.log, {
          excludePackages: [...installedPackages],
          onPackagesResolved: () => {
            if (!buildRequestIsCurrent(rootPath, options, activityGeneration)) return;
            const installingMessage = "Installing missing TeX packages…";
            sendBuildState("building", installingMessage, eventContext);
            sendIssues(0, installingMessage, "info", []);
          },
        });
        if (!recovery?.success || !Array.isArray(recovery.packages) || recovery.packages.length === 0) {
          break;
        }
        recovery.packages.forEach((packageName) => installedPackages.add(packageName));
        recoveryNotes.push(
          `[tex64] ${recovery.message || `Installed ${recovery.packages.join(", ")}.`}`
        );
        if (!buildRequestIsCurrent(rootPath, options, activityGeneration)) return;
        result = await buildService.build(rootPath, targetFile, options.engine, buildProfile);
      }
      if (!buildRequestIsCurrent(rootPath, options, activityGeneration)) return;
      if (recoveryNotes.length > 0 && typeof result.log === "string") {
        result.log = [...recoveryNotes, "", result.log].join("\n");
      }
      if (result.kind === "busy") {
        if (options.queueIfBusy === true) {
          queueLatestBuild(
            {
              rootPath,
              mainFile,
              options: { ...options },
              activityGeneration,
            },
            { announce: false },
          );
          scheduleQueuedBuild();
          return;
        }
        sendBuildState("building", buildMessage, eventContext);
        sendIssues(0, "Build is already running.", "info", []);
        return;
      }
      if (result.kind === "cancelled") {
        sendBuildLog(result.log ?? null);
        sendBuildState("idle", result.summary ?? "Build cancelled.", eventContext);
        sendIssues(0, result.summary ?? "Build cancelled.", "info", []);
        return;
      }
      sendBuildLog(result.log ?? null);
      // A build writes new files into the workspace (PDF, .log, .aux, …). Nothing
      // watches the filesystem, so the file tree only learns about them when we
      // force a refresh here.
      await updateWorkspaceIfNeeded(rootPath, true);
      if (!buildRequestIsCurrent(rootPath, options, activityGeneration)) return;
      if (result.kind === "success") {
        if (fs.existsSync(result.pdfPath)) {
          state.lastBuildPdfPath = result.pdfPath;
          // "none" leaves every viewer untouched: the AI mode shows the page
          // itself and must not have the Code-mode PDF window pop over it.
          const viewerMode =
            options.pdfViewerMode === "tab"
              ? "tab"
              : options.pdfViewerMode === "none"
                ? "none"
                : "window";
          if (viewerMode === "tab") {
            const relativePdfPath = resolveWorkspaceRelativePath(rootPath, result.pdfPath);
            if (relativePdfPath) {
              await handleOpenFile(relativePdfPath);
            } else {
              pdfWindowManager.show(result.pdfPath);
            }
          } else if (viewerMode === "window") {
            pdfWindowManager.show(result.pdfPath);
          }
          sendBuildState("success", result.summary, {
            ...eventContext,
            pdfPath: resolveWorkspaceRelativePath(rootPath, result.pdfPath),
          });
          // A build can succeed and still have plenty to say — undefined
          // references, missing images, overfull lines. Those used to be thrown
          // away along with the log, which left the panel empty on exactly the
          // runs where a reader wants to look something up. Keep them; the panel
          // renders a non-fatal run differently from a stopped one.
          const successIssues = result.issues ?? [];
          sendIssues(
            successIssues.length,
            result.summary,
            successIssues.length > 0 ? "info" : "success",
            successIssues
          );
          sendBuildLog(result.log ?? null);
          return;
        }
        sendBuildState("failed", "PDF not found.", eventContext);
        sendIssues(1, "PDF not found.", "error", [
          { severity: "error", message: "PDF not found.", line: null },
        ]);
        return;
      }
      if (result.kind === "failure") {
        // A failed build used to send errors only, so everything non-fatal the run
        // reported (undefined references, missing images, overfull lines) was
        // thrown away and the panel could not tell the two apart. Send both, with
        // the blockers first; the panel styles them differently.
        const errorIssues = result.issues.filter((issue) => issue.severity === "error");
        const warningIssues = result.issues.filter((issue) => issue.severity === "warning");
        const displayIssues = [...errorIssues, ...warningIssues].slice(0, 20);
        const count = Math.max(displayIssues.length, 1);
        const summaryText = displayIssues[0]?.message ?? result.summary;
        sendBuildState("failed", result.summary, eventContext);
        sendIssues(count, summaryText, "error", displayIssues);
      }
    } catch (error) {
      const errMsg = error?.message ?? String(error);
      console.error("[build] handleBuild error:", errMsg);
      if (!buildRequestIsCurrent(rootPath, options, activityGeneration)) return;
      sendBuildState("failed", errMsg, eventContext);
      sendIssues(1, errMsg, "error", [
        { severity: "error", message: errMsg },
      ]);
    } finally {
      activeBuildRequests.delete(buildHandlerId);
      activeBuildHandlers = Math.max(0, activeBuildHandlers - 1);
      scheduleQueuedBuild();
    }
  };

  const handleClean = async (mainFile, options = {}) => {
    const activityGeneration = buildActivityGeneration;
    const rootPath = ensureWorkspace();
    const message = "Cleaning...";
    if (!rootPath) {
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
      ]);
      return;
    }
    sendIssues(0, message, "info", []);
    sendBuildLog(null);
    activeCleanHandlers += 1;
    try {
      if (!buildRequestIsCurrent(rootPath, {}, activityGeneration)) return;
      await updateWorkspaceIfNeeded(rootPath);
      if (!buildRequestIsCurrent(rootPath, {}, activityGeneration)) return;
      const rootInfo = await workspace.rootInfo().catch(() => null);
      const requestedFile = mainFile && mainFile.trim() ? mainFile.trim() : null;
      let targetFile = rootInfo?.path || "main.tex";
      if (requestedFile && requestedFile.endsWith(".tex")) {
        const magicRoot = await workspace.resolveTexRootFromMagic(requestedFile).catch(() => null);
        if (magicRoot) {
          targetFile = magicRoot;
        } else if (!rootInfo?.path) {
          targetFile = requestedFile;
        }
      } else if (requestedFile && !rootInfo?.path) {
        targetFile = requestedFile;
      }
      targetFile = resolveWorkspaceBuildTarget(rootPath, targetFile);
      const buildProfile =
        normalizeBuildProfile(options?.buildProfile) ??
        (await resolveBuildProfile().catch(() => null));
      if (!buildRequestIsCurrent(rootPath, {}, activityGeneration)) return;
      const deep = options.deep === true;
      const result = await buildService.clean(rootPath, targetFile, { deep }, buildProfile);
      if (!buildRequestIsCurrent(rootPath, {}, activityGeneration)) return;
      // Clean removes files from the workspace; refresh the tree for the same
      // reason a build does.
      await updateWorkspaceIfNeeded(rootPath, true);
      if (!buildRequestIsCurrent(rootPath, {}, activityGeneration)) return;
      if (result.kind === "busy") {
        sendIssues(0, "Already processing.", "info", []);
        return;
      }
      if (result.kind === "cancelled") {
        sendIssues(0, result.summary ?? "Clean cancelled.", "info", []);
        return;
      }
      sendBuildLog(result.log ?? null);
      if (result.kind === "success") {
        sendIssues(0, result.summary ?? "Clean done", "success", []);
        return;
      }
      if (result.kind === "failure") {
        const count = Math.max(result.issues.length, 1);
        const summaryText = result.issues[0]?.message ?? result.summary;
        sendIssues(count, summaryText, "error", result.issues);
      }
    } catch (error) {
      const errMsg = error?.message ?? String(error);
      console.error("[build] handleClean error:", errMsg);
      if (!buildRequestIsCurrent(rootPath, {}, activityGeneration)) return;
      sendIssues(1, errMsg, "error", [
        { severity: "error", message: errMsg },
      ]);
    } finally {
      activeCleanHandlers = Math.max(0, activeCleanHandlers - 1);
      scheduleQueuedBuild();
    }
  };

  const cancelAllBuilds = () => {
    const hadActiveHandlers = activeBuildHandlers > 0 || activeCleanHandlers > 0;
    buildActivityGeneration += 1;
    if (queuedBuildTimer) {
      clearTimeout(queuedBuildTimer);
      queuedBuildTimer = null;
    }
    const pending = pendingQueuedBuild;
    pendingQueuedBuild = null;
    const active = [...activeBuildRequests.values()];
    const requested = buildService.cancelCurrentRun();
    const cancelledRequests = [...active, ...(pending ? [pending] : [])];
    const announced = new Set();
    for (const request of cancelledRequests) {
      const context = buildEventContext(request.options, request.mainFile);
      const key = `${context.requestId ?? ""}\0${context.documentMainFile ?? ""}`;
      if (announced.has(key)) continue;
      announced.add(key);
      sendBuildState("idle", "Build cancelled.", context);
    }
    return requested || cancelledRequests.length > 0 || hadActiveHandlers || buildService.isBuilding;
  };

  const waitForBuildIdle = async (timeoutMs = 5_000) => {
    const boundedTimeout = Number.isFinite(timeoutMs)
      ? Math.max(0, Math.floor(timeoutMs))
      : 5_000;
    const deadline = Date.now() + boundedTimeout;
    const isIdle = () =>
      activeBuildHandlers === 0 &&
      activeCleanHandlers === 0 &&
      pendingQueuedBuild === null &&
      queuedBuildTimer === null &&
      buildService.isBuilding !== true;
    while (!isIdle() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return isIdle();
  };

  const handleBuildCancel = () => {
    const requested = cancelAllBuilds();
    if (!requested) {
      sendIssues(0, "No build is running.", "info", []);
      return;
    }
    sendIssues(0, "Canceling build...", "info", []);
  };

  return {
    handleBuild,
    handleBuildCancel,
    handleClean,
    cancelAllBuilds,
    waitForBuildIdle,
  };
};

module.exports = { createBuildCoreHandlers };

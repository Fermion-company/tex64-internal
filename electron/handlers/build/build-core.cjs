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

  const ensureRuntimeReadyForBuild = async (engine) => {
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
    if (missing.length === 0) {
      return false;
    }
    const labels = missing.map((entry) => entry.label);
    const summary =
      labels.length > 0 ? `実行環境が不足しています: ${labels.join(", ")}` : "実行環境が不足しています。";
    sendBuildState("idle", summary);
    sendIssues(missing.length, summary, "error", [
      ...missing.map((entry) => ({
        severity: "error",
        message: `${entry.label} が未検出です。Settings > 実行環境で確認してください。`,
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

  const handleBuild = async (mainFile, options = {}) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendBuildState("idle", "キャンセル");
      sendIssues(0, "ビルドをキャンセルしました。", "info", []);
      return;
    }
    const blockedByRuntime = await ensureRuntimeReadyForBuild(options?.engine);
    if (blockedByRuntime) {
      return;
    }
    const buildMessage = "ビルド中...";
    sendBuildState("building", buildMessage);
    sendIssues(0, buildMessage, "info", []);
    await updateWorkspaceIfNeeded(rootPath);
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
    if (options.format && typeof targetFile === "string" && targetFile.endsWith(".tex")) {
      const formatResult = await formatterService
        .formatFile(rootPath, targetFile, options.formatSettings)
        .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (!formatResult.ok && !state.formatWarningShown) {
        state.formatWarningShown = true;
        sendIssues(1, formatResult.error ?? "整形に失敗しました。", "info", [
          { severity: "warning", message: formatResult.error ?? "整形に失敗しました。", line: null },
        ]);
      }
    }
    const buildProfile = await resolveBuildProfile().catch(() => null);
    const result = await buildService.build(rootPath, targetFile, options.engine, buildProfile);
    if (result.kind === "busy") {
      sendBuildState("building", buildMessage);
      sendIssues(0, "すでにビルド中です。", "info", []);
      return;
    }
    if (result.kind === "cancelled") {
      sendBuildLog(result.log ?? null);
      sendBuildState("idle", result.summary ?? "ビルドをキャンセルしました。");
      sendIssues(0, result.summary ?? "ビルドをキャンセルしました。", "info", []);
      return;
    }
    sendBuildLog(result.log ?? null);
    if (result.kind === "success") {
      if (fs.existsSync(result.pdfPath)) {
        state.lastBuildPdfPath = result.pdfPath;
        const viewerMode = options.pdfViewerMode === "tab" ? "tab" : "window";
        if (viewerMode === "tab") {
          const relativePdfPath = resolveWorkspaceRelativePath(rootPath, result.pdfPath);
          if (relativePdfPath) {
            await handleOpenFile(relativePdfPath);
          } else {
            pdfWindowManager.show(result.pdfPath);
          }
        } else {
          pdfWindowManager.show(result.pdfPath);
        }
        sendBuildState("success", result.summary);
        // Keep writing flow calm: clear issues and build log on each successful build.
        sendIssues(0, result.summary, "success", []);
        sendBuildLog(null);
        return;
      }
      sendBuildState("failed", "PDFが見つかりません。");
      sendIssues(1, "PDFが見つかりません。", "error", [
        { severity: "error", message: "PDFが見つかりません。", line: null },
      ]);
      return;
    }
    if (result.kind === "failure") {
      const errorIssues = result.issues.filter((issue) => issue.severity === "error");
      const warningIssues = result.issues.filter((issue) => issue.severity === "warning");
      const shouldIncludeWarnings =
        errorIssues.length === 1 &&
        warningIssues.length > 0 &&
        /警告だけでは原因を特定できません/.test(errorIssues[0]?.message ?? "");
      const displayIssues =
        errorIssues.length > 0
          ? shouldIncludeWarnings
            ? [errorIssues[0], ...warningIssues].slice(0, 20)
            : errorIssues
          : result.issues;
      const count = Math.max(displayIssues.length, 1);
      const summaryText = displayIssues[0]?.message ?? result.summary;
      sendBuildState("failed", result.summary);
      sendIssues(count, summaryText, "error", displayIssues);
    }
  };

  const handleClean = async (mainFile, options = {}) => {
    const message = "clean 中...";
    sendIssues(0, message, "info", []);
    sendBuildLog(null);
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
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
    const buildProfile = normalizeBuildProfile(options?.buildProfile) ?? (await resolveBuildProfile().catch(() => null));
    const deep = options.deep === true;
    const result = await buildService.clean(rootPath, targetFile, { deep }, buildProfile);
    if (result.kind === "busy") {
      sendIssues(0, "すでに処理中です。", "info", []);
      return;
    }
    if (result.kind === "cancelled") {
      sendIssues(0, result.summary ?? "clean をキャンセルしました。", "info", []);
      return;
    }
    sendBuildLog(result.log ?? null);
    if (result.kind === "success") {
      sendIssues(0, result.summary ?? "clean 完了", "success", []);
      return;
    }
    if (result.kind === "failure") {
      const count = Math.max(result.issues.length, 1);
      const summaryText = result.issues[0]?.message ?? result.summary;
      sendIssues(count, summaryText, "error", result.issues);
    }
  };

  const handleBuildCancel = () => {
    const requested = buildService.cancelCurrentRun();
    if (!requested) {
      sendIssues(0, "実行中のビルドはありません。", "info", []);
      return;
    }
    sendBuildState("building", "キャンセルしています...");
    sendIssues(0, "ビルドをキャンセルしています...", "info", []);
  };

  return { handleBuild, handleBuildCancel, handleClean };
};

module.exports = { createBuildCoreHandlers };


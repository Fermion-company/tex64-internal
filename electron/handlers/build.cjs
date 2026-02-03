const createBuildHandlers = (deps) => {
  const {
    fs,
    path,
    buildService,
    lintService,
    formatterService,
    workspace,
    pdfWindowManager,
    synctexService,
    sendBuildState,
    sendIssues,
    sendBuildLog,
    sendToRenderer,
    ensureWorkspace,
    updateWorkspaceIfNeeded,
    handleOpenFile,
    state,
    delay,
  } = deps;

  const resolveWorkspacePathFromRoot = (rootPath, targetPath) => {
    if (!targetPath || typeof targetPath !== "string") {
      return null;
    }
    return path.isAbsolute(targetPath) ? targetPath : path.join(rootPath, targetPath);
  };

  const resolveWorkspaceRelativePath = (rootPath, targetPath) => {
    if (!rootPath || !targetPath || typeof targetPath !== "string") {
      return null;
    }
    if (!path.isAbsolute(targetPath)) {
      return targetPath;
    }
    const relative = path.relative(rootPath, targetPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    return relative;
  };

  const isSkippableSynctexLine = (sourcePath, lineNumber) => {
    if (!Number.isFinite(lineNumber) || lineNumber < 1) {
      return false;
    }
    try {
      const content = fs.readFileSync(sourcePath, "utf8");
      const lines = content.split(/\r?\n/);
      const line = lines[lineNumber - 1];
      if (typeof line !== "string") {
        return false;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      return trimmed.startsWith("%");
    } catch {
      return false;
    }
  };

  const resolveBuildProfile = async () => {
    const settings = await workspace.loadSettings().catch(() => null);
    const activeId = typeof settings?.buildProfileId === "string" ? settings.buildProfileId.trim() : "";
    if (!activeId) {
      return null;
    }
    const profiles = Array.isArray(settings?.buildProfiles) ? settings.buildProfiles : [];
    const selected = profiles.find(
      (profile) => profile && typeof profile === "object" && profile.id === activeId
    );
    if (!selected) {
      return null;
    }
    const outDir =
      typeof selected.outDir === "string" && selected.outDir.trim() ? selected.outDir.trim() : null;
    const extraArgs =
      typeof selected.extraArgs === "string" && selected.extraArgs.trim()
        ? selected.extraArgs.trim()
        : null;
    return { outDir, extraArgs };
  };

  const handleBuild = async (mainFile, options = {}) => {
    const buildMessage = "ビルド中...";
    sendBuildState("building", buildMessage);
    sendIssues(0, buildMessage, "info", []);
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendBuildState("idle", "キャンセル");
      sendIssues(0, "ビルドをキャンセルしました。", "info", []);
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
    sendBuildLog(result.log ?? null);
    if (result.kind === "success") {
      const warningIssues = result.issues.filter((issue) => issue.severity === "warning");
      const warningCount = warningIssues.length;
      const summaryText = warningIssues[0]?.message ?? result.summary;
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
        if (warningCount > 0) {
          sendIssues(warningCount, summaryText, "info", warningIssues);
        } else {
          sendIssues(0, result.summary, "success", []);
        }
        return;
      }
      sendBuildState("failed", "PDFが見つかりません。");
      sendIssues(1, "PDFが見つかりません。", "error", [
        { severity: "error", message: "PDFが見つかりません。", line: null },
      ]);
      return;
    }
    if (result.kind === "failure") {
      const count = Math.max(result.issues.length, 1);
      const summaryText = result.issues[0]?.message ?? result.summary;
      sendBuildState("failed", result.summary);
      sendIssues(count, summaryText, "error", result.issues);
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
    const buildProfile = await resolveBuildProfile().catch(() => null);
    const deep = options.deep === true;
    const result = await buildService.clean(rootPath, targetFile, { deep }, buildProfile);
    if (result.kind === "busy") {
      sendIssues(0, "すでに処理中です。", "info", []);
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

  const handleLint = async (mainFile) => {
    if (!lintService) {
      sendIssues(1, "lint 機能が利用できません。", "error", [
        { severity: "error", message: "lint 機能が利用できません。", line: null },
      ]);
      return;
    }
    const message = "Lint 中...";
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

    const result = await lintService.lint(rootPath, targetFile);
    if (result.kind === "busy") {
      sendIssues(0, "すでに処理中です。", "info", []);
      return;
    }
    sendBuildLog(result.log ?? null);
    if (result.kind === "failure") {
      const count = Math.max(result.issues.length, 1);
      const summaryText = result.issues[0]?.message ?? result.summary;
      sendIssues(count, summaryText, "error", result.issues);
      return;
    }
    const issueCount = Array.isArray(result.issues) ? result.issues.length : 0;
    if (issueCount > 0) {
      sendIssues(issueCount, result.summary ?? "Lint: 警告があります。", "info", result.issues);
    } else {
      sendIssues(0, result.summary ?? "Lint 完了", "success", []);
    }
  };

  const handleSynctexForward = async (message) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("synctex:forwardResult", {
        ok: false,
        error: "ワークスペースが選択されていません。",
      });
      return;
    }
    const sourcePath = resolveWorkspacePathFromRoot(rootPath, message.path);
    const pdfPath =
      resolveWorkspacePathFromRoot(rootPath, message.pdfPath) || state.lastBuildPdfPath;
    if (!sourcePath) {
      sendToRenderer("synctex:forwardResult", {
        ok: false,
        error: "対象のTeXファイルが選択されていません。",
      });
      return;
    }
    if (!pdfPath) {
      sendToRenderer("synctex:forwardResult", {
        ok: false,
        error: "PDFがまだ生成されていません。",
      });
      return;
    }
    const line = Number.parseInt(message.line, 10);
    const column = Number.parseInt(message.column, 10);
    const viewerMode = message.pdfViewerMode === "tab" ? "tab" : "window";
    const allowFallback = message.fallbackToTop !== false;
    const isRetryableSynctexError = (error) =>
      typeof error === "string" &&
      (error.includes("位置情報") || error.includes("解析に失敗"));

    const runForward = async (forwardLine, forwardColumn) => {
      let result = await synctexService.forward({
        sourcePath,
        line: Number.isFinite(forwardLine) ? forwardLine : 1,
        column: Number.isFinite(forwardColumn) ? forwardColumn : 1,
        pdfPath,
      });
      if (result.ok || !isRetryableSynctexError(result.error)) {
        return result;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await delay(200);
        result = await synctexService.forward({
          sourcePath,
          line: Number.isFinite(forwardLine) ? forwardLine : 1,
          column: Number.isFinite(forwardColumn) ? forwardColumn : 1,
          pdfPath,
        });
        if (result.ok || !isRetryableSynctexError(result.error)) {
          break;
        }
      }
      return result;
    };

    const targetLine = Number.isFinite(line) ? line : 1;
    const preferBacktrack = isSkippableSynctexLine(sourcePath, targetLine);
    let result = preferBacktrack
      ? { ok: false, error: "skip" }
      : await runForward(targetLine, column);
    if (!result.ok && (preferBacktrack || isRetryableSynctexError(result.error))) {
      const maxBacktrack = 160;
      for (let offset = 1; offset <= maxBacktrack; offset += 1) {
        const candidateLine = targetLine - offset;
        if (candidateLine < 1) {
          break;
        }
        const candidate = await runForward(candidateLine, column);
        if (candidate.ok) {
          candidate.fallback = true;
          result = candidate;
          break;
        }
        if (!isRetryableSynctexError(candidate.error)) {
          result = candidate;
          break;
        }
      }
    }
    if (!result.ok && allowFallback) {
      const fallbackResult = await runForward(1, 1);
      if (fallbackResult.ok) {
        fallbackResult.fallback = true;
      }
      result = fallbackResult;
    }
    if (!result.ok) {
      sendToRenderer("synctex:forwardResult", result);
      return;
    }
    if (viewerMode === "window") {
      pdfWindowManager.show(pdfPath, { reload: false });
      pdfWindowManager.queueSync({ page: result.page, x: result.x, y: result.y });
    }
    const relativePdfPath = resolveWorkspaceRelativePath(rootPath, pdfPath);
    sendToRenderer("synctex:forwardResult", {
      ok: true,
      page: result.page,
      x: result.x,
      y: result.y,
      fallback: result.fallback === true,
      pdfPath: relativePdfPath,
    });
  };

  const handleSynctexReverse = async (message) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("synctex:reverseResult", {
        ok: false,
        error: "ワークスペースが選択されていません。",
      });
      return;
    }

    const pdfPath =
      resolveWorkspacePathFromRoot(rootPath, message.pdfPath) ||
      resolveWorkspacePathFromRoot(rootPath, message.path) ||
      state.lastBuildPdfPath;
    if (!pdfPath) {
      sendToRenderer("synctex:reverseResult", {
        ok: false,
        error: "PDFがまだ生成されていません。",
      });
      return;
    }

    const page = Number.parseInt(message.page, 10);
    const x = Number.parseFloat(message.x);
    const y = Number.parseFloat(message.y);
    if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
      sendToRenderer("synctex:reverseResult", {
        ok: false,
        error: "SyncTeX の座標が不正です。",
      });
      return;
    }

    let result;
    try {
      result = await synctexService.reverse({ page, x, y, pdfPath });
    } catch (_error) {
      sendToRenderer("synctex:reverseResult", {
        ok: false,
        error: "SyncTeX の解析に失敗しました。",
      });
      return;
    }

    if (!result?.ok) {
      sendToRenderer("synctex:reverseResult", result);
      return;
    }

    const relativeSourcePath = resolveWorkspaceRelativePath(rootPath, result.path);
    if (!relativeSourcePath) {
      sendToRenderer("synctex:reverseResult", {
        ok: false,
        error: "SyncTeX の参照先がワークスペース外です。",
      });
      return;
    }

    sendToRenderer("synctex:reverseResult", {
      ok: true,
      path: relativeSourcePath,
      line: result.line,
      column: result.column ?? 1,
      confidence: result.confidence === true,
      scoreGap: Number.isFinite(result.scoreGap) ? result.scoreGap : null,
      distance: Number.isFinite(result.distance) ? result.distance : null,
      pdfPath: resolveWorkspaceRelativePath(rootPath, pdfPath),
    });
  };

  return { handleBuild, handleClean, handleLint, handleSynctexForward, handleSynctexReverse };
};

module.exports = { createBuildHandlers };

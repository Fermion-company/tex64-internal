const createWorkspaceHandlers = (deps) => {
  const {
    dialog,
    shell,
    spawn,
    fs,
    fsp,
    path,
    workspace,
    indexerService,
    formatterService,
    searchService,
    sendToRenderer,
    sendIssues,
    isE2E,
    WorkspaceError,
    state,
  } = deps;

  const TEXT_FILE_EXTENSIONS = new Set([
    "tex",
    "bib",
    "sty",
    "cls",
    "bst",
    "bbx",
    "cbx",
    "cfg",
    "def",
    "lbx",
    "ins",
    "dtx",
    "ltx",
    "aux",
    "bbl",
    "blg",
    "log",
    "out",
    "toc",
    "lof",
    "lot",
    "fdb_latexmk",
    "fls",
  ]);
  const IMAGE_FILE_EXTENSIONS = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "bmp",
    "webp",
    "svg",
    "tif",
    "tiff",
    "ico",
  ]);
  const IMAGE_MIME_TYPES = new Map([
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["bmp", "image/bmp"],
    ["webp", "image/webp"],
    ["svg", "image/svg+xml"],
    ["tif", "image/tiff"],
    ["tiff", "image/tiff"],
    ["ico", "image/x-icon"],
  ]);

  const getFileExtension = (relativePath) => {
    const name = typeof relativePath === "string" ? path.basename(relativePath) : "";
    const ext = path.extname(name).toLowerCase();
    return ext.startsWith(".") ? ext.slice(1) : ext;
  };

  const isTextFilePath = (relativePath) => TEXT_FILE_EXTENSIONS.has(getFileExtension(relativePath));
  const isImageFilePath = (relativePath) => IMAGE_FILE_EXTENSIONS.has(getFileExtension(relativePath));
  const isPdfFilePath = (relativePath) => getFileExtension(relativePath) === "pdf";

  const sendWorkspace = async (rootPath) => {
    let files = [];
    let folders = [];
    let errorMessage = null;
    try {
      files = await workspace.listFiles();
    } catch (error) {
      errorMessage = error.message;
    }
    try {
      folders = await workspace.listFolders();
    } catch (error) {
      if (!errorMessage) {
        errorMessage = error.message;
      }
    }
    let rootFile = "";
    let rootSource = "";
    let buildProfiles = [];
    let buildProfileId = "";
    try {
      const info = await workspace.rootInfo();
      if (info?.path) {
        rootFile = info.path;
        rootSource = info.source;
      }
      const settings = await workspace.loadSettings().catch(() => null);
      if (Array.isArray(settings?.buildProfiles)) {
        buildProfiles = settings.buildProfiles;
      }
      if (typeof settings?.buildProfileId === "string") {
        buildProfileId = settings.buildProfileId;
      }
    } catch (error) {
      if (!errorMessage) {
        errorMessage = error.message;
      }
    }
    sendToRenderer("updateWorkspace", {
      rootName: path.basename(rootPath),
      rootPath,
      files,
      folders,
      rootFile,
      rootSource,
      buildProfiles,
      buildProfileId,
    });
    if (errorMessage) {
      sendIssues(1, errorMessage, "error", [
        { severity: "error", message: errorMessage },
      ]);
    }
  };

  const updateWorkspaceIfNeeded = async (rootPath, force = false) => {
    if (!force && state.currentWorkspacePath === rootPath) {
      return;
    }
    state.currentWorkspacePath = rootPath;
    await sendWorkspace(rootPath);
  };

  const requestIndex = (rootPath) => {
    if (isE2E) {
      return;
    }
    indexerService.requestIndex(rootPath, (snapshot) => {
      if (state.currentWorkspacePath !== rootPath) {
        return;
      }
      sendToRenderer("updateIndex", snapshot);
    });
  };

  const sendLauncherStatus = (payload) => {
    sendToRenderer("launcherStatus", payload);
  };

  const ensureWorkspace = () => workspace.getRootPath();

  const resolveWorkspacePath = (relativePath) => {
    const rootPath = workspace.getRootPath();
    if (!rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolved = path.resolve(rootPath, relativePath);
    const rootResolved = path.resolve(rootPath);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(WorkspaceError.invalidPath);
    }
    return resolved;
  };

  const openInTerminal = (targetPath) => {
    const rootPath = workspace.getRootPath();
    if (!rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolved = resolveWorkspacePath(targetPath);
    let dirPath = resolved;
    if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
      dirPath = path.dirname(resolved);
    }
    if (process.platform === "darwin") {
      spawn("open", ["-a", "Terminal", dirPath]);
      return;
    }
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "cmd.exe", "/K", `cd /d "${dirPath}"`], {
        windowsHide: true,
      });
      return;
    }
    spawn("x-terminal-emulator", [], { cwd: dirPath });
  };

  const revealInFinder = (targetPath) => {
    const resolved = resolveWorkspacePath(targetPath);
    shell.showItemInFolder(resolved);
  };

  const handleOpenWorkspace = async () => {
    if (!state.mainWindow) {
      return;
    }
    sendLauncherStatus({ isBusy: true, message: null });
    const result = await dialog.showOpenDialog(state.mainWindow, {
      title: "プロジェクトを選択",
      message: "LaTeXプロジェクトのフォルダを選択してください。",
      properties: ["openDirectory"],
      buttonLabel: "選択",
    });
    if (result.canceled || result.filePaths.length === 0) {
      sendLauncherStatus({ isBusy: false, message: "キャンセルしました。" });
      sendIssues(0, "フォルダ選択をキャンセルしました。", "info", []);
      return;
    }
    const rootPath = result.filePaths[0];
    workspace.setRootPath(rootPath);
    state.lastBuildPdfPath = null;
    state.currentWorkspacePath = null;
    await updateWorkspaceIfNeeded(rootPath, true);
    requestIndex(rootPath);
    sendLauncherStatus({ isBusy: false, message: null });
  };

  const handleCreateProject = async (template) => {
    if (!state.mainWindow) {
      return;
    }
    sendLauncherStatus({ isBusy: true, message: null });
    const result = await dialog.showOpenDialog(state.mainWindow, {
      title: "新規プロジェクト",
      message: "プロジェクト用フォルダを作成または選択してください。",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "作成",
    });
    if (result.canceled || result.filePaths.length === 0) {
      sendLauncherStatus({ isBusy: false, message: null });
      return;
    }
    const rootPath = result.filePaths[0];
    try {
      await workspace.initializeProject(rootPath, template === "lecture" ? "lecture" : "paper");
    } catch (error) {
      sendLauncherStatus({ isBusy: false, message: error.message });
      return;
    }
    workspace.setRootPath(rootPath);
    state.lastBuildPdfPath = null;
    state.currentWorkspacePath = null;
    await updateWorkspaceIfNeeded(rootPath, true);
    requestIndex(rootPath);
    sendLauncherStatus({ isBusy: false, message: null });
  };

  const handleOpenFile = async (relativePath) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("openFileResult", {
        path: relativePath,
        error: "ワークスペースが選択されていません。",
      });
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      if (isPdfFilePath(relativePath)) {
        const data = await workspace.readBinaryFile(relativePath);
        sendToRenderer("openFileResult", {
          path: relativePath,
          kind: "pdf",
          mimeType: "application/pdf",
          data: data.toString("base64"),
        });
        return;
      }
      if (isImageFilePath(relativePath)) {
        const data = await workspace.readBinaryFile(relativePath);
        const ext = getFileExtension(relativePath);
        sendToRenderer("openFileResult", {
          path: relativePath,
          kind: "image",
          mimeType: IMAGE_MIME_TYPES.get(ext) || "image/*",
          data: data.toString("base64"),
        });
        return;
      }
      if (!isTextFilePath(relativePath)) {
        sendToRenderer("openFileResult", { path: relativePath, kind: "unsupported" });
        return;
      }
      const content = await workspace.readFile(relativePath);
      sendToRenderer("openFileResult", { path: relativePath, content, kind: "text" });
    } catch (error) {
      sendToRenderer("openFileResult", { path: relativePath, error: error.message });
    }
  };

  const handleFilePreview = async (requestId, relativePath) => {
    const rootPath = ensureWorkspace();
    if (!requestId || typeof requestId !== "string") {
      return;
    }
    if (!rootPath) {
      sendToRenderer("file:previewResult", {
        requestId,
        ok: false,
        error: "ワークスペースが選択されていません。",
      });
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    if (!isImageFilePath(relativePath)) {
      sendToRenderer("file:previewResult", {
        requestId,
        ok: false,
        path: relativePath,
        error: "プレビューできない形式です。",
      });
      return;
    }
    try {
      const data = await workspace.readBinaryFile(relativePath);
      const maxBytes = 1024 * 1024 * 2;
      if (data.length > maxBytes) {
        sendToRenderer("file:previewResult", {
          requestId,
          ok: false,
          path: relativePath,
          error: "画像が大きすぎます（2MBまで）。",
        });
        return;
      }
      const ext = getFileExtension(relativePath);
      sendToRenderer("file:previewResult", {
        requestId,
        ok: true,
        path: relativePath,
        mimeType: IMAGE_MIME_TYPES.get(ext) || "image/*",
        data: data.toString("base64"),
      });
    } catch (error) {
      sendToRenderer("file:previewResult", {
        requestId,
        ok: false,
        path: relativePath,
        error: error.message,
      });
    }
  };

  const handleFileExcerpt = async (requestId, relativePath, options = {}) => {
    const rootPath = ensureWorkspace();
    if (!requestId || typeof requestId !== "string") {
      return;
    }
    if (!rootPath) {
      sendToRenderer("file:excerptResult", {
        requestId,
        ok: false,
        error: "ワークスペースが選択されていません。",
      });
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    if (!isTextFilePath(relativePath)) {
      sendToRenderer("file:excerptResult", {
        requestId,
        ok: false,
        path: relativePath,
        error: "抜粋できない形式です。",
      });
      return;
    }

    const lineNumber = Number.parseInt(options.line ?? "1", 10);
    const radius = Number.isFinite(options.radius)
      ? Math.min(180, Math.max(0, Math.floor(options.radius)))
      : 6;
    const maxLines = Number.isFinite(options.maxLines)
      ? Math.min(360, Math.max(1, Math.floor(options.maxLines)))
      : Math.min(2 * radius + 1, 25);
    const center = Number.isFinite(lineNumber) && lineNumber > 0 ? lineNumber : 1;

    try {
      const content = await workspace.readFile(relativePath);
      const allLines = content.split(/\r?\n/);
      const total = allLines.length;
      const startLine = Math.max(1, center - radius);
      const endLine = Math.min(total, center + radius);
      let excerptLines = allLines.slice(startLine - 1, endLine);
      let truncated = false;
      if (excerptLines.length > maxLines) {
        excerptLines = excerptLines.slice(0, maxLines);
        truncated = true;
      }

      const maxBytes = 12_000;
      let joined = excerptLines.join("\n");
      if (Buffer.byteLength(joined, "utf8") > maxBytes) {
        const clipped = [];
        let currentBytes = 0;
        for (const line of excerptLines) {
          const nextBytes = Buffer.byteLength(`${line}\n`, "utf8");
          if (currentBytes + nextBytes > maxBytes) {
            truncated = true;
            break;
          }
          clipped.push(line);
          currentBytes += nextBytes;
        }
        excerptLines = clipped;
        joined = excerptLines.join("\n");
      }

      sendToRenderer("file:excerptResult", {
        requestId,
        ok: true,
        path: relativePath,
        startLine,
        lines: excerptLines,
        ...(truncated ? { truncated: true } : {}),
      });
    } catch (error) {
      sendToRenderer("file:excerptResult", {
        requestId,
        ok: false,
        path: relativePath,
        error: error.message,
      });
    }
  };

  const handleSaveFile = async (relativePath, content, options = {}) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("saveResult", {
        path: relativePath,
        ok: false,
        error: "ワークスペースが選択されていません。",
      });
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      const shouldFormat =
        options.format === true &&
        typeof relativePath === "string" &&
        relativePath.toLowerCase().endsWith(".tex");
      let finalContent = content ?? "";
      let formatError = null;
      if (shouldFormat) {
        const formatResult = await formatterService
          .formatContent(
            rootPath,
            relativePath,
            finalContent,
            options.formatSettings
          )
          .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
        if (formatResult.warning && !state.formatWarningShown) {
          state.formatWarningShown = true;
          sendIssues(1, formatResult.warning, "info", [
            { severity: "warning", message: formatResult.warning, line: null },
          ]);
        }
        if (formatResult.ok && typeof formatResult.content === "string") {
          finalContent = formatResult.content;
        } else {
          formatError = formatResult.error ?? "整形に失敗しました。";
          if (!state.formatWarningShown) {
            state.formatWarningShown = true;
            sendIssues(1, formatError, "info", [
              { severity: "warning", message: formatError, line: null },
            ]);
          }
        }
      }
      await workspace.writeFile(relativePath, finalContent);
      sendToRenderer("saveResult", {
        path: relativePath,
        ok: true,
        content: shouldFormat ? finalContent : undefined,
        formatError: formatError ?? undefined,
      });
      if (workspace.isIndexTarget(relativePath)) {
        requestIndex(rootPath);
      }
    } catch (error) {
      sendToRenderer("saveResult", { path: relativePath, ok: false, error: error.message });
    }
  };

  const handleFormatFile = async (relativePath, content, source, formatSettings) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("formatResult", {
        path: relativePath,
        ok: false,
        error: "ワークスペースが選択されていません。",
        source,
      });
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      const result = await formatterService
        .formatContent(rootPath, relativePath, content ?? "", formatSettings)
        .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (result.warning && !state.formatWarningShown) {
        state.formatWarningShown = true;
        const lower = result.warning.toLowerCase();
        const isEnvMissing =
          (result.warning.includes("見つかりません") || lower.includes("not found")) &&
          lower.includes("latexindent");
        const issue = {
          severity: "warning",
          message: result.warning,
          line: null,
          ...(isEnvMissing ? { action: "open-runtime" } : {}),
        };
        sendIssues(1, result.warning, "info", [issue]);
      }
      if (!result.ok) {
        if (!state.formatWarningShown) {
          state.formatWarningShown = true;
          sendIssues(1, result.error ?? "整形に失敗しました。", "info", [
            {
              severity: "warning",
              message: result.error ?? "整形に失敗しました。",
              line: null,
            },
          ]);
        }
        sendToRenderer("formatResult", {
          path: relativePath,
          ok: false,
          error: result.error ?? "整形に失敗しました。",
          source,
        });
        return;
      }
      sendToRenderer("formatResult", {
        path: relativePath,
        ok: true,
        content: result.content ?? content ?? "",
        source,
      });
    } catch (error) {
      sendToRenderer("formatResult", {
        path: relativePath,
        ok: false,
        error: error.message,
        source,
      });
    }
  };

  const handleCreateFile = async (relativePath) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      await workspace.createFile(relativePath);
      await sendWorkspace(rootPath);
      sendToRenderer("openFileResult", { path: relativePath, content: "" });
      sendIssues(0, "ファイルを作成しました。", "success", []);
      if (workspace.isIndexTarget(relativePath)) {
        requestIndex(rootPath);
      }
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleCreateFolder = async (relativePath) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      await workspace.createFolder(relativePath);
      await sendWorkspace(rootPath);
      sendIssues(0, "フォルダを作成しました。", "success", []);
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleRevealInFinder = (relativePath) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    try {
      revealInFinder(relativePath);
    } catch (_error) {
      sendIssues(1, "対象が見つかりません。", "error", [
        { severity: "error", message: "対象が見つかりません。", line: null },
      ]);
    }
  };

  const handleOpenInTerminal = (relativePath) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    try {
      openInTerminal(relativePath);
    } catch (_error) {
      sendIssues(1, "ターミナルを開けませんでした。", "error", [
        { severity: "error", message: "ターミナルを開けませんでした。", line: null },
      ]);
    }
  };

  const handleRenameItem = async (relativePath, newName) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      const resolved = resolveWorkspacePath(relativePath);
      const isDirectory = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
      const newPath = await workspace.renameItem(relativePath, newName);
      sendToRenderer("renameResult", {
        oldPath: relativePath,
        newPath,
        isDirectory,
      });
      await sendWorkspace(rootPath);
      sendIssues(0, "名前を変更しました。", "success", []);
      if (isDirectory || workspace.isIndexTarget(relativePath) || workspace.isIndexTarget(newPath)) {
        requestIndex(rootPath);
      }
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleDeleteItem = async (relativePath) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      await workspace.deleteItem(relativePath);
      await sendWorkspace(rootPath);
      sendIssues(0, "削除しました。", "success", []);
      if (workspace.isIndexTarget(relativePath)) {
        requestIndex(rootPath);
      }
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleMoveItem = async (relativePath, destination) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      const resolved = resolveWorkspacePath(relativePath);
      const isDirectory = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
      const newPath = await workspace.moveItem(relativePath, destination);
      sendToRenderer("renameResult", {
        oldPath: relativePath,
        newPath,
        isDirectory,
      });
      await sendWorkspace(rootPath);
      sendIssues(0, "移動しました。", "success", []);
      if (isDirectory || workspace.isIndexTarget(relativePath) || workspace.isIndexTarget(newPath)) {
        requestIndex(rootPath);
      }
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleCopyItem = async (relativePath, destination) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      const newPath = await workspace.copyItem(relativePath, destination);
      await sendWorkspace(rootPath);
      sendIssues(0, "コピーしました。", "success", []);
      if (workspace.isIndexTarget(relativePath) || workspace.isIndexTarget(newPath)) {
        requestIndex(rootPath);
      }
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleUndoFileOperation = async () => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      const operation = await workspace.undoLastOperation();
      if (!operation) {
        sendIssues(0, "戻す操作はありません。", "info", []);
        return;
      }
      if (operation.kind === "move" && operation.toPath) {
        sendToRenderer("renameResult", {
          oldPath: operation.toPath,
          newPath: operation.fromPath,
          isDirectory: operation.isDirectory,
        });
      }
      await sendWorkspace(rootPath);
      sendIssues(0, "操作を戻しました。", "success", []);
      if (operation.affectsIndex) {
        requestIndex(rootPath);
      }
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
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
    if (isE2E) {
      return;
    }
    requestIndex(rootPath);
  };

  const handleSearch = async (query) => {
    if (isE2E) {
      return;
    }
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("updateSearch", {
        query,
        results: [],
        message: "ワークスペースが選択されていません。",
      });
      return;
    }
    const results = await searchService.search(rootPath, query ?? "");
    sendToRenderer("updateSearch", { query, results });
  };

  return {
    sendWorkspace,
    updateWorkspaceIfNeeded,
    requestIndex,
    sendLauncherStatus,
    ensureWorkspace,
    resolveWorkspacePath,
    openInTerminal,
    revealInFinder,
    handleOpenWorkspace,
    handleCreateProject,
    handleOpenFile,
    handleFilePreview,
    handleFileExcerpt,
    handleSaveFile,
    handleFormatFile,
    handleCreateFile,
    handleCreateFolder,
    handleRevealInFinder,
    handleOpenInTerminal,
    handleRenameItem,
    handleDeleteItem,
    handleMoveItem,
    handleCopyItem,
    handleUndoFileOperation,
    handleSetRoot,
    handleDetectRoot,
    handleBuildProfilesUpdate,
    handleIndexRequest,
    handleSearch,
  };
};

module.exports = { createWorkspaceHandlers };

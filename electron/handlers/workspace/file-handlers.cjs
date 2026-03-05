const createWorkspaceFileHandlers = (ctx) => {
  const {
    fs,
    workspace,
    formatterService,
    sendToRenderer,
    sendIssues,
    WorkspaceError,
    state,
    userSettings,

    IMAGE_MIME_TYPES,
    getFileExtension,
    isTextFilePath,
    isImageFilePath,
    isPdfFilePath,

    sendWorkspace,
    updateWorkspaceIfNeeded,
    requestIndex,
    ensureWorkspace,
    resolveWorkspacePath,
    openInTerminal,
    revealInFinder,
  } = ctx;

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
          const lower = formatResult.warning.toLowerCase();
          const isEnvMissing =
            (formatResult.warning.includes("見つかりません") || lower.includes("not found")) &&
            lower.includes("latexindent");
          const issue = {
            severity: "warning",
            message: formatResult.warning,
            line: null,
            ...(isEnvMissing ? { action: "open-runtime" } : {}),
          };
          sendIssues(1, formatResult.warning, "info", [
            issue,
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
    if (process.env.TEX64_E2E === "1") {
      sendToRenderer("e2e:externalAction", {
        kind: "revealInFinder",
        path: relativePath,
      });
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
    if (process.env.TEX64_E2E === "1") {
      sendToRenderer("e2e:externalAction", {
        kind: "openInTerminal",
        path: relativePath,
      });
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

  return {
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
  };
};

module.exports = { createWorkspaceFileHandlers };

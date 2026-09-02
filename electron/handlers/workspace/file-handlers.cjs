const {
  looksBinary,
  MAX_EXTENDED_TEXT_FILE_BYTES,
} = require("../../services/text-file-types.cjs");

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
    isExtendedTextFilePath,
    isImageFilePath,
    isPdfFilePath,

    sendWorkspace,
    updateWorkspaceIfNeeded,
    workspaceWatcher,
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
        error: "No workspace is selected.",
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
      if (!isTextFilePath(relativePath) && !isExtendedTextFilePath(relativePath)) {
        sendToRenderer("openFileResult", { path: relativePath, kind: "unsupported" });
        return;
      }
      if (isExtendedTextFilePath(relativePath) && !isTextFilePath(relativePath)) {
        const data = await workspace.readBinaryFile(relativePath);
        if (data.length > MAX_EXTENDED_TEXT_FILE_BYTES) {
          sendToRenderer("openFileResult", {
            path: relativePath,
            error: "File is too large to open in the editor (max 10MB).",
          });
          return;
        }
        if (looksBinary(data)) {
          sendToRenderer("openFileResult", { path: relativePath, kind: "unsupported" });
          return;
        }
        sendToRenderer("openFileResult", {
          path: relativePath,
          content: data.toString("utf8"),
          kind: "text",
        });
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
        error: "No workspace is selected.",
      });
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    // PDFs are allowed through so the renderer can rasterize the first page
    // into a hover thumbnail (LaTeX figures are very often PDF).
    const isPdfPreview = isPdfFilePath(relativePath);
    if (!isImageFilePath(relativePath) && !isPdfPreview) {
      sendToRenderer("file:previewResult", {
        requestId,
        ok: false,
        path: relativePath,
        error: "Cannot preview this format.",
      });
      return;
    }
    try {
      const data = await workspace.readBinaryFile(relativePath);
      const maxBytes = isPdfPreview ? 1024 * 1024 * 5 : 1024 * 1024 * 2;
      if (data.length > maxBytes) {
        sendToRenderer("file:previewResult", {
          requestId,
          ok: false,
          path: relativePath,
          error: isPdfPreview ? "PDF is too large (max 5MB)." : "Image is too large (max 2MB).",
        });
        return;
      }
      const ext = getFileExtension(relativePath);
      sendToRenderer("file:previewResult", {
        requestId,
        ok: true,
        path: relativePath,
        mimeType: isPdfPreview ? "application/pdf" : IMAGE_MIME_TYPES.get(ext) || "image/*",
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

  /**
   * Hands a workspace file to a caller that cannot read the disk itself — the
   * AI mode webview, which shows the built PDF. Bounded, and only for formats
   * a viewer displays; source files go through the text paths.
   */
  const MAX_FILE_BYTES_RESULT = 48 * 1024 * 1024;
  const VIEWABLE_BYTE_FORMATS = new Set(["pdf", "png", "jpg", "jpeg"]);

  const handleFileBytes = async (requestId, relativePath) => {
    if (!requestId || typeof requestId !== "string") return;
    const fail = (error) => {
      sendToRenderer("file:bytesResult", {
        requestId,
        ok: false,
        path: relativePath,
        error,
      });
    };
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      fail("No workspace is selected.");
      return;
    }
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      fail("No file was requested.");
      return;
    }
    if (!VIEWABLE_BYTE_FORMATS.has(getFileExtension(relativePath))) {
      fail("Cannot read this format.");
      return;
    }
    try {
      // resolvePath keeps the read inside the workspace root.
      const bytes = await workspace.readBinaryFile(relativePath);
      if (bytes.byteLength > MAX_FILE_BYTES_RESULT) {
        fail("File is too large to display.");
        return;
      }
      sendToRenderer("file:bytesResult", {
        requestId,
        ok: true,
        path: relativePath,
        byteSize: bytes.byteLength,
        base64: bytes.toString("base64"),
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not read the file.");
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
        error: "No workspace is selected.",
      });
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    if (!isTextFilePath(relativePath) && !isExtendedTextFilePath(relativePath)) {
      sendToRenderer("file:excerptResult", {
        requestId,
        ok: false,
        path: relativePath,
        error: "Cannot excerpt this format.",
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

  // Re-read one already-open text file after the watcher reported it changed
  // on disk. Deliberately separate from handleOpenFile: nothing about the tab
  // layout, focus or active group may move for a background refresh.
  const handleReloadFile = async (relativePath) => {
    const rootPath = ensureWorkspace();
    if (!rootPath || typeof relativePath !== "string" || !relativePath) {
      return;
    }
    if (!isTextFilePath(relativePath) && !isExtendedTextFilePath(relativePath)) {
      return;
    }
    try {
      const content = await workspace.readFile(relativePath);
      sendToRenderer("fileReloaded", { path: relativePath, content });
    } catch (error) {
      sendToRenderer("fileReloaded", {
        path: relativePath,
        error: error && error.message ? error.message : "reload failed",
      });
    }
  };

  const handleSaveFile = async (relativePath, content, options = {}) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("saveResult", {
        path: relativePath,
        ok: false,
        error: "No workspace is selected.",
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
            (formatResult.warning.includes("not found") || lower.includes("not found")) &&
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
          formatError = formatResult.error ?? "Formatting failed.";
          if (!state.formatWarningShown) {
            state.formatWarningShown = true;
            sendIssues(1, formatError, "info", [
              { severity: "warning", message: formatError, line: null },
            ]);
          }
        }
      }
      // TeX64's own write would otherwise come straight back as an external
      // change and cost a pointless reload round trip on every save.
      workspaceWatcher?.suppress(relativePath, finalContent);
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

  // AI mode's direct paragraph edit: replace exactly the lines the guest
  // read, and only while they are still what it read. The whole file never
  // crosses the bridge (large messages are dropped there), and a stale card
  // cannot overwrite an edit that happened in between.
  const handleReplaceLines = async (requestId, relativePath, options = {}) => {
    if (!requestId || typeof requestId !== "string") {
      return { ok: false };
    }
    // Returns the outcome as well as replying, so the caller can chain what
    // must follow a successful write (the rebuild) without a second message
    // from the guest.
    const reply = (payload) => {
      sendToRenderer("file:replaceLinesResult", {
        requestId,
        path: relativePath,
        ...payload,
      });
      return payload;
    };
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      return reply({ ok: false, error: "No workspace is selected." });
    }
    await updateWorkspaceIfNeeded(rootPath);
    if (!isTextFilePath(relativePath) && !isExtendedTextFilePath(relativePath)) {
      return reply({ ok: false, error: "Cannot edit this format." });
    }
    const startLine = Number.parseInt(options.startLine, 10);
    const endLine = Number.parseInt(options.endLine, 10);
    const expectedText =
      typeof options.expectedText === "string" ? options.expectedText : null;
    const replacementText =
      typeof options.replacementText === "string" ? options.replacementText : null;
    if (
      !Number.isFinite(startLine) ||
      !Number.isFinite(endLine) ||
      startLine < 1 ||
      endLine < startLine ||
      expectedText === null ||
      replacementText === null
    ) {
      return reply({ ok: false, error: "Invalid replacement request." });
    }
    try {
      const content = await workspace.readFile(relativePath);
      const newline = content.includes("\r\n") ? "\r\n" : "\n";
      const allLines = content.split(/\r?\n/);
      if (endLine > allLines.length) {
        return reply({ ok: false, stale: true, error: "The file changed since it was read." });
      }
      const current = allLines.slice(startLine - 1, endLine).join("\n");
      if (current !== expectedText) {
        return reply({ ok: false, stale: true, error: "The file changed since it was read." });
      }
      const replaced = [
        ...allLines.slice(0, startLine - 1),
        ...replacementText.split(/\r?\n/),
        ...allLines.slice(endLine),
      ].join(newline);
      workspaceWatcher?.suppress(relativePath, replaced);
      await workspace.writeFile(relativePath, replaced);
      const outcome = reply({ ok: true });
      if (workspace.isIndexTarget(relativePath)) {
        requestIndex(rootPath);
      }
      return outcome;
    } catch (error) {
      return reply({ ok: false, error: error.message });
    }
  };

  const handleFormatFile = async (relativePath, content, source, formatSettings) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("formatResult", {
        path: relativePath,
        ok: false,
        error: "No workspace is selected.",
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
          (result.warning.includes("not found") || lower.includes("not found")) &&
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
          sendIssues(1, result.error ?? "Formatting failed.", "info", [
            {
              severity: "warning",
              message: result.error ?? "Formatting failed.",
              line: null,
            },
          ]);
        }
        sendToRenderer("formatResult", {
          path: relativePath,
          ok: false,
          error: result.error ?? "Formatting failed.",
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
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      await workspace.createFile(relativePath);
      await sendWorkspace(rootPath);
      sendToRenderer("openFileResult", { path: relativePath, content: "" });
      sendIssues(0, "File created.", "success", []);
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
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      await workspace.createFolder(relativePath);
      await sendWorkspace(rootPath);
      sendIssues(0, "Folder created.", "success", []);
    } catch (error) {
      sendIssues(1, error.message, "error", [
        { severity: "error", message: error.message, line: null },
      ]);
    }
  };

  const handleRevealInFinder = (relativePath) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
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
      sendIssues(1, "Target not found.", "error", [
        { severity: "error", message: "Target not found.", line: null },
      ]);
    }
  };

  const handleOpenInTerminal = (relativePath) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
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
      sendIssues(1, "Failed to open terminal.", "error", [
        { severity: "error", message: "Failed to open terminal.", line: null },
      ]);
    }
  };

  const handleRenameItem = async (relativePath, newName) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
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
      sendIssues(0, "Renamed.", "success", []);
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
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      await workspace.deleteItem(relativePath);
      await sendWorkspace(rootPath);
      sendIssues(0, "Deleted.", "success", []);
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
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
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
      sendIssues(0, "Moved.", "success", []);
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
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      const newPath = await workspace.copyItem(relativePath, destination);
      await sendWorkspace(rootPath);
      sendIssues(0, "Copied.", "success", []);
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
      sendIssues(1, "No workspace is selected.", "error", [
        { severity: "error", message: "No workspace is selected.", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      const operation = await workspace.undoLastOperation();
      if (!operation) {
        sendIssues(0, "No operation to undo.", "info", []);
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
      sendIssues(0, "Operation undone.", "success", []);
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
    handleFileBytes,
    handleSaveFile,
    handleReloadFile,
    handleReplaceLines,
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

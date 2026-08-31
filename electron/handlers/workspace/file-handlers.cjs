const {
  looksBinary,
  MAX_EXTENDED_TEXT_FILE_BYTES,
} = require("../../services/text-file-types.cjs");
const crypto = require("crypto");
const path = require("path");

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
    requestIndex,
    ensureWorkspace,
    resolveWorkspacePath,
    openInTerminal,
    revealInFinder,
    withWorkspaceMutation = async (operation) => operation(),
  } = ctx;

  const hashText = (content) =>
    crypto.createHash("sha256").update(content, "utf8").digest("hex");
  const localFileMutationTails = new Map();

  const requestIdentity = (options = {}) => {
    const requestedGeneration = Number.isSafeInteger(options.workspaceGeneration)
      ? options.workspaceGeneration
      : null;
    const activeGeneration = Number.isSafeInteger(state?.workspaceGeneration)
      ? state.workspaceGeneration
      : null;
    return {
      workspaceGeneration: requestedGeneration ?? activeGeneration,
      workspaceId:
        typeof options.workspaceId === "string" && options.workspaceId.trim()
          ? options.workspaceId.trim()
          : typeof state?.workspaceId === "string" && state.workspaceId.trim()
            ? state.workspaceId.trim()
            : null,
    };
  };

  const identityPayload = (identity) => ({
    ...(Number.isSafeInteger(identity?.workspaceGeneration)
      ? { workspaceGeneration: identity.workspaceGeneration }
      : {}),
    ...(identity?.workspaceId ? { workspaceId: identity.workspaceId } : {}),
  });

  const workspaceRequestIsCurrent = (rootPath, identity) => {
    if (ensureWorkspace() !== rootPath) return false;
    if (
      Number.isSafeInteger(identity?.workspaceGeneration) &&
      Number.isSafeInteger(state?.workspaceGeneration) &&
      identity.workspaceGeneration !== state.workspaceGeneration
    ) {
      return false;
    }
    if (
      identity?.workspaceId &&
      typeof state?.workspaceId === "string" &&
      state.workspaceId &&
      identity.workspaceId !== state.workspaceId
    ) {
      return false;
    }
    return true;
  };

  // Keep each in-process read/check/write sequence indivisible. Atomic rename
  // prevents truncation, but without this queue two valid CAS reads can still
  // both pass and the later write can erase the earlier one.
  const withFileMutation = async (rootPath, relativePath, operation) => {
    const workspaceRoot =
      typeof workspace.getRootPath === "function" ? workspace.getRootPath() : ensureWorkspace();
    if (workspaceRoot !== rootPath) {
      const error = new Error("The workspace changed before the file operation started.");
      error.code = "STALE_WORKSPACE";
      throw error;
    }
    if (typeof workspace.withFileMutation === "function") {
      return workspace.withFileMutation(relativePath, operation);
    }
    const key = `${rootPath}\0${relativePath}`;
    const previous = localFileMutationTails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    localFileMutationTails.set(key, tail);
    try {
      return await run;
    } finally {
      if (localFileMutationTails.get(key) === tail) localFileMutationTails.delete(key);
    }
  };

  const mutateCapturedWorkspace = (rootPath, operation) =>
    withWorkspaceMutation(async () => {
      if (ensureWorkspace() !== rootPath) {
        const error = new Error("The workspace changed before the operation finished.");
        error.code = "STALE_WORKSPACE";
        throw error;
      }
      return operation();
    });

  const handleOpenFile = async (relativePath) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("openFileResult", {
        path: relativePath,
        error: "No workspace is selected.",
      });
      return;
    }
    const identity = requestIdentity();
    await updateWorkspaceIfNeeded(rootPath);
    if (!workspaceRequestIsCurrent(rootPath, identity)) return;
    const sendOpenResult = (payload) => {
      if (!workspaceRequestIsCurrent(rootPath, identity)) return false;
      sendToRenderer("openFileResult", payload);
      return true;
    };
    try {
      if (isPdfFilePath(relativePath)) {
        const data = await workspace.readBinaryFile(relativePath);
        sendOpenResult({
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
        sendOpenResult({
          path: relativePath,
          kind: "image",
          mimeType: IMAGE_MIME_TYPES.get(ext) || "image/*",
          data: data.toString("base64"),
        });
        return;
      }
      if (!isTextFilePath(relativePath) && !isExtendedTextFilePath(relativePath)) {
        sendOpenResult({ path: relativePath, kind: "unsupported" });
        return;
      }
      if (isExtendedTextFilePath(relativePath) && !isTextFilePath(relativePath)) {
        const data = await workspace.readBinaryFile(relativePath);
        if (data.length > MAX_EXTENDED_TEXT_FILE_BYTES) {
          sendOpenResult({
            path: relativePath,
            error: "File is too large to open in the editor (max 10MB).",
          });
          return;
        }
        if (looksBinary(data)) {
          sendOpenResult({ path: relativePath, kind: "unsupported" });
          return;
        }
        sendOpenResult({
          path: relativePath,
          content: data.toString("utf8"),
          kind: "text",
        });
        return;
      }
      const content = await workspace.readFile(relativePath);
      sendOpenResult({ path: relativePath, content, kind: "text" });
    } catch (error) {
      sendOpenResult({ path: relativePath, error: error.message });
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
    const identity = requestIdentity();
    const reply = (payload) =>
      sendToRenderer("file:previewResult", { requestId, ...payload });
    const replyStale = () =>
      reply({
        ok: false,
        stale: true,
        path: relativePath,
        error: "The workspace changed.",
      });
    await updateWorkspaceIfNeeded(rootPath);
    if (!workspaceRequestIsCurrent(rootPath, identity)) {
      replyStale();
      return;
    }
    // PDFs are allowed through so the renderer can rasterize the first page
    // into a hover thumbnail (LaTeX figures are very often PDF).
    const isPdfPreview = isPdfFilePath(relativePath);
    if (!isImageFilePath(relativePath) && !isPdfPreview) {
      reply({
        ok: false,
        path: relativePath,
        error: "Cannot preview this format.",
      });
      return;
    }
    try {
      const data = await workspace.readBinaryFile(relativePath);
      if (!workspaceRequestIsCurrent(rootPath, identity)) {
        replyStale();
        return;
      }
      const maxBytes = isPdfPreview ? 1024 * 1024 * 5 : 1024 * 1024 * 2;
      if (data.length > maxBytes) {
        reply({
          ok: false,
          path: relativePath,
          error: isPdfPreview ? "PDF is too large (max 5MB)." : "Image is too large (max 2MB).",
        });
        return;
      }
      const ext = getFileExtension(relativePath);
      reply({
        ok: true,
        path: relativePath,
        mimeType: isPdfPreview ? "application/pdf" : IMAGE_MIME_TYPES.get(ext) || "image/*",
        data: data.toString("base64"),
      });
    } catch (error) {
      if (!workspaceRequestIsCurrent(rootPath, identity)) replyStale();
      else reply({ ok: false, path: relativePath, error: error.message });
    }
  };

  /**
   * Hands a workspace file to a caller that cannot read the disk itself — the
   * AI mode webview, which shows the built PDF. Bounded, and only for formats
   * a viewer displays; source files go through the text paths.
   */
  const MAX_FILE_BYTES_RESULT = 32 * 1024 * 1024;
  const VIEWABLE_BYTE_FORMATS = new Set(["pdf", "png", "jpg", "jpeg"]);

  const handleFileBytes = async (requestId, relativePath, options = {}) => {
    if (!requestId || typeof requestId !== "string") return;
    const identity = requestIdentity(options);
    const documentMainFile =
      typeof options.documentMainFile === "string" && options.documentMainFile.trim()
        ? options.documentMainFile.trim().replace(/\\/g, "/").replace(/^\.\/+/, "")
        : "";
    const reply = (payload) =>
      sendToRenderer("file:bytesResult", {
        requestId,
        path: relativePath,
        ...identityPayload(identity),
        ...(documentMainFile ? { documentMainFile } : {}),
        ...payload,
      });
    const fail = (error, extra = {}) => reply({ ok: false, error, ...extra });
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      fail("No workspace is selected.");
      return;
    }
    if (!workspaceRequestIsCurrent(rootPath, identity)) {
      fail("The workspace changed.", { stale: true });
      return;
    }
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      fail("No file was requested.");
      return;
    }
    const extension = getFileExtension(relativePath);
    if (!VIEWABLE_BYTE_FORMATS.has(extension)) {
      fail("Cannot read this format.");
      return;
    }
    try {
      // Resolve symlinks before exposing bytes to the webview. WorkspaceManager
      // deliberately permits ordinary project symlinks, but a viewer request
      // must not use one to escape the selected workspace. Stat before read so
      // the 32 MiB cap is also a memory bound, not merely a reply-size check.
      let safeAbsolutePath = null;
      if (
        typeof resolveWorkspacePath === "function" &&
        typeof fs?.realpathSync === "function" &&
        typeof fs?.statSync === "function"
      ) {
        const rootRealPath = fs.realpathSync(rootPath);
        const requestedRealPath = fs.realpathSync(resolveWorkspacePath(relativePath));
        const relativeRealPath = path.relative(rootRealPath, requestedRealPath);
        if (
          !relativeRealPath ||
          relativeRealPath.startsWith(`..${path.sep}`) ||
          relativeRealPath === ".." ||
          path.isAbsolute(relativeRealPath)
        ) {
          fail("The requested file is outside the workspace.");
          return;
        }
        const stats = fs.statSync(requestedRealPath);
        if (!stats.isFile()) {
          fail("The requested path is not a file.");
          return;
        }
        if (stats.size > MAX_FILE_BYTES_RESULT) {
          fail("File is too large to display.");
          return;
        }
        safeAbsolutePath = requestedRealPath;
      }
      const bytes =
        safeAbsolutePath && typeof fs?.promises?.readFile === "function"
          ? await fs.promises.readFile(safeAbsolutePath)
          : await workspace.readBinaryFile(relativePath);
      if (!workspaceRequestIsCurrent(rootPath, identity)) {
        fail("The workspace changed.", { stale: true });
        return;
      }
      if (bytes.byteLength > MAX_FILE_BYTES_RESULT) {
        fail("File is too large to display.");
        return;
      }
      reply({
        ok: true,
        byteSize: bytes.byteLength,
        mimeType:
          extension === "pdf"
            ? "application/pdf"
            : IMAGE_MIME_TYPES.get(extension) || "application/octet-stream",
        base64: bytes.toString("base64"),
      });
    } catch (error) {
      if (!workspaceRequestIsCurrent(rootPath, identity)) {
        fail("The workspace changed.", { stale: true });
      } else {
        fail(error instanceof Error ? error.message : "Could not read the file.");
      }
    }
  };

  const handleFileExcerpt = async (requestId, relativePath, options = {}) => {
    const rootPath = ensureWorkspace();
    const identity = requestIdentity(options);
    const reply = (payload) =>
      sendToRenderer("file:excerptResult", {
        requestId,
        path: relativePath,
        ...identityPayload(identity),
        ...payload,
      });
    if (!requestId || typeof requestId !== "string") {
      return;
    }
    if (!rootPath) {
      reply({ ok: false, error: "No workspace is selected." });
      return;
    }
    if (!workspaceRequestIsCurrent(rootPath, identity)) {
      reply({ ok: false, stale: true, error: "The workspace changed." });
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    if (!isTextFilePath(relativePath) && !isExtendedTextFilePath(relativePath)) {
      reply({ ok: false, error: "Cannot excerpt this format." });
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
      if (!workspaceRequestIsCurrent(rootPath, identity)) {
        reply({ ok: false, stale: true, error: "The workspace changed." });
        return;
      }
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

      reply({
        ok: true,
        startLine,
        lines: excerptLines,
        contentHash: hashText(content),
        ...(truncated ? { truncated: true } : {}),
      });
    } catch (error) {
      reply({ ok: false, error: error.message });
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
      await mutateCapturedWorkspace(rootPath, () => withFileMutation(rootPath, relativePath, async () => {
        // WorkspaceManager resolves the absolute target synchronously when
        // writeFile is called. Re-check inside the per-file queue immediately
        // before that call so formatting/queue waits cannot retarget this save
        // into a newly selected workspace.
        if (ensureWorkspace() !== rootPath) {
          const error = new Error("The workspace changed before the file was saved.");
          error.code = "STALE_WORKSPACE";
          throw error;
        }
        if (typeof options.expectedContent === "string") {
          const currentContent = await workspace.readFile(relativePath).catch(() => null);
          if (currentContent !== options.expectedContent) {
            const error = new Error(
              "The file changed on disk before this save completed. Your editor buffer was kept.",
            );
            error.code = "FILE_SAVE_CONFLICT";
            throw error;
          }
        }
        await workspace.writeFile(relativePath, finalContent);
      }));
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
      sendToRenderer("saveResult", {
        path: relativePath,
        ok: false,
        ...(error?.code === "STALE_WORKSPACE" ? { stale: true } : {}),
        ...(error?.code === "AGENT_WORKSPACE_BUSY" ? { busy: true } : {}),
        error: error.message,
      });
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
    const identity = requestIdentity(options);
    const documentMainFile =
      typeof options.documentMainFile === "string"
        ? options.documentMainFile.trim().replace(/\\/g, "/").replace(/^\.\/+/, "")
        : "";
    const conversationId =
      typeof options.conversationId === "string" && options.conversationId.trim()
        ? options.conversationId.trim()
        : "";
    // Returns the outcome as well as replying, so the caller can chain what
    // must follow a successful write (the rebuild) without a second message
    // from the guest.
    const reply = (payload) => {
      sendToRenderer("file:replaceLinesResult", {
        requestId,
        path: relativePath,
        ...identityPayload(identity),
        ...(documentMainFile ? { documentMainFile } : {}),
        ...payload,
      });
      return payload;
    };
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      return reply({ ok: false, error: "No workspace is selected." });
    }
    if (!workspaceRequestIsCurrent(rootPath, identity)) {
      return reply({ ok: false, stale: true, error: "The workspace changed." });
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
    const expectedContentHash =
      typeof options.expectedContentHash === "string" && options.expectedContentHash.trim()
        ? options.expectedContentHash.trim().toLowerCase()
        : null;
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
    if (documentMainFile) {
      if (!documentMainFile.toLowerCase().endsWith(".tex")) {
        return reply({ ok: false, error: "Invalid document build target." });
      }
      try {
        if (typeof resolveWorkspacePath === "function") {
          resolveWorkspacePath(documentMainFile);
        }
      } catch {
        return reply({ ok: false, error: "Invalid document build target." });
      }
    }
    try {
      return await mutateCapturedWorkspace(rootPath, () =>
        withFileMutation(rootPath, relativePath, async () => {
        const content = await workspace.readFile(relativePath);
        if (!workspaceRequestIsCurrent(rootPath, identity)) {
          return reply({ ok: false, stale: true, error: "The workspace changed." });
        }
        const beforeHash = hashText(content);
        if (expectedContentHash && beforeHash !== expectedContentHash) {
          return reply({ ok: false, stale: true, error: "The file changed since it was read." });
        }
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
        if (!workspaceRequestIsCurrent(rootPath, identity)) {
          return reply({ ok: false, stale: true, error: "The workspace changed." });
        }
        await workspace.writeFile(relativePath, replaced);
        const contentHash = hashText(replaced);
        const publicOutcome = {
          ok: true,
          beforeContentHash: beforeHash,
          contentHash,
          ...(documentMainFile ? { documentMainFile } : {}),
          ...(conversationId ? { conversationId } : {}),
        };
        reply(publicOutcome);
        // Code's Monaco model otherwise keeps the pre-edit disk snapshot and a
        // later save can put that stale content back. Reuse its existing agent
        // content event, with additive CAS/session metadata for guarded clients.
        if (workspaceRequestIsCurrent(rootPath, identity)) {
          sendToRenderer("agent:applyContent", {
            path: relativePath,
            content: replaced,
            expectedContent: content,
            updateSaved: true,
            source: "ai-direct-edit",
            ...(conversationId ? { conversationId } : {}),
            baseContentHash: beforeHash,
            contentHash,
            ...identityPayload(identity),
            ...(documentMainFile ? { documentMainFile } : {}),
          });
        }
        if (workspace.isIndexTarget(relativePath)) {
          requestIndex(rootPath);
        }
        // Full buffers stay inside main; the guest receives only publicOutcome.
        // main can register this write with AgentService.pushUndoEntry.
        return {
          ...publicOutcome,
          previousContent: content,
          content: replaced,
          workspaceRootPath: rootPath,
        };
        }),
      );
    } catch (error) {
      return reply({
        ok: false,
        ...(error?.code === "STALE_WORKSPACE" ? { stale: true } : {}),
        error: error.message,
      });
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
    const identity = requestIdentity();
    const replyStale = () =>
      sendToRenderer("formatResult", {
        path: relativePath,
        ok: false,
        stale: true,
        error: "The workspace changed.",
        source,
      });
    await updateWorkspaceIfNeeded(rootPath);
    if (!workspaceRequestIsCurrent(rootPath, identity)) {
      replyStale();
      return;
    }
    try {
      const result = await formatterService
        .formatContent(rootPath, relativePath, content ?? "", formatSettings)
        .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (!workspaceRequestIsCurrent(rootPath, identity)) {
        replyStale();
        return;
      }
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
      if (!workspaceRequestIsCurrent(rootPath, identity)) replyStale();
      else {
        sendToRenderer("formatResult", {
          path: relativePath,
          ok: false,
          error: error.message,
          source,
        });
      }
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
      await mutateCapturedWorkspace(rootPath, async () => {
        await workspace.createFile(relativePath);
        await sendWorkspace(rootPath);
        sendToRenderer("openFileResult", { path: relativePath, content: "" });
        sendIssues(0, "File created.", "success", []);
        if (workspace.isIndexTarget(relativePath)) {
          requestIndex(rootPath);
        }
      });
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
      await mutateCapturedWorkspace(rootPath, async () => {
        await workspace.createFolder(relativePath);
        await sendWorkspace(rootPath);
        sendIssues(0, "Folder created.", "success", []);
      });
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
      await mutateCapturedWorkspace(rootPath, async () => {
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
      });
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
      await mutateCapturedWorkspace(rootPath, async () => {
        await workspace.deleteItem(relativePath);
        await sendWorkspace(rootPath);
        sendIssues(0, "Deleted.", "success", []);
        if (workspace.isIndexTarget(relativePath)) {
          requestIndex(rootPath);
        }
      });
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
      await mutateCapturedWorkspace(rootPath, async () => {
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
      });
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
      await mutateCapturedWorkspace(rootPath, async () => {
        const newPath = await workspace.copyItem(relativePath, destination);
        await sendWorkspace(rootPath);
        sendIssues(0, "Copied.", "success", []);
        if (workspace.isIndexTarget(relativePath) || workspace.isIndexTarget(newPath)) {
          requestIndex(rootPath);
        }
      });
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
      await mutateCapturedWorkspace(rootPath, async () => {
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
      });
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

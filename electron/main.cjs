const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { BuildService } = require("./services/build.cjs");
const FormatterService = require("./services/formatter.cjs");
const { GitService } = require("./services/git.cjs");
const { IndexerService } = require("./services/indexer.cjs");
const { PDFWindowManager } = require("./services/pdf.cjs");
const { SynctexService } = require("./services/synctex.cjs");
const { SearchService } = require("./services/search.cjs");
const { WorkspaceManager, WorkspaceError } = require("./services/workspace.cjs");
const { EnvService } = require("./services/env.cjs");

let mainWindow = null;
let currentWorkspacePath = null;
const isE2E = process.env.TEX180_E2E === "1";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workspace = new WorkspaceManager();
const buildService = new BuildService();
const formatterService = new FormatterService();
const indexerService = new IndexerService();
const searchService = new SearchService();
const gitService = new GitService();
const pdfWindowManager = new PDFWindowManager();
const synctexService = new SynctexService();
let lastBuildPdfPath = null;
const envService = new EnvService();
let formatWarningShown = false;

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

const createMainWindow = () => {
  const preloadPath = path.join(__dirname, "preload.cjs");
  const indexPath = path.join(app.getAppPath(), "Resources", "web", "index.html");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#1c2129",
    title: "tex180",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  if (isE2E) {
    mainWindow.loadFile(indexPath, { query: { e2e: "1" } });
  } else {
    mainWindow.loadFile(indexPath);
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

const sendToRenderer = (type, payload) => {
  if (!mainWindow) {
    return;
  }
  mainWindow.webContents.send("tex180:message", { type, payload });
};

const sendBuildState = (state, message) => {
  const payload = { state };
  if (message) {
    payload.message = message;
  }
  sendToRenderer("setBuildState", payload);
};

const sendIssues = (count, summary, status, issues) => {
  sendToRenderer("updateIssues", { count, summary, status, issues });
};

const sendBuildLog = (log) => {
  sendToRenderer("buildLog", { log });
};

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
  try {
    const info = await workspace.rootInfo();
    if (info?.path) {
      rootFile = info.path;
      rootSource = info.source;
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
  });
  if (errorMessage) {
    sendIssues(1, errorMessage, "error", [
      { severity: "error", message: errorMessage },
    ]);
  }
};

const updateWorkspaceIfNeeded = async (rootPath, force = false) => {
  if (!force && currentWorkspacePath === rootPath) {
    return;
  }
  currentWorkspacePath = rootPath;
  await sendWorkspace(rootPath);
};

const requestIndex = (rootPath) => {
  indexerService.requestIndex(rootPath, (snapshot) => {
    if (currentWorkspacePath !== rootPath) {
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

app.whenReady().then(() => {
  const e2eWorkspace = process.env.TEX180_E2E_WORKSPACE;
  if (e2eWorkspace) {
    const resolved = path.resolve(e2eWorkspace);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      workspace.setRootPath(resolved);
      currentWorkspacePath = null;
    }
  }
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.on("tex180", (_event, message) => {
  if (!message || typeof message !== "object") {
    return;
  }
  const { type } = message;
  if (!type) {
    return;
  }
  if (type === "ready") {
    const rootPath = workspace.getRootPath();
    if (!rootPath) {
      return;
    }
    updateWorkspaceIfNeeded(rootPath, true);
    requestIndex(rootPath);
    return;
  }
  if (type === "openWorkspace" || type === "requestWorkspace") {
    handleOpenWorkspace();
    return;
  }
  if (type === "createProject") {
    handleCreateProject(message.template);
    return;
  }
  if (type === "synctex:forward") {
    handleSynctexForward(message);
    return;
  }
  if (type === "build") {
    handleBuild(message.mainFile, {
      format: message.format,
      engine: message.engine,
      pdfViewerMode: message.pdfViewerMode,
    });
    return;
  }
  if (type === "openFile") {
    handleOpenFile(message.path);
    return;
  }
  if (type === "saveFile") {
    handleSaveFile(message.path, message.content, {
      format: message.format,
      formatSource: message.formatSource,
    });
    return;
  }
  if (type === "formatFile") {
    handleFormatFile(message.path, message.content, message.source);
    return;
  }
  if (type === "createFile") {
    handleCreateFile(message.path);
    return;
  }
  if (type === "createFolder") {
    handleCreateFolder(message.path);
    return;
  }
  if (type === "revealInFinder") {
    handleRevealInFinder(message.path);
    return;
  }
  if (type === "openInTerminal") {
    handleOpenInTerminal(message.path);
    return;
  }
  if (type === "renameItem") {
    handleRenameItem(message.path, message.newName);
    return;
  }

  if (type === "deleteItem") {
    handleDeleteItem(message.path);
    return;
  }
  if (type === "moveItem") {
    handleMoveItem(message.path, message.destination);
    return;
  }
  if (type === "copyItem") {
    handleCopyItem(message.path, message.destination);
    return;
  }
  if (type === "undoFileOperation") {
    handleUndoFileOperation();
    return;
  }
  if (type === "setRoot") {
    handleSetRoot(message.path);
    return;
  }
  if (type === "detectRoot") {
    handleDetectRoot();
    return;
  }
  if (type === "requestIndex") {
    handleIndexRequest();
    return;
  }
  if (type === "search") {
    handleSearch(message.query);
    return;
  }
  if (type === "gitStatus") {
    handleGitStatus();
    return;
  }
  if (type === "consoleLog") {
    if (message.message) {
      // eslint-disable-next-line no-console
      console.log(`[WebView] ${message.message}`);
    }
  }


  // Environment IPC
  if (type === "env:check") {
    handleEnvCheck(message.command);
    return;
  }
  if (type === "env:install") {
    handleEnvInstall(message.target);
    return;
  }
});

ipcMain.on("tex180:pdf", (_event, message) => {
  if (!message || typeof message !== "object") {
    return;
  }
  const { type } = message;
  if (!type) {
    return;
  }
  if (type === "ready") {
    pdfWindowManager.markReady();
    return;
  }
});

const handleEnvCheck = async (command) => {
  const result = await envService.checkCommand(command);
  sendToRenderer("env:checkResult", { command, available: result });
};

const handleEnvInstall = async (target) => {
  sendToRenderer("env:installStart", { target });
  const result = await envService.installEnvironment(target);
  sendToRenderer("env:installResult", { target, ...result });
  // Re-check relevant commands after install attempt
  if (target === "basictex") {
    const lualatex = await envService.checkCommand("lualatex");
    const latexmk = await envService.checkCommand("latexmk");
    sendToRenderer("env:checkResult", { command: "lualatex", available: lualatex });
    sendToRenderer("env:checkResult", { command: "latexmk", available: latexmk });
  } else if (target === "latexmk") {
    const available = await envService.checkCommand("latexmk");
    sendToRenderer("env:checkResult", { command: "latexmk", available });
  }
};

const handleOpenWorkspace = async () => {
  if (!mainWindow) {
    return;
  }
  sendLauncherStatus({ isBusy: true, message: null });
  const result = await dialog.showOpenDialog(mainWindow, {
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
  lastBuildPdfPath = null;
  currentWorkspacePath = null;
  await updateWorkspaceIfNeeded(rootPath, true);
  requestIndex(rootPath);
  sendLauncherStatus({ isBusy: false, message: null });
};

const handleCreateProject = async (template) => {
  if (!mainWindow) {
    return;
  }
  sendLauncherStatus({ isBusy: true, message: null });
  const result = await dialog.showOpenDialog(mainWindow, {
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
  lastBuildPdfPath = null;
  currentWorkspacePath = null;
  await updateWorkspaceIfNeeded(rootPath, true);
  requestIndex(rootPath);
  sendLauncherStatus({ isBusy: false, message: null });
};

const handleBuild = async (mainFile, options = {}) => {
  sendBuildState("building", "ビルド中...");
  sendIssues(0, "ビルド中...", "info", []);
  const rootPath = ensureWorkspace();
  if (!rootPath) {
    sendBuildState("idle", "キャンセル");
    sendIssues(0, "ビルドをキャンセルしました。", "info", []);
    return;
  }
  await updateWorkspaceIfNeeded(rootPath);
  const rootInfo = await workspace.rootInfo().catch(() => null);
  const targetFile =
    (mainFile && mainFile.trim() ? mainFile : null) ||
    rootInfo?.path ||
    "main.tex";
  if (options.format && typeof targetFile === "string" && targetFile.endsWith(".tex")) {
    const formatResult = await formatterService
      .formatFile(rootPath, targetFile)
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!formatResult.ok && !formatWarningShown) {
      formatWarningShown = true;
      sendIssues(1, formatResult.error ?? "整形に失敗しました。", "info", [
        { severity: "warning", message: formatResult.error ?? "整形に失敗しました。", line: null },
      ]);
    }
  }
  const result = await buildService.build(rootPath, targetFile, options.engine);
  if (result.kind === "busy") {
    sendBuildState("building", "ビルド中...");
    sendIssues(0, "すでにビルド中です。", "info", []);
    return;
  }
  sendBuildLog(result.log ?? null);
  if (result.kind === "success") {
    const warningIssues = result.issues.filter((issue) => issue.severity === "warning");
    const warningCount = warningIssues.length;
    const summaryText = warningIssues[0]?.message ?? result.summary;
    if (fs.existsSync(result.pdfPath)) {
      lastBuildPdfPath = result.pdfPath;
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
    resolveWorkspacePathFromRoot(rootPath, message.pdfPath) || lastBuildPdfPath;
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
        .formatContent(rootPath, relativePath, finalContent)
        .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (formatResult.ok && typeof formatResult.content === "string") {
        finalContent = formatResult.content;
      } else {
        formatError = formatResult.error ?? "整形に失敗しました。";
        if (!formatWarningShown) {
          formatWarningShown = true;
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

const handleFormatFile = async (relativePath, content, source) => {
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
      .formatContent(rootPath, relativePath, content ?? "")
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!result.ok) {
      if (!formatWarningShown) {
        formatWarningShown = true;
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

const handleIndexRequest = () => {
  const rootPath = ensureWorkspace();
  if (!rootPath) {
    return;
  }
  requestIndex(rootPath);
};

const handleSearch = async (query) => {
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

const handleGitStatus = async () => {
  const rootPath = ensureWorkspace();
  if (!rootPath) {
    sendToRenderer("updateGit", {
      entries: [],
      message: "ワークスペースが選択されていません。",
    });
    return;
  }
  const snapshot = await gitService.status(rootPath);
  sendToRenderer("updateGit", snapshot);
};

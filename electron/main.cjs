const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { BuildService } = require("./services/build.cjs");
const { GitService } = require("./services/git.cjs");
const { IndexerService } = require("./services/indexer.cjs");
const { PDFWindowManager } = require("./services/pdf.cjs");
const { SearchService } = require("./services/search.cjs");
const { WorkspaceManager, WorkspaceError } = require("./services/workspace.cjs");

let mainWindow = null;
let currentWorkspacePath = null;
const isE2E = process.env.TEX180_E2E === "1";

const workspace = new WorkspaceManager();
const buildService = new BuildService();
const indexerService = new IndexerService();
const searchService = new SearchService();
const gitService = new GitService();
const pdfWindowManager = new PDFWindowManager();

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
  if (type === "build") {
    handleBuild(message.mainFile);
    return;
  }
  if (type === "openFile") {
    handleOpenFile(message.path);
    return;
  }
  if (type === "saveFile") {
    handleSaveFile(message.path, message.content);
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
});

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
  currentWorkspacePath = null;
  await updateWorkspaceIfNeeded(rootPath, true);
  requestIndex(rootPath);
  sendLauncherStatus({ isBusy: false, message: null });
};

const handleBuild = async (mainFile) => {
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
  const result = await buildService.build(rootPath, targetFile);
  if (result.kind === "busy") {
    sendBuildState("building", "ビルド中...");
    sendIssues(0, "すでにビルド中です。", "info", []);
    return;
  }
  if (result.kind === "success") {
    const warningIssues = result.issues.filter((issue) => issue.severity === "warning");
    const warningCount = warningIssues.length;
    const summaryText = warningIssues[0]?.message ?? result.summary;
    if (fs.existsSync(result.pdfPath)) {
      pdfWindowManager.show(result.pdfPath);
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
    const content = await workspace.readFile(relativePath);
    sendToRenderer("openFileResult", { path: relativePath, content });
  } catch (error) {
    sendToRenderer("openFileResult", { path: relativePath, error: error.message });
  }
};

const handleSaveFile = async (relativePath, content) => {
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
    await workspace.writeFile(relativePath, content ?? "");
    sendToRenderer("saveResult", { path: relativePath, ok: true });
    if (workspace.isIndexTarget(relativePath)) {
      requestIndex(rootPath);
    }
  } catch (error) {
    sendToRenderer("saveResult", { path: relativePath, ok: false, error: error.message });
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

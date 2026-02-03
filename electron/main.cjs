const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  shell,
} = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { BuildService } = require("./services/build.cjs");
const { LintService } = require("./services/lint.cjs");
const FormatterService = require("./services/formatter.cjs");

const { IndexerService } = require("./services/indexer.cjs");
const { PDFWindowManager } = require("./services/pdf.cjs");
const { SynctexService } = require("./services/synctex.cjs");
const { SearchService } = require("./services/search.cjs");
const { WorkspaceManager, WorkspaceError } = require("./services/workspace.cjs");
const { EnvService } = require("./services/env.cjs");
const { BlocksStore } = require("./services/blocks.cjs");
const { UserSettingsService } = require("./services/user-settings.cjs");
const { MathOcrService } = require("./services/math-ocr.cjs");
const { AgentService } = require("./services/agent.cjs");
const { ApiUsageService } = require("./services/api-usage.cjs");
const { createWorkspaceHandlers } = require("./handlers/workspace.cjs");
const { createBuildHandlers } = require("./handlers/build.cjs");

const { createMiscHandlers } = require("./handlers/misc.cjs");
const { createAgentHandlers } = require("./handlers/agent.cjs");

// Expose require so Playwright's electronApp.evaluate can load Electron APIs in e2e.
global.require = require;

const state = {
  mainWindow: null,
  currentWorkspacePath: null,
  userSettings: null,
  lastBuildPdfPath: null,
  formatWarningShown: false,
};
const isE2E = process.env.TEX180_E2E === "1";
if (isE2E && process.env.TEX180_E2E_USERDATA) {
  app.setPath("userData", process.env.TEX180_E2E_USERDATA);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workspace = new WorkspaceManager();
const buildService = new BuildService();
const lintService = new LintService();
const formatterService = new FormatterService();
const indexerService = new IndexerService();
const searchService = new SearchService();

const pdfWindowManager = new PDFWindowManager();
const synctexService = new SynctexService();
const blocksStore = new BlocksStore();
const envService = new EnvService();
let mathOcrService = null;
let apiUsageService = null;

const getMathOcrService = () => {
  if (!mathOcrService) {
    mathOcrService = new MathOcrService({
      appPath: app.getAppPath(),
      userDataPath: app.getPath("userData"),
    });
  }
  return mathOcrService;
};

const createMainWindow = () => {
  const preloadPath = path.join(__dirname, "preload.cjs");
  const indexPath = path.join(app.getAppPath(), "Resources", "web", "index.html");

  state.mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#1c2129",
    title: "tex64",
    webPreferences: {
      contextIsolation: !isE2E,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  if (isE2E) {
    state.mainWindow.loadFile(indexPath, { query: { e2e: "1" } });
  } else {
    state.mainWindow.loadFile(indexPath);
  }
  state.mainWindow.on("closed", () => {
    if (state.captureShortcut) {
      globalShortcut.unregister(state.captureShortcut);
      state.captureShortcut = null;
    }
    state.mainWindow = null;
  });
};

const sendToRenderer = (type, payload) => {
  if (!state.mainWindow) {
    return;
  }
  state.mainWindow.webContents.send("tex64:message", { type, payload });
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

const ensureUserSettings = () => {
  if (!state.userSettings) {
    state.userSettings = new UserSettingsService(app.getPath("userData"));
  }
  return state.userSettings;
};

const getApiUsageService = () => {
  if (!apiUsageService) {
    apiUsageService = new ApiUsageService({
      userDataPath: app.getPath("userData"),
      getPricing: async () => ensureUserSettings().getAgentSettings(),
    });
  }
  return apiUsageService;
};

const workspaceHandlers = createWorkspaceHandlers({
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
});

const agentService = new AgentService({
  workspace,
  searchService,
  ensureUserSettings,
  sendToRenderer,
  updateWorkspaceIfNeeded: workspaceHandlers.updateWorkspaceIfNeeded,
  requestIndex: workspaceHandlers.requestIndex,
  buildService,
  sendBuildState,
  sendBuildLog,
  sendIssues,
  indexerService,
  apiUsageService: getApiUsageService(),
});

const buildHandlers = createBuildHandlers({
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
  ensureWorkspace: workspaceHandlers.ensureWorkspace,
  updateWorkspaceIfNeeded: workspaceHandlers.updateWorkspaceIfNeeded,
  handleOpenFile: workspaceHandlers.handleOpenFile,
  state,
  delay,
});



const miscHandlers = createMiscHandlers({
  envService,
  ensureUserSettings,
  workspace,
  sendToRenderer,
  blocksStore,
  apiUsageService: getApiUsageService(),
});

const agentHandlers = createAgentHandlers({
  agentService,
  ensureUserSettings,
  sendToRenderer,
});

app.whenReady().then(() => {
  const e2eWorkspace = process.env.TEX180_E2E_WORKSPACE;
  if (e2eWorkspace) {
    const resolved = path.resolve(e2eWorkspace);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      workspace.setRootPath(resolved);
      state.currentWorkspacePath = null;
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

// Desktop capture IPC handler
ipcMain.handle("tex64:capture:getSources", async (_event, options) => {
  if (process.env.TEX180_E2E === "1") {
    const windows = BrowserWindow.getAllWindows();
    const mainWindow = windows.find((win) => !win.isDestroyed()) ?? null;
    if (!mainWindow) {
      throw new Error("E2E capture failed: no window available.");
    }
    const image = await mainWindow.capturePage();
    const size = image.getSize();
    const target = options?.thumbnailSize ?? null;
    let thumbnail = image;
    if (target) {
      const scale = Math.min(
        target.width / size.width,
        target.height / size.height,
        1
      );
      const width = Math.max(1, Math.round(size.width * scale));
      const height = Math.max(1, Math.round(size.height * scale));
      if (width !== size.width || height !== size.height) {
        thumbnail = image.resize({ width, height });
      }
    }
    const thumbSize = thumbnail.getSize();
    return [
      {
        id: "e2e:main-window",
        title: mainWindow.getTitle() || "E2E Window",
        app: "tex64",
        thumbnailUrl: thumbnail.toDataURL(),
        width: thumbSize.width,
        height: thumbSize.height,
      },
    ];
  }

  const size = options?.thumbnailSize ?? { width: 1600, height: 900 };

  const fetchSources = async (types, fetchWindowIcons = false) => {
    const params = { types, thumbnailSize: size };
    if (fetchWindowIcons && types.includes("window")) {
      params.fetchWindowIcons = true;
    }
    return desktopCapturer.getSources(params);
  };

  const mapSource = (source) => {
    const thumbnail = source.thumbnail;
    const thumbSize = thumbnail.getSize();
    const idPrefix =
      typeof source.id === "string" ? source.id.split(":")[0] : "";
    const isScreen = idPrefix === "screen";
    return {
      id: source.id,
      title: source.name,
      app: isScreen ? "画面" : source.appIcon ? source.name.split(" - ")[0] : "",
      thumbnailUrl:
        typeof thumbnail.isEmpty === "function" && thumbnail.isEmpty()
          ? ""
          : thumbnail.toDataURL(),
      width: thumbSize.width,
      height: thumbSize.height,
    };
  };

  let sources = [];
  let lastError = null;

  try {
    sources = await fetchSources(["window"], true);
  } catch (error) {
    lastError = error;
  }

  if (sources.length === 0) {
    try {
      sources = await fetchSources(["window"], false);
    } catch (error) {
      lastError = error;
    }
  }

  if (sources.length === 0) {
    try {
      sources = await fetchSources(["screen"], false);
    } catch (error) {
      lastError = error;
    }
  }

  if (sources.length === 0 && lastError) {
    throw lastError;
  }

  return sources.map(mapSource);
});

ipcMain.handle("tex64:math-ocr:run", async (_event, payload) => {
  const service = getMathOcrService();
  return service.recognize(payload);
});

ipcMain.on("tex64", (_event, message) => {
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
    workspaceHandlers.updateWorkspaceIfNeeded(rootPath, true);
    workspaceHandlers.requestIndex(rootPath);
    return;
  }
  if (type === "openWorkspace" || type === "requestWorkspace") {
    workspaceHandlers.handleOpenWorkspace();
    return;
  }
  if (type === "createProject") {
    workspaceHandlers.handleCreateProject(message.template);
    return;
  }
  if (type === "synctex:forward") {
    buildHandlers.handleSynctexForward(message);
    return;
  }
  if (type === "synctex:reverse") {
    buildHandlers.handleSynctexReverse(message);
    return;
  }
  if (type === "build") {
    buildHandlers.handleBuild(message.mainFile, {
      format: message.format,
      formatSettings: message.formatSettings,
      engine: message.engine,
      pdfViewerMode: message.pdfViewerMode,
    });
    return;
  }
  if (type === "build:clean") {
    buildHandlers.handleClean(message.mainFile, { deep: message.deep === true });
    return;
  }
  if (type === "lint:run") {
    buildHandlers.handleLint(message.mainFile);
    return;
  }
  if (type === "openFile") {
    workspaceHandlers.handleOpenFile(message.path);
    return;
  }
  if (type === "file:preview") {
    workspaceHandlers.handleFilePreview(message.requestId, message.path);
    return;
  }
  if (type === "file:excerpt") {
    workspaceHandlers.handleFileExcerpt(message.requestId, message.path, {
      line: message.line,
      radius: message.radius,
      maxLines: message.maxLines,
    });
    return;
  }
  if (type === "saveFile") {
    workspaceHandlers.handleSaveFile(message.path, message.content, {
      format: message.format,
      formatSource: message.formatSource,
      formatSettings: message.formatSettings,
    });
    return;
  }
  if (type === "formatFile") {
    workspaceHandlers.handleFormatFile(
      message.path,
      message.content,
      message.source,
      message.formatSettings
    );
    return;
  }
  if (type === "createFile") {
    workspaceHandlers.handleCreateFile(message.path);
    return;
  }
  if (type === "createFolder") {
    workspaceHandlers.handleCreateFolder(message.path);
    return;
  }
  if (type === "revealInFinder") {
    workspaceHandlers.handleRevealInFinder(message.path);
    return;
  }
  if (type === "openInTerminal") {
    workspaceHandlers.handleOpenInTerminal(message.path);
    return;
  }
  if (type === "renameItem") {
    workspaceHandlers.handleRenameItem(message.path, message.newName);
    return;
  }

  if (type === "deleteItem") {
    workspaceHandlers.handleDeleteItem(message.path);
    return;
  }
  if (type === "moveItem") {
    workspaceHandlers.handleMoveItem(message.path, message.destination);
    return;
  }
  if (type === "copyItem") {
    workspaceHandlers.handleCopyItem(message.path, message.destination);
    return;
  }
  if (type === "undoFileOperation") {
    workspaceHandlers.handleUndoFileOperation();
    return;
  }
  if (type === "setRoot") {
    workspaceHandlers.handleSetRoot(message.path);
    return;
  }
  if (type === "detectRoot") {
    workspaceHandlers.handleDetectRoot();
    return;
  }
  if (type === "build:profiles:update") {
    workspaceHandlers.handleBuildProfilesUpdate(message.profiles, message.activeId);
    return;
  }
  if (type === "requestIndex") {
    workspaceHandlers.handleIndexRequest();
    return;
  }
  if (type === "search") {
    workspaceHandlers.handleSearch(message.query);
    return;
  }
  if (type === "search:renameSymbol") {
    agentHandlers.handleSearchRename(message);
    return;
  }

  if (type === "blocks:save") {
    miscHandlers.handleBlocksSave(message.entry);
    return;
  }
  if (type === "api:usage:get") {
    miscHandlers.handleApiUsageGet();
    return;
  }
  if (type === "api:usage:reset") {
    miscHandlers.handleApiUsageReset();
    return;
  }
  if (type === "api:ghostCompletion") {
    miscHandlers.handleApiGhostCompletion(message);
    return;
  }
  if (type === "consoleLog") {
    if (message.message) {
      // eslint-disable-next-line no-console
      console.log(`[WebView] ${message.message}`);
    }
  }

  if (type === "agent:settings:get") {
    agentHandlers.handleAgentSettingsGet();
    return;
  }
  if (type === "agent:settings:set") {
    agentHandlers.handleAgentSettingsSet(message.settings);
    return;
  }
  if (type === "agent:run") {
    agentHandlers.handleAgentRun(message.message, message.context, message.conversationId);
    return;
  }
  if (type === "agent:abort") {
    agentHandlers.handleAgentAbort();
    return;
  }
  if (type === "agent:apply") {
    agentHandlers.handleAgentApply(message.proposalId);
    return;
  }
  if (type === "agent:clear") {
    agentHandlers.handleAgentClear(message.conversationId);
    return;
  }

  if (type === "settings:response") {
    agentHandlers.handleSettingsResponse(message);
    return;
  }

  // Environment IPC
  if (type === "env:check") {
    miscHandlers.handleEnvCheck(message.command);
    return;
  }
  if (type === "env:install") {
    miscHandlers.handleEnvInstall(message.target);
    return;
  }
});

ipcMain.on("tex64:pdf", (_event, message) => {
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
  if (type === "reverse") {
    const payload = message.payload ?? {};
    buildHandlers.handleSynctexReverse({
      page: payload.page,
      x: payload.x,
      y: payload.y,
      pdfPath: payload.path,
    });
  }
});

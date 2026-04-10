const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  shell,
  systemPreferences,
  Notification,
} = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { BuildService } = require("./services/build.cjs");
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
const { AgentAuditService } = require("./services/agent-audit.cjs");
const { AgentSessionsService } = require("./services/agent-sessions.cjs");
const { ApiUsageService } = require("./services/api-usage.cjs");
const { PlatformAccessService } = require("./services/platform-access.cjs");
const { createMainErrorReporter } = require("./services/main-error-reporter.cjs");
const { createWorkspaceHandlers } = require("./handlers/workspace.cjs");
const { createBuildHandlers } = require("./handlers/build.cjs");

const { createMiscHandlers } = require("./handlers/misc.cjs");
const { createAgentHandlers } = require("./handlers/agent.cjs");

const e2eUserDataPath =
  typeof process.env.TEX64_E2E_USERDATA === "string"
    ? process.env.TEX64_E2E_USERDATA.trim()
    : "";
const isE2EContext =
  process.env.TEX64_E2E === "1" ||
  (typeof e2eUserDataPath === "string" && e2eUserDataPath.length > 0);
const e2eHeadless =
  isE2EContext && process.env.TEX64_E2E_FORCE_HEADLESS !== "0";
if (e2eUserDataPath) {
  app.setPath("userData", path.resolve(e2eUserDataPath));
} else if (!app.isPackaged) {
  // Keep development runtime isolated from installed app cache/profile.
  const devUserDataPath = path.join(app.getPath("appData"), "tex64-dev");
  app.setPath("userData", devUserDataPath);
}
if (!app.isPackaged) {
  app.setName("TeX64 Dev");
  app.commandLine.appendSwitch("disable-http-cache");
}

const state = {
  mainWindow: null,
  currentWorkspacePath: null,
  userSettings: null,
  lastBuildPdfPath: null,
  formatWarningShown: false,
};

// ---------------------------------------------------------------------------
// Window state persistence
// ---------------------------------------------------------------------------
const WINDOW_STATE_FILE = "tex64-window-state.json";
const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;
let windowStateSaveTimer = null;

const loadWindowState = () => {
  try {
    const filePath = path.join(app.getPath("userData"), WINDOW_STATE_FILE);
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.width === "number" &&
      typeof parsed.height === "number"
    ) {
      return parsed;
    }
  } catch {
    // No saved state or corrupt file — use defaults.
  }
  return null;
};

const saveWindowState = (bounds) => {
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
  }
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    try {
      const filePath = path.join(app.getPath("userData"), WINDOW_STATE_FILE);
      fs.writeFileSync(filePath, JSON.stringify(bounds, null, 2), "utf8");
    } catch {
      // Non-critical — silently ignore write failures.
    }
  }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
};

const validateWindowBounds = (saved) => {
  if (!saved) return null;
  const { screen } = require("electron");
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return null;

  // Check if saved position is visible on any display.
  const isOnScreen = displays.some((display) => {
    const { x, y, width, height } = display.workArea;
    // At least 100px of the window should be visible on this display.
    return (
      saved.x < x + width - 100 &&
      saved.x + saved.width > x + 100 &&
      saved.y < y + height - 50 &&
      saved.y + saved.height > y + 50
    );
  });

  if (!isOnScreen) {
    // Position is off-screen (monitor disconnected), only restore size.
    return { width: saved.width, height: saved.height };
  }
  return saved;
};

const shouldRunStartupWebBuild = () => {
  if (app.isPackaged) {
    return false;
  }
  if (isE2EContext) {
    return false;
  }
  if (process.env.TEX64_SKIP_STARTUP_WEB_BUILD === "1") {
    return false;
  }
  return true;
};

const runStartupWebBuildIfNeeded = () => {
  if (!shouldRunStartupWebBuild()) {
    return;
  }
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const build = spawnSync(npmCommand, ["run", "-s", "web:build"], {
    cwd: app.getAppPath(),
    stdio: "inherit",
    env: {
      ...process.env,
      TEX64_FROM_ELECTRON_STARTUP_BUILD: "1",
    },
  });
  if (build.error || build.status !== 0) {
    const reason = build.error?.message || `exit ${build.status}`;
    console.warn(`[startup] web:build failed (${reason}); launching with existing Resources/web.`);
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workspace = new WorkspaceManager();
const buildService = new BuildService();
const formatterService = new FormatterService();
const indexerService = new IndexerService();
const searchService = new SearchService();

const pdfWindowManager = new PDFWindowManager();
const synctexService = new SynctexService();
const blocksStore = new BlocksStore();
const envService = new EnvService();
let mathOcrService = null;
let apiUsageService = null;
let platformAccessService = null;
let agentAuditService = null;
let agentSessionsService = null;

const getMathOcrService = () => {
  if (!mathOcrService) {
    mathOcrService = new MathOcrService({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath("userData"),
    });
  }
  return mathOcrService;
};

const createMainWindow = () => {
  const preloadPath = path.join(__dirname, "preload.cjs");
  const indexPath = path.join(app.getAppPath(), "Resources", "web", "index.html");

  const savedBounds = isE2EContext ? null : validateWindowBounds(loadWindowState());
  const windowOptions = {
    width: savedBounds?.width ?? 1280,
    height: savedBounds?.height ?? 820,
    minWidth: 960,
    minHeight: 600,
    show: !e2eHeadless,
    backgroundColor: "#1c2129",
    title: "TeX64",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 10 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  };
  if (typeof savedBounds?.x === "number" && typeof savedBounds?.y === "number") {
    windowOptions.x = savedBounds.x;
    windowOptions.y = savedBounds.y;
  }

  state.mainWindow = new BrowserWindow(windowOptions);

  // Persist window position and size on move/resize.
  const trackWindowBounds = () => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
    if (state.mainWindow.isMinimized() || state.mainWindow.isFullScreen()) return;
    saveWindowState(state.mainWindow.getBounds());
  };
  state.mainWindow.on("resize", trackWindowBounds);
  state.mainWindow.on("move", trackWindowBounds);

  const loadRenderer = () => {
    state.mainWindow.loadFile(indexPath);
  };
  state.mainWindow.webContents.session
    .clearCache()
    .catch(() => {})
    .finally(loadRenderer);
  state.mainWindow.on("closed", () => {
    // Ensure any teardown work doesn't try to message a destroyed window.
    state.mainWindow = null;
    clearWorkspaceSession({ closePdfWindow: true });
    if (state.captureShortcut) {
      globalShortcut.unregister(state.captureShortcut);
      state.captureShortcut = null;
    }
  });
};

const sendToRenderer = (type, payload) => {
  const mainWindow = state.mainWindow;
  if (!mainWindow) {
    return;
  }
  if (typeof mainWindow.isDestroyed === "function" && mainWindow.isDestroyed()) {
    return;
  }
  const webContents = mainWindow.webContents;
  if (!webContents) {
    return;
  }
  if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) {
    return;
  }
  try {
    webContents.send("tex64:message", { type, payload });
  } catch (error) {
    const message = error && typeof error.message === "string" ? error.message : "";
    if (message.includes("Object has been destroyed")) {
      return;
    }
    console.warn("[main] sendToRenderer failed", error);
  }
};

const sendBuildState = (buildState, message) => {
  const payload = { state: buildState };
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

const getAgentAuditService = () => {
  if (!agentAuditService) {
    agentAuditService = new AgentAuditService({
      userDataPath: app.getPath("userData"),
    });
  }
  return agentAuditService;
};

const getAgentSessionsService = () => {
  if (!agentSessionsService) {
    agentSessionsService = new AgentSessionsService({
      userDataPath: app.getPath("userData"),
    });
  }
  return agentSessionsService;
};

const getPlatformAccessService = () => {
  if (!platformAccessService) {
    platformAccessService = new PlatformAccessService({
      userDataPath: app.getPath("userData"),
      strictProduction: app.isPackaged === true,
      allowDirectOAuthCallbackAuthUrl: app.isPackaged !== true && isE2EContext,
    });
  }
  return platformAccessService;
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
  WorkspaceError,
  state,
  userSettings: { 
    addRecentProject: (p) => ensureUserSettings().addRecentProject(p),
    removeRecentProject: (p) => ensureUserSettings().removeRecentProject(p),
  },
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
  auditService: getAgentAuditService(),
  sessionsService: getAgentSessionsService(),
  platformAccess: getPlatformAccessService(),
  envService,
});

const buildHandlers = createBuildHandlers({
  fs,
  path,
  buildService,
  envService,
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

const clearWorkspaceSession = ({ closePdfWindow = false } = {}) => {
  buildHandlers.handleBuildCancel();
  workspace.setRootPath(null);
  state.currentWorkspacePath = null;
  state.lastBuildPdfPath = null;
  if (closePdfWindow && typeof pdfWindowManager.close === "function") {
    pdfWindowManager.close();
  }
};



const miscHandlers = createMiscHandlers({
  envService,
  ensureUserSettings,
  workspace,
  shell,
  Notification,
  sendToRenderer,
  blocksStore,
  apiUsageService: getApiUsageService(),
  platformService: getPlatformAccessService(),
  ensureProtocolClient: registerProtocolClient,
  runtimeInfo: {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    userDataPath: app.getPath("userData"),
    packaged: app.isPackaged === true,
  },
});

const agentHandlers = createAgentHandlers({
  agentService,
  ensureUserSettings,
  sendToRenderer,
  platformService: getPlatformAccessService(),
});

let errorReportingEnabled = true;
const mainErrorReporter = createMainErrorReporter({
  isEnabled: () => errorReportingEnabled,
  sendReport: (report) =>
    miscHandlers.handleErrorReportSend({
      report: {
        ...report,
        diagnostics: {
          processPlatform: process.platform,
          processArch: process.arch,
          ...(report?.diagnostics && typeof report.diagnostics === "object"
            ? report.diagnostics
            : {}),
        },
      },
    }),
});

const reportMainProcessError = (kind, value, diagnostics = {}) => {
  mainErrorReporter.report(kind, value, diagnostics);
};

process.on("uncaughtExceptionMonitor", (error, origin) => {
  reportMainProcessError("main_uncaught_exception", error, {
    origin: typeof origin === "string" ? origin : null,
  });
});

process.on("unhandledRejection", (reason) => {
  reportMainProcessError("main_unhandled_rejection", reason, {});
});

const focusMainWindow = () => {
  if (!state.mainWindow) {
    return;
  }
  if (state.mainWindow.isMinimized()) {
    state.mainWindow.restore();
  }
  state.mainWindow.focus();
};

function registerProtocolClient() {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("tex64", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
    return;
  }
  app.setAsDefaultProtocolClient("tex64");
}

const normalizeOAuthPathname = (value) => {
  const pathname = typeof value === "string" && value ? value : "/";
  if (pathname === "/") {
    return "/";
  }
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
};

const normalizeOAuthCallbackUrlInput = (value) => {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const looksLikeOAuthCallbackUrl = (value) => {
  const candidate = normalizeOAuthCallbackUrlInput(value);
  if (!/^tex64:\/\//i.test(candidate)) {
    return false;
  }
  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = normalizeOAuthPathname(parsed.pathname || "/");
    if (hostname === "oauth" && pathname === "/callback") {
      return true;
    }
    if (!hostname && pathname === "/oauth/callback") {
      return true;
    }
    if (hostname === "account" && pathname === "/oauth/callback") {
      return true;
    }
    if (!hostname && pathname === "/account/oauth/callback") {
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

const pendingOAuthCallbackUrls = [];

const allowMultiInstance =
  process.env.TEX64_ALLOW_MULTI_INSTANCE === "1";

const launchDetachedInstance = () => {
  try {
    const env = {
      ...process.env,
      TEX64_ALLOW_MULTI_INSTANCE: "1",
    };
    const args = [];
    if (process.defaultApp) {
      const appEntry =
        typeof process.argv[1] === "string" && process.argv[1]
          ? path.resolve(process.argv[1])
          : app.getAppPath();
      args.push(appEntry);
    }
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
};

const queueOAuthCallbackUrl = (value) => {
  const url = normalizeOAuthCallbackUrlInput(value);
  if (!looksLikeOAuthCallbackUrl(url)) {
    return;
  }
  if (app.isReady()) {
    miscHandlers.handleAuthGoogleCallback(url).catch(() => {});
    return;
  }
  pendingOAuthCallbackUrls.push(url);
};

const hasSingleInstanceLock = allowMultiInstance
  ? true
  : app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  if (!allowMultiInstance) {
    app.on("second-instance", (_event, argv = []) => {
      const oauthArgs = Array.isArray(argv)
        ? argv.filter((arg) => looksLikeOAuthCallbackUrl(arg))
        : [];
      if (oauthArgs.length > 0) {
        focusMainWindow();
        oauthArgs.forEach((arg) => {
          queueOAuthCallbackUrl(arg);
        });
        return;
      }
      const launched = launchDetachedInstance();
      if (!launched) {
        focusMainWindow();
      }
    });
  }
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  focusMainWindow();
  queueOAuthCallbackUrl(url);
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }
  runStartupWebBuildIfNeeded();
  createMainWindow();
  registerProtocolClient();
  while (pendingOAuthCallbackUrls.length > 0) {
    const url = pendingOAuthCallbackUrls.shift();
    if (url) {
      miscHandlers.handleAuthGoogleCallback(url).catch(() => {});
    }
  }
  process.argv.forEach((arg) => {
    queueOAuthCallbackUrl(arg);
  });
  if (!e2eHeadless) {
    const triggerUpdateCheck = () => {
      Promise.resolve(
        miscHandlers.handleUpdateCheck({ force: false, source: "background" })
      ).catch(() => {});
    };
    setTimeout(() => {
      triggerUpdateCheck();
    }, 15_000);
    setInterval(() => {
      triggerUpdateCheck();
    }, 6 * 60 * 60 * 1000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  clearWorkspaceSession({ closePdfWindow: true });
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Desktop capture IPC handler
ipcMain.handle("tex64:capture:getSources", async (_event, options) => {
  const size = options?.thumbnailSize ?? { width: 1600, height: 900 };

  const fetchSources = async (types, fetchWindowIcons = false) => {
    const params = { types, thumbnailSize: size };
    if (fetchWindowIcons && types.includes("window")) {
      params.fetchWindowIcons = true;
    }
    return desktopCapturer.getSources(params);
  };

  const fetchWindowSources = async () => {
    let windowSources = [];
    let windowError = null;
    try {
      windowSources = await fetchSources(["window"], true);
    } catch (error) {
      windowError = error;
    }
    if (windowSources.length === 0) {
      try {
        windowSources = await fetchSources(["window"], false);
      } catch (error) {
        if (!windowError) {
          windowError = error;
        }
      }
    }
    return { windowSources, windowError };
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
      app: isScreen ? "Screen" : source.appIcon ? source.name.split(" - ")[0] : "",
      thumbnailUrl:
        typeof thumbnail.isEmpty === "function" && thumbnail.isEmpty()
          ? ""
          : thumbnail.toDataURL(),
      width: thumbSize.width,
      height: thumbSize.height,
    };
  };

  const { windowSources, windowError } = await fetchWindowSources();
  let screenSources = [];
  let screenError = null;

  try {
    screenSources = await fetchSources(["screen"], false);
  } catch (error) {
    screenError = error;
  }

  const mergedSources = [...windowSources, ...screenSources];

  if (mergedSources.length === 0) {
    if (windowError) {
      throw windowError;
    }
    if (screenError) {
      throw screenError;
    }
    return [];
  }

  const seen = new Set();
  const deduped = [];
  for (const source of mergedSources) {
    if (!source?.id || seen.has(source.id)) {
      continue;
    }
    seen.add(source.id);
    deduped.push(source);
  }

  return deduped.map(mapSource);
});

// Screen capture permission helpers (macOS)
ipcMain.handle("tex64:capture:checkPermission", async () => {
  if (process.platform !== "darwin") {
    return "granted";
  }
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    // Older Electron versions may not support this
    return "unknown";
  }
});

ipcMain.handle("tex64:capture:openPermissionSettings", async () => {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    );
    return true;
  } catch {
    return false;
  }
});

// High-resolution capture of a single source (for cropper quality)
ipcMain.handle("tex64:capture:captureHighRes", async (_event, options) => {
  const { sourceId } = options ?? {};
  if (!sourceId) return null;

  // Determine native resolution from all displays
  const displays = screen.getAllDisplays();
  let maxWidth = 1920;
  let maxHeight = 1080;
  for (const display of displays) {
    const w = Math.round(display.size.width * display.scaleFactor);
    const h = Math.round(display.size.height * display.scaleFactor);
    if (w > maxWidth) maxWidth = w;
    if (h > maxHeight) maxHeight = h;
  }

  const type = sourceId.startsWith("screen:") ? "screen" : "window";
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: [type],
      thumbnailSize: { width: maxWidth, height: maxHeight },
    });
  } catch {
    return null;
  }

  const source = sources.find((s) => s.id === sourceId);
  if (!source) return null;

  const thumbnail = source.thumbnail;
  if (typeof thumbnail.isEmpty === "function" && thumbnail.isEmpty()) {
    return null;
  }
  const thumbSize = thumbnail.getSize();
  return {
    thumbnailUrl: thumbnail.toDataURL(),
    width: thumbSize.width,
    height: thumbSize.height,
  };
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
  if (type === "openRecentProject") {
    workspaceHandlers.handleOpenRecentProject(message.path);
    return;
  }
  if (type === "getRecentProjects") {
    ensureUserSettings()
      .getRecentProjects()
      .then((projects) => {
        sendToRenderer("recentProjects", { projects });
      })
      .catch(() => {
        sendToRenderer("recentProjects", { projects: [] });
      });
    return;
  }
  if (type === "removeRecentProject") {
    ensureUserSettings()
      .removeRecentProject(message.path)
      .then((projects) => {
        sendToRenderer("recentProjects", { projects });
      })
      .catch(() => {});
    return;
  }
  if (type === "createProject") {
    workspaceHandlers.handleCreateProject();
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
  if (type === "build:cancel") {
    buildHandlers.handleBuildCancel();
    return;
  }
  if (type === "build:clean") {
    buildHandlers.handleClean(message.mainFile, {
      deep: message.deep === true,
      buildProfile: message.buildProfile,
    });
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
    workspaceHandlers.handleSearch(message.query, message.requestId);
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
  if (type === "platform:state:get") {
    miscHandlers.handlePlatformStateGet();
    return;
  }
  if (type === "feature:check") {
    miscHandlers.handleFeatureCheck(message);
    return;
  }
  if (type === "platform:usage:get") {
    miscHandlers.handlePlatformUsageGet(message);
    return;
  }
  if (type === "update:check") {
    miscHandlers.handleUpdateCheck(message);
    return;
  }
  if (type === "update:download") {
    miscHandlers.handleUpdateDownload(message);
    return;
  }
  if (type === "update:install") {
    miscHandlers.handleUpdateInstall(message);
    return;
  }
  if (type === "update:status:get") {
    miscHandlers.handleUpdateStatusGet();
    return;
  }
  if (type === "auth:google:start") {
    miscHandlers.handleAuthGoogleStart();
    return;
  }
  if (type === "auth:google:cancel") {
    miscHandlers.handleAuthGoogleCancel();
    return;
  }
  if (type === "auth:signout") {
    miscHandlers.handleAuthSignOut();
    return;
  }
  if (type === "shell:openExternal") {
    miscHandlers.handleOpenExternal(message.url);
    return;
  }
  if (type === "feedback:send") {
    miscHandlers.handleFeedbackSend(message);
    return;
  }
  if (type === "error:reporting:set") {
    errorReportingEnabled = message?.enabled !== false;
    return;
  }
  if (type === "error:report") {
    if (!errorReportingEnabled) {
      return;
    }
    miscHandlers.handleErrorReportSend(message);
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
  if (type === "consoleLog") {
    if (message.message) {
      // eslint-disable-next-line no-console
      console.log(`[WebView] ${message.message}`);
    }
    return;
  }

  if (type === "agent:settings:get") {
    agentHandlers.handleAgentSettingsGet();
    return;
  }
  if (type === "agent:settings:set") {
    agentHandlers.handleAgentSettingsSet(message.settings);
    return;
  }
  if (type === "agent:state:get") {
    agentHandlers.handleAgentStateGet();
    return;
  }
  if (type === "agent:run") {
    agentHandlers.handleAgentRun(
      message.message,
      message.context,
      message.conversationId,
      message.parts
    );
    return;
  }
  if (type === "agent:resume") {
    agentHandlers.handleAgentResume(message.conversationId, message.context);
    return;
  }
  if (type === "agent:abort") {
    agentHandlers.handleAgentAbort(message.conversationId);
    return;
  }
  if (type === "agent:apply") {
    agentHandlers.handleAgentApply(message.proposalId);
    return;
  }
  if (type === "agent:proposal:dismiss") {
    agentHandlers.handleAgentProposalDismiss(message.proposalId);
    return;
  }
  if (type === "agent:undoLastRunApply") {
    agentHandlers.handleAgentUndoLastRunApply(message.conversationId);
    return;
  }
  if (type === "agent:undoLastApply") {
    agentHandlers.handleAgentUndoLastApply(message.conversationId);
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

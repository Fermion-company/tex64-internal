const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Notification,
} = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
if (process.env.TEX64_EDITION === "education") {
  app.setName("TeX64 Education");
  app.setPath("userData", path.join(app.getPath("appData"), "TeX64 Education"));
  app.setAppUserModelId("com.fermion.tex64.education");
}
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
const { TexizeService } = require("./services/texize.cjs");
const { TdomEngineService } = require("./services/tdom-engine.cjs");
const { MacFileAccessService } = require("./services/mac-file-access.cjs");
const { TexlabService } = require("./services/texlab/service.cjs");
const { SpellService } = require("./services/spell/service.cjs");
const { TerminalService } = require("./services/terminal.cjs");
const { WorkspaceWatcher } = require("./services/file-watcher.cjs");
const { GitService } = require("./services/git.cjs");
const { SnippetsService } = require("./services/snippets.cjs");
const { AgentService } = require("./services/agent.cjs");
const { AgentAuditService } = require("./services/agent-audit.cjs");
const { AgentSessionsService } = require("./services/agent-sessions.cjs");
const { ApiUsageService } = require("./services/api-usage.cjs");
const { PlatformAccessService } = require("./services/platform-access.cjs");
const {
  resolveDistributionRuntime,
} = require("./services/distribution-runtime.cjs");
const {
  getCheckoutReturnOutcome,
  normalizeStripeCheckoutUrl,
} = require("./services/billing-checkout.cjs");
const { createWorkspaceHandlers } = require("./handlers/workspace.cjs");
const { createBuildHandlers } = require("./handlers/build.cjs");
const { registerTexizeHandlers } = require("./handlers/texize.cjs");
const { registerTdomEngineHandlers } = require("./handlers/tdom-engine.cjs");
const { registerAiWebHandlers } = require("./handlers/ai-web.cjs");
const { AiWebService } = require("./services/ai-web.cjs");

const { createMiscHandlers } = require("./handlers/misc.cjs");
const { createAgentHandlers } = require("./handlers/agent.cjs");
const { createApplicationMenuTemplate } = require("./app-menu.cjs");

const e2eUserDataPath =
  typeof process.env.TEX64_E2E_USERDATA === "string"
    ? process.env.TEX64_E2E_USERDATA.trim()
    : "";
const isE2EContext =
  process.env.TEX64_E2E === "1" ||
  (typeof e2eUserDataPath === "string" && e2eUserDataPath.length > 0);
const e2eHeadless =
  isE2EContext && process.env.TEX64_E2E_FORCE_HEADLESS !== "0";
const distributionRuntime = resolveDistributionRuntime(process.windowsStore);
const createWindowsSessionSecretStorage = () => {
  if (process.platform !== "win32" || app.isPackaged !== true) {
    return null;
  }
  return {
    required: true,
    encrypt: (plaintext) => {
      try {
        if (
          typeof plaintext !== "string" ||
          !safeStorage ||
          !safeStorage.isEncryptionAvailable()
        ) {
          return null;
        }
        return safeStorage.encryptString(plaintext).toString("base64");
      } catch {
        return null;
      }
    },
    decrypt: (ciphertext) => {
      try {
        if (
          typeof ciphertext !== "string" ||
          !ciphertext ||
          !safeStorage ||
          !safeStorage.isEncryptionAvailable()
        ) {
          return null;
        }
        return safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
      } catch {
        return null;
      }
    },
  };
};
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
  // The renderer's in-app language, pushed via the "uiLocale" message. Native
  // surfaces (dialogs, menu, notifications) read this instead of the OS locale.
  uiLocale: "en",
};
const macFileAccess = new MacFileAccessService({
  // E2E runs must never block on the native permission dialog; the denied
  // state still reaches the renderer through the normal status reporting.
  dialog: isE2EContext ? null : dialog,
  shell,
  getWindow: () => state.mainWindow,
  // The in-app language wins over the OS locale once the renderer has pushed it.
  locale: () => state.uiLocale || app.getLocale(),
});

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
let texizeService = null;
let tdomEngineService = null;
let texlabService = null;
let spellService = null;
let terminalService = null;
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

const getTexizeService = () => {
  if (!texizeService) {
    texizeService = new TexizeService({ fileAccess: macFileAccess });
  }
  return texizeService;
};

let aiWebService = null;
const getAiWebService = () => {
  if (!aiWebService) {
    aiWebService = new AiWebService({ app, ensureUserSettings });
  }
  return aiWebService;
};
const getTdomEngineService = () => {
  if (!tdomEngineService) {
    tdomEngineService = new TdomEngineService({
      fileAccess: macFileAccess,
      resourcesPath: app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "Resources"),
      userDataPath: app.getPath("userData"),
    });
  }
  return tdomEngineService;
};
const getTexlabService = () => {
  if (!texlabService) {
    texlabService = new TexlabService({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
    texlabService.setHandlers({
      onMessage: (message) => sendLspToRenderer("tex64:lsp:message", message),
      onStatus: (status, detail) => sendLspToRenderer("tex64:lsp:status", { status, detail }),
    });
  }
  return texlabService;
};

const getSpellService = () => {
  if (!spellService) {
    spellService = new SpellService({ userDataPath: app.getPath("userData") });
  }
  return spellService;
};

// Detached terminal windows own their own xterm but share the pty sessions in
// this process, so shell output has to reach every window that might be showing
// the session, not just the main one.
const terminalWindows = new Set();

const sendToTerminalSurfaces = (channel, data) => {
  sendLspToRenderer(channel, data);
  for (const win of terminalWindows) {
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) {
      terminalWindows.delete(win);
      continue;
    }
    try {
      win.webContents.send(channel, data);
    } catch {
      /* a window closing mid-send is not an error worth reporting */
    }
  }
};

const getTerminalService = () => {
  if (!terminalService) {
    terminalService = new TerminalService({
      onData: (id, data) => sendToTerminalSurfaces("tex64:terminal:data", { id, data }),
      onExit: (id, exitCode, signal) =>
        sendToTerminalSurfaces("tex64:terminal:exit", { id, exitCode, signal }),
    });
  }
  return terminalService;
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
    title: process.env.TEX64_EDITION === "education" ? "TeX64 Education" : "TeX64",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 8 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      // AI mode hosts the tex64-ai web app in a <webview> guest.
      webviewTag: true,
    },
  };
  if (typeof savedBounds?.x === "number" && typeof savedBounds?.y === "number") {
    windowOptions.x = savedBounds.x;
    windowOptions.y = savedBounds.y;
  }

  state.mainWindow = new BrowserWindow(windowOptions);
  if (process.env.TEX64_EDITION === "education") {
    state.mainWindow.on("page-title-updated", (event) => event.preventDefault());
  }

  // Persist window position and size on move/resize.
  const trackWindowBounds = () => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
    if (state.mainWindow.isMinimized() || state.mainWindow.isFullScreen()) return;
    saveWindowState(state.mainWindow.getBounds());
  };
  state.mainWindow.on("resize", trackWindowBounds);
  state.mainWindow.on("move", trackWindowBounds);

  // texlab restart on renderer (re)load is handled by the texlab service itself
  // (it restarts when a fresh client sends `initialize`). We intentionally do
  // NOT reset on webContents "did-start-loading" — that also fires for the PDF
  // viewer iframe and would kill texlab mid-session.

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
    if (terminalService) {
      terminalService.killAll();
    }
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

const handleLivePreviewSource = (payload) => {
  const rootPath = workspace.getRootPath();
  const sourceFile = typeof payload?.file === "string" ? payload.file.replace(/\0/g, "") : "";
  const line = Number(payload?.line);
  const column = Number(payload?.column);
  if (!rootPath || !sourceFile || !Number.isFinite(line) || line < 1) {
    return;
  }
  const root = path.resolve(rootPath);
  const absolute = path.isAbsolute(sourceFile)
    ? path.resolve(sourceFile)
    : path.resolve(root, sourceFile);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return;
  }
  sendToRenderer("synctex:reverseResult", {
    ok: true,
    path: relative.split(path.sep).join("/"),
    line: Math.floor(line),
    column: Number.isFinite(column) && column >= 1 ? Math.floor(column) : 1,
    source: "live-preview",
  });
};

const handleLivePreviewEdit = (payload) => {
  const rootPath = workspace.getRootPath();
  const sourceFile = typeof payload?.file === "string" ? payload.file.replace(/\0/g, "") : "";
  if (!rootPath || !sourceFile || typeof payload?.sessionId !== "string") return;
  const root = path.resolve(rootPath);
  const absolute = path.isAbsolute(sourceFile)
    ? path.resolve(sourceFile)
    : path.resolve(root, sourceFile);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  const positionValid = (value) =>
    value && Number.isFinite(Number(value.line)) && Number(value.line) >= 1 &&
    Number.isFinite(Number(value.column)) && Number(value.column) >= 1;
  if (!positionValid(payload.start) || !positionValid(payload.end)) return;
  sendToRenderer("live-preview:edit", {
    sessionId: payload.sessionId,
    regionId: typeof payload.regionId === "string" ? payload.regionId : undefined,
    kind: payload.kind === "math" ? "math" : "text",
    path: relative.split(path.sep).join("/"),
    start: {
      line: Math.floor(Number(payload.start.line)),
      column: Math.floor(Number(payload.start.column)),
    },
    end: {
      line: Math.floor(Number(payload.end.line)),
      column: Math.floor(Number(payload.end.column)),
    },
    baseValue: typeof payload.baseValue === "string" ? payload.baseValue : "",
    value: typeof payload.value === "string" ? payload.value : undefined,
    replacement: typeof payload.replacement === "string" ? payload.replacement : "",
    cancel: payload.cancel === true,
    finish: payload.finish === true,
    sourceRev: Number.isFinite(Number(payload.sourceRev)) ? Number(payload.sourceRev) : undefined,
  });
};

const educationService = process.env.TEX64_EDITION === "education"
  ? require("./education/service.cjs").createEducationService({app, BrowserWindow, dialog,
      getMainWindow:()=>state.mainWindow, getRoot:()=>workspace.getRootPath(),
      openProject:(root)=>workspaceHandlers.handleOpenRecentProject(root)}) : null;
const installApplicationMenu = () => {
  const template = createApplicationMenuTemplate({
    appName: app.name || "TeX64",
    isMac: process.platform === "darwin",
    sendCommand: (command) => {
      focusMainWindow();
      sendToRenderer("app:command", { command });
    },
    locale: state.uiLocale,
  });
  if (educationService) template.push(educationService.menu());
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const sendLspToRenderer = (channel, data) => {
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
    webContents.send(channel, data);
  } catch (error) {
    const message = error && typeof error.message === "string" ? error.message : "";
    if (message.includes("Object has been destroyed")) {
      return;
    }
    console.warn("[main] sendLspToRenderer failed", error);
  }
};

const sendBuildState = (buildState, message, extra) => {
  const payload = { state: buildState };
  if (message) {
    payload.message = message;
  }
  // AI mode reads the page from the build output, so a successful build says
  // which file it wrote (workspace-relative). Code mode ignores the field.
  if (extra && typeof extra === "object") {
    Object.assign(payload, extra);
  }
  sendToRenderer("setBuildState", payload);
};

const sendIssues = (count, summary, status, issues) => {
  sendToRenderer("updateIssues", { count, summary, status, issues });
};

const sendBuildLog = (log) => {
  sendToRenderer("buildLog", { log });
};

// Which document a build actually compiles is no longer always the workspace
// root, so the renderer is told the resolved target and why it was picked; the
// status bar shows it so a surprising PDF is traceable to a file.
const sendBuildTarget = (payload) => {
  sendToRenderer("buildTarget", payload && typeof payload === "object" ? payload : {});
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
      sessionSecretStorage: createWindowsSessionSecretStorage(),
    });
  }
  return platformAccessService;
};

let lastWorkspaceListingRefresh = 0;

// Edits made outside TeX64 (git checkout, a script, another editor) are pushed
// to the renderer, which reloads clean buffers in place and flags dirty ones.
// A create/delete also refreshes the file tree, which previously only updated
// when the workspace was reopened.
const workspaceWatcher = new WorkspaceWatcher({
  onChanges: (changes) => {
    const rootPath = workspace.getRootPath();
    if (!rootPath) {
      return;
    }
    sendToRenderer("workspaceChanged", { changes });
    // A create, delete or rename changes the tree; a plain content edit does
    // not. The kinds are indistinguishable from a raw watch event, so the
    // listing is refreshed on any change but no more than twice a second —
    // enough to feel live without walking the project on every keystroke a
    // background tool makes.
    const now = Date.now();
    if (now - lastWorkspaceListingRefresh >= 500) {
      lastWorkspaceListingRefresh = now;
      void workspaceHandlers.sendWorkspace(rootPath).catch(() => {});
    }
  },
});

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
  fileAccess: macFileAccess,
  workspaceWatcher,
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
  sendBuildTarget,
  sendToRenderer,
  ensureWorkspace: workspaceHandlers.ensureWorkspace,
  updateWorkspaceIfNeeded: workspaceHandlers.updateWorkspaceIfNeeded,
  handleOpenFile: workspaceHandlers.handleOpenFile,
  state,
  delay,
});

const clearWorkspaceSession = ({ closePdfWindow = false } = {}) => {
  buildHandlers.handleBuildCancel();
  workspaceWatcher.stop();
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
  getUiLocale: () => state.uiLocale,
  sendToRenderer,
  blocksStore,
  apiUsageService: getApiUsageService(),
  platformService: getPlatformAccessService(),
  ensureProtocolClient: distributionRuntime.registerCustomProtocol
    ? registerProtocolClient
    : null,
  runtimeInfo: {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    userDataPath: app.getPath("userData"),
    packaged: app.isPackaged === true,
    windowsStore: distributionRuntime.windowsStore,
  },
});

const agentHandlers = createAgentHandlers({
  agentService,
  ensureUserSettings,
  sendToRenderer,
  platformService: getPlatformAccessService(),
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
  if (!distributionRuntime.registerCustomProtocol) {
    return false;
  }
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("tex64", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
    return true;
  }
  app.setAsDefaultProtocolClient("tex64");
  return true;
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
  installApplicationMenu();
  if (educationService) educationService.startup();
  if (distributionRuntime.registerCustomProtocol && !educationService) {
    registerProtocolClient();
  }
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
    if (app.isPackaged === true) {
      const triggerProductActivity = () => {
        if (!BrowserWindow.getFocusedWindow()) return;
        Promise.resolve(
          getPlatformAccessService().recordActivity({
            version: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            distribution: distributionRuntime.windowsStore
              ? "microsoft-store"
              : "direct",
          })
        ).catch(() => {});
      };
      setTimeout(triggerProductActivity, 0);
      setInterval(() => {
        if (BrowserWindow.getFocusedWindow()) {
          triggerProductActivity();
        }
      }, 60 * 60 * 1000);
      app.on("browser-window-focus", triggerProductActivity);
    }
    if (distributionRuntime.useIndependentUpdater) {
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
    const triggerAnnouncementsCheck = () => {
      Promise.resolve(miscHandlers.handleAnnouncementsCheck()).catch(() => {});
    };
    setTimeout(() => {
      triggerAnnouncementsCheck();
    }, 5_000);
    setInterval(() => {
      triggerAnnouncementsCheck();
    }, 6 * 60 * 60 * 1000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (texlabService) {
    texlabService.shutdown();
  }
  if (texizeService) {
    texizeService.shutdown();
  }
  if (tdomEngineService) {
    tdomEngineService.shutdown();
  }
  clearWorkspaceSession({ closePdfWindow: true });
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (texlabService) {
    texlabService.shutdown();
  }
  if (texizeService) {
    texizeService.shutdown();
  }
  if (tdomEngineService) {
    tdomEngineService.shutdown();
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

registerTexizeHandlers({ ipcMain, getTexizeService, workspace });
registerTdomEngineHandlers({ ipcMain, getTdomEngineService, getPdfWindowManager: () => pdfWindowManager });
registerAiWebHandlers({ ipcMain, shell, getAiWebService });

// AI-mode webview guests: window.open / target=_blank goes to the system
// browser, never to a new in-app window.
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });
});
ipcMain.handle("tex64:files:read-text", async (_event, payload) => {
  try {
    const relativePath = typeof payload?.path === "string" ? payload.path : "";
    if (!relativePath) throw new Error("A workspace path is required.");
    const data = await workspace.readFile(relativePath);
    if (data.byteLength > 2 * 1024 * 1024) throw new Error("File exceeds the 2 MiB text limit.");
    return { ok: true, text: data.toString("utf8") };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});
ipcMain.handle("tex64:files:write-base64", async (_event, payload) => {
  try {
    const relativePath = typeof payload?.path === "string" ? payload.path : "";
    const data = typeof payload?.data === "string" ? payload.data : "";
    if (!relativePath || !data) throw new Error("A workspace path and image data are required.");
    if (!workspace.getRootPath()) throw new Error("No workspace is selected.");
    await workspace.writeBinaryFile(relativePath, Buffer.from(data, "base64"));
    return { ok: true, path: relativePath };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});
ipcMain.handle("tex64:ai:complete", async (_event, payload) => agentHandlers.handleStashComplete(payload));

// LSP transport: the renderer owns the LSP client; main just relays JSON-RPC
// to/from texlab over stdio. Outgoing messages are fire-and-forget; replies and
// server notifications come back on the "tex64:lsp:message" channel.
ipcMain.on("tex64:lsp:send", (_event, message) => {
  if (!message || typeof message !== "object") {
    return;
  }
  getTexlabService().send(message);
});

ipcMain.handle("tex64:lsp:status", async () => {
  const service = getTexlabService();
  return { available: service.isAvailable(), running: service.isRunning() };
});

// Source control: every operation runs the machine's own `git` against the open
// workspace. Nothing is cached here — the renderer asks for a fresh status after
// each action, which is also what keeps it correct when the user works in a
// terminal at the same time.
const gitService = new GitService({ getRootPath: () => workspace.getRootPath() });

const gitOperations = {
  status: () => gitService.status(),
  branches: () => gitService.branches(),
  diff: (payload) => gitService.diff(payload?.path, { staged: payload?.staged === true }),
  stage: (payload) => gitService.stage(payload?.paths),
  stageAll: () => gitService.stageAll(),
  unstage: (payload) => gitService.unstage(payload?.paths),
  discard: (payload) => gitService.discard(payload?.paths),
  commit: (payload) => gitService.commit(payload?.message, { amend: payload?.amend === true }),
  fetch: () => gitService.fetch(),
  pull: () => gitService.pull(),
  push: (payload) =>
    gitService.push({ setUpstream: payload?.setUpstream === true, branch: payload?.branch }),
  checkout: (payload) => gitService.checkout(payload?.branch, { create: payload?.create === true }),
  init: () => gitService.init(),
};

ipcMain.handle("tex64:git:invoke", async (_event, message) => {
  const op = message && typeof message === "object" ? message.op : null;
  const handler = typeof op === "string" ? gitOperations[op] : null;
  if (!handler) {
    return { ok: false, error: `Unknown git operation: ${op}` };
  }
  try {
    const result = await handler(message.payload ?? {});
    // The git helpers return execFile output; the renderer only needs the
    // outcome and whatever git said about it.
    return {
      ok: result?.ok !== false,
      ...result,
      stdout: typeof result?.stdout === "string" ? result.stdout.slice(0, 20000) : undefined,
      stderr: undefined,
    };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : "git failed" };
  }
});

// Snippets: user-managed macro templates, stored per user and per workspace.
let snippetsService = null;
const getSnippetsService = () => {
  if (!snippetsService) {
    snippetsService = new SnippetsService({
      userDataPath: app.getPath("userData"),
      getRootPath: () => workspace.getRootPath(),
    });
  }
  return snippetsService;
};

ipcMain.handle("tex64:snippets:list", async () => {
  try {
    return await getSnippetsService().list();
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : "snippets failed" };
  }
});

ipcMain.handle("tex64:snippets:save", async (_event, snippet) => {
  try {
    return await getSnippetsService().save(snippet);
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : "snippets failed" };
  }
});

ipcMain.handle("tex64:snippets:remove", async (_event, message) => {
  try {
    return await getSnippetsService().remove(message?.id, message?.scope);
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : "snippets failed" };
  }
});

// Integrated terminal: the renderer owns the xterm UI and drives sessions by id.
// Output and exit stream back on the "tex64:terminal:data" / ":exit" channels.
ipcMain.handle("tex64:terminal:create", async (_event, options) => {
  const opts = options && typeof options === "object" ? options : {};
  try {
    const rootPath = workspace.getRootPath() || undefined;
    // "Open terminal here" in the file tree passes a workspace-relative folder;
    // anything pointing outside the workspace falls back to its root.
    let cwd = rootPath;
    if (rootPath && typeof opts.cwd === "string" && opts.cwd.trim()) {
      const candidate = path.resolve(rootPath, opts.cwd.trim());
      const rootResolved = path.resolve(rootPath);
      if (candidate === rootResolved || candidate.startsWith(rootResolved + path.sep)) {
        const stat = fs.existsSync(candidate) ? fs.statSync(candidate) : null;
        cwd = stat ? (stat.isDirectory() ? candidate : path.dirname(candidate)) : rootPath;
      }
    }
    return getTerminalService().create({ cols: opts.cols, rows: opts.rows, cwd });
  } catch (error) {
    console.warn("[terminal] create failed", error);
    return { error: error && error.message ? error.message : "terminal create failed" };
  }
});

// A terminal in its own window: same pty sessions, a window the user can move
// to another display and keep next to the editor.
ipcMain.handle("tex64:terminal:openWindow", async (_event, options) => {
  const opts = options && typeof options === "object" ? options : {};
  try {
    const win = new BrowserWindow({
      width: 760,
      height: 420,
      title: "TeX64 Terminal",
      backgroundColor: opts.theme === "light" ? "#f8fafc" : "#0e1116",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "terminal-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    terminalWindows.add(win);
    win.on("closed", () => {
      terminalWindows.delete(win);
    });
    const theme = opts.theme === "light" ? "light" : "dark";
    // app.getAppPath() is what the main window uses; inside the packaged
    // bundle __dirname sits in app.asar/electron and would need a "..".
    await win.loadFile(path.join(app.getAppPath(), "Resources", "web", "terminal-window.html"), {
      search: `theme=${theme}`,
    });
    win.show();
    return { ok: true };
  } catch (error) {
    console.warn("[terminal] window failed", error);
    return { error: error && error.message ? error.message : "terminal window failed" };
  }
});

ipcMain.on("tex64:terminal:write", (_event, message) => {
  if (!message || typeof message !== "object") {
    return;
  }
  getTerminalService().write(message.id, message.data);
});

ipcMain.on("tex64:terminal:resize", (_event, message) => {
  if (!message || typeof message !== "object") {
    return;
  }
  getTerminalService().resize(message.id, message.cols, message.rows);
});

ipcMain.on("tex64:terminal:kill", (_event, message) => {
  if (!message || typeof message !== "object") {
    return;
  }
  getTerminalService().kill(message.id);
});

let billingCheckoutWindow = null;
let billingCheckoutRequestInFlight = false;

// The production API currently returns hosted Checkout sessions. Keep the
// payment inside TeX64, then report the Stripe return URL back to the renderer
// so it can refresh the user's entitlement without guessing that they paid.
const openBillingCheckoutWindow = ({ url, plan, sender }) => {
  if (billingCheckoutWindow && !billingCheckoutWindow.isDestroyed()) {
    billingCheckoutWindow.focus();
    return billingCheckoutWindow;
  }

  const parent =
    state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : undefined;
  const checkoutWebPreferences = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    partition: "persist:tex64-billing",
  };
  const win = new BrowserWindow({
    width: 560,
    height: 760,
    show: !e2eHeadless,
    parent,
    title: "TeX64 — Checkout",
    backgroundColor: "#1c2129",
    webPreferences: checkoutWebPreferences,
  });
  billingCheckoutWindow = win;

  const billingSession = win.webContents.session;
  billingSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  billingSession.setPermissionCheckHandler(() => false);
  win.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    try {
      if (new URL(popupUrl).protocol !== "https:") {
        return { action: "deny" };
      }
    } catch {
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        parent: win,
        title: "TeX64 — Secure Checkout",
        webPreferences: { ...checkoutWebPreferences },
      },
    };
  });

  let outcome = "closed";
  const captureReturn = (event, targetUrl) => {
    const navigationUrl =
      event && typeof event.url === "string" && event.url ? event.url : targetUrl;
    const nextOutcome = getCheckoutReturnOutcome(navigationUrl);
    if (!nextOutcome) {
      try {
        if (new URL(navigationUrl).protocol !== "https:") {
          event.preventDefault();
        }
      } catch {
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    outcome = nextOutcome;
    if (!win.isDestroyed()) {
      win.close();
    }
  };
  win.webContents.on("will-navigate", captureReturn);
  win.webContents.on("will-redirect", captureReturn);
  win.on("closed", () => {
    if (billingCheckoutWindow === win) {
      billingCheckoutWindow = null;
    }
    const target =
      sender && !sender.isDestroyed()
        ? sender
        : state.mainWindow && !state.mainWindow.isDestroyed()
          ? state.mainWindow.webContents
          : null;
    if (target && !target.isDestroyed()) {
      try {
        target.send("tex64:billing:checkout-closed", { plan, outcome });
      } catch {
        // The main window may have closed between the guard and send.
      }
    }
  });
  win.loadURL(url).catch(() => {
    if (outcome === "closed") {
      outcome = "error";
    }
    if (!win.isDestroyed()) {
      win.close();
    }
  });
  return win;
};

// Open the Stripe Customer Portal (hosted-only) in an in-app child window and
// explicitly tell the renderer to refresh entitlement + usage when it closes.
const openBillingPortalWindow = ({ url, sender }) => {
  const parent =
    state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : undefined;
  const win = new BrowserWindow({
    width: 480,
    height: 760,
    parent,
    title: "TeX64",
    backgroundColor: "#1c2129",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:tex64-billing",
    },
  });
  const billingSession = win.webContents.session;
  billingSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  billingSession.setPermissionCheckHandler(() => false);
  win.on("closed", () => {
    const target =
      sender && !sender.isDestroyed()
        ? sender
        : state.mainWindow && !state.mainWindow.isDestroyed()
          ? state.mainWindow.webContents
          : null;
    if (target && !target.isDestroyed()) {
      try {
        target.send("tex64:billing:portal-closed");
      } catch {
        // The main window may have closed between the guard and send.
      }
    }
  });
  win.loadURL(url).catch(() => {
    if (!win.isDestroyed()) {
      win.close();
    }
  });
  return win;
};

ipcMain.handle("tex64:billing:checkout", async (event, payload) => {
  const plan = payload && typeof payload === "object" ? payload.plan : undefined;
  if (billingCheckoutWindow && !billingCheckoutWindow.isDestroyed()) {
    billingCheckoutWindow.focus();
    return { hosted: true, uiMode: "hosted" };
  }
  if (billingCheckoutRequestInFlight) {
    return {
      error: "checkout already in progress",
      code: "BILLING_CHECKOUT_IN_PROGRESS",
    };
  }
  billingCheckoutRequestInFlight = true;
  try {
    const checkout = await getPlatformAccessService().createBillingCheckout(plan);
    const checkoutUrl = normalizeStripeCheckoutUrl(checkout.checkoutUrl);
    if (checkoutUrl) {
      openBillingCheckoutWindow({ url: checkoutUrl, plan, sender: event.sender });
      return { hosted: true, uiMode: "hosted", sessionId: checkout.sessionId };
    }
    return {
      error: "checkout unavailable",
      code: "BILLING_CHECKOUT_UNAVAILABLE",
    };
  } catch (error) {
    return {
      error: error && error.message ? error.message : "checkout failed",
      code: error && error.code ? error.code : undefined,
    };
  } finally {
    billingCheckoutRequestInFlight = false;
  }
});

ipcMain.handle("tex64:billing:portal", async (event) => {
  try {
    const { portalUrl } = await getPlatformAccessService().createBillingPortal();
    if (!portalUrl || !/^https:\/\//i.test(portalUrl)) {
      return { error: "portal unavailable" };
    }
    openBillingPortalWindow({ url: portalUrl, sender: event.sender });
    return { ok: true };
  } catch (error) {
    return {
      error: error && error.message ? error.message : "portal failed",
      code: error && error.code ? error.code : undefined,
    };
  }
});

ipcMain.handle("tex64:spell:check", async (_event, request) => {
  try {
    const words = Array.isArray(request) ? request : request?.words;
    const locale = Array.isArray(request) ? "en" : request?.locale;
    return await getSpellService().check(words, locale);
  } catch (error) {
    console.warn("[spell] check failed", error);
    return [];
  }
});

ipcMain.handle("tex64:spell:suggest", async (_event, request) => {
  try {
    const word = typeof request === "string" ? request : request?.word;
    const locale = typeof request === "string" ? "en" : request?.locale;
    return await getSpellService().suggest(word, locale);
  } catch {
    return [];
  }
});

ipcMain.handle("tex64:spell:add", async (_event, request) => {
  try {
    const word = typeof request === "string" ? request : request?.word;
    const locale = typeof request === "string" ? "en" : request?.locale;
    return await getSpellService().addWord(word, locale);
  } catch {
    return false;
  }
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
  if (type === "uiLocale") {
    // The renderer pushes its language setting on startup and on every change,
    // so native surfaces (dialogs, menu, notifications) can follow the in-app
    // language instead of the OS locale.
    if (typeof message.locale === "string" && message.locale) {
      const previous = state.uiLocale;
      state.uiLocale = message.locale;
      if (previous !== state.uiLocale) {
        installApplicationMenu();
      }
    }
    return;
  }
  // Answers "what is open?" without touching it. openWorkspace/requestWorkspace
  // both raise a folder picker, so a surface that only wants to know — the AI
  // mode, created long after the project was opened — needs its own question.
  if (type === "workspace:state:get") {
    const currentRoot = workspace.getRootPath();
    if (currentRoot) {
      workspaceHandlers.updateWorkspaceIfNeeded(currentRoot, true);
    } else {
      sendToRenderer("updateWorkspace", {
        rootName: null,
        rootPath: null,
        files: [],
        folders: [],
      });
    }
    return;
  }
  if (type === "openWorkspace" || type === "requestWorkspace") {
    workspaceHandlers.handleOpenWorkspace(message);
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
    workspaceHandlers.handleCreateProject(message);
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
  if (type === "live-preview:source") {
    handleLivePreviewSource(message);
    return;
  }
  if (type === "build") {
    // targetFile (AI mode) builds exactly that document; mainFile (Code mode)
    // keeps deferring to the workspace's designated root.
    const exactTarget =
      typeof message.targetFile === "string" && message.targetFile.trim() !== "";
    buildHandlers.handleBuild(exactTarget ? message.targetFile : message.mainFile, {
      format: message.format,
      formatSettings: message.formatSettings,
      engine: message.engine,
      pdfViewerMode: message.pdfViewerMode,
      exactTarget,
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
  if (type === "file:bytes") {
    workspaceHandlers.handleFileBytes(message.requestId, message.path);
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
  if (type === "file:replaceLines") {
    void workspaceHandlers
      .handleReplaceLines(message.requestId, message.path, {
        startLine: message.startLine,
        endLine: message.endLine,
        expectedText: message.expectedText,
        replacementText: message.replacementText,
      })
      .then((outcome) => {
        // The page must follow the paragraph that just changed. Rebuilding
        // here, off the write itself, cannot be lost the way a second
        // build request from the guest can.
        if (outcome && outcome.ok === true) {
          // The edited file's own document builds — its folder's main.tex
          // when it has one, the workspace root otherwise.
          const editedPath = typeof message.path === "string" ? message.path : "";
          const folder = editedPath.includes("/")
            ? editedPath.slice(0, editedPath.lastIndexOf("/"))
            : "";
          const candidate = folder ? `${folder}/main.tex` : null;
          const rootPath = workspaceHandlers.ensureWorkspace();
          const documentMain =
            candidate && rootPath && fs.existsSync(path.join(rootPath, candidate))
              ? candidate
              : null;
          return buildHandlers.handleBuild(documentMain ?? undefined, {
            pdfViewerMode: "none",
            exactTarget: documentMain !== null,
          });
        }
        return undefined;
      });
    return;
  }
  if (type === "document:create") {
    workspaceHandlers.handleDocumentCreate(message.requestId, message.title);
    return;
  }
  if (type === "document:list") {
    workspaceHandlers.handleDocumentList(message.requestId);
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
  if (type === "reloadFile") {
    void workspaceHandlers.handleReloadFile(message.path);
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
  if (type === "announcements:check") {
    miscHandlers.handleAnnouncementsCheck();
    return;
  }
  if (type === "announcement:dismiss") {
    miscHandlers.handleAnnouncementDismiss(message);
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
  if (type === "env:detect") {
    miscHandlers.handleEnvDetect({ force: message.force === true });
    return;
  }
  if (type === "env:install") {
    miscHandlers.handleEnvInstall(message.target, message.variant);
    return;
  }

});

ipcMain.on("tex64:pdf", (event, message) => {
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
  if (type === "live-surface-ready") {
    pdfWindowManager.markLiveReady(message.payload ?? {}, event.sender);
    return;
  }
  if (type === "live-error-surface-ready") {
    pdfWindowManager.markLiveErrorReady(message.payload ?? {}, event.sender);
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
    return;
  }
  if (type === "live-source") {
    handleLivePreviewSource(message.payload);
    return;
  }
  if (type === "live-edit") {
    handleLivePreviewEdit(message.payload);
  }
});

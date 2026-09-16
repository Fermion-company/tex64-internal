const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  protocol,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Notification,
  utilityProcess,
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
const {
  WorkspaceWriterCoordinator,
} = require("./services/workspace-writer-coordinator.cjs");
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
const { WorkspaceFileWatcher } = require("./services/workspace-file-watcher.cjs");
const { AgentService } = require("./services/agent.cjs");
const { AgentAuditService } = require("./services/agent-audit.cjs");
const { AgentSessionsService } = require("./services/agent-sessions.cjs");
const {
  flushAgentSessionsForQuit,
} = require("./services/agent-quit-flush.cjs");
const {
  createQuitCoordinator,
} = require("./services/quit-coordinator.cjs");
const { ApiUsageService } = require("./services/api-usage.cjs");
const { PlatformAccessService } = require("./services/platform-access.cjs");
const {
  resolveDistributionRuntime,
} = require("./services/distribution-runtime.cjs");
const {
  getCheckoutReturnOutcome,
  normalizeStripeCheckoutUrl,
  parseBillingCompletionDeepLink,
} = require("./services/billing-checkout.cjs");
const { createWorkspaceHandlers } = require("./handlers/workspace.cjs");
const { createBuildHandlers } = require("./handlers/build.cjs");
const { registerTexizeHandlers } = require("./handlers/texize.cjs");
const { registerTdomEngineHandlers } = require("./handlers/tdom-engine.cjs");
const { registerAiWebHandlers } = require("./handlers/ai-web.cjs");
const { AiWebService } = require("./services/ai-web.cjs");
const {
  hardenAiWebviewPreferences,
  isAllowedAiWebviewSource,
  secureAiWebviewContents,
} = require("./services/ai-web-security.cjs");

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
let mainRendererReady = false;
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
let historyController = null;
let gitController = null;
const projectBoundary = (root) => {
  const history = historyController?.boundary(root) || null;
  const git = gitController?.boundary?.(root) || null;
  return git ? JSON.stringify([history, git]) : history;
};
const { HistoryController } = require("./services/history-controller.cjs");
const { WorkspaceOperationCoordinator } = require("./services/workspace-operation.cjs");
const workspaceOperations = new WorkspaceOperationCoordinator();
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
const { TerminalWindow } = require("./services/terminal-window.cjs");
const terminalWindow = new TerminalWindow({ BrowserWindow, getMainWindow: () => state.mainWindow, rootPath: () => workspace.getRootPath(), webDirectory: path.join(__dirname, "../Resources/web"), onFocusChange: () => installApplicationMenu() });
let terminalFocused = false;
let workspaceFileWatcher = null;
let workspaceTreeSignature = "";
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
    aiWebService = new AiWebService({
      app,
      utilityProcess,
      resourcesPath: process.resourcesPath,
    });
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

const getTerminalService = () => {
  if (!terminalService) {
    terminalService = new TerminalService({
      onData: (id, data) => sendLspToRenderer("tex64:terminal:data", { id, data }),
      onExit: (id, exitCode, signal) =>
        sendLspToRenderer("tex64:terminal:exit", { id, exitCode, signal }),
    });
  }
  return terminalService;
};

let allowMainWindowClose = false;
let mainWindowClosePromise = null;

// AI mode is held back from the general release: a packaged build shows only
// Code unless TEX64_AI_MODE_ENABLED=1; development shows both unless it is 0.
const isAiModeEnabled = () => {
  const override = String(process.env.TEX64_AI_MODE_ENABLED ?? "").trim();
  if (override === "1") return true;
  if (override === "0") return false;
  return app.isPackaged !== true;
};

const createMainWindow = () => {
  allowMainWindowClose = false;
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
    trafficLightPosition: { x: 12, y: 8 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      additionalArguments: [`--tex64-ai-mode=${isAiModeEnabled() ? "on" : "off"}`],
      // AI mode hosts the tex64-ai web app in a <webview> guest.
      webviewTag: true,
    },
  };
  if (typeof savedBounds?.x === "number" && typeof savedBounds?.y === "number") {
    windowOptions.x = savedBounds.x;
    windowOptions.y = savedBounds.y;
  }

  state.mainWindow = new BrowserWindow(windowOptions);
  terminalFocused = false;
  mainRendererReady = false;
  state.mainWindow.webContents.on("before-input-event", (_event, input) => {
    // Native Edit/File menu accelerators run before DOM key handlers. In a
    // terminal, Ctrl+C/Z/S belong to the shell (especially on Windows).
    // Keep macOS Command shortcuts, including copy/paste, available.
    state.mainWindow?.webContents.setIgnoreMenuShortcuts(terminalFocused && input.control && !input.meta);
  });
  state.mainWindow.webContents.on(
    "did-start-navigation",
    (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) {
        mainRendererReady = false;
        terminalFocused = false;
        terminalService?.killAll();
      }
    },
  );
  state.mainWindow.webContents.on("did-finish-load", () => {
    mainRendererReady = true;
    flushPendingBillingCompletionLinks();
  });
  state.mainWindow.webContents.on("render-process-gone", () => terminalService?.killAll());

  const aiWebPreloadPath = path.join(__dirname, "ai-web-preload.cjs");
  const pendingAiWebviewUrls = [];
  state.mainWindow.webContents.on(
    "will-attach-webview",
    (event, webPreferences, params) => {
      hardenAiWebviewPreferences(webPreferences, aiWebPreloadPath);
      const expectedOrigin = getAiWebService().getNativeOrigin();
      if (
        !isAllowedAiWebviewSource(params.src, {
          packaged: app.isPackaged === true,
          expectedOrigin,
        })
      ) {
        event.preventDefault();
        return;
      }
      pendingAiWebviewUrls.push(params.src);
    },
  );
  state.mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
    const initialUrl = pendingAiWebviewUrls.shift() ?? contents.getURL();
    const secured = secureAiWebviewContents(contents, {
      initialUrl,
      packaged: app.isPackaged === true,
      expectedOrigin: getAiWebService().getNativeOrigin(),
    });
    if (!secured) contents.close();
  });

  // Persist window position and size on move/resize.
  const trackWindowBounds = () => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
    if (state.mainWindow.isMinimized() || state.mainWindow.isFullScreen()) return;
    saveWindowState(state.mainWindow.getBounds());
  };
  state.mainWindow.on("resize", trackWindowBounds);
  state.mainWindow.on("move", trackWindowBounds);

  state.mainWindow.on("close", (event) => {
    const finalQuitInProgress = ["relaunching", "exiting", "forced"].includes(
      quitCoordinator.getPhase(),
    );
    if (allowMainWindowClose || finalQuitInProgress) return;
    event.preventDefault();
    if (mainWindowClosePromise) return;
    const closingWindow = state.mainWindow;
    mainWindowClosePromise = (async () => {
      const prepared = await prepareRendererForQuit();
      if (!prepared?.ok) {
        throw new Error(prepared?.error || "The editor could not save its open files.");
      }
      await quiesceWorkspaceActivity();
      if (!closingWindow || closingWindow.isDestroyed()) return;
      allowMainWindowClose = true;
      closingWindow.close();
    })()
      .catch((error) => {
        const message = error?.message || "The window could not close safely.";
        sendIssues(1, message, "error", [{ severity: "error", message }]);
        focusMainWindow();
      })
      .finally(() => {
        mainWindowClosePromise = null;
      });
  });

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
    terminalWindow.destroy();
    state.mainWindow = null;
    mainRendererReady = false;
    if (terminalService) {
      terminalService.killAll();
    }
    clearWorkspaceSession({ closePdfWindow: true });
    allowMainWindowClose = false;
    if (state.captureShortcut) {
      globalShortcut.unregister(state.captureShortcut);
      state.captureShortcut = null;
    }
  });
};

const sendToRenderer = (type, payload) => {
  if (type === "updateWorkspace") {
    terminalWindow.workspaceChanged(payload.rootPath);
    payload.history = historyController?.status();
    payload.workspaceOperation = workspaceOperations.status();
    pdfWindowManager.setWorkspaceRoot(payload.rootPath);
    const restoreBoundary = projectBoundary(payload.rootPath);
    if (restoreBoundary) pdfWindowManager.markRestored(payload.rootPath, restoreBoundary);
    payload.pdfSourceState = pdfWindowManager.sourceStatus(payload.rootPath);
    workspaceTreeSignature = JSON.stringify([payload.files, payload.folders]);
    workspaceFileWatcher?.start(payload.rootPath, payload.workspaceGeneration);
  } else if ((type === "openFileResult" && !payload.error) ||
    (type === "saveResult" && payload.ok) ||
    (type === "agent:applyContent" && payload.updateSaved)) {
    workspaceFileWatcher?.track(payload.path, payload.savedContent ?? payload.content);
  }
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

const installApplicationMenu = () => {
  const template = createApplicationMenuTemplate({
    appName: app.name || "TeX64",
    isMac: process.platform === "darwin",
    sendCommand: (command) => {
      focusMainWindow();
      sendToRenderer("app:command", { command });
    },
    locale: state.uiLocale,
    terminalActive: Boolean(terminalWindow.window?.isFocused()),
    sendTerminalCommand: (command) => {
      const target = terminalWindow.window;
      if (!target || target.isDestroyed() || !target.isFocused()) return;
      if (command === "hide") target.hide();
      else target.webContents.send("tex64:terminal:command", command);
    },
  });
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
  if (buildState === "success") payload.pdfSourceState = pdfWindowManager.sourceStatus(workspace.getRootPath());
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
      sessionSecretStorage: createWindowsSessionSecretStorage(),
    });
  }
  return platformAccessService;
};

const workspaceChangeCoordinator = {
  beforeChange: async () => {},
};

const externalWriterCoordinator = new WorkspaceWriterCoordinator();

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
  beforeWorkspaceChange: (change) => workspaceChangeCoordinator.beforeChange(change),
  prepareHistoryWorkspace: async (rootPath) => {
    await historyController?.prepareWorkspace(rootPath);
    await gitController?.prepareWorkspace(rootPath);
  },
  beginRendererWorkspaceMutation: (rootPath) => {
    historyController?.assertWriterAllowed();
    return externalWriterCoordinator.beginRendererMutation(rootPath);
  },
});

workspaceFileWatcher = new WorkspaceFileWatcher({
  isPaused: () => Boolean(historyController?.blocked()),
  resolvePath: (file) => workspace.resolvePath(file),
  onChange: (change) => {
    if (historyController?.blocked()) return;
    if (workspace.getRootPath() !== change.root || state.workspaceGeneration !== change.generation) return;
    sendToRenderer("file:externalChange", {
      ...change, workspaceId: state.workspaceId, workspaceGeneration: change.generation,
    });
    workspaceHandlers.requestIndex(change.root);
  },
  onTree: async ({ root, generation }) => {
    if (historyController?.blocked()) { workspaceFileWatcher.treeDirty = true; return; }
    const [files, folders] = await Promise.all([workspace.listFiles(), workspace.listFolders()]);
    if (workspace.getRootPath() !== root || state.workspaceGeneration !== generation) return;
    if (historyController?.blocked()) { workspaceFileWatcher.treeDirty = true; return; }
    if (workspaceTreeSignature !== JSON.stringify([files, folders])) {
      await workspaceHandlers.updateWorkspaceIfNeeded(root, true);
    }
  },
  onError: (error) => console.warn("[workspace-watch]", error.message),
});

const agentService = new AgentService({
  workspace,
  getHistoryBoundary: projectBoundary,
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
  synctexService,
  isRendererWorkspaceMutationActive: (rootPath) =>
    Boolean(historyController?.blocked()) || externalWriterCoordinator.hasRendererMutation(rootPath),
});

externalWriterCoordinator.setAgentActiveCheck((rootPath) =>
  agentService.runningWorkspaceRoots.has(rootPath));

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

const quiesceWorkspaceActivity = async () => {
  agentService.abort();
  buildHandlers.cancelAllBuilds();
  const [agentStopped, buildStopped] = await Promise.all([
    agentService.waitForIdle(10_000),
    buildHandlers.waitForBuildIdle(10_000),
  ]);
  if (!agentStopped || !buildStopped) {
    throw new Error("The current project is still finishing work. Please try again.");
  }
  return true;
};

historyController = new HistoryController({
  workspace, state, coordinator: workspaceOperations,
  directory: () => process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, app.isPackaged ? "TeX64" : "TeX64-Dev", "history")
    : path.join(app.getPath("userData"), "history"),
  notify: sendToRenderer,
  withMutation: (operation) => workspaceHandlers.withWorkspaceMutation(operation),
  isAgentBusy: () => agentService.runningControllers.size > 0 || agentService.hasContentConflictInWorkspace(workspace.getRootPath()),
  hasTerminals: () => Boolean(terminalService?.sessions.size || terminalWindow.service?.sessions.size),
  quiesce: async () => {
    await quiesceWorkspaceActivity();
    if (tdomEngineService) {
      await tdomEngineService.pushQueue;
      const proc = tdomEngineService.proc;
      tdomEngineService.stop();
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("The live preview is still stopping. Try again.")), 10000);
          proc.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
    }
  },
  advanceGeneration: () => { state.workspaceGeneration += 1; },
  afterRestore: async () => {
    pdfWindowManager.markRestored(workspace.getRootPath(), projectBoundary(workspace.getRootPath()));
    // Keep Axiom's CAS/preflight checks. Existing proposals and undo still have
    // their original baseline; never rewrite them to match restored content.
    await workspaceHandlers.updateWorkspaceIfNeeded(workspace.getRootPath(), true);
    workspaceHandlers.requestIndex(workspace.getRootPath());
  },
});

const { GitController } = require("./services/git-controller.cjs");
gitController = new GitController({
  workspace, state, coordinator: workspaceOperations, safeStorage,
  chooseRecoveryDestination: async ({ path: relative, side }) => {
    const result = await dialog.showSaveDialog(state.mainWindow, { title: "復旧用ファイルを書き出す", defaultPath: `${side}-${path.basename(relative)}` });
    return result.canceled ? null : result.filePath;
  },
  directory: () => path.join(app.getPath("userData"), "git-protection"),
  notify: sendToRenderer,
  withMutation: (operation) => workspaceHandlers.withWorkspaceMutation(operation),
  isAgentBusy: () => agentService.runningControllers.size > 0 || agentService.hasContentConflictInWorkspace(workspace.getRootPath()),
  hasTerminals: () => Boolean(terminalService?.sessions.size || terminalWindow.service?.sessions.size),
  quiesce: () => historyController.deps.quiesce(),
  advanceGeneration: () => { state.workspaceGeneration += 1; },
  afterRestore: async (_changedPaths, { writesWorktree = true } = {}) => {
    if (writesWorktree) pdfWindowManager.markRestored(workspace.getRootPath(), projectBoundary(workspace.getRootPath()));
    await workspaceHandlers.updateWorkspaceIfNeeded(workspace.getRootPath(), true);
    workspaceHandlers.requestIndex(workspace.getRootPath());
  },
});
const gitCloneDestinations = new Map();
ipcMain.handle("tex64:git", async (event, action, request) => {
  if (event.sender !== state.mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return { ok: false, code: "INVALID_OWNER", error: "Invalid Git owner." };
  try {
    if (typeof action !== "string" || !request || typeof request !== "object" || JSON.stringify(request).length > 16 * 1024 * 1024) throw new Error("Invalid Git request.");
    if (action === "choose-clone-destination") {
      gitController.validate(request);
      const name = request.name;
      if (typeof name !== "string" || !name || name.length > 160 || /[\\/\0]/.test(name) || name === "." || name === "..") throw new Error("新しいフォルダ名を入力してください。");
      const selected = await dialog.showOpenDialog(state.mainWindow, { title: "取得先の親フォルダを選択", properties: ["openDirectory", "createDirectory"] });
      if (selected.canceled || !selected.filePaths[0]) return { ok: true, canceled: true };
      gitController.validate(request);
      const destination = path.join(selected.filePaths[0], name);
      const id = require("node:crypto").randomUUID(); gitCloneDestinations.clear();
      gitCloneDestinations.set(id, { destination, workspaceId: request.workspaceId });
      return { ok: true, destinationId: id, destination };
    }
    if (action === "clone") {
      const target = gitCloneDestinations.get(request.args?.destinationId);
      if (!target || target.workspaceId !== request.workspaceId) throw new Error("取得先を選び直してください。");
      gitCloneDestinations.delete(request.args.destinationId);
      request = { ...request, args: { url: request.args.url, destination: target.destination } };
    }
    return { ok: true, ...await gitController.request(action, request) };
  } catch (error) { return { ok: false, code: error.code || "GIT_ERROR", error: error.message }; }
});

workspaceOperations.subscribe((operation) => sendToRenderer("workspace:operation", {
  ...operation, workspaceId: state.workspaceId, workspaceGeneration: state.workspaceGeneration,
}));

const { SnippetStore } = require("./services/snippets.cjs");
let snippetStore;
ipcMain.handle("tex64:snippets", async (event, action, request = {}) => {
  if (event.sender !== state.mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return { ok: false, error: "Invalid snippet owner." };
  try {
    snippetStore ||= new SnippetStore(app.getPath("userData"));
    const data = action === "list" ? await snippetStore.read() : await snippetStore.change(action, request);
    return { ok: true, ...data };
  } catch (error) { return { ok: false, code: error.code, error: error.message }; }
});

ipcMain.handle("tex64:history", async (event, action, request) => {
  if (event.sender !== state.mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return { ok: false, code: "INVALID_OWNER", error: "Invalid history owner." };
  try {
    if (!request || typeof request !== "object" || JSON.stringify(request).length > 16 * 1024 * 1024) throw new Error("History request is too large.");
    const result = await historyController.request(action, request);
    return { ok: true, ...(result || {}) };
  } catch (error) { return { ok: false, code: error.code || "HISTORY_ERROR", error: error.message }; }
});

workspaceChangeCoordinator.beforeChange = async (change = {}) => {
  await quiesceWorkspaceActivity();
  if (
    typeof change.fromRootPath === "string" &&
    change.fromRootPath &&
    agentService.hasContentConflictInWorkspace(change.fromRootPath)
  ) {
    throw new Error(
      "Resolve the Axiom edit conflict before switching projects.",
    );
  }
};

const clearWorkspaceSession = ({ closePdfWindow = false } = {}) => {
  workspaceFileWatcher?.stop();
  agentService.abort();
  buildHandlers.cancelAllBuilds();
  agentService.discardContentConflictsForWorkspace(workspace.getRootPath());
  workspace.setRootPath(null);
  state.workspaceGeneration =
    (Number.isSafeInteger(state.workspaceGeneration) ? state.workspaceGeneration : 0) + 1;
  state.workspaceId = null;
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
const pendingBillingCompletionPayloads = [];

const canDeliverBillingCompletion = () => {
  const mainWindow = state.mainWindow;
  return Boolean(
    app.isReady() &&
      mainRendererReady &&
      mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.webContents &&
      !mainWindow.webContents.isDestroyed(),
  );
};

const deliverBillingCompletion = (payload) => {
  if (!canDeliverBillingCompletion()) {
    return false;
  }
  focusMainWindow();
  sendToRenderer("billing:checkoutClosed", payload);
  return true;
};

const queueBillingCompletionDeepLink = (value) => {
  const payload = parseBillingCompletionDeepLink(value);
  if (!payload) {
    return false;
  }
  if (!deliverBillingCompletion(payload)) {
    pendingBillingCompletionPayloads.push(payload);
  }
  return true;
};

const flushPendingBillingCompletionLinks = () => {
  if (!canDeliverBillingCompletion()) {
    return;
  }
  while (pendingBillingCompletionPayloads.length > 0) {
    const payload = pendingBillingCompletionPayloads.shift();
    if (payload) {
      deliverBillingCompletion(payload);
    }
  }
};

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
      const protocolArgs = Array.isArray(argv)
        ? argv.filter(
            (arg) =>
              looksLikeOAuthCallbackUrl(arg) ||
              Boolean(parseBillingCompletionDeepLink(arg)),
          )
        : [];
      if (protocolArgs.length > 0) {
        focusMainWindow();
        protocolArgs.forEach((arg) => {
          if (!queueBillingCompletionDeepLink(arg)) {
            queueOAuthCallbackUrl(arg);
          }
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
  if (!queueBillingCompletionDeepLink(url)) {
    queueOAuthCallbackUrl(url);
  }
});

// The AI mode's webview fetches the workspace PDF through this scheme: a
// streamed file read scoped to the open workspace, instead of base64 bytes
// copied through the message bridge. Registered before the app is ready so
// fetch() from the page may use it.
const WORKSPACE_PDF_SCHEME = "tex64-pdf";
protocol.registerSchemesAsPrivileged([
  {
    scheme: WORKSPACE_PDF_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

const handleWorkspacePdfRequest = async (request) => {
  const deny = (status, message) =>
    new Response(message, { status, headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" } });
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return deny(400, "Bad request.");
  }
  if (url.host !== "workspace") return deny(404, "Not found.");
  const rootPath = workspace.getRootPath();
  if (!rootPath) return deny(409, "No workspace is open.");
  const requestedWorkspaceId = url.searchParams.get("workspaceId");
  if (!requestedWorkspaceId || requestedWorkspaceId !== state.workspaceId) {
    return deny(409, "The workspace changed.");
  }
  const generation = Number.parseInt(url.searchParams.get("workspaceGeneration") ?? "", 10);
  if (!Number.isSafeInteger(generation) || generation !== state.workspaceGeneration) {
    return deny(409, "The workspace changed.");
  }
  let relativePath;
  try {
    relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return deny(400, "Bad path.");
  }
  if (!relativePath || !relativePath.toLowerCase().endsWith(".pdf") || relativePath.includes("\0")) {
    return deny(403, "Only a workspace PDF can be read here.");
  }
  let realPath;
  try {
    const rootReal = fs.realpathSync(rootPath);
    realPath = fs.realpathSync(workspace.resolvePath(relativePath));
    const relative = path.relative(rootReal, realPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      return deny(403, "The file is outside the workspace.");
    }
  } catch {
    return deny(404, "Not found.");
  }
  let stats;
  try {
    stats = fs.statSync(realPath);
  } catch {
    return deny(404, "Not found.");
  }
  if (!stats.isFile()) return deny(404, "Not found.");
  const { Readable } = require("stream");
  const stream = Readable.toWeb(fs.createReadStream(realPath));
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(stats.size),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
};

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }
  protocol.handle(WORKSPACE_PDF_SCHEME, handleWorkspacePdfRequest);
  runStartupWebBuildIfNeeded();
  createMainWindow();
  installApplicationMenu();
  if (distributionRuntime.registerCustomProtocol) {
    registerProtocolClient();
  }
  while (pendingOAuthCallbackUrls.length > 0) {
    const url = pendingOAuthCallbackUrls.shift();
    if (url) {
      miscHandlers.handleAuthGoogleCallback(url).catch(() => {});
    }
  }
  process.argv.forEach((arg) => {
    if (!queueBillingCompletionDeepLink(arg)) {
      queueOAuthCallbackUrl(arg);
    }
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

let quitPreparationSequence = 0;
let pendingRendererQuitPreparation = null;

const settleRendererQuitPreparation = (pending, result) => {
  if (!pending || pendingRendererQuitPreparation !== pending) return false;
  pendingRendererQuitPreparation = null;
  try {
    pending.webContents.removeListener("destroyed", pending.onDestroyed);
  } catch {
    // A renderer that disappeared while quitting has no listener to remove.
  }
  pending.resolve(result);
  return true;
};

const prepareRendererForQuit = () => {
  if (pendingRendererQuitPreparation) {
    return pendingRendererQuitPreparation.promise;
  }
  const mainWindow = state.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve({ ok: true });
  }
  const webContents = mainWindow.webContents;
  if (!webContents || webContents.isDestroyed()) {
    return Promise.resolve({ ok: true });
  }

  const requestId = `quit:${process.pid}:${++quitPreparationSequence}`;
  let resolvePreparation;
  const promise = new Promise((resolve) => {
    resolvePreparation = resolve;
  });
  const pending = {
    requestId,
    webContents,
    promise,
    resolve: resolvePreparation,
    onDestroyed: null,
  };
  pending.onDestroyed = () => {
    settleRendererQuitPreparation(pending, {
      ok: false,
      error: "The editor closed before its files were saved.",
    });
  };
  pendingRendererQuitPreparation = pending;
  webContents.once("destroyed", pending.onDestroyed);
  try {
    webContents.send("tex64:message", {
      type: "prepareQuit",
      payload: { requestId },
    });
  } catch (error) {
    settleRendererQuitPreparation(pending, {
      ok: false,
      error: error?.message ?? "Could not ask the editor to save its files.",
    });
  }
  return promise;
};

const acceptRendererQuitPreparation = (event, message) => {
  const pending = pendingRendererQuitPreparation;
  if (
    !pending ||
    event.sender !== pending.webContents ||
    message.requestId !== pending.requestId
  ) {
    return false;
  }
  return settleRendererQuitPreparation(pending, {
    ok: message.ok === true,
    error: typeof message.error === "string" ? message.error : undefined,
  });
};

const shutdownQuitServices = () => {
  const steps = [
    ["agent", () => agentService.abort()],
    ["build", () => buildHandlers.cancelAllBuilds()],
    ["terminal", () => terminalService?.killAll()],
    ["terminal-window", () => terminalWindow.destroy()],
    ["pdf", () => pdfWindowManager.close?.()],
    ["ai-web", () => aiWebService?.shutdown?.()],
    ["texlab", () => texlabService?.shutdown?.()],
    ["texize", () => texizeService?.shutdown?.()],
    ["tdom", () => tdomEngineService?.shutdown?.()],
  ];
  for (const [name, stop] of steps) {
    try {
      stop();
    } catch (error) {
      console.warn(`[quit] ${name} shutdown failed:`, error?.message ?? error);
    }
  }
};

const quitCoordinator = createQuitCoordinator({
  prepareRenderer: prepareRendererForQuit,
  flushAgent: () => flushAgentSessionsForQuit(agentService),
  teardown: shutdownQuitServices,
  requestQuit: () => app.quit(),
  forceExit: (code) => app.exit(code),
  // Native save acknowledgements already have bounded waits. Do not race them
  // with a second timer: a late renderer success could otherwise freeze the UI
  // after this coordinator had canceled the quit attempt.
  prepareTimeoutMs: null,
  forceExitTimeoutMs: 1_000,
  onError: (error, stage) => {
    console.warn(`[quit] ${stage} failed:`, error?.message ?? error);
    if (stage === "prepare-renderer") focusMainWindow();
  },
});

app.on("before-quit", (event) => {
  quitCoordinator.handleBeforeQuit(event);
});
app.on("will-quit", () => {
  quitCoordinator.handleWillQuit();
});
app.on("quit", () => {
  quitCoordinator.handleQuit();
});

app.on("window-all-closed", () => {
  const finalQuitInProgress = ["relaunching", "exiting", "forced"].includes(
    quitCoordinator.getPhase(),
  );
  if (!finalQuitInProgress) {
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
  }
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

registerTexizeHandlers({ ipcMain, getTexizeService, workspace });
registerTdomEngineHandlers({ ipcMain, getTdomEngineService, isBlocked: () => historyController?.blocked() });
registerAiWebHandlers({ ipcMain, shell, getAiWebService });
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
    const rootPath = workspace.getRootPath();
    if (!rootPath) throw new Error("No workspace is selected.");
    await workspaceHandlers.withWorkspaceMutation(async () => {
      if (workspace.getRootPath() !== rootPath) {
        throw new Error("The workspace changed before the file was saved.");
      }
      await workspace.writeBinaryFile(relativePath, Buffer.from(data, "base64"));
    });
    return { ok: true, path: relativePath };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});
ipcMain.handle("tex64:ai:complete", async (_event, payload) => agentHandlers.handleStashComplete(payload));
ipcMain.handle("tex64:agent:quiesce", async () => {
  try {
    await quiesceWorkspaceActivity();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

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

// Integrated terminal: the renderer owns the xterm UI and drives sessions by id.
// Output and exit stream back on the "tex64:terminal:data" / ":exit" channels.
ipcMain.on("tex64:terminal:focus", (event, focused) => {
  if (!(event.sender === state.mainWindow?.webContents && event.senderFrame === event.sender.mainFrame) && !terminalWindow.owns(event)) return;
  if (terminalWindow.owns(event)) return;
  terminalFocused = focused === true;
  if (!terminalFocused) event.sender.setIgnoreMenuShortcuts(false);
});
ipcMain.handle("tex64:terminal:create", async (event, options) => {
  if (!(event.sender === state.mainWindow?.webContents && event.senderFrame === event.sender.mainFrame) && !terminalWindow.owns(event)) return { error: "Invalid terminal owner." };
  const opts = options && typeof options === "object" ? options : {};
  try {
    historyController?.assertWriterAllowed();
    const cwd = typeof opts.cwd === "string" && workspace.getRootPath()
      ? workspace.resolvePath(opts.cwd)
      : workspace.getRootPath() || undefined;
    return (terminalWindow.owns(event) ? terminalWindow.service : getTerminalService()).create({ cols: opts.cols, rows: opts.rows, cwd });
  } catch (error) {
    console.warn("[terminal] create failed", error);
    return { error: error && error.message ? error.message : "terminal create failed" };
  }
});

ipcMain.on("tex64:terminal:write", (event, message) => {
  if (!(event.sender === state.mainWindow?.webContents && event.senderFrame === event.sender.mainFrame) && !terminalWindow.owns(event)) return;
  if (!message || typeof message !== "object") {
    return;
  }
  if (historyController?.blocked()) return;
  (terminalWindow.owns(event) ? terminalWindow.service : getTerminalService()).write(message.id, message.data);
});

ipcMain.on("tex64:terminal:resize", (event, message) => {
  if (!(event.sender === state.mainWindow?.webContents && event.senderFrame === event.sender.mainFrame) && !terminalWindow.owns(event)) return;
  if (!message || typeof message !== "object") {
    return;
  }
  (terminalWindow.owns(event) ? terminalWindow.service : getTerminalService()).resize(message.id, message.cols, message.rows);
});

ipcMain.on("tex64:terminal:kill", (event, message) => {
  if (!(event.sender === state.mainWindow?.webContents && event.senderFrame === event.sender.mainFrame) && !terminalWindow.owns(event)) return;
  if (!message || typeof message !== "object") {
    return;
  }
  (terminalWindow.owns(event) ? terminalWindow.service : getTerminalService()).kill(message.id);
});

ipcMain.handle("tex64:terminal:window", (event) => {
  if (event.sender !== state.mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return { error: "Invalid terminal owner." };
  if (historyController?.blocked()) return { error: "Finish the history operation before opening a terminal." };
  terminalWindow.open(); return { ok: true };
});

let billingCheckoutWindow = null;
let billingCheckoutRequestInFlight = false;

// The production API currently returns hosted Checkout sessions. Keep the
// payment inside TeX64, then report the Stripe return URL back to the renderer
// so it can refresh the user's entitlement without guessing that they paid.
const openBillingCheckoutWindow = ({ url, plan }) => {
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
    // Use the app's normal host -> renderer bus. Unlike a listener installed
    // directly on ipcRenderer by the preload, this survives renderer reloads
    // and is initialized through the same bridge as plan/usage updates.
    sendToRenderer("billing:checkoutClosed", { plan, outcome });
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

ipcMain.handle("tex64:billing:checkout", async (_event, payload) => {
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
      openBillingCheckoutWindow({ url: checkoutUrl, plan });
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

const AI_MODE_CONVERSATION_PREFIX = "tex64-ai-mode:";
const validateAiModeTurn = (message) => {
  const conversationId =
    typeof message?.conversationId === "string" ? message.conversationId : "";
  if (!conversationId.startsWith(AI_MODE_CONVERSATION_PREFIX)) {
    return { ok: true, context: message?.context };
  }
  const rootPath = workspace.getRootPath();
  const workspaceId =
    typeof message.workspaceId === "string" ? message.workspaceId.trim() : "";
  const documentMainFile =
    typeof message.documentMainFile === "string"
      ? message.documentMainFile.trim().replace(/\\/g, "/").replace(/^\.\/+/, "")
      : "";
  const generationMatches =
    Number.isSafeInteger(message.workspaceGeneration) &&
    message.workspaceGeneration === state.workspaceGeneration;
  if (
    !rootPath ||
    !workspaceId ||
    workspaceId !== state.workspaceId ||
    !generationMatches ||
    !documentMainFile ||
    !documentMainFile.toLowerCase().endsWith(".tex")
  ) {
    return { ok: false };
  }
  const expectedConversationId = `${AI_MODE_CONVERSATION_PREFIX}${encodeURIComponent(
    workspaceId
  )}:${encodeURIComponent(documentMainFile)}`;
  if (conversationId !== expectedConversationId) {
    return { ok: false };
  }
  const resolved = path.resolve(rootPath, documentMainFile);
  const relative = path.relative(rootPath, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false };
  }
  return {
    ok: true,
    context: {
      ...(message.context && typeof message.context === "object"
        ? message.context
        : {}),
      activeFilePath: documentMainFile,
      workspaceRoot: rootPath,
      workspaceId,
      workspaceGeneration: state.workspaceGeneration,
      documentMainFile,
      // The AI mode speaks the app's language; status copy follows it.
      ...(typeof state.uiLocale === "string" && state.uiLocale
        ? { uiLocale: state.uiLocale }
        : {}),
    },
  };
};

const handleRendererMessage = (event, message) => {
  if (!message || typeof message !== "object") {
    return;
  }
  const { type } = message;
  if (!type) {
    return;
  }
  if (type === "prepareQuit:result") {
    acceptRendererQuitPreparation(event, message);
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
        workspaceGeneration:
          Number.isSafeInteger(state.workspaceGeneration) ? state.workspaceGeneration : 0,
        workspaceId: null,
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
  if (type === "synctex:forwardBatch") {
    buildHandlers.handleSynctexForwardBatch(message);
    return;
  }
  if (type === "synctex:reverse") {
    buildHandlers.handleSynctexReverse(message);
    return;
  }
  if (type === "build") {
    // targetFile (AI mode) builds exactly that document; mainFile (Code mode)
    // resolves the active file's document, including magic roots and chapters.
    const exactTarget =
      typeof message.targetFile === "string" && message.targetFile.trim() !== "";
    buildHandlers.handleBuild(exactTarget ? message.targetFile : message.mainFile, {
      format: message.format,
      formatSettings: message.formatSettings,
      engine: message.engine,
      pdfViewerMode: message.pdfViewerMode,
      exactTarget,
      requestId: message.requestId,
      workspaceGeneration: message.workspaceGeneration,
      workspaceId: message.workspaceId,
      documentMainFile: message.documentMainFile,
      queueIfBusy: message.queueIfBusy === true,
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
      workspaceGeneration: message.workspaceGeneration,
      workspaceId: message.workspaceId,
      documentMainFile: message.documentMainFile,
    });
    return;
  }
  if (type === "file:importAttachment") {
    workspaceHandlers.handleImportAttachment(message.requestId, {
      name: message.name,
      data: message.data,
      workspaceGeneration: message.workspaceGeneration,
      workspaceId: message.workspaceId,
      documentMainFile: message.documentMainFile,
    });
    return;
  }
  if (type === "file:exportPdf") {
    void workspaceHandlers.handleExportPdf(message.requestId, message.path, {
      workspaceGeneration: message.workspaceGeneration,
      workspaceId: message.workspaceId,
      documentMainFile: message.documentMainFile,
    });
    return;
  }
  if (type === "file:bytes") {
    workspaceHandlers.handleFileBytes(message.requestId, message.path, {
      workspaceGeneration: message.workspaceGeneration,
      workspaceId: message.workspaceId,
      documentMainFile: message.documentMainFile,
    });
    return;
  }
  if (type === "saveFile") {
    workspaceHandlers.handleSaveFile(message.path, message.content, {
      workspaceId: message.workspaceId,
      workspaceGeneration: message.workspaceGeneration,
      format: message.format,
      expectedContent: message.expectedContent,
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
        expectedContentHash: message.expectedContentHash,
        workspaceGeneration: message.workspaceGeneration,
        workspaceId: message.workspaceId,
        documentMainFile: message.documentMainFile,
        conversationId: message.conversationId,
      })
      .then((outcome) => {
        // The page must follow the paragraph that just changed. Rebuilding
        // here, off the write itself, cannot be lost the way a second
        // build request from the guest can.
        if (outcome && outcome.ok === true) {
          if (
            typeof outcome.previousContent === "string" &&
            typeof message.path === "string" &&
            message.path
          ) {
            agentService.pushUndoEntry({
              type: "write",
              conversationId:
                typeof outcome.conversationId === "string" && outcome.conversationId
                  ? outcome.conversationId
                  : "tex64-ai-direct-edit",
              runId: `direct:${message.requestId || Date.now()}`,
              path: message.path,
              existed: true,
              previousBuffer: Buffer.from(outcome.previousContent, "utf8"),
              wasBinary: false,
              appliedHash: outcome.contentHash,
              workspaceRootPath: outcome.workspaceRootPath,
            });
          }
          const documentMain =
            typeof outcome.documentMainFile === "string" && outcome.documentMainFile
              ? outcome.documentMainFile
              : undefined;
          return buildHandlers.handleBuild(documentMain, {
            pdfViewerMode: "none",
            exactTarget: Boolean(documentMain),
            requestId: `${message.requestId || "direct-edit"}:build`,
            workspaceGeneration: message.workspaceGeneration,
            workspaceId: message.workspaceId,
            documentMainFile: documentMain,
            queueIfBusy: true,
          });
        }
        return undefined;
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
  if (type === "agent:model:get") {
    agentHandlers.handleAgentModelGet();
    return;
  }
  if (type === "agent:model:set") {
    agentHandlers.handleAgentModelSet(message.model);
    return;
  }
  if (type === "agent:state:get") {
    agentHandlers.handleAgentStateGet(message.requestId, message.conversationId);
    return;
  }
  if (type === "agent:run") {
    const turn = validateAiModeTurn(message);
    if (!turn.ok) {
      sendToRenderer("agent:error", {
        conversationId: message.conversationId,
        message: "The workspace changed. Retry in the document now open.",
      });
      agentService.sendStatus(
        "error",
        "The workspace changed.",
        message.conversationId,
      );
      return;
    }
    agentHandlers.handleAgentRun(
      message.message,
      turn.context,
      message.conversationId,
      message.parts,
      () => validateAiModeTurn(message).ok,
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
  if (type === "agent:contentConflict") {
    agentHandlers.handleAgentContentConflict(message.conversationId, message.path);
    return;
  }
  if (type === "agent:contentConflictResolved") {
    agentHandlers.handleAgentContentConflictResolved(message.conversationId, message.path);
    return;
  }
  if (type === "agent:apply") {
    agentHandlers.handleAgentApply(message.proposalId);
    return;
  }
  if (type === "agent:applyBatch") {
    agentHandlers.handleAgentApplyBatch(message.proposalIds);
    return;
  }
  if (type === "agent:proposal:dismiss") {
    agentHandlers.handleAgentProposalDismiss(message.proposalId);
    return;
  }
  if (type === "agent:undoLastRunApply") {
    agentHandlers.handleAgentUndoLastRunApply(
      message.conversationId,
      message.requestId
    );
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
  if (type === "agent:feedback") {
    agentHandlers.handleAgentFeedback(message);
    return;
  }
  if (type === "agent:branch") {
    agentHandlers.handleAgentBranch(message);
    return;
  }
  if (type === "agent:transcribe") {
    agentHandlers.handleAgentTranscribe(message);
    return;
  }
  if (type === "agent:documentMap:get") {
    agentHandlers.handleAgentDocumentMapGet(message);
    return;
  }
  if (type === "agent:rules:open") {
    agentHandlers.handleAgentRulesOpen();
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

};

ipcMain.on("tex64", (event, message) => {
  if (workspaceOperations.blocked()) {
    const lease = workspaceOperations.current;
    const token = lease.owner === "git" ? message?.gitToken : message?.historyToken;
    const allowedFlush = message?.type === "saveFile" && token === lease.operation.id && lease.operation.phase === "saving";
    const safe = (message?.type === "openFile" && lease.operation.phase === "syncing") || ["ready", "prepareQuit:result", "uiLocale", "build:cancel", "agent:stop", "settings:response", "agent:contentConflict"].includes(message?.type);
    if (!allowedFlush && !safe) {
      if (message?.type === "saveFile") sendToRenderer("saveResult", { ok: false, path: message.path, error: "A project operation is protecting this workspace. Your edits remain open." });
      return;
    }
    return workspaceOperations.run(allowedFlush ? token : null, () => handleRendererMessage(event, message));
  }
  // Never replay a delayed flush after its operation finished.
  if (message?.historyToken || message?.gitToken) {
    if (message.type === "saveFile") sendToRenderer("saveResult", { ok: false, path: message.path, error: "This project save has expired. Save again." });
    return;
  }
  handleRendererMessage(event, message);
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
    return;
  }
  if (type === "ask-axiom") {
    const payload = message.payload ?? {};
    const source =
      payload.source && typeof payload.source.file === "string" && Number.isFinite(payload.source.line)
        ? { file: payload.source.file, line: payload.source.line, column: Number.isFinite(payload.source.column) ? payload.source.column : 1 }
        : null;
    sendToRenderer("pdf:askAxiom", {
      page: payload.page,
      x: payload.x,
      y: payload.y,
      text: typeof payload.text === "string" ? payload.text.slice(0, 2000) : "",
      pdfPath: typeof payload.path === "string" ? payload.path : null,
      ...(source ? { source } : {}),
    });
    return;
  }
});

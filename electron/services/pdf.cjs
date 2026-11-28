const { BrowserWindow, app } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { PdfSourceState } = require("./pdf-source-state.cjs");

const isE2EContext =
  process.env.TEX64_E2E === "1" ||
  (typeof process.env.TEX64_E2E_USERDATA === "string" &&
    process.env.TEX64_E2E_USERDATA.trim().length > 0);
const e2eHeadless =
  isE2EContext && process.env.TEX64_E2E_FORCE_HEADLESS !== "0";

const PDF_WINDOW_STATE_FILE = "tex64-pdf-window-state.json";
let pdfStateSaveTimer = null;

const loadPdfWindowState = () => {
  try {
    const filePath = path.join(app.getPath("userData"), PDF_WINDOW_STATE_FILE);
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && typeof parsed.width === "number") {
      return parsed;
    }
  } catch {
    // No saved state.
  }
  return null;
};

const savePdfWindowState = (bounds) => {
  if (pdfStateSaveTimer) clearTimeout(pdfStateSaveTimer);
  pdfStateSaveTimer = setTimeout(() => {
    pdfStateSaveTimer = null;
    try {
      const filePath = path.join(app.getPath("userData"), PDF_WINDOW_STATE_FILE);
      fs.writeFileSync(filePath, JSON.stringify(bounds, null, 2), "utf8");
    } catch {
      // Non-critical.
    }
  }, 500);
};

class PDFWindowManager {
  constructor(onLiveIssue = () => {}) {
    this.onLiveIssue = onLiveIssue;
    this.liveIssue = null;
    this.window = null;
    this.workspaceRoot = null;
    this.currentRoot = null;
    this.sourceState = null;
    this.currentPath = null;
    this.isReady = false;
    this.pendingOpen = null;
    this.automaticPreview = false;
    this.unbuiltPath = null;
    this.pendingSync = null;
    this.pendingBuildState = null;
    this.livePreview = null;
    this.fallbackPreview = null;
    this.pendingLiveAnchors = new Map();
    this.nextLiveAnchorId = 0;
  }

  getSourceState() {
    this.sourceState ||= new PdfSourceState(path.join(app.getPath("userData"), "pdf-source-state"));
    return this.sourceState;
  }

  sourceStatus(rootPath) { return this.getSourceState().status(rootPath); }
  setWorkspaceRoot(rootPath) {
    const nextRoot = rootPath ? path.resolve(rootPath) : null;
    if (nextRoot !== this.workspaceRoot) {
      this.setLiveIssue(null);
      this.closeUnbuiltWindow();
      this.automaticPreview = false;
      this.livePreview = null;
      this.setFallbackPreview(null);
      this.pendingLiveAnchors.clear();
    }
    this.workspaceRoot = nextRoot;
    this.flushLivePreview();
  }
  notifySourceState() {
    if (!this.isReady || !this.currentPath) return;
    this.send("source-state", {
      path: this.currentPath,
      needsRebuild: this.getSourceState().needsRebuild(this.currentRoot, this.currentPath),
    });
  }
  markRestored(rootPath, restoreBoundary = null) {
    const unchanged = restoreBoundary && this.getSourceState().status(rootPath).restoreBoundary === restoreBoundary;
    const value = this.getSourceState().restored(rootPath, restoreBoundary);
    if (!unchanged) this.notifySourceState();
    return value;
  }
  markBuilt(rootPath, pdfPath) {
    if (this.fallbackPreview?.root === rootPath && this.fallbackPreview.pdfPath === pdfPath) this.setFallbackPreview(null);
    const value = this.getSourceState().built(rootPath, pdfPath);
    this.notifySourceState();
    return value;
  }

  close() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
      return;
    }
    this.window = null;
    this.currentPath = null;
    this.isReady = false;
    this.pendingOpen = null;
    this.unbuiltPath = null;
    this.pendingSync = null;
    this.pendingBuildState = null;
    this.pendingLiveAnchors.clear();
  }

  closeUnbuiltWindow() {
    if (this.unbuiltPath && this.currentPath === this.unbuiltPath) this.close();
    this.unbuiltPath = null;
  }

  openUnbuiltWindow(pdfPath) {
    // Both candidates have already been validated by the preview IPC.
    const target = this.livePreview?.target;
    const fallback = this.fallbackPreview;
    const matches = (target?.workspaceRoot === this.workspaceRoot && target.pdfPath === pdfPath) ||
      (fallback?.root === this.workspaceRoot && fallback.pdfPath === pdfPath);
    if (this.window && !this.window.isDestroyed() && !this.automaticPreview) return false;
    let saved = false;
    if (fs.existsSync(pdfPath)) {
      if (!this.workspaceRoot || !/\.pdf$/i.test(pdfPath)) return false;
      try {
        const rel = path.relative(fs.realpathSync(this.workspaceRoot), fs.realpathSync(pdfPath));
        const stat = fs.statSync(pdfPath);
        if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel) || !stat.isFile()) return false;
        saved = stat.size > 0;
      } catch { return false; }
    } else if (!matches) return false;
    this.show(pdfPath, { unbuilt: !saved, inactive: true, automaticPreview: true });
    return true;
  }

  show(pdfPath, options = {}) {
    this.automaticPreview = options.automaticPreview === true;
    this.unbuiltPath = options.unbuilt ? pdfPath : null;
    this.ensureWindow();
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    const reload = options?.reload !== false;
    const needsOpen = reload || !this.isReady || this.currentPath !== pdfPath;
    if (this.currentPath !== pdfPath) this.setLiveIssue(null);
    this.currentPath = pdfPath;
    this.currentRoot = this.workspaceRoot;
    if (needsOpen) {
      this.pendingOpen = pdfPath;
      if (this.isReady) {
        this.flushOpen();
      }
    }
    this.flushLivePreview();
    if (this.window && !this.window.isDestroyed()) {
      this.window.setTitle(path.basename(pdfPath));
      if (!e2eHeadless) {
        if (options.inactive || options.unbuilt) this.window.showInactive();
        else { this.window.show(); this.window.focus(); }
      }
    }
  }

  send(type, payload) {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    const webContents = this.window.webContents;
    if (!webContents || (typeof webContents.isDestroyed === "function" && webContents.isDestroyed())) {
      return;
    }
    try {
      webContents.send("tex64:pdf-message", { type, payload });
    } catch (error) {
      const msg = error && typeof error.message === "string" ? error.message : "";
      if (!msg.includes("Object has been destroyed")) {
        console.warn("[pdf] send failed:", error);
      }
    }
  }

  setBuildState(state, message, pdfPath) {
    this.pendingBuildState = { state, message, pdfPath };
    this.flushBuildState();
  }

  flushBuildState(clearMismatched = false) {
    const pending = this.pendingBuildState;
    if (!this.isReady || !this.currentPath) return;
    if (!pending || pending.pdfPath !== this.currentPath) {
      if (clearMismatched) this.send("build-state", { state: "idle" });
      return;
    }
    this.send("build-state", { state: pending.state, message: pending.message });
  }

  markReady() {
    this.isReady = true;
    this.pendingOpen ??= this.currentPath;
    this.flushOpen();
    this.notifySourceState();
    this.flushBuildState();
    this.flushLivePreview();
    if (this.pendingSync) {
      const payload = this.pendingSync;
      this.pendingSync = null;
      this.send("sync", payload);
    }
  }

  queueSync(payload) {
    if (!this.isReady) {
      this.pendingSync = payload;
      return;
    }
    this.send("sync", payload);
  }

  flushOpen() {
    if (!this.pendingOpen) {
      return;
    }
    const pdfPath = this.pendingOpen;
    this.pendingOpen = null;
    const fileUrl = pathToFileURL(pdfPath).toString();
    const cacheBust = `?t=${Date.now()}`;
    const preview = this.fallbackPreview;
    this.send("open", { path: pdfPath,
      previewGeneration: preview?.root === this.currentRoot && preview?.pdfPath === pdfPath ? preview.generation : undefined,
      url: this.unbuiltPath === pdfPath ? undefined : `${fileUrl}${cacheBust}`,
      needsRebuild: this.getSourceState().needsRebuild(this.currentRoot, pdfPath) });
    if (this.fallbackPreview) this.setFallbackPreview(this.fallbackPreview);
    this.flushBuildState(true);
    this.flushLivePreview();
  }

  ownsSender(sender) {
    if (!this.window || this.window.isDestroyed()) return false;
    return sender === this.window.webContents;
  }

  setFallbackPreview(preview) {
    const previous = this.fallbackPreview;
    this.fallbackPreview = preview;
    if (!this.isReady || !this.currentPath) return;
    const matches = (value) => value?.root === this.currentRoot && value.pdfPath === this.currentPath;
    if (matches(preview) || matches(previous)) {
      this.send("preview-open", matches(preview) ? { path: this.currentPath, data: preview.data, url: preview.url, generation: preview.generation } : null);
    }
  }

  matchingLivePreview() {
    const preview = this.livePreview;
    if (!preview || !this.currentPath || !this.currentRoot) return null;
    if (path.resolve(preview.target.workspaceRoot) !== path.resolve(this.currentRoot)) return null;
    const targetPath = path.isAbsolute(preview.target.pdfPath)
      ? path.resolve(preview.target.pdfPath)
      : path.resolve(preview.target.workspaceRoot, preview.target.pdfPath);
    return targetPath === path.resolve(this.currentPath) ? preview : null;
  }

  setLiveIssue(message) {
    if (this.liveIssue === message) return;
    this.liveIssue = message;
    this.onLiveIssue(message);
  }

  setLivePreview(preview) {
    if (!preview || preview.hold || preview.generation !== this.livePreview?.generation ||
        preview.url !== this.livePreview?.url || preview.target?.pdfPath !== this.livePreview?.target?.pdfPath) {
      this.setLiveIssue(null);
    }
    this.livePreview = preview || null;
    this.pendingLiveAnchors.clear();
    this.flushLivePreview();
  }

  flushLivePreview() {
    if (!this.isReady) return;
    this.send("live", this.matchingLivePreview());
  }

  acceptsLiveEvents() {
    return Boolean(this.matchingLivePreview());
  }

  beginLiveAnchor(payload) {
    if (!this.acceptsLiveEvents() || !payload || typeof payload !== "object") return null;
    const windowRequestId = `pdf-live-anchor-${Date.now().toString(36)}-${(++this.nextLiveAnchorId).toString(36)}`;
    this.pendingLiveAnchors.set(windowRequestId, {
      requestId: payload.requestId,
      activationId: payload.activationId,
      documentEpoch: payload.documentEpoch,
      sessionId: payload.sessionId,
      file: payload.file,
      sourceRev: payload.sourceRev,
    });
    while (this.pendingLiveAnchors.size > 64) {
      this.pendingLiveAnchors.delete(this.pendingLiveAnchors.keys().next().value);
    }
    return { windowRequestId, request: payload };
  }

  replyLiveAnchor(payload) {
    const windowRequestId = typeof payload?.windowRequestId === "string" ? payload.windowRequestId : "";
    const pending = this.pendingLiveAnchors.get(windowRequestId);
    if (!pending) return false;
    this.pendingLiveAnchors.delete(windowRequestId);
    const result = payload?.result;
    if (!this.acceptsLiveEvents() || !result || typeof result !== "object" ||
        result.requestId !== pending.requestId || result.activationId !== pending.activationId ||
        result.documentEpoch !== pending.documentEpoch || result.sessionId !== pending.sessionId ||
        result.file !== pending.file || result.sourceRev !== pending.sourceRev) return false;
    this.send("live-edit-anchor-result", result);
    return true;
  }

  ensureWindow() {
    if (this.window && !this.window.isDestroyed()) {
      return;
    }
    const viewerPath = path.resolve(
      __dirname,
      "..",
      "..",
      "Resources",
      "web",
      "pdf-viewer.html"
    );
    const preloadPath = path.resolve(__dirname, "..", "pdf-preload.cjs");
    const saved = isE2EContext ? null : loadPdfWindowState();
    const windowOptions = {
      width: saved?.width ?? 960,
      height: saved?.height ?? 720,
      // show() decides when the surface appears. Creating a hidden window
      // avoids an editor-focus flash during load.
      show: false,
      title: "PDF",
      backgroundColor: "#1c2129",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: preloadPath,
      },
    };
    if (typeof saved?.x === "number" && typeof saved?.y === "number") {
      windowOptions.x = saved.x;
      windowOptions.y = saved.y;
    }
    this.window = new BrowserWindow(windowOptions);

    const trackBounds = () => {
      if (!this.window || this.window.isDestroyed()) return;
      if (this.window.isMinimized() || this.window.isFullScreen()) return;
      savePdfWindowState(this.window.getBounds());
    };
    this.window.on("resize", trackBounds);
    this.window.on("move", trackBounds);

    this.window.loadFile(viewerPath).catch((error) => {
      console.warn("[pdf] Failed to load PDF viewer:", error);
    });
    this.window.on("closed", () => {
      this.setLiveIssue(null);
      this.unbuiltPath = null;
      this.window = null;
      this.currentPath = null;
      this.isReady = false;
      this.pendingOpen = null;
      this.pendingSync = null;
      this.pendingBuildState = null;
      this.pendingLiveAnchors.clear();
    });
  }
}

module.exports = {
  PDFWindowManager,
};

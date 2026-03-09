const { BrowserWindow, app } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

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
  constructor() {
    this.window = null;
    this.currentPath = null;
    this.isReady = false;
    this.pendingOpen = null;
    this.pendingSync = null;
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
    this.pendingSync = null;
  }

  show(pdfPath, options = {}) {
    this.ensureWindow();
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    const reload = options?.reload !== false;
    const needsOpen = reload || !this.isReady || this.currentPath !== pdfPath;
    this.currentPath = pdfPath;
    if (needsOpen) {
      this.pendingOpen = pdfPath;
      if (this.isReady) {
        this.flushOpen();
      }
    }
    if (this.window && !this.window.isDestroyed()) {
      this.window.setTitle(path.basename(pdfPath));
      if (!e2eHeadless) {
        this.window.show();
        this.window.focus();
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

  markReady() {
    this.isReady = true;
    this.flushOpen();
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
    this.send("open", { path: pdfPath, url: `${fileUrl}${cacheBust}` });
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
      show: !e2eHeadless,
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
      this.window = null;
      this.currentPath = null;
      this.isReady = false;
      this.pendingOpen = null;
      this.pendingSync = null;
    });
  }
}

module.exports = {
  PDFWindowManager,
};

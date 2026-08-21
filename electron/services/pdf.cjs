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
    // Real-time preview: while set, the viewer swaps its page canvas for the
    // live engine frame. Kept across window close/reopen so a re-shown
    // window comes back live.
    this.liveUrl = null;
    this.liveGeneration = 0;
    this.liveError = null;
    this.pendingLiveShow = null;
    this.committedLiveSurface = null;
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
    this.pendingLiveShow = null;
    this.committedLiveSurface = null;
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
        this.setWindowInputTransparent(false);
        this.setWindowOpacity(1);
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
    // A renderer navigation discards the previously committed compositor
    // surface even when the engine URL/generation did not change.
    this.committedLiveSurface = null;
    this.flushOpen();
    if (this.pendingSync) {
      const payload = this.pendingSync;
      this.pendingSync = null;
      this.send("sync", payload);
    }
    if (this.liveUrl || this.liveError) {
      this.pendingLiveShow = {
        url: this.liveUrl,
        generation: this.liveGeneration || 0,
        error: this.liveError,
      };
      if (!this.currentPath) {
        this.setWindowInputTransparent(true);
        this.setWindowOpacity(0);
      }
      this.send("live", this.liveUrl
        ? { url: this.liveUrl, generation: this.liveGeneration || 0 }
        : null);
    }
    if (this.liveError) {
      this.send("live-error", {
        error: this.liveError,
        url: this.liveUrl,
        generation: this.liveGeneration || 0,
      });
    }
  }

  setLive(url, options = {}) {
    const previousUrl = this.liveUrl;
    const hasErrorOption = Object.hasOwn(options, "error");
    this.liveUrl = typeof url === "string" && url ? url : null;
    this.liveGeneration = Number(options.generation) || 0;
    if (hasErrorOption) {
      this.liveError = typeof options.error === "string" && options.error ? options.error : null;
    } else if (previousUrl !== this.liveUrl || !this.liveUrl) {
      this.liveError = null;
    }
    const committedLiveMatches = Boolean(
      this.committedLiveSurface &&
      this.committedLiveSurface.url === this.liveUrl &&
      this.committedLiveSurface.generation === this.liveGeneration
    );
    if (!committedLiveMatches) this.committedLiveSurface = null;

    if (!this.liveUrl && !this.liveError) {
      this.pendingLiveShow = null;
      this.committedLiveSurface = null;
      const shouldHide = Boolean(
        (options?.hide === true || !this.currentPath) &&
        this.window &&
        !this.window.isDestroyed()
      );
      // Hide first. Restoring opacity on a transparent staging window before
      // the native hide reaches the compositor can flash its uncommitted
      // backing store for one frame.
      if (shouldHide) this.window.hide();
      this.setWindowInputTransparent(false);
      this.setWindowOpacity(1);
    }
    if ((this.liveUrl || this.liveError) && options?.show === true) {
      this.ensureWindow();
      if (this.window && !this.window.isDestroyed()) {
        this.window.setTitle("Live Preview");
        if (!e2eHeadless) {
          if (committedLiveMatches) {
            // A transient error (or its recovery) can reuse the already
            // committed last-good Live surface. Only its toolbar text changes.
            this.pendingLiveShow = null;
            this.setWindowInputTransparent(false);
            this.setWindowOpacity(1);
            this.showWindowInactive();
          } else {
            this.pendingLiveShow = {
              url: this.liveUrl,
              generation: this.liveGeneration,
              error: this.liveError,
            };
            if (this.currentPath) {
              // A real static PDF is a valid cover while Live or a terminal
              // error surface stages.
              this.setWindowInputTransparent(false);
              this.setWindowOpacity(1);
              this.showWindowInactive();
            } else {
              this.setWindowInputTransparent(true);
              if (this.setWindowOpacity(0)) {
                // Warm Chromium and let the hidden iframe cross its two-paint
                // barrier without exposing an empty native window.
                this.showWindowInactive();
              } else {
                this.setWindowInputTransparent(false);
              }
            }
          }
        }
      }
    }
    if (this.isReady) {
      this.send("live", this.liveUrl ? { url: this.liveUrl, generation: this.liveGeneration } : null);
      if (this.liveError || hasErrorOption) {
        this.send("live-error", {
          error: this.liveError,
          url: this.liveUrl,
          generation: this.liveGeneration,
        });
      }
    }
  }

  setWindowOpacity(value) {
    if (!this.window || this.window.isDestroyed() || typeof this.window.setOpacity !== "function") {
      return false;
    }
    try {
      this.window.setOpacity(value);
      return true;
    } catch {
      return false;
    }
  }

  setWindowInputTransparent(enabled) {
    if (!this.window || this.window.isDestroyed() || typeof this.window.setIgnoreMouseEvents !== "function") return;
    try { this.window.setIgnoreMouseEvents(enabled === true); } catch { /* unsupported platform */ }
  }

  showWindowInactive() {
    if (!this.window || this.window.isDestroyed()) return;
    // Showing the preview must not steal the caret from the editor at the
    // exact moment the user enables it or starts typing.
    if (typeof this.window.showInactive === "function") this.window.showInactive();
    else this.window.show();
  }

  markLiveReady(payload = {}, sender = null) {
    if (!this.window || this.window.isDestroyed() || !this.liveUrl || !this.pendingLiveShow) return false;
    if (this.pendingLiveShow.error) return false;
    const webContents = this.window.webContents;
    if (sender && sender !== webContents) return false;
    const generation = Number(payload.generation) || 0;
    if (generation !== this.liveGeneration || generation !== this.pendingLiveShow.generation) return false;
    if (payload.url !== this.liveUrl) return false;

    this.pendingLiveShow = null;
    this.committedLiveSurface = {
      url: this.liveUrl,
      generation: this.liveGeneration,
    };
    if (!e2eHeadless) {
      this.setWindowInputTransparent(false);
      this.setWindowOpacity(1);
      this.showWindowInactive();
    }
    return true;
  }

  markLiveErrorReady(payload = {}, sender = null) {
    if (!this.window || this.window.isDestroyed() || !this.liveError || !this.pendingLiveShow?.error) return false;
    const webContents = this.window.webContents;
    if (sender && sender !== webContents) return false;
    const generation = Number(payload.generation) || 0;
    if (generation !== this.liveGeneration || generation !== this.pendingLiveShow.generation) return false;
    if ((payload.url ?? null) !== this.liveUrl || this.pendingLiveShow.url !== this.liveUrl) return false;
    if (payload.error !== this.liveError || this.pendingLiveShow.error !== this.liveError) return false;

    this.pendingLiveShow = null;
    if (!e2eHeadless) {
      this.setWindowInputTransparent(false);
      this.setWindowOpacity(1);
      this.showWindowInactive();
    }
    return true;
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
      // show() and setLive({ show:true }) decide when the surface appears.
      // Creating a hidden window avoids an editor-focus flash during load.
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

    this.window.webContents?.on?.("did-start-loading", () => {
      if ((!this.liveUrl && !this.liveError) || this.currentPath) return;
      this.committedLiveSurface = null;
      this.pendingLiveShow = {
        url: this.liveUrl,
        generation: this.liveGeneration,
        error: this.liveError,
      };
      this.setWindowInputTransparent(true);
      this.setWindowOpacity(0);
    });

    this.window.loadFile(viewerPath).catch((error) => {
      console.warn("[pdf] Failed to load PDF viewer:", error);
    });
    this.window.on("closed", () => {
      this.window = null;
      this.currentPath = null;
      this.isReady = false;
      this.pendingOpen = null;
      this.pendingSync = null;
      this.pendingLiveShow = null;
      this.committedLiveSurface = null;
    });
  }
}

module.exports = {
  PDFWindowManager,
};

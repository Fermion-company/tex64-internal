const { BrowserWindow } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

class PDFWindowManager {
  constructor() {
    this.window = null;
    this.currentPath = null;
    this.isReady = false;
    this.pendingOpen = null;
    this.pendingSync = null;
  }

  show(pdfPath) {
    this.ensureWindow();
    this.currentPath = pdfPath;
    this.pendingOpen = pdfPath;
    if (this.isReady) {
      this.flushOpen();
    }
    if (this.window) {
      this.window.setTitle(path.basename(pdfPath));
      this.window.show();
      this.window.focus();
    }
  }

  send(type, payload) {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    this.window.webContents.send("tex180:pdf-message", { type, payload });
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
    this.window = new BrowserWindow({
      width: 960,
      height: 720,
      title: "PDF",
      backgroundColor: "#1c2129",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: preloadPath,
      },
    });
    this.window.loadFile(viewerPath);
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

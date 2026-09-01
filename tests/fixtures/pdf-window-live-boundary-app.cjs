const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

if (typeof process.env.TEX64_E2E_USERDATA === "string" && process.env.TEX64_E2E_USERDATA) {
  app.setPath("userData", process.env.TEX64_E2E_USERDATA);
}

// Record the actual native ordering, rather than inferring it from the
// manager's JavaScript state. In particular, a Live-only window must have
// opacity 0 before its first showInactive call.
const nativeEvents = [];
const recordWindowState = (window, type, requestedOpacity = null) => {
  let opacity = null;
  let visible = null;
  try { opacity = window.getOpacity(); } catch { /* unsupported */ }
  try { visible = window.isVisible(); } catch { /* destroyed */ }
  nativeEvents.push({ type, requestedOpacity, opacity, visible, at: Date.now() });
};

const nativeSetOpacity = BrowserWindow.prototype.setOpacity;
BrowserWindow.prototype.setOpacity = function setOpacity(value) {
  const result = nativeSetOpacity.call(this, value);
  recordWindowState(this, "set-opacity", value);
  return result;
};
const nativeShowInactive = BrowserWindow.prototype.showInactive;
BrowserWindow.prototype.showInactive = function showInactive() {
  recordWindowState(this, "show-inactive-before");
  const result = nativeShowInactive.call(this);
  recordWindowState(this, "show-inactive-after");
  return result;
};
const nativeShow = BrowserWindow.prototype.show;
BrowserWindow.prototype.show = function show() {
  recordWindowState(this, "show-before");
  const result = nativeShow.call(this);
  recordWindowState(this, "show-after");
  return result;
};

app.whenReady().then(() => {
  const { PDFWindowManager } = require("../../electron/services/pdf.cjs");
  const manager = new PDFWindowManager();
  globalThis.__pdfBoundaryManager = manager;
  globalThis.__pdfBoundaryNativeEvents = nativeEvents;

  ipcMain.on("tex64:pdf", (event, message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      manager.markReady();
      return;
    }
    if (message.type === "live-surface-ready") {
      manager.markLiveReady(message.payload ?? {}, event.sender);
      return;
    }
    if (message.type === "live-error-surface-ready") {
      manager.markLiveErrorReady(message.payload ?? {}, event.sender);
    }
  });
});

app.on("window-all-closed", () => {
  // Playwright owns the application lifetime.
});

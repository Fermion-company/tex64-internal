"use strict";
const path = require("node:path");
const { TerminalService } = require("./terminal.cjs");

class TerminalWindow {
  constructor({ BrowserWindow, getMainWindow, rootPath, webDirectory, onFocusChange = () => {}, Service = TerminalService }) {
    Object.assign(this, { BrowserWindow, getMainWindow, rootPath, webDirectory, onFocusChange, Service });
    this.window = null;
    this.service = null;
    this.root = null;
  }
  owns(event) { return Boolean(this.window && event.sender === this.window.webContents && event.senderFrame === event.sender.mainFrame); }
  open() {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return; }
    this.root = this.rootPath();
    const window = new this.BrowserWindow({
      width: 900, height: 520, minWidth: 480, minHeight: 280, title: this.root ? `${path.basename(this.root)} — TeX64 Terminal` : "TeX64 — Terminal",
      parent: this.getMainWindow() || undefined, show: false,
      webPreferences: { preload: path.join(__dirname, "../terminal-preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    this.window = window;
    window.on("focus", () => this.onFocusChange());
    window.on("blur", () => this.onFocusChange());
    window.on("page-title-updated", (event) => event.preventDefault());
    const send = (channel, payload) => { if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload); };
    this.service = new this.Service({ onData: (id, data) => send("tex64:terminal:data", { id, data }), onExit: (id, exitCode, signal) => send("tex64:terminal:exit", { id, exitCode, signal }) });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.on("render-process-gone", () => this.destroy());
    window.on("close", (event) => { event.preventDefault(); window.hide(); });
    window.on("closed", () => { this.service?.killAll(); this.service = null; this.window = null; });
    window.once("ready-to-show", () => window.show());
    void window.loadFile(path.join(this.webDirectory, "terminal-window.html"));
  }
  workspaceChanged(root) { if (this.window && this.root !== root) this.destroy(); }
  destroy() {
    this.service?.killAll();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null; this.service = null; this.root = null;
  }
}
module.exports = { TerminalWindow };

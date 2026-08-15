"use strict";

const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");

const PROTECTED_ROOTS = Object.freeze({
  desktop: (homeDir) => path.join(homeDir, "Desktop"),
  documents: (homeDir) => path.join(homeDir, "Documents"),
  downloads: (homeDir) => path.join(homeDir, "Downloads"),
  icloud: (homeDir) => path.join(homeDir, "Library", "Mobile Documents"),
  removable: () => "/Volumes",
});

class MacFileAccessService {
  constructor({
    platform = process.platform,
    homeDir = os.homedir(),
    readdir = fsp.readdir,
    dialog = null,
    shell = null,
    getWindow = () => null,
    locale = "en",
  } = {}) {
    this.platform = platform;
    this.homeDir = homeDir;
    this.readdir = readdir;
    this.dialog = dialog;
    this.shell = shell;
    this.getWindow = getWindow;
    // A function keeps app.getLocale() out of module load, which runs before "ready".
    this.getLocale = typeof locale === "function" ? locale : () => locale;
    this.states = new Map();
    this.pending = new Map();
    this.notified = new Set();
  }

  classify(absPath) {
    if (this.platform !== "darwin" || typeof absPath !== "string" || !absPath || !path.isAbsolute(absPath)) {
      return null;
    }
    const resolved = path.resolve(absPath);
    for (const [key, makeRoot] of Object.entries(PROTECTED_ROOTS)) {
      const root = path.resolve(makeRoot(this.homeDir));
      if (resolved === root || resolved.startsWith(root + path.sep)) return { key, root };
    }
    return null;
  }

  getState(key) {
    return this.states.get(key) || "unknown";
  }

  async ensureAccess(absPathOrKey, { reason } = {}) {
    void reason;
    const classified = Object.hasOwn(PROTECTED_ROOTS, absPathOrKey)
      ? { key: absPathOrKey, root: path.resolve(PROTECTED_ROOTS[absPathOrKey](this.homeDir)) }
      : this.classify(absPathOrKey);
    if (this.platform !== "darwin" || !classified) return true;
    const { key, root } = classified;
    const state = this.getState(key);
    if (state === "granted") return true;
    if (state === "denied") return false;
    if (this.pending.has(key)) return this.pending.get(key);

    const request = (async () => {
      try {
        await this.readdir(root);
        this.states.set(key, "granted");
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") {
          this.states.set(key, "granted");
          return true;
        }
        if (error?.code === "EPERM" || error?.code === "EACCES") {
          this.states.set(key, "denied");
          await this.notifyDenied(key);
          return false;
        }
        return true;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, request);
    return request;
  }

  probeIfAllowed(absPath, probeFn) {
    const classified = this.classify(absPath);
    if (!classified || this.getState(classified.key) === "granted") return probeFn();
    return null;
  }

  async notifyDenied(key) {
    if (!this.dialog || this.notified.has(key)) return;
    this.notified.add(key);
    try {
      const japanese = String(this.getLocale()).toLowerCase().startsWith("ja");
      const buttons = japanese
        ? ["システム設定を開く", "閉じる"]
        : ["Open System Settings", "Close"];
      const root = path.resolve(PROTECTED_ROOTS[key](this.homeDir));
      const options = {
        type: "warning",
        buttons,
        defaultId: 0,
        cancelId: 1,
        message: japanese
          ? `TeX64 に ${root} へのアクセスが許可されていません。`
          : `TeX64 does not have permission to access ${root}.`,
        detail: japanese
          ? "「プライバシーとセキュリティ」→「ファイルとフォルダ」で TeX64 を有効にしてから、TeX64 を再起動してください。"
          : "Enable TeX64 under Privacy & Security → Files and Folders, then restart TeX64.",
      };
      const window = this.getWindow();
      const result = window
        ? await this.dialog.showMessageBox(window, options)
        : await this.dialog.showMessageBox(options);
      if (result?.response === 0 && this.shell?.openExternal) {
        await this.shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders");
      }
    } catch {}
  }
}

module.exports = { MacFileAccessService, PROTECTED_ROOTS };

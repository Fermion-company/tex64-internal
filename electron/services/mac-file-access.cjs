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
      const STRINGS = {
        en: {
          buttons: ["Open System Settings", "Close"],
          message: (root) => `TeX64 does not have permission to access ${root}.`,
          detail: "Enable TeX64 under Privacy & Security → Files and Folders, then restart TeX64.",
        },
        ja: {
          buttons: ["システム設定を開く", "閉じる"],
          message: (root) => `TeX64 に ${root} へのアクセスが許可されていません。`,
          detail: "「プライバシーとセキュリティ」→「ファイルとフォルダ」で TeX64 を有効にしてから、TeX64 を再起動してください。",
        },
        zh: {
          buttons: ["打开系统设置", "关闭"],
          message: (root) => `TeX64 没有访问 ${root} 的权限。`,
          detail: "请在“隐私与安全性”→“文件与文件夹”中启用 TeX64，然后重新启动 TeX64。",
        },
        ko: {
          buttons: ["시스템 설정 열기", "닫기"],
          message: (root) => `TeX64 에 ${root} 접근 권한이 없습니다.`,
          detail: "'개인정보 보호 및 보안' → '파일 및 폴더'에서 TeX64 를 활성화한 뒤 TeX64 를 다시 시작하세요.",
        },
        fr: {
          buttons: ["Ouvrir les Réglages Système", "Fermer"],
          message: (root) => `TeX64 n'a pas l'autorisation d'accéder à ${root}.`,
          detail: "Activez TeX64 dans Confidentialité et sécurité → Fichiers et dossiers, puis redémarrez TeX64.",
        },
        de: {
          buttons: ["Systemeinstellungen öffnen", "Schließen"],
          message: (root) => `TeX64 hat keine Berechtigung für den Zugriff auf ${root}.`,
          detail: "Aktivieren Sie TeX64 unter Datenschutz & Sicherheit → Dateien und Ordner und starten Sie TeX64 neu.",
        },
        es: {
          buttons: ["Abrir Ajustes del Sistema", "Cerrar"],
          message: (root) => `TeX64 no tiene permiso para acceder a ${root}.`,
          detail: "Activa TeX64 en Privacidad y seguridad → Archivos y carpetas y reinicia TeX64.",
        },
      };
      const base = String(this.getLocale()).toLowerCase().split(/[-_]/, 1)[0];
      const strings = STRINGS[base] || STRINGS.en;
      const root = path.resolve(PROTECTED_ROOTS[key](this.homeDir));
      const options = {
        type: "warning",
        buttons: strings.buttons,
        defaultId: 0,
        cancelId: 1,
        message: strings.message(root),
        detail: strings.detail,
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

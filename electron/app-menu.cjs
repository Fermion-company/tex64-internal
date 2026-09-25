"use strict";

// Custom menu items follow the in-app language (pushed from the renderer via
// the "uiLocale" message). `role:` items are localized by Electron itself from
// the OS locale — that part cannot follow the in-app setting.
const MENU_LABELS = {
  en: { settings: "Settings…", file: "File", newFile: "New File", newProject: "New Project…", openFolder: "Open Folder…", save: "Save" },
  ja: { settings: "設定…", file: "ファイル", newFile: "新規ファイル", newProject: "新規プロジェクト…", openFolder: "フォルダを開く…", save: "保存" },
  zh: { settings: "设置…", file: "文件", newFile: "新建文件", newProject: "新建项目…", openFolder: "打开文件夹…", save: "保存" },
  ko: { settings: "설정…", file: "파일", newFile: "새 파일", newProject: "새 프로젝트…", openFolder: "폴더 열기…", save: "저장" },
  fr: { settings: "Réglages…", file: "Fichier", newFile: "Nouveau fichier", newProject: "Nouveau projet…", openFolder: "Ouvrir un dossier…", save: "Enregistrer" },
  de: { settings: "Einstellungen…", file: "Datei", newFile: "Neue Datei", newProject: "Neues Projekt…", openFolder: "Ordner öffnen…", save: "Sichern" },
  es: { settings: "Ajustes…", file: "Archivo", newFile: "Nuevo archivo", newProject: "Nuevo proyecto…", openFolder: "Abrir carpeta…", save: "Guardar" },
};

const createApplicationMenuTemplate = ({
  appName = "TeX64",
  isMac = process.platform === "darwin",
  sendCommand = () => {},
  locale = "en",
  terminalActive = false,
  sendTerminalCommand = () => {},
} = {}) => {
  const labels = MENU_LABELS[locale] || MENU_LABELS.en;
  const commandItem = (label, command, accelerator) => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => sendCommand(command),
  });

  const template = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        commandItem(labels.settings, "settings:open", "CmdOrCtrl+,"),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: labels.file,
      submenu: [
        commandItem(labels.newFile, "file:new", "CmdOrCtrl+N"),
        { type: "separator" },
        commandItem(labels.newProject, "project:new", "CmdOrCtrl+Shift+N"),
        commandItem(labels.openFolder, "project:open", "CmdOrCtrl+O"),
        { type: "separator" },
        commandItem(labels.save, "file:save", "CmdOrCtrl+S"),
        { type: "separator" },
        { role: isMac ? "close" : "quit" },
      ],
    },
    { role: "editMenu", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" },
      { type: "separator" }, commandItem(locale === "ja" ? "検索…" : "Find…", "edit:find", "CmdOrCtrl+F"),
      commandItem(locale === "ja" ? "スニペット…" : "Snippets…", "snippets:open"),
    ] },
    { role: "viewMenu" },
    { label: locale === "ja" ? "ターミナル" : "Terminal", submenu: [
      { label: locale === "ja" ? "シェルを再起動…" : "Restart shell…", enabled: terminalActive, click: () => sendTerminalCommand("restart") },
      { label: locale === "ja" ? "ウインドウを隠す（実行は継続）" : "Hide window (keep running)", enabled: terminalActive, click: () => sendTerminalCommand("hide") },
    ] },
    { role: "windowMenu" }
  );

  return template;
};

module.exports = { createApplicationMenuTemplate };

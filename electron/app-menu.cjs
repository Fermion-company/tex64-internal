"use strict";

// Custom menu items follow the in-app language (pushed from the renderer via
// the "uiLocale" message). `role:` items are localized by Electron itself from
// the OS locale — that part cannot follow the in-app setting.
const MENU_LABELS = {
  en: { math: "Math", captureFormula: "Capture Formula from Screen…", settings: "Settings…", file: "File", newWindow: "New Window", newFile: "New File", newProject: "New Project…", openFolder: "Open Folder…", save: "Save", importPrism: "Import from Prism…", collaborate: "Collaborate…", wordCount: "Word Count…", undo: "Undo", redo: "Redo", find: "Find…", snippets: "Snippets…", terminal: "Terminal", restartShell: "Restart shell…", hideTerminal: "Hide window (keep running)" },
  ja: { math: "数式", captureFormula: "画面から数式を取り込む…", settings: "設定…", file: "ファイル", newWindow: "新規ウインドウ", closeWindow: "ウインドウを閉じる", newFile: "新規ファイル", newProject: "新規プロジェクト…", openFolder: "フォルダを開く…", save: "保存", importPrism: "Prism から読み込む…", collaborate: "共同編集…", wordCount: "文字数…", undo: "取り消す", redo: "やり直す", find: "検索…", snippets: "スニペット…", terminal: "ターミナル", restartShell: "シェルを再起動…", hideTerminal: "ウインドウを隠す（実行は継続）" },
  zh: { math: "数学", captureFormula: "从屏幕导入公式…", settings: "设置…", file: "文件", newWindow: "新建窗口", newFile: "新建文件", newProject: "新建项目…", openFolder: "打开文件夹…", save: "保存", importPrism: "从 Prism 导入…", collaborate: "协作…", wordCount: "字数统计…", undo: "撤销", redo: "重做", find: "查找…", snippets: "代码片段…", terminal: "终端", restartShell: "重新启动 Shell…", hideTerminal: "隐藏窗口（保持运行）" },
  ko: { math: "수식", captureFormula: "화면에서 수식 가져오기…", settings: "설정…", file: "파일", newWindow: "새 창", newFile: "새 파일", newProject: "새 프로젝트…", openFolder: "폴더 열기…", save: "저장", importPrism: "Prism에서 가져오기…", collaborate: "공동 편집…", wordCount: "단어 수…", undo: "실행 취소", redo: "다시 실행", find: "찾기…", snippets: "코드 조각…", terminal: "터미널", restartShell: "셸 다시 시작…", hideTerminal: "창 숨기기(셸은 계속 실행)" },
  fr: { math: "Mathématiques", captureFormula: "Capturer une formule à l’écran…", settings: "Réglages…", file: "Fichier", newWindow: "Nouvelle fenêtre", newFile: "Nouveau fichier", newProject: "Nouveau projet…", openFolder: "Ouvrir un dossier…", save: "Enregistrer", importPrism: "Importer depuis Prism…", collaborate: "Collaborer…", wordCount: "Nombre de mots…", undo: "Annuler", redo: "Rétablir", find: "Rechercher…", snippets: "Extraits de code…", terminal: "Terminal", restartShell: "Redémarrer le shell…", hideTerminal: "Masquer la fenêtre (le shell reste actif)" },
  de: { math: "Mathematik", captureFormula: "Formel vom Bildschirm erfassen…", settings: "Einstellungen…", file: "Datei", newWindow: "Neues Fenster", newFile: "Neue Datei", newProject: "Neues Projekt…", openFolder: "Ordner öffnen…", save: "Sichern", importPrism: "Aus Prism importieren…", collaborate: "Gemeinsam bearbeiten…", wordCount: "Wörter zählen…", undo: "Rückgängig", redo: "Wiederholen", find: "Suchen…", snippets: "Textbausteine…", terminal: "Terminal", restartShell: "Shell neu starten…", hideTerminal: "Fenster ausblenden (Shell läuft weiter)" },
  es: { math: "Matemáticas", captureFormula: "Capturar una fórmula de la pantalla…", settings: "Ajustes…", file: "Archivo", newWindow: "Nueva ventana", newFile: "Nuevo archivo", newProject: "Nuevo proyecto…", openFolder: "Abrir carpeta…", save: "Guardar", importPrism: "Importar desde Prism…", collaborate: "Colaborar…", wordCount: "Recuento de palabras…", undo: "Deshacer", redo: "Rehacer", find: "Buscar…", snippets: "Fragmentos de código…", terminal: "Terminal", restartShell: "Reiniciar el intérprete…", hideTerminal: "Ocultar la ventana (el intérprete sigue activo)" },
};

const createApplicationMenuTemplate = ({
  appName = "TeX64",
  isMac = process.platform === "darwin",
  sendCommand = () => {},
  locale = "en",
  terminalActive = false,
  sendTerminalCommand = () => {},
  collabActive = false,
  // Opens another app instance with its own folder; null hides the item.
  onNewWindow = null,
} = {}) => {
  const labels = { ...MENU_LABELS.en, ...(MENU_LABELS[locale] || {}) };
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
        // Ctrl+Alt is AltGr on Windows keyboards, so only macOS gets a shortcut.
        ...(typeof onNewWindow === "function"
          ? [{ label: labels.newWindow, ...(isMac ? { accelerator: "Alt+Cmd+N" } : {}), click: () => onNewWindow() }]
          : []),
        { type: "separator" },
        commandItem(labels.newProject, "project:new", "CmdOrCtrl+Shift+N"),
        commandItem(labels.openFolder, "project:open", "CmdOrCtrl+O"),
        commandItem(labels.importPrism, "prism:import"),
        { type: "separator" },
        commandItem(labels.save, "file:save", "CmdOrCtrl+S"),
        { type: "separator" },
        commandItem(labels.collaborate, "collab:open"),
        commandItem(labels.wordCount, "wordcount:open"),
        { type: "separator" },
        // Electron names the role from the OS locale; Japanese follows the
        // in-app language like the rest of this menu.
        isMac
          ? { role: "close", ...(MENU_LABELS[locale]?.closeWindow ? { label: MENU_LABELS[locale].closeWindow } : {}) }
          : { role: "quit" },
      ],
    },
    // During a collaboration session Undo/Redo must reach the shared-document
    // undo manager (only the user's own edits), so the role items — whose
    // accelerators run before the DOM — are replaced by renderer commands.
    { role: "editMenu", submenu: [
      ...(collabActive
        ? [commandItem(labels.undo, "edit:undo", "CmdOrCtrl+Z"), commandItem(labels.redo, "edit:redo", isMac ? "Shift+CmdOrCtrl+Z" : "CmdOrCtrl+Y")]
        : [{ role: "undo" }, { role: "redo" }]),
      { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" },
      { type: "separator" }, commandItem(labels.find, "edit:find", "CmdOrCtrl+F"),
      commandItem(labels.snippets, "snippets:open"),
    ] },
    { role: "viewMenu" },
    { label: labels.math, submenu: [commandItem(labels.captureFormula, "math:capture")] },
    { label: labels.terminal, submenu: [
      { label: labels.restartShell, enabled: terminalActive, click: () => sendTerminalCommand("restart") },
      { label: labels.hideTerminal, enabled: terminalActive, click: () => sendTerminalCommand("hide") },
    ] },
    { role: "windowMenu" }
  );

  return template;
};

const newWindowLabel = (locale) => (MENU_LABELS[locale] || MENU_LABELS.en).newWindow || MENU_LABELS.en.newWindow;

module.exports = { createApplicationMenuTemplate, newWindowLabel };

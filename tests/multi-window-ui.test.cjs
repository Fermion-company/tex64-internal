"use strict";
// Second-window UI: the File menu's close item in the in-app language, and a
// refusal from the main process shown while a folder is open (the launcher,
// where such messages normally appear, is hidden then).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { chromium } = require("playwright");
const { createApplicationMenuTemplate } = require("../electron/app-menu.cjs");

const root = path.join(__dirname, "..");
const transpile = (rel) =>
  ts.transpileModule(fs.readFileSync(path.join(root, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

const fileMenuLastItem = (options) => {
  const file = createApplicationMenuTemplate({ onNewWindow: () => {}, ...options }).find(
    (menu) => Array.isArray(menu.submenu) && menu.submenu.some((item) => item.label === "新規ファイル" || item.label === "New File" || item.label === "新建文件")
  );
  return file.submenu[file.submenu.length - 1];
};

test("the File menu's Close Window follows the Japanese UI; other languages keep Electron's label", () => {
  assert.deepEqual(fileMenuLastItem({ isMac: true, locale: "ja" }), { role: "close", label: "ウインドウを閉じる" });
  assert.deepEqual(fileMenuLastItem({ isMac: true, locale: "en" }), { role: "close" });
  assert.deepEqual(fileMenuLastItem({ isMac: true, locale: "zh" }), { role: "close" });
  assert.deepEqual(fileMenuLastItem({ isMac: false, locale: "ja" }), { role: "quit" });
});

test("a refusal while a folder is open shows as an error notice, not only in the hidden launcher", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <div id="launcher"><button id="create"></button><button id="open"></button><p id="status" class="is-hidden"></p>
    <div id="recent"><div id="recentList"></div><p id="recentEmpty"></p><button id="recentToggle"><span class="launcher-recent-toggle-text"></span></button></div>
    <button id="langToggle"><span id="langLabel"></span></button><div id="langMenu" class="is-hidden"></div></div>`);
  const message = "このフォルダは別の TeX64 ウインドウで開かれています。";
  const result = await page.evaluate(
    ({ sources, message }) => {
      const stubs = {
        "./i18n.js": {
          getUiLocale: () => "ja",
          setUiLocale() {},
          onUiLocaleChange() {},
          uiText: (_en, ja) => ja,
          SUPPORTED_LOCALES: [{ code: "en", label: "English" }, { code: "ja", label: "日本語" }],
        },
      };
      const notice = {};
      new Function("exports", sources.notice)(notice);
      stubs["./editor-notice.js"] = notice;
      const launcherModule = {};
      new Function("exports", "require", sources.launcher)(launcherModule, (spec) => stubs[spec]);
      const byId = (id) => document.getElementById(id);
      const ui = launcherModule.initLauncherUi(
        {
          dom: {
            launcher: byId("launcher"),
            launcherCreateButton: byId("create"),
            launcherOpenButton: byId("open"),
            launcherStatusMessage: byId("status"),
            launcherRecent: byId("recent"),
            launcherRecentList: byId("recentList"),
            launcherRecentEmpty: byId("recentEmpty"),
            launcherRecentToggle: byId("recentToggle"),
            launcherLangToggle: byId("langToggle"),
            launcherLangToggleLabel: byId("langLabel"),
            launcherLangMenu: byId("langMenu"),
          },
        },
        { onCreate() {}, onOpen() {}, onOpenRecent() {}, onRemoveRecent() {} }
      );
      const notices = () => [...document.querySelectorAll(".editor-notice")].map((el) => [el.className, el.textContent]);
      // A folder is open: the launcher is hidden.
      ui.setVisible(false);
      ui.setStatus({ isBusy: false, message });
      const folderOpen = notices();
      notice.hideEditorNotice();
      // Busy updates and cleared messages say nothing.
      ui.setStatus({ isBusy: true, message: null });
      ui.setStatus({ isBusy: false, message: null });
      const quiet = notices();
      // At the launcher the status line shows it, as before.
      ui.setVisible(true);
      ui.setStatus({ isBusy: false, message });
      return { folderOpen, quiet, atLauncher: notices(), launcherLine: byId("status").textContent };
    },
    { sources: { notice: transpile("web-src/app/editor-notice.ts"), launcher: transpile("web-src/app/launcher-ui.ts") }, message }
  );
  assert.deepEqual(result.folderOpen, [["editor-notice is-error", message]]);
  assert.deepEqual(result.quiet, []);
  assert.deepEqual(result.atLauncher, []);
  assert.equal(result.launcherLine, message);
});

test("a detached window can receive its settings when app-data session storage is full", async (t) => {
  const os = require("node:os");
  const vm = require("node:vm");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-window-session-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const userData = path.join(tmp, "app-data");
  const temporaryLockDirectory = () => path.join(tmp, "temporary");
  const env = { TEX64_ALLOW_MULTI_INSTANCE: "1" };
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  const bootstrap = main.slice(main.indexOf("const WINDOW_SESSIONS_DIR"), main.indexOf('ipcMain.on("tex64:windowSettingsSeed"'));
  const writer = main.slice(main.indexOf("const writeWindowSettingsSeed"), main.indexOf("async function launchDetachedInstance"));
  const full = Object.assign(new Error("full app-data directory"), { code: "ENOSPC" });
  const entries = [["theme", "dark"]];
  let sessionPath;
  const { writeWindowSettingsSeed, takeWindowSettingsSeed } = vm.runInNewContext(
    bootstrap + writer + "\n({ writeWindowSettingsSeed, takeWindowSettingsSeed });",
    {
      app: {
        getPath: () => userData,
        setPath(_name, value) {
          if (value.startsWith(userData + path.sep)) throw full;
          sessionPath = value;
        },
      },
      fs, path, require, temporaryLockDirectory, setTimeout, clearTimeout, logStorageFailure() {},
      ensureTemporaryLockDirectory: require("../electron/services/app-storage.cjs").ensureTemporaryLockDirectory,
      fsp: {
        ...fs.promises,
        writeFile: (filename, ...args) => filename.startsWith(userData + path.sep)
          ? Promise.reject(full) : fs.promises.writeFile(filename, ...args),
      },
      process: { pid: 1234, once() {}, env },
      mainRendererReady: true,
      state: { mainWindow: { webContents: { isDestroyed: () => false, executeJavaScript: async () => entries } } },
    },
  );
  assert.equal(path.dirname(sessionPath), path.join(temporaryLockDirectory(), "window-sessions"));
  env.TEX64_WINDOW_SETTINGS_FILE = await writeWindowSettingsSeed();
  assert.equal(path.dirname(env.TEX64_WINDOW_SETTINGS_FILE), path.dirname(sessionPath));
  assert.equal(JSON.stringify(takeWindowSettingsSeed()), JSON.stringify(entries));
  assert.equal(takeWindowSettingsSeed(), null);
  assert.equal(fs.existsSync(env.TEX64_WINDOW_SETTINGS_FILE), false);
});

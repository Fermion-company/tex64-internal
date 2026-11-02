#!/usr/bin/env node
// Drives the app against mock-zotero.cjs: insert from the personal and the
// group library over Better BibTeX, then over the local API, sync the .bib,
// and record the "not reachable" state. Screenshots land in RUN_DIR/shots.
//
//   RUN_DIR=/tmp/zotero-run node testing/zotero-20261031/drive.mjs
//
// The test workspace is copied into RUN_DIR/project; the original is untouched.

import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../..");
const RUN = process.env.RUN_DIR ? path.resolve(process.env.RUN_DIR) : path.join(HERE, "run");
const PROJECT = path.join(RUN, "project");
const SHOTS = process.env.SHOTS_DIR ? path.resolve(process.env.SHOTS_DIR) : path.join(RUN, "shots");
const PORT = 23119;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const log = (step, data = {}) => { results.push({ step, ...data }); console.log(step, JSON.stringify(data)); };

fs.rmSync(RUN, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.cpSync(path.join(APP, "testing/test-workspace"), PROJECT, { recursive: true });
fs.writeFileSync(path.join(PROJECT, ".tex64/settings.json"), JSON.stringify({ rootFile: "main.tex" }));

// ---- mock Zotero
let mock = null;
const startMock = async (env = {}) => {
  if (mock) { mock.kill(); await sleep(400); }
  mock = spawn(process.execPath, [path.join(HERE, "mock-zotero.cjs")], { env: { ...process.env, PORT: String(PORT), ...env }, stdio: ["ignore", fs.openSync(path.join(RUN, "mock.log"), "a"), fs.openSync(path.join(RUN, "mock.log"), "a")] });
  await sleep(600);
};
const bump = async (key) => (await fetch(`http://127.0.0.1:${PORT}/mock/bump?key=${key}`, { method: "PUT" })).json();
await startMock();

// ---- app
const app = await electron.launch({
  cwd: APP, args: [APP], timeout: 180_000,
  env: { ...process.env, TEX64_E2E_USERDATA: `${RUN}/profile`, TEX64_E2E_FORCE_HEADLESS: "0", TEX64_ALLOW_MULTI_INSTANCE: "1", TEX64_AI_MODE_ENABLED: "0" },
});
const page = await app.firstWindow();
page.on("console", (msg) => { if (msg.type() === "error") fs.appendFileSync(path.join(RUN, "renderer-console.log"), `${msg.text()}\n`); });
await page.waitForLoadState("domcontentloaded");
await page.evaluate((locale) => localStorage.setItem("tex64.ui.locale.v1", locale), process.env.UI_LOCALE || "ja");
await page.reload();
await page.waitForLoadState("domcontentloaded");
await sleep(2000);
await page.evaluate((p) => window.tex64Bridge.postMessage({ type: "openRecentProject", path: p }), PROJECT);
await page.waitForSelector('button.file-item[data-path="main.tex"]', { timeout: 60_000, state: "attached" });
for (let i = 0; i < 3; i += 1) {
  if (await page.evaluate(() => document.getElementById("settings-pages")?.getAttribute("aria-hidden") === "false")) { await page.click("#settings-close").catch(() => {}); await sleep(500); }
  if (await page.evaluate(() => document.getElementById("announcement-modal")?.classList.contains("is-open"))) { await page.click("#announcement-modal-close").catch(() => {}); await sleep(500); }
}
await page.click('button.file-item[data-path="main.tex"]');
await page.waitForFunction(() => window.monaco?.editor?.getEditors?.().some((e) => e.getModel()?.uri?.path?.endsWith("main.tex")), null, { timeout: 30_000 });
log("workspace-open");

const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const inEditor = (fn, arg) => page.evaluate(([src, value]) => {
  const editor = window.monaco.editor.getEditors().find((e) => e.getModel()?.uri?.path?.endsWith("main.tex"));
  return new Function("editor", "arg", `return (${src})(editor, arg);`)(editor, value);
}, [fn.toString(), arg]);
const lineText = (line) => inEditor((editor, n) => editor.getModel().getLineContent(n), line);
const bibPath = path.join(PROJECT, "refs.bib");
const readBib = () => (fs.existsSync(bibPath) ? fs.readFileSync(bibPath, "utf8") : null);
const status = () => page.textContent("dialog.zotero-dialog .zotero-status");
const settingsStatus = () => page.textContent("#settings-zotero-status");

const openDialog = async (line, column, { viaMenu = false } = {}) => {
  await inEditor((editor, pos) => { editor.focus(); editor.setPosition(pos); editor.revealLineInCenter(pos.lineNumber); }, { lineNumber: line, column });
  await sleep(200);
  let usedMenu = false;
  if (viaMenu) {
    const point = await inEditor((editor) => {
      const rect = editor.getDomNode().getBoundingClientRect();
      const p = editor.getScrolledVisiblePosition(editor.getPosition());
      return { x: rect.left + p.left + 2, y: rect.top + p.top + p.height / 2 };
    });
    await page.mouse.click(point.x, point.y, { button: "right" });
    const item = page.locator(".monaco-menu .action-label", { hasText: /Zotero/ });
    try {
      await item.first().waitFor({ timeout: 3000 });
      await shot("00-context-menu");
      await item.first().click();
      usedMenu = true;
    } catch {
      await page.keyboard.press("Escape");
    }
  }
  if (!usedMenu) await inEditor((editor) => editor.getAction("tex64.zotero.insert").run());
  await page.waitForSelector("dialog.zotero-dialog[open]", { timeout: 5000 });
  await page.waitForFunction(() => { const t = document.querySelector("dialog.zotero-dialog .zotero-status")?.textContent || ""; return t && !/確認中|Checking/.test(t); }, null, { timeout: 20_000 });
  return usedMenu;
};
const searchAndInsert = async (query) => {
  await page.fill("dialog.zotero-dialog input[type=text]", query);
  // wait for the rows of THIS query (the previous list stays until the debounce fires)
  await page.waitForFunction((q) => Array.from(document.querySelectorAll("dialog.zotero-dialog .zotero-result")).some((row) => row.textContent.toLowerCase().includes(q)), query, { timeout: 10_000 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /inserted|挿入|already|既に|既存|not inserted|挿入できません/.test(document.querySelector("dialog.zotero-dialog .zotero-status")?.textContent || ""), null, { timeout: 20_000 });
  return status();
};
const closeDialog = async () => {
  await page.keyboard.press("Escape");
  await page.waitForSelector("dialog.zotero-dialog", { state: "detached", timeout: 5000 }).catch(async () => {
    log("escape-did-not-close");
    await page.click("dialog.zotero-dialog .history-confirm-actions button:last-child");
    await page.waitForSelector("dialog.zotero-dialog", { state: "detached", timeout: 5000 });
  });
};
const openSettingsZotero = async () => {
  await page.click("#settings-tab");
  await page.click('.settings-nav-item[data-settings-target="zotero"]');
  await page.waitForFunction(() => { const t = document.getElementById("settings-zotero-status")?.textContent || ""; return t && !/確認中|Checking/.test(t); }, null, { timeout: 20_000 });
  await sleep(700); // the overlay fades in
};
const chooseLibrary = async (prefix) => {
  const value = await page.evaluate((p) => Array.from(document.querySelectorAll("#settings-zotero-library option")).map((o) => o.value).find((v) => v.startsWith(p)), prefix);
  await page.selectOption("#settings-zotero-library", value);
  await page.waitForFunction(() => { const t = document.getElementById("settings-zotero-status")?.textContent || ""; return t && !/確認中|Checking/.test(t); }, null, { timeout: 20_000 });
  return value;
};
const syncBib = async () => {
  await page.click("dialog.zotero-dialog .history-confirm-actions button:first-child");
  await page.waitForFunction(() => !/同期中|Syncing/.test(document.querySelector("dialog.zotero-dialog .zotero-status")?.textContent || ""), null, { timeout: 30_000 });
  return status();
};

// ---- 1. Better BibTeX, personal library: new \cite on an empty line
const usedMenu = await openDialog(12, 1, { viaMenu: true });
log("dialog-bbt", { usedMenu, status: await status() });
await page.fill("dialog.zotero-dialog input[type=text]", "turing");
await page.waitForSelector("dialog.zotero-dialog .zotero-result");
await shot("01-search-bbt");
log("insert-bbt-personal", { status: await searchAndInsert("turing"), line12: await lineText(12), bibTail: (readBib() || "").slice(-320), referencesBibCreated: fs.existsSync(path.join(PROJECT, "references.bib")) });
await shot("02-inserted-bbt");
await closeDialog();

// ---- 2. Settings → group library (BBT)
await openSettingsZotero();
await shot("03-settings-bbt");
log("settings-bbt", { status: await settingsStatus(), library: await chooseLibrary("bbt:7"), after: await settingsStatus() });
await page.click("#settings-close");
await sleep(400);

// ---- 3. group item appended inside the existing \cite{…}
await openDialog(12, 8);
log("insert-bbt-group", { status: await searchAndInsert("attention"), line12: await lineText(12) });
await shot("04-group-append-bbt");

// ---- 4. sync over BBT after the library changed one entry
log("bump", await bump("VASWANI17"));
log("sync-bbt", { status: await syncBib(), bibHasRev: /\(rev\)/.test(readBib() || "") });
await shot("05-sync-bbt");
await closeDialog();

// ---- 5. local API only (BBT closed)
await startMock({ MOCK_BBT: "0" });
await openSettingsZotero();
log("settings-local", { status: await settingsStatus(), library: await chooseLibrary("groups:"), after: await settingsStatus() });
await shot("06-settings-local");
await page.click("#settings-close");
await sleep(400);
await inEditor((editor) => { editor.setPosition({ lineNumber: 12, column: editor.getModel().getLineMaxColumn(12) }); editor.trigger("drive", "type", { text: "\n" }); });
await openDialog(13, 1);
log("dialog-local", { status: await status() });
// the Vaswani paper again, now through the local API: same item → same key, no second entry
log("insert-local-dup", { status: await searchAndInsert("attention"), line13: await lineText(13), vaswaniEntries: ((readBib() || "").match(/@inproceedings\{vaswani/g) || []).length });
// straight after the previous insertion the caret sits after "}", so the next key joins the same \cite
log("insert-local-group", { status: await searchAndInsert("hinton"), line13: await lineText(13), bibTail: (readBib() || "").slice(-400) });
await shot("07-local-group");
log("bump", await bump("HINTON2006"));
log("sync-local", { status: await syncBib(), bibTail: (readBib() || "").slice(-900) });
await shot("08-sync-local");
await closeDialog();

// ---- 6. nothing reachable
await startMock({ MOCK_BBT: "0", MOCK_LOCAL: "0" });
await openDialog(13, 1);
log("dialog-unreachable", { status: await status() });
await shot("09-unreachable");
await closeDialog();
await openSettingsZotero();
log("settings-unreachable", { status: await settingsStatus() });
await shot("10-settings-unreachable");
await page.click("#settings-close");

fs.writeFileSync(path.join(RUN, "result.json"), JSON.stringify(results, null, 2));
await app.close().catch(() => {});
mock?.kill();
console.log("done", RUN);

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");
const PROJECT = path.resolve(__dirname, "../..");
const doc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const waitFor = async (read, accept, timeout = 15000) => {
  let value;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error("Timed out: " + JSON.stringify(value));
};

test("Issue 38: terminal, build target, external edits, scrollbar and root creation in the current UI", { timeout: 120000 }, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-issue38-"));
  const workspace = path.join(temp, "workspace");
  const artifacts = path.join(PROJECT, "tmp", "issue38-e2e");
  fs.mkdirSync(path.join(workspace, "sub", "child space"), { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  const subFile = path.join(workspace, "sub/main.tex");
  fs.writeFileSync(path.join(workspace, "main.tex"), doc("Root document"));
  fs.writeFileSync(subFile, doc(Array.from({ length: 120 }, (_, i) => `Nested document line ${i}.\n`).join("\n")));
  let app;
  t.after(async () => {
    const child = app?.process();
    if (app) await Promise.race([app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (child && child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(temp, { recursive: true, force: true });
  });
  app = await electron.launch({
    executablePath: require("electron"), args: [PROJECT], timeout: 45000,
    env: { ...process.env, PATH: "/Library/TeX/texbin:/opt/homebrew/bin:" + process.env.PATH,
      TEX64_E2E: "1", TEX64_E2E_USERDATA: path.join(temp, "userdata"), TEX64_E2E_FORCE_HEADLESS: "1",
      TEX64_E2E_OPEN_WORKSPACE_PATH: workspace, TEX64_ALLOW_MULTI_INSTANCE: "1", NODE_ENV: "test" },
  });
  const page = await app.firstWindow();
  await page.waitForSelector("body.is-ready");
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const original = contents.setIgnoreMenuShortcuts.bind(contents);
    contents.setIgnoreMenuShortcuts = (ignore) => {
      global.__issue38IgnoreMenuShortcuts = ignore;
      original(ignore);
    };
  });
  const nativeCtrlIgnored = () => app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.emit("before-input-event", {}, { control: true, meta: false });
    return global.__issue38IgnoreMenuShortcuts;
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    document.getElementById("announcement-modal-close")?.click();
    window.__issue38Output = {};
    window.__issue38Messages = [];
    window.tex64Terminal.onData(({ id, data }) => { window.__issue38Output[id] = (window.__issue38Output[id] || "") + data; });
    window.tex64Bridge.onMessage((message) => window.__issue38Messages.push(message));
  });
  await page.locator("#launcher-open").click();
  await page.waitForTimeout(1200);
  await page.evaluate(() => { document.getElementById("settings-close")?.click(); document.getElementById("announcement-modal-close")?.click(); });
  await page.locator('.file-item[data-path="sub/main.tex"]').waitFor({ state: "attached" });
  const subFolder = page.locator('details[data-path="sub"]');
  if (!await subFolder.evaluate((element) => element.open)) await subFolder.locator(":scope > summary").click();
  await page.locator('.file-item[data-path="sub/main.tex"]').click();
  const modelValue = () => page.evaluate(() => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith("/sub/main.tex"))?.getValue());
  await waitFor(modelValue, (value) => value?.includes("Nested document"));

  // Exercise real keyboard input through xterm, then observe real PTY output.
  await page.keyboard.press("Control+Backquote");
  const activeId = () => page.locator(".terminal-pane.is-active").getAttribute("data-session-id");
  let firstId = await waitFor(activeId, Boolean);
  assert.equal(await nativeCtrlIgnored(), true, "native Ctrl accelerators defer to the focused terminal");
  const command = async (text) => { await page.keyboard.type(text); await page.keyboard.press("Enter"); };
  const output = (id) => page.evaluate((key) => window.__issue38Output[key] || "", id);
  await command("cd 'sub/child space'");
  await command("printf '__CWD__%s__\\n' \"$PWD\"");
  await waitFor(() => output(firstId), (value) => /__CWD__[^\r\n]+child space__/.test(value));
  await command("TEX64_SESSION_VALUE=first");
  await command("printf '日本語\\n' | wc -l");
  await command("sleep 30");
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+c");
  await command("printf '__%s__\\n' INTERRUPTED");
  await waitFor(() => output(firstId), (value) => value.includes("__INTERRUPTED__"));
  await page.keyboard.press("Control+t");
  const secondId = await waitFor(activeId, (value) => value && value !== firstId);
  assert.equal(await page.locator(".terminal-tab").count(), 2);
  await command("printf '__SECOND__%s__\\n' \"$PWD\"");
  await waitFor(() => output(secondId), (value) => value.includes("__SECOND__" + workspace + "__"));
  await page.locator("#bottom-panel-terminal-split").click();
  const splitId = await waitFor(activeId, (value) => value && value !== secondId);
  assert.equal(await page.locator(".terminal-pane:visible").count(), 2);
  await command("stty size");
  await waitFor(() => output(splitId), (value) => /\r?\n\d+ \d+\r?\n/.test(value));
  await page.locator(".terminal-tab [role=tab]").first().click();
  assert.equal(await activeId(), firstId);
  await command("printf '__KEPT__%s__\\n' \"$TEX64_SESSION_VALUE\"");
  await waitFor(() => output(firstId), (value) => value.includes("__KEPT__first__"));
  await page.keyboard.press("Control+Backquote");
  await page.keyboard.press("Control+Backquote");
  assert.equal(await activeId(), firstId);
  await command("exit");
  await waitFor(() => page.locator(".terminal-pane.is-active").getAttribute("data-state"), (value) => value === "exited");
  await page.keyboard.press("Enter");
  const restarted = await waitFor(activeId, (value) => value && value !== firstId);
  await command("printf '__%s__\\n' RESTARTED");
  await waitFor(() => output(restarted), (value) => value.includes("__RESTARTED__"));
  await page.locator(".terminal-tab [role=tab]").nth(1).click();
  await page.screenshot({ path: path.join(artifacts, "terminal-split.png") });
  await page.evaluate(async () => (await import("./app/appearance.js")).setAppearanceTheme("light"));
  await page.screenshot({ path: path.join(artifacts, "terminal-split-light.png") });
  await page.evaluate(async () => (await import("./app/appearance.js")).setAppearanceTheme("dark"));
  await page.locator(".terminal-tab-close").nth(1).click();
  assert.equal(await page.locator(".terminal-tab").count(), 1);
  await page.locator("#bottom-panel-close").click();
  assert.equal(await nativeCtrlIgnored(), false, "editor menu shortcuts resume after leaving the terminal");

  // Clean buffers reload without stealing selection/cursor; dirty ones conflict.
  const external = doc("External clean change");
  fs.writeFileSync(subFile, external);
  await waitFor(modelValue, (value) => value === external);
  await page.evaluate(() => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith("/sub/main.tex")).setValue("Unsaved local edit"));
  fs.writeFileSync(subFile, doc("External competing edit"));
  await page.locator("#ai-content-conflict-bar").waitFor();
  await page.waitForTimeout(700);
  assert.equal(await modelValue(), "Unsaved local edit");
  assert.match(fs.readFileSync(subFile, "utf8"), /External competing edit/);
  await page.locator("#ai-content-conflict-bar .is-keep").click();
  await waitFor(modelValue, (value) => value?.includes("External competing edit"));
  await page.evaluate(() => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith("/sub/main.tex")).setValue("Keep this local edit"));
  fs.writeFileSync(subFile, doc("Second external edit"));
  await page.locator("#ai-content-conflict-bar").waitFor();
  await page.locator("#ai-content-conflict-bar .is-undo").click();
  await waitFor(() => fs.readFileSync(subFile, "utf8"), (value) => value === "Keep this local edit");

  // Whitespace context menu must target root even when sub/main.tex is active.
  await page.locator("#file-tree").evaluate((tree) => {
    const rect = tree.getBoundingClientRect();
    tree.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: rect.x + 50, clientY: rect.bottom - 12 }));
  });
  await page.locator("#context-menu").getByText(/New folder|新しいフォルダー/).click();
  await page.locator("#create-modal-input").fill("created-at-root");
  await page.locator("#create-modal-submit").click();
  await waitFor(() => fs.existsSync(path.join(workspace, "created-at-root")), Boolean);
  assert.equal(fs.existsSync(path.join(workspace, "sub/created-at-root")), false);
  fs.writeFileSync(path.join(workspace, "outside-created.tex"), "Created externally");
  await page.locator('.file-item[data-path="outside-created.tex"]').waitFor();

  fs.writeFileSync(subFile, doc(Array.from({ length: 120 }, (_, i) => `Nested line ${i}.\n`).join("\n")));
  await waitFor(modelValue, (value) => value?.includes("Nested line 119"));
  await page.locator('.file-item[data-path="sub/main.tex"]').click();
  await page.evaluate(() => {
    const toggle = document.getElementById("editor-pdf-window");
    if (toggle) { toggle.checked = false; toggle.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  await page.locator("#build-button").click();
  await waitFor(() => fs.existsSync(path.join(workspace, "sub/main.pdf")), Boolean, 30000);
  assert.equal(fs.existsSync(path.join(workspace, "main.pdf")), false);
  await waitFor(() => page.evaluate(() => window.__issue38Messages.filter((m) => m.type === "setBuildState").at(-1)?.payload), (value) => value?.state === "success", 30000);
  const pdf = await waitFor(() => page.frames().find((frame) => frame.url().includes("pdf-viewer.html")), Boolean);
  await waitFor(() => pdf.locator("#pdf-page-count").textContent(), (value) => /\/\s*[1-9]/.test(value), 15000);
  await pdf.locator("#pdf-pages canvas").first().waitFor();
  await page.locator('.file-item[data-path="sub/main.tex"]').click();
  assert.ok(await page.locator('.monaco-editor .scrollbar.vertical').first().evaluate((el) => getComputedStyle(el).visibility !== "hidden"));
  await page.screenshot({ path: path.join(artifacts, "workspace-fixed.png") });
  console.log("Issue 38 screenshots: " + artifacts);
});

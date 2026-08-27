#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "../../..");
const output = __dirname;
const workspace = path.join(output, "demo-workspace");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-marketing-"));
const electronBin = require("electron");

fs.mkdirSync(workspace, { recursive: true });
fs.copyFileSync(
  path.join(root, "store/windows/demo-workspace/main.tex"),
  path.join(workspace, "main.tex")
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendFromMain = (app, type, payload) =>
  app.evaluate(
    ({ BrowserWindow }, message) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("tex64:message", message);
    },
    { type, payload }
  );

const setWindow = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1600, 900);
    win.setPosition(120, 60);
    win.show();
    win.focus();
  });

const hideStartupSurfaces = (page) =>
  page.evaluate(() => {
    for (const id of ["onboarding", "launcher"]) {
      const el = document.getElementById(id);
      el?.classList.remove("is-visible");
      el?.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("has-onboarding", "has-launcher");
  });

const showLauncher = (page) =>
  page.evaluate(() => {
    const onboarding = document.getElementById("onboarding");
    onboarding?.classList.remove("is-visible");
    onboarding?.setAttribute("aria-hidden", "true");
    document.body.classList.remove("has-onboarding");
    const launcher = document.getElementById("launcher");
    launcher?.classList.add("is-visible");
    launcher?.setAttribute("aria-hidden", "false");
    document.body.classList.add("has-launcher");
  });

const openWorkspace = async (page) => {
  await showLauncher(page);
  await page.evaluate(() => {
    window.tex64Bridge?.postMessage({ type: "openWorkspace", locale: "ja" });
  });
  await page.waitForSelector('.editor-tab[data-path="main.tex"].is-active', {
    timeout: 20_000,
  });
  await page.waitForSelector(".monaco-editor .view-line", { timeout: 20_000 });
  await hideStartupSurfaces(page);
  if ((await page.locator("body").getAttribute("data-active-tab")) === "settings") {
    await page.locator("#settings-close").click({ force: true });
  }
  await page.locator('[data-tab="files"]').click({ force: true });
  await page.waitForSelector('body[data-active-tab="files"]', { timeout: 10_000 });
};

const openEnvironmentSettings = async (page) => {
  await hideStartupSurfaces(page);
  if ((await page.locator("body").getAttribute("data-active-tab")) !== "settings") {
    await page.locator('[data-tab="settings"]').click({ force: true });
  }
  if (!(await page.locator('[data-settings-page="env"]').getAttribute("class"))?.includes("is-active")) {
    await page.locator('[data-settings-target="env"]').click({ force: true });
  }
  await page.waitForSelector('[data-settings-page="env"].is-active', {
    timeout: 10_000,
  });
  await page.waitForTimeout(1200);
};

const captureWindow = async (app, fileName) => {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.toPNG().toString("base64");
  });
  fs.writeFileSync(path.join(output, fileName), Buffer.from(png, "base64"));
};

const prepEditor = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() || [];
    const editor = editors.find((item) => item.getModel()?.uri?.path?.endsWith("/main.tex"));
    const model = editor?.getModel();
    if (!editor || !model) throw new Error("main.tex editor is unavailable");
    const lineNumber = model.findMatches("\\\\end\\{document\\}", false, true, false, null, false)[0]
      ?.range.startLineNumber || model.getLineCount();
    editor.setPosition({ lineNumber, column: 1 });
    editor.revealLineInCenter(lineNumber);
    editor.focus();
  });
  await page.keyboard.type(
    "\n% TeX64: write, build, and preview LaTeX instantly\n\\section{A beautiful result}\n",
    { delay: 18 }
  );
  await page.waitForTimeout(700);
};

const launch = async () => {
  const app = await electron.launch({
    executablePath: electronBin,
    args: ["--force-device-scale-factor=1", root],
    env: {
      ...process.env,
      TEX64_ALLOW_MULTI_INSTANCE: "1",
      TEX64_E2E: "1",
      TEX64_E2E_USERDATA: userData,
      TEX64_E2E_OPEN_WORKSPACE_PATH: workspace,
      TEX64_E2E_FORCE_HEADLESS: "0",
      TEX64_E2E_FORCE_MISSING_TOOLS:
        "lualatex,pdflatex,xelatex,uplatex,latexmk,synctex,latexindent",
      TEX64_E2E_IGNORE_SYSTEM_TEX: "1",
      TEX64_SKIP_STARTUP_WEB_BUILD: "1",
      NODE_ENV: "test",
    },
    timeout: 45_000,
  });
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector("body.is-ready", { timeout: 20_000 });
  await page.evaluate(() => localStorage.setItem("tex64.ui.locale.v1", "ja"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("body.is-ready", { timeout: 20_000 });
  await page.waitForTimeout(1600);
  await page.evaluate(() => document.getElementById("announcement-modal-close")?.click());
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById("announcement-modal-close")?.click());
  await setWindow(app);
  await page.waitForSelector("#onboarding.is-visible", { timeout: 20_000 });
  return { app, page };
};

const runShots = async () => {
  const { app, page } = await launch();
  try {
    await openEnvironmentSettings(page);
    await captureWindow(app, "tex64-settings-tex-environment-1600x900.png");
    await openWorkspace(page);
    await prepEditor(page);
    await captureWindow(app, "tex64-editor-coding-1600x900.png");
  } finally {
    await app.close().catch(() => {});
  }
};

const runDemo = async () => {
  const { app, page } = await launch();
  process.stdout.write("TEX64_DEMO_READY\n");
  try {
    await new Promise((resolve) => process.stdin.once("data", resolve));
    await wait(1200);
    await sendFromMain(app, "env:installStart", { target: "basictex", variant: "full" });
    for (const [delay, percent, current] of [
      [800, 12, 24],
      [850, 34, 68],
      [850, 61, 122],
      [850, 84, 168],
      [700, 100, 200],
    ]) {
      await wait(delay);
      await sendFromMain(app, "env:installProgress", {
        phase: percent < 84 ? "texlive" : "finalize",
        percent,
        current,
        total: 200,
      });
    }
    await wait(500);
    await openWorkspace(page);
    await wait(900);
    await page.evaluate(() => {
      const editors = window.monaco?.editor?.getEditors?.() || [];
      const editor = editors.find((item) => item.getModel()?.uri?.path?.endsWith("/main.tex"));
      const model = editor?.getModel();
      if (!editor || !model) throw new Error("main.tex editor is unavailable");
      const lineNumber = model.findMatches("\\\\end\\{document\\}", false, true, false, null, false)[0]
        ?.range.startLineNumber || model.getLineCount();
      editor.setPosition({ lineNumber, column: 1 });
      editor.revealLineInCenter(lineNumber);
      editor.focus();
    });
    await page.keyboard.type("\n% Ready in TeX64\n\\section{First document}\n", {
      delay: 70,
    });
    await wait(3900);
    process.stdout.write("TEX64_DEMO_DONE\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
  } finally {
    await app.close().catch(() => {});
  }
};

const runEditorShot = async () => {
  const { app, page } = await launch();
  try {
    await openWorkspace(page);
    await prepEditor(page);
    await captureWindow(app, "tex64-editor-coding-1600x900.png");
  } finally {
    await app.close().catch(() => {});
  }
};

const mode = process.argv[2] || "shots";
const selectedRun = mode === "demo" ? runDemo : mode === "editor" ? runEditorShot : runShots;
selectedRun().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const FIXTURE_TEX = path.join(
  PROJECT_ROOT,
  "store",
  "windows",
  "demo-workspace",
  "main.tex"
);
const CAPTURE_WIDTH = 1600;
const CAPTURE_HEIGHT = 900;
const UI_LOCALE_STORAGE_KEY = "tex64.ui.locale.v1";
const DEFAULT_LOCALES = ["ja", "en"];
const SENSITIVE_ENV_KEY =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|AUTH|COOKIE|CREDENTIAL|PRIVATE_KEY)(?:_|$)/i;

const usage = () => `
Capture real TeX64 Microsoft Store screenshots with Playwright Electron.

Usage:
  node scripts/capture-windows-store-screenshots.cjs [options]

Options:
  --executable <path>       Packaged TeX64 executable. Defaults to local Electron.
  --app-dir <path>          App directory passed to a development Electron binary.
  --output <path>           Output directory (default: dist/store-screenshots).
  --locales <ja,en>         Comma-separated UI locales (default: ja,en).
  --require-packaged        Fail unless Electron reports app.isPackaged=true.
  --require-platform <name> Fail unless the runtime platform matches (for CI: win32).
  --keep-temp               Keep the isolated demo workspace for debugging.
  --help                    Show this help.
`;

const takeValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};

const parseArgs = (argv) => {
  const options = {
    executablePath: null,
    appDir: null,
    outputDir: path.join(PROJECT_ROOT, "dist", "store-screenshots"),
    locales: [...DEFAULT_LOCALES],
    requirePackaged: false,
    requirePlatform: null,
    keepTemp: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--executable") {
      options.executablePath = path.resolve(takeValue(argv, index, arg));
      index += 1;
    } else if (arg === "--app-dir") {
      options.appDir = path.resolve(takeValue(argv, index, arg));
      index += 1;
    } else if (arg === "--output") {
      options.outputDir = path.resolve(takeValue(argv, index, arg));
      index += 1;
    } else if (arg === "--locales") {
      const locales = takeValue(argv, index, arg)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (locales.length === 0 || locales.some((locale) => !["ja", "en"].includes(locale))) {
        throw new Error("--locales only accepts ja and en");
      }
      options.locales = [...new Set(locales)];
      index += 1;
    } else if (arg === "--require-packaged") {
      options.requirePackaged = true;
    } else if (arg === "--require-platform") {
      options.requirePlatform = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === "--keep-temp") {
      options.keepTemp = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
};

const sanitizeLaunchEnv = (sourceEnv) => {
  const clean = {};
  for (const [key, value] of Object.entries(sourceEnv ?? {})) {
    if (typeof value !== "string" || SENSITIVE_ENV_KEY.test(key)) {
      continue;
    }
    clean[key] = value;
  }
  delete clean.ELECTRON_RUN_AS_NODE;
  delete clean.NODE_INSPECT;
  delete clean.NODE_INSPECT_RESUME_ON_START;
  return clean;
};

const escapePdfText = (value) =>
  String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const pdfText = ({ font = "F1", size = 11, x, y, text, color = "0.15 0.17 0.21" }) =>
  `BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${x} ${y} Tm (${escapePdfText(text)}) Tj ET`;

const createDemoPdf = (outputPath) => {
  const content = [
    "q",
    "0.16 0.42 0.78 rg",
    "54 773 487 5 re f",
    "Q",
    pdfText({ font: "F2", size: 25, x: 54, y: 730, text: "Robust Optimization" }),
    pdfText({
      font: "F3",
      size: 11,
      x: 54,
      y: 708,
      text: "A reproducible TeX64 demo project",
      color: "0.38 0.42 0.48",
    }),
    pdfText({ font: "F2", size: 14, x: 54, y: 663, text: "Abstract" }),
    pdfText({
      size: 10.5,
      x: 54,
      y: 642,
      text: "This example compares a nominal model with a regularized alternative",
    }),
    pdfText({
      size: 10.5,
      x: 54,
      y: 626,
      text: "under small data perturbations.",
    }),
    pdfText({ font: "F2", size: 14, x: 54, y: 582, text: "1  Model" }),
    pdfText({
      size: 10.5,
      x: 54,
      y: 558,
      text: "For observations A and targets b, the regularized estimate is",
    }),
    "q",
    "0.95 0.97 1 rg",
    "82 501 431 39 re f",
    "Q",
    pdfText({
      font: "F4",
      size: 11,
      x: 106,
      y: 516,
      text: "x* = arg min_x  || A x - b ||_2^2 + lambda || x ||_2^2",
      color: "0.08 0.23 0.42",
    }),
    pdfText({ font: "F2", size: 14, x: 54, y: 456, text: "2  Result" }),
    pdfText({
      size: 10.5,
      x: 54,
      y: 432,
      text: "The regularized estimate remains stable as the noise level grows.",
    }),
    "0.76 0.79 0.84 RG 0.7 w 54 388 m 514 388 l S",
    pdfText({ font: "F2", size: 10, x: 66, y: 400, text: "Method" }),
    pdfText({ font: "F2", size: 10, x: 324, y: 400, text: "Error" }),
    pdfText({ font: "F2", size: 10, x: 420, y: 400, text: "Stability" }),
    pdfText({ size: 10, x: 66, y: 367, text: "Nominal" }),
    pdfText({ font: "F4", size: 10, x: 324, y: 367, text: "0.184" }),
    pdfText({ font: "F4", size: 10, x: 432, y: 367, text: "0.71" }),
    "q 0.95 0.97 1 rg 54 323 460 27 re f Q",
    pdfText({ font: "F2", size: 10, x: 66, y: 333, text: "Regularized" }),
    pdfText({ font: "F4", size: 10, x: 324, y: 333, text: "0.092" }),
    pdfText({ font: "F4", size: 10, x: 432, y: 333, text: "0.94" }),
    "0.76 0.79 0.84 RG 0.7 w 54 311 m 514 311 l S",
    pdfText({
      font: "F3",
      size: 9,
      x: 133,
      y: 287,
      text: "Table 1: Evaluation on deterministic demo data.",
      color: "0.38 0.42 0.48",
    }),
    pdfText({
      font: "F3",
      size: 8.5,
      x: 54,
      y: 74,
      text: "TeX64 - local-first LaTeX editing and PDF preview",
      color: "0.45 0.49 0.55",
    }),
  ].join("\n");

  const streamLength = Buffer.byteLength(content, "latin1");
  const objects = [
    null,
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R /F4 7 0 R >> >> /Contents 8 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    `<< /Length ${streamLength} >>\nstream\n${content}\nendstream`,
    "<< /Title (Robust Optimization) /Author (TeX64 Demo) /Creator (TeX64 Store Screenshot Fixture) >>",
  ];

  const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [0];
  let byteOffset = parts[0].length;
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = byteOffset;
    const objectBuffer = Buffer.from(`${index} 0 obj\n${objects[index]}\nendobj\n`, "latin1");
    parts.push(objectBuffer);
    byteOffset += objectBuffer.length;
  }

  const xrefOffset = byteOffset;
  const xref = ["xref", `0 ${objects.length}`, "0000000000 65535 f "];
  for (let index = 1; index < objects.length; index += 1) {
    xref.push(`${String(offsets[index]).padStart(10, "0")} 00000 n `);
  }
  xref.push(
    "trailer",
    `<< /Size ${objects.length} /Root 1 0 R /Info 9 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    ""
  );
  parts.push(Buffer.from(xref.join("\n"), "latin1"));
  fs.writeFileSync(outputPath, Buffer.concat(parts));
};

const createDemoWorkspace = (tempRoot) => {
  if (!fs.existsSync(FIXTURE_TEX)) {
    throw new Error(`Demo fixture is missing: ${FIXTURE_TEX}`);
  }
  const workspacePath = path.join(tempRoot, "TeX64 Demo");
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.copyFileSync(FIXTURE_TEX, path.join(workspacePath, "main.tex"));
  createDemoPdf(path.join(workspacePath, "main.pdf"));
  return workspacePath;
};

const readPngSize = (filePath) => {
  const header = fs.readFileSync(filePath).subarray(0, 24);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (header.length < 24 || !header.subarray(0, 8).equals(signature)) {
    throw new Error(`Not a PNG file: ${filePath}`);
  }
  if (header.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`PNG is missing IHDR: ${filePath}`);
  }
  return {
    width: header.readUInt32BE(16),
    height: header.readUInt32BE(20),
  };
};

const waitFor = async (check, description, timeoutMs = 20_000, intervalMs = 100) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const suffix = lastError ? ` (${lastError.message})` : "";
  throw new Error(`Timed out waiting for ${description}${suffix}`);
};

const dismissAnnouncements = async (page) => {
  // Close through the product UI so queued notices are dismissed in the
  // isolated profile exactly as they would be by a user. A queue may reveal
  // the next notice immediately, hence the bounded loop.
  for (let index = 0; index < 8; index += 1) {
    const modal = page.locator("#announcement-modal.is-open");
    if ((await modal.count()) === 0) {
      return;
    }
    await page.locator("#announcement-modal-close").click({ force: true });
    await page.waitForTimeout(100);
  }
  if ((await page.locator("#announcement-modal.is-open").count()) !== 0) {
    throw new Error("Announcement queue did not close after eight notices");
  }
};

const setCaptureWindowSize = async (electronApp) => {
  return electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
      if (!mainWindow) {
        throw new Error("TeX64 did not create a BrowserWindow");
      }
      mainWindow.setContentSize(size.width, size.height, false);
      mainWindow.setResizable(false);
      return mainWindow.getContentSize();
    },
    { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT }
  );
};

const prepareAppState = async (page, locale, workspaceName) => {
  const ensureFilesTab = async () => {
    const activeTab = await page.locator("body").getAttribute("data-active-tab");
    if (activeTab !== "files") {
      await page.locator('[data-tab="files"]').click({ force: true });
    }
    await page.waitForSelector('body[data-active-tab="files"]', { timeout: 10_000 });
  };

  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: UI_LOCALE_STORAGE_KEY, value: locale }
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector("body.is-ready", { timeout: 20_000 });
  await dismissAnnouncements(page);

  const workspaceIsOpen = async () =>
    (await page.locator("#workspace-label").textContent().catch(() => ""))?.trim() === workspaceName;
  if (!(await workspaceIsOpen())) {
    await page.locator("#launcher-open").click({ timeout: 15_000 });
  }
  await waitFor(workspaceIsOpen, `workspace ${workspaceName}`, 20_000);
  await dismissAnnouncements(page);
  await page.waitForSelector(
    '.editor-tab[data-group="primary"][data-path="main.tex"].is-active',
    { timeout: 20_000 }
  );
  await page.waitForSelector(
    '[data-editor-group="primary"] .monaco-editor .view-line',
    { timeout: 20_000 }
  );

  // A clean Windows machine legitimately opens TeX environment settings when
  // no engine is installed yet. Return through the real Files tab before the
  // capture; the fixture PDF intentionally proves preview without installing
  // a multi-gigabyte TeX distribution on the runner.
  await ensureFilesTab();

  const splitEnabled = await page
    .locator("#editor-groups")
    .getAttribute("data-split")
    .catch(() => "false");
  if (splitEnabled !== "true") {
    await page.locator("#editor-split-button").click();
  }
  await page.waitForSelector('#editor-groups[data-split="true"]', { timeout: 10_000 });
  await page.locator('.file-item[data-path="main.pdf"]').click({ timeout: 15_000 });
  await page.waitForSelector(
    '.editor-tab[data-group="secondary"][data-path="main.pdf"].is-active',
    { timeout: 20_000 }
  );
  await page.waitForSelector('#editor-viewer-secondary[data-view="pdf"].is-visible', {
    timeout: 20_000,
  });

  const pdfFrame = page.frameLocator("#editor-viewer-pdf-secondary");
  const pdfCanvas = pdfFrame.locator('#pdf-pages .page[data-page-number="1"] canvas').first();
  await pdfFrame.locator("#pdf-status").waitFor({ state: "attached", timeout: 20_000 });
  await waitFor(
    async () => {
      const status = await pdfFrame.locator("#pdf-status").textContent().catch(() => "");
      if (status?.includes("失敗")) {
        throw new Error(`PDF viewer reported: ${status}`);
      }
      return pdfCanvas
        .evaluate((canvas) => canvas.width > 200 && canvas.height > 200)
        .catch(() => false);
    },
    "the rendered PDF page",
    25_000
  );

  // The embedded toolbar is hidden, but its actual Page control remains wired.
  // Activating it keeps the full A4 result visible beside the editor.
  await pdfFrame.locator("#pdf-fit-page").evaluate((button) => button.click());
  await waitFor(
    () => pdfCanvas.evaluate((canvas) => canvas.width > 200 && canvas.height > 200),
    "the page-fit PDF render",
    10_000
  );

  await dismissAnnouncements(page);
  await ensureFilesTab();

  await page.evaluate(async () => {
    await document.fonts.ready;
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
    const style = document.createElement("style");
    style.dataset.storeScreenshotStability = "true";
    style.textContent = `
      *, *::before, *::after { animation: none !important; transition: none !important; }
      .monaco-editor .cursor { visibility: hidden !important; }
    `;
    document.head.appendChild(style);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await pdfFrame.locator("body").evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForTimeout(500);

  const safety = await page.evaluate(() => {
    const visibleText = document.body.innerText;
    return {
      openModals: document.querySelectorAll(".modal.is-open, #announcement-modal.is-open").length,
      emailAddresses: visibleText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [],
      activeTab: document.body.dataset.activeTab ?? "",
      workspaceLabel: document.getElementById("workspace-label")?.textContent?.trim() ?? "",
      split: document.getElementById("editor-groups")?.dataset.split ?? "false",
    };
  });
  if (safety.openModals !== 0 || safety.emailAddresses.length !== 0) {
    throw new Error("Capture safety check found an open modal or visible email address");
  }
  if (
    safety.activeTab !== "files" ||
    safety.workspaceLabel !== workspaceName ||
    safety.split !== "true"
  ) {
    throw new Error(`Unexpected capture state: ${JSON.stringify(safety)}`);
  }
};

const closeElectronApp = async (electronApp) => {
  if (!electronApp) {
    return;
  }
  const child = typeof electronApp.process === "function" ? electronApp.process() : null;
  await Promise.race([
    electronApp.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child && !child.killed && child.exitCode == null) {
    child.kill("SIGKILL");
  }
};

const captureScreenshots = async (options) => {
  const { _electron: electron } = require("playwright");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-store-capture-"));
  const userDataPath = path.join(tempRoot, "user-data");
  const workspacePath = createDemoWorkspace(tempRoot);
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(options.outputDir, { recursive: true });

  const usingLocalElectron = !options.executablePath;
  const executablePath = options.executablePath ?? require("electron");
  const appDir = options.appDir ?? (usingLocalElectron ? PROJECT_ROOT : null);
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Electron executable does not exist: ${executablePath}`);
  }

  const launchArgs = ["--force-device-scale-factor=1", "--disable-background-networking"];
  if (appDir) {
    launchArgs.push(appDir);
  }
  const env = {
    ...sanitizeLaunchEnv(process.env),
    TEX64_ALLOW_MULTI_INSTANCE: "1",
    TEX64_E2E: "1",
    TEX64_E2E_USERDATA: userDataPath,
    TEX64_E2E_OPEN_WORKSPACE_PATH: workspacePath,
    TEX64_E2E_FORCE_HEADLESS: "1",
    TEX64_E2E_FORCE_MISSING_TOOLS: "latexmk,pdflatex,lualatex,xelatex",
    TEX64_E2E_IGNORE_SYSTEM_TEX: "1",
    TEX64_SKIP_STARTUP_WEB_BUILD: "1",
    NODE_ENV: "test",
    TZ: "UTC",
  };

  let electronApp = null;
  try {
    electronApp = await electron.launch({
      executablePath,
      args: launchArgs,
      env,
      timeout: 45_000,
    });
    const page = await electronApp.firstWindow({ timeout: 30_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("body.is-ready", { timeout: 20_000 });

    const runtime = await electronApp.evaluate(({ app }) => ({
      appName: app.getName(),
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    }));
    if (options.requirePackaged && runtime.isPackaged !== true) {
      throw new Error("Screenshot capture requires a packaged TeX64 executable");
    }
    if (options.requirePlatform && runtime.platform !== options.requirePlatform) {
      throw new Error(
        `Screenshot capture expected ${options.requirePlatform}, got ${runtime.platform}`
      );
    }

    const contentSize = await setCaptureWindowSize(electronApp);
    if (contentSize[0] !== CAPTURE_WIDTH || contentSize[1] !== CAPTURE_HEIGHT) {
      throw new Error(`Could not set ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT} content size: ${contentSize}`);
    }

    const captures = [];
    for (const locale of options.locales) {
      await prepareAppState(page, locale, path.basename(workspacePath));
      const localeTag = locale === "ja" ? "ja-JP" : "en-US";
      const fileName = `tex64-editor-pdf-${localeTag}-${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}.png`;
      const filePath = path.join(options.outputDir, fileName);
      await page.screenshot({
        path: filePath,
        type: "png",
        animations: "disabled",
        caret: "hide",
        scale: "css",
      });
      const dimensions = readPngSize(filePath);
      const byteLength = fs.statSync(filePath).size;
      if (dimensions.width !== CAPTURE_WIDTH || dimensions.height !== CAPTURE_HEIGHT) {
        throw new Error(
          `${fileName} is ${dimensions.width}x${dimensions.height}; expected ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}`
        );
      }
      if (byteLength < 50_000) {
        throw new Error(`${fileName} is unexpectedly small (${byteLength} bytes)`);
      }
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
      captures.push({ file: fileName, locale: localeTag, ...dimensions, byteLength, sha256 });
      console.log(`[store-screenshot] ${fileName} (${byteLength} bytes, sha256 ${sha256})`);
    }

    const manifest = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      runtime,
      source: "real Playwright Electron page screenshot",
      workspace: {
        label: path.basename(workspacePath),
        files: ["main.tex", "main.pdf"],
        containsUserData: false,
      },
      captures,
    };
    fs.writeFileSync(
      path.join(options.outputDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    return manifest;
  } finally {
    await closeElectronApp(electronApp);
    if (options.keepTemp) {
      console.log(`[store-screenshot] kept isolated fixture at ${tempRoot}`);
    } else {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  await captureScreenshots(options);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[store-screenshot] ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  createDemoPdf,
  parseArgs,
  readPngSize,
  sanitizeLaunchEnv,
};

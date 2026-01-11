import { test, expect, _electron as electron } from "@playwright/test";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs/promises";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const templateWorkspace = path.join(repoRoot, "test-workspace");

test.describe.configure({ mode: "serial" });

const copyWorkspace = async (targetPath) => {
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(targetPath, { recursive: true });
  await fs.cp(templateWorkspace, targetPath, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("__e2e__"),
  });
};

const launchApp = async (testInfo) => {
  const workspacePath = testInfo.outputPath("workspace");
  const userDataPath = testInfo.outputPath("userdata");
  await copyWorkspace(workspacePath);
  await fs.mkdir(userDataPath, { recursive: true });

  const env = {
    ...process.env,
    TEX180_E2E: "1",
    TEX180_E2E_WORKSPACE: workspacePath,
    TEX180_E2E_USERDATA: userDataPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot],
    cwd: repoRoot,
    env,
  });
  const existing = app.windows();
  const page = existing[0] ?? (await app.waitForEvent("window", { timeout: 60000 }));
  await page.waitForSelector("#file-tree .file-item");
  return { app, page };
};

const ensureEditorReady = async (page) => {
  await page.waitForFunction(() => {
    const editor = window.__tex64Editor;
    return !!editor && typeof editor.getValue === "function";
  });
};

const openMainTex = async (page) => {
  await page.evaluate(() => {
    window.tex64Bridge?.postMessage?.({ type: "openFile", path: "main.tex" });
  });
  await page.waitForFunction(() => {
    const value = window.__tex64Editor?.getValue?.() ?? "";
    return value.includes("\\documentclass");
  });
};

const resetEditor = async (page) => {
  await page.evaluate(() => {
    const editor = window.__tex64Editor;
    if (!editor) return;
    editor.setValue("");
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.setSelection({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    });
  });
};

const setOcrMock = async (page) => {
  await page.evaluate(() => {
    window.__tex64OcrMock = () => ({
      text: window.__tex64OcrLabel || "",
    });
  });
};

const setCaptureMock = async (page, imageDataUrl) => {
  await page.evaluate((dataUrl) => {
    const source = {
      id: "window:mock",
      title: "Mock Window",
      app: "MockApp",
      thumbnailUrl: dataUrl,
      width: 800,
      height: 600,
    };
    window.tex64Capture = {
      listSources: async () => [source],
    };
  }, imageDataUrl);
};

const waitForCropImageReady = async (page) => {
  await page.waitForFunction(() => {
    const img = document.getElementById("capture-crop-image");
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  });
};

const waitForEditorContains = async (page, expected) => {
  const timeoutMs = 60000;
  const start = Date.now();
  let lastStatus = "";
  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate(() => {
      const value = window.__tex64Editor?.getValue?.() ?? "";
      const status =
        document.getElementById("alchemy-status-line")?.textContent?.trim() ?? "";
      return { value, status };
    });
    lastStatus = result.status;
    if (result.value.includes(expected)) {
      return;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for "${expected}". status="${lastStatus}"`);
};

test("Alchemy capture inserts TeX from screenshot", async ({}, testInfo) => {
  test.setTimeout(90000);
  const { app, page } = await launchApp(testInfo);
  const sampleImageDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAIUlEQVQoU2NkYGD4z0AEYBxVSFUBCjFqDA0DAwAAM3sFzVra4S4AAAAASUVORK5CYII=";
  try {
    await ensureEditorReady(page);
    await openMainTex(page);
    await resetEditor(page);

    await page.click('.tab[data-tab="alchemy"]');
    await expect(page.locator('.tab[data-tab="alchemy"]')).toHaveAttribute(
      "aria-selected",
      "true"
    );

    await setOcrMock(page);
    await page.click("#alchemy-settings-button");
    await expect(page.locator("#alchemy-settings")).toHaveClass(/is-open/);
    await page.selectOption("#alchemy-ocr-language", "eng");

    await page.evaluate(() => {
      window.__tex64OcrLabel = "CAPTURE OCR OK";
    });
    await setCaptureMock(page, sampleImageDataUrl);

    await page.click("#alchemy-capture-button");
    await expect(page.locator("#capture-window-modal")).toHaveClass(/is-open/);
    await page.click("#capture-window-grid .capture-window-item");
    await expect(page.locator("#capture-crop-modal")).toHaveClass(/is-open/);
    await waitForCropImageReady(page);
    await page.evaluate(() => {
      document.getElementById("capture-crop-apply")?.click();
    });

    await waitForEditorContains(page, "CAPTURE OCR OK");
  } finally {
    await app.close();
  }
});

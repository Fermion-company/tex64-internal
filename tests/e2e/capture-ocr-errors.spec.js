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
  const page = await app.firstWindow();
  await page.waitForSelector("#file-tree .file-item");
  return { app, page };
};

const openIssuesTab = async (page) => {
  await page.click('.tab[data-tab="issues"]');
  await page.waitForSelector(".issue-item");
};

test("capture: listSources failure shows issue", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await page.evaluate(() => {
    if (!window.tex64Capture) {
      window.tex64Capture = {};
    }
    window.tex64Capture.listSources = async () => {
      throw new Error("capture failed");
    };
  });

  await page.click('.tab[data-tab="blocks"]');
  await page.waitForSelector("#block-capture-button");
  await page.click("#block-capture-button");

  await openIssuesTab(page);
  await expect(page.locator(".issue-message")).toContainText("ウィンドウ一覧の取得に失敗しました");
  await expect(page.locator(".issue-resolution")).toContainText("画面収録");
  await expect(page.locator(".issue-item")).toBeDisabled();

  await app.close();
});

test("ocr: failure shows issue and resolution", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  const imagePath = testInfo.outputPath("sample.png");
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
  await fs.writeFile(imagePath, Buffer.from(pngBase64, "base64"));

  await page.evaluate(() => {
    window.__tex64OcrMock = () => Promise.reject(new Error("OCRに失敗しました。"));
  });

  await page.click('.tab[data-tab="alchemy"]');
  await page.setInputFiles("#alchemy-file-input", imagePath);

  await openIssuesTab(page);
  await expect(page.locator(".issue-message")).toContainText("OCRに失敗しました");
  await expect(page.locator(".issue-resolution")).toContainText("画像");
  await expect(page.locator(".issue-item")).toBeDisabled();

  await app.close();
});

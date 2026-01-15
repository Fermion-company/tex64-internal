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

test("file ops: openFile error shows resolution", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await page.evaluate(() => {
    window.tex64OpenFileResult?.({
      path: "missing.tex",
      error: "ファイルを開けません。",
    });
  });

  await openIssuesTab(page);
  await expect(page.locator(".issue-message")).toContainText("ファイルを開けません");
  await expect(page.locator(".issue-resolution")).toContainText("ファイルの存在");
  await expect(page.locator(".issue-item")).toBeDisabled();

  await app.close();
});

test("file ops: save error shows resolution", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await page.evaluate(() => {
    window.tex64SaveResult?.({
      path: "main.tex",
      ok: false,
      error: "保存に失敗しました。",
    });
  });

  await openIssuesTab(page);
  await expect(page.locator(".issue-message")).toContainText("保存に失敗");
  await expect(page.locator(".issue-resolution")).toContainText("権限");
  await expect(page.locator(".issue-item")).toBeDisabled();

  await app.close();
});

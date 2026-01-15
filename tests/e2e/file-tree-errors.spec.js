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

const markMainTexDirty = async (page) => {
  await page.click('.file-item[data-path="main.tex"]');
  await page.evaluate(() => {
    const editor = window.__tex64Editor;
    if (!editor || typeof editor.getValue !== "function") {
      return;
    }
    const value = editor.getValue();
    editor.setValue(`${value}\n% dirty`);
  });
  await page.waitForSelector('.file-item[data-path="main.tex"].is-dirty');
};

test("file tree: invalid path shows issue", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await page.click('.file-item[data-path="main.tex"]', { button: "right" });
  await page.click('.context-menu-item:has-text("新しいファイル...")');
  await page.waitForSelector('#create-modal[aria-hidden="false"]');
  await page.fill("#create-modal-input", "../bad.tex");
  await page.click("#create-modal-submit");
  await page.click("#create-modal-cancel");

  await openIssuesTab(page);
  await expect(page.locator(".issue-message")).toContainText("親ディレクトリを含む名前は使えません");
  await expect(page.locator(".issue-resolution")).toContainText("相対パス");
  await expect(page.locator(".issue-item")).toBeDisabled();

  await app.close();
});

test("file tree: rename blocked when dirty", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await markMainTexDirty(page);

  await page.click('.file-item[data-path="main.tex"]', { button: "right" });
  await page.click('.context-menu-item:has-text("名前の変更...")');
  await page.waitForSelector('#rename-modal[aria-hidden="false"]');
  await page.click("#rename-modal-submit");
  await page.click("#rename-modal-cancel");

  await openIssuesTab(page);
  await expect(page.locator(".issue-message")).toContainText("未保存の変更があります。保存してから名前を変更してください。");
  await expect(page.locator(".issue-resolution")).toContainText("保存");

  await app.close();
});

test("file tree: move blocked when dirty", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await markMainTexDirty(page);

  const source = page.locator('.file-item[data-path="main.tex"]');
  const target = page.locator('details.file-folder[data-path="sections"] > summary');
  await source.dragTo(target);

  await openIssuesTab(page);
  await expect(page.locator(".issue-message")).toContainText("未保存の変更があります。移動前に保存してください。");
  await expect(page.locator(".issue-resolution")).toContainText("保存");

  await app.close();
});

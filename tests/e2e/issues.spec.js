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

const showIssues = async (page, payload) => {
  await page.evaluate((next) => {
    window.tex64UpdateIssues?.(next);
  }, payload);
  await page.click('.tab[data-tab="issues"]');
  await page.waitForSelector(".issue-item");
};

test("issues: path+line jumps to the line", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await showIssues(page, {
    count: 1,
    summary: "main.tex:5: test error",
    status: "error",
    issues: [{ severity: "error", message: "main.tex:5: test error" }],
  });

  const item = page.locator(".issue-item").first();
  await expect(item).toBeEnabled();
  await item.click();

  await page.waitForFunction(() => {
    const active = document.querySelector(".editor-tab.is-active");
    return active?.getAttribute("data-path") === "main.tex";
  });

  const position = await page.evaluate(() => {
    const editor = window.__tex64Editor;
    return editor?.getPosition?.() ?? null;
  });
  expect(position?.lineNumber).toBe(5);

  await app.close();
});

test("issues: path only opens the file", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await showIssues(page, {
    count: 1,
    summary: "file error",
    status: "error",
    issues: [
      {
        severity: "error",
        message: "ファイルに問題があります。",
        path: "notes/unformatted.tex",
      },
    ],
  });

  const item = page.locator(".issue-item").first();
  await expect(item).toBeEnabled();
  await item.click();

  await page.waitForFunction(() => {
    const active = document.querySelector(".editor-tab.is-active");
    return active?.getAttribute("data-path") === "notes/unformatted.tex";
  });

  await app.close();
});

test("issues: no location shows non-clickable with resolution", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await showIssues(page, {
    count: 1,
    summary: "ワークスペースが未選択です。",
    status: "error",
    issues: [{ severity: "error", message: "ワークスペースが未選択です。" }],
  });

  const item = page.locator(".issue-item").first();
  await expect(item).toBeDisabled();
  await expect(page.locator(".issue-hintline")).toHaveText("位置情報がないため移動できません");
  await expect(page.locator(".issue-resolution")).toContainText("フォルダを開く");

  await app.close();
});

test("issues: non-tex path in message is clickable", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await showIssues(page, {
    count: 1,
    summary: "refs.bib:2: test error",
    status: "error",
    issues: [{ severity: "error", message: "refs.bib:2: test error" }],
  });

  const item = page.locator(".issue-item").first();
  await expect(item).toBeEnabled();
  await item.click();

  await page.waitForFunction(() => {
    const active = document.querySelector(".editor-tab.is-active");
    return active?.getAttribute("data-path") === "refs.bib";
  });

  await app.close();
});

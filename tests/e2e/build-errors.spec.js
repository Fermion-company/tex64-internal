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

test("build: latexmk missing opens runtime settings", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await page.evaluate(() => {
    window.tex64UpdateIssues?.({
      count: 1,
      summary: "latexmk が見つかりません。TeX環境を確認してください。",
      status: "error",
      issues: [
        {
          severity: "error",
          message: "latexmk が見つかりません。TeX環境を確認してください。",
          action: "open-runtime",
        },
      ],
    });
  });

  await openIssuesTab(page);

  const item = page.locator(".issue-item").first();
  await expect(item).toHaveAttribute("data-action", "open-runtime");
  await expect(page.locator(".issue-resolution")).toContainText("Runtime");
  await item.click();

  await page.waitForFunction(() => {
    const tab = document.querySelector('.tab[data-tab="settings"]');
    return tab?.classList.contains("is-active");
  });

  await app.close();
});

test("build: compile error jumps to line", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await page.evaluate(() => {
    window.tex64UpdateIssues?.({
      count: 1,
      summary: "main.tex:7: Undefined control sequence",
      status: "error",
      issues: [
        {
          severity: "error",
          message: "main.tex:7: Undefined control sequence",
        },
      ],
    });
  });

  await openIssuesTab(page);
  await expect(page.locator(".issue-resolution")).toContainText("該当行");

  const item = page.locator(".issue-item").first();
  await item.click();

  await page.waitForFunction(() => {
    const active = document.querySelector(".editor-tab.is-active");
    return active?.getAttribute("data-path") === "main.tex";
  });

  const position = await page.evaluate(() => {
    const editor = window.__tex64Editor;
    return editor?.getPosition?.() ?? null;
  });
  expect(position?.lineNumber).toBe(7);

  await app.close();
});

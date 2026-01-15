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

test("ai: recent issues are included in agent context", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);

  await page.evaluate(() => {
    window.__tex64PostMessages = [];
    if (window.tex64Bridge) {
      window.tex64Bridge.postMessage = () => {};
    }
    window.tex64UpdateIssues?.({
      count: 1,
      summary: "latexmk が見つかりません。TeX環境を確認してください。",
      status: "error",
      issues: [
        {
          severity: "error",
          message: "latexmk が見つかりません。TeX環境を確認してください。",
        },
      ],
    });
  });

  await page.click('.tab[data-tab="ai"]');
  await page.waitForSelector(".ai-chat-item");
  await page.click(".ai-chat-item");
  await page.waitForSelector("#ai-input", { state: "visible" });
  await page.fill("#ai-input", "エラー原因を教えて");
  await page.click("#ai-send");

  const handle = await page.waitForFunction(() => {
    const log = window.__tex64PostMessages;
    if (!Array.isArray(log)) return null;
    const entry = log.find((item) => item?.type === "agent:run");
    return entry?.context ?? null;
  });
  const context = await handle.jsonValue();

  expect(context?.recentIssues?.[0]?.message).toContain("latexmk");
  expect(context?.recentIssues?.[0]?.resolution).toContain("Runtime");
  expect(context?.recentIssueSummary).toContain("latexmk");

  await app.close();
});

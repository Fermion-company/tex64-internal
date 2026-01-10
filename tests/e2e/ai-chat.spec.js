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

test("AI chat supports multiple conversations", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);
  try {
    await page.click('.tab[data-tab="ai"]');
    await expect(page.locator('.tab[data-tab="ai"]')).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await page.waitForSelector("#ai-chat-list .ai-chat-item[data-chat-id]");

    const chatItems = page.locator("#ai-chat-list .ai-chat-item[data-chat-id]");
    await expect(chatItems).toHaveCount(1);

    const firstChatId = "chat-test-1";
    const secondChatId = "chat-test-2";

    await page.evaluate(
      ({ firstChatId, secondChatId }) => {
        window.tex64AgentMessage?.({
          text: "First chat message",
          conversationId: firstChatId,
        });
        window.tex64AgentMessage?.({
          text: "Second chat message",
          conversationId: secondChatId,
        });
      },
      { firstChatId, secondChatId }
    );

    await expect(chatItems).toHaveCount(3);

    await page.click(`#ai-chat-list .ai-chat-item[data-chat-id="${secondChatId}"]`);
    await expect(page.locator(".ai-message")).toContainText("Second chat message");
    await expect(page.locator(".ai-message")).not.toContainText("First chat message");

    await page.click("#ai-chat .panel-button.ghost");
    await page.click(`#ai-chat-list .ai-chat-item[data-chat-id="${firstChatId}"]`);
    await expect(page.locator(".ai-message")).toContainText("First chat message");
    await expect(page.locator(".ai-message")).not.toContainText("Second chat message");

    await page.evaluate((chatId) => {
      window.tex64AgentProposal?.({
        proposal: {
          id: "proposal-1",
          path: "main.tex",
          content: "NEW",
          originalContent: "OLD",
          summary: "テスト提案",
          conversationId: chatId,
        },
      });
    }, firstChatId);

    await expect(page.locator(".ai-proposal")).toHaveCount(1);

    await page.click("#ai-chat .panel-button.ghost");
    await page.click(`#ai-chat-list .ai-chat-item[data-chat-id="${secondChatId}"]`);
    await expect(page.locator(".ai-proposal")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

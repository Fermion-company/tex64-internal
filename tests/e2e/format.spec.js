import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { openWorkspaceApp, workspaceRoot } from "./helpers.js";

const relativePath = "notes/unformatted.tex";
const filePath = path.join(workspaceRoot, relativePath);

const waitForBridgeMessage = (page, type, timeoutMs = 30000) =>
  page.evaluate(
    ({ messageType, timeout }) =>
      new Promise((resolve) => {
        const bridge = window.tex180Bridge;
        if (!bridge?.onMessage) {
          resolve(null);
          return;
        }
        const off = bridge.onMessage((message) => {
          if (message?.type === messageType) {
            clearTimeout(timer);
            off();
            resolve(message.payload);
          }
        });
        const timer = setTimeout(() => {
          off();
          resolve(null);
        }, timeout);
      }),
    { messageType: type, timeout: timeoutMs }
  );

test("format button formats and saves file", async () => {
  test.setTimeout(120000);
  const { electronApp, page } = await openWorkspaceApp();
  try {
    await page.waitForSelector(`button.file-item[data-path="${relativePath}"]`);
    await page.click(`button.file-item[data-path="${relativePath}"]`);
    await page.waitForSelector(`button.file-item[data-path="${relativePath}"].is-active`);

    const formatPromise = waitForBridgeMessage(page, "formatResult", 60000);
    await page.click("#format-button");
    const formatResult = await formatPromise;
    expect(formatResult?.ok).toBe(true);

    await expect
      .poll(() => fs.readFileSync(filePath, "utf8"), { timeout: 15000 })
      .toMatch(/\n  \\begin\{itemize\}\n/);
    await expect
      .poll(() => fs.readFileSync(filePath, "utf8"), { timeout: 15000 })
      .toMatch(/\n    \\item first\n/);
  } finally {
    await electronApp.close();
  }
});

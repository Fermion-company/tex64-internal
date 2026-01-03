import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { openWorkspaceApp, workspaceRoot } from "./helpers.js";

test("main tex selection toggles manual and auto detection", async () => {
  test.setTimeout(90000);
  const settingsDir = path.join(workspaceRoot, ".tex180");
  const hadSettingsDir = await fs
    .stat(settingsDir)
    .then(() => true)
    .catch(() => false);
  const { electronApp, page } = await openWorkspaceApp();
  try {
    await page.click('.tab[data-tab="settings"]');
    await page.waitForSelector('.panel[data-panel="settings"].is-active');
    await page.waitForFunction(() => {
      const select = document.getElementById("settings-root-select");
      return select instanceof HTMLSelectElement && select.options.length > 1;
    });
    await page.waitForFunction(() => {
      const select = document.getElementById("settings-root-select");
      return select instanceof HTMLSelectElement && !select.disabled;
    });

    await expect(page.locator("#settings-root-select")).toHaveValue("main.tex");
    await expect(page.locator("#settings-root-auto")).toHaveText("再検出");

    await page.selectOption("#settings-root-select", "sections/intro.tex");
    await page.waitForFunction(
      () => document.getElementById("issues-hint")?.textContent?.includes("メインTeXを更新しました")
    );
    await page.waitForFunction(() => {
      const select = document.getElementById("settings-root-select");
      return select instanceof HTMLSelectElement && select.value === "sections/intro.tex";
    });
    await expect(page.locator("#settings-root-auto")).toHaveText("自動に戻す");

    await page.evaluate(() => {
      const button = document.getElementById("settings-root-auto");
      if (button instanceof HTMLButtonElement) {
        button.click();
      }
    });
    await page.waitForFunction(() => {
      const select = document.getElementById("settings-root-select");
      return select instanceof HTMLSelectElement && select.value === "main.tex";
    });
    await expect(page.locator("#settings-root-auto")).toHaveText("再検出");
  } finally {
    await electronApp.close();
    if (!hadSettingsDir) {
      await fs.rm(settingsDir, { recursive: true, force: true });
    }
  }
});

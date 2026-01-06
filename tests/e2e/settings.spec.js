import { test, expect } from "@playwright/test";
import { openWorkspaceApp } from "./helpers.js";

test.describe("Settings & Environment Setup", () => {
  test("Persists engine selection and settings buttons are clickable", async () => {
    const { electronApp, page } = await openWorkspaceApp();
    try {
      await page.click('.tab[data-tab="settings"]');
      await page.waitForSelector('.panel[data-panel="settings"].is-active');

      await expect(page.locator('.env-item[data-env="lualatex"]')).toBeVisible();
      await expect(page.locator('.env-item[data-env="latexmk"]')).toBeVisible();

      const engineSelect = page.locator("#settings-compile-engine");
      await expect(engineSelect).toBeVisible();

      await engineSelect.selectOption("xelatex");
      const savedEngine = await page.evaluate(() => localStorage.getItem("tex180.compileEngine"));
      expect(savedEngine).toBe("xelatex");
      await expect(engineSelect).toHaveValue("xelatex");

      await page.reload();
      await page.waitForSelector('.tab[data-tab="settings"]');
      await page.click('.tab[data-tab="settings"]');
      await expect(page.locator("#settings-compile-engine")).toHaveValue("xelatex");

      const panelBody = page.locator('.panel[data-panel="settings"] .panel-body');
      await panelBody.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });

      const buttons = page.locator('.panel[data-panel="settings"] button');
      const count = await buttons.count();
      for (let i = 0; i < count; i += 1) {
        const button = buttons.nth(i);
        if (await button.isVisible()) {
          await button.click();
        }
      }

      await page.evaluate(() => {
        localStorage.setItem("tex180.compileEngine", "lualatex");
      });
    } finally {
      await electronApp.close();
    }
  });
});

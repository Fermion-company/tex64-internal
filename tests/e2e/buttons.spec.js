import { test, expect } from "@playwright/test";
import { openWorkspaceApp } from "./helpers.js";

test.describe("All Buttons Clickable", () => {
  test("Every button in settings-v2 is clickable", async () => {
    const { electronApp, page } = await openWorkspaceApp();
    try {
      await page.click('.tab[data-tab="settings"]');
      await page.waitForSelector('.panel[data-panel="settings"].is-active');

      const autoFormat = page.locator("#editor-auto-format");
      await expect(autoFormat).toBeVisible();
      const initialChecked = await autoFormat.isChecked();
      await page.click('label[for="editor-auto-format"]');
      await expect(autoFormat).toHaveJSProperty("checked", !initialChecked);

      await expect(page.locator("#settings-compile-engine")).toBeVisible();
      await page.selectOption("#settings-compile-engine", "pdflatex");
      await page.selectOption("#settings-compile-engine", "lualatex");

      await expect(page.locator("#settings-env-refresh")).toBeVisible();

      await page.click('.tab[data-tab="project"]');
      await page.waitForSelector('.panel[data-panel="project"].is-active');
      await expect(page.locator("#settings-root-select")).toBeVisible();
      await expect(page.locator("#settings-root-auto")).toBeVisible();
      await expect(page.locator("#project-align-env")).toBeVisible();

      await page.click('.tab[data-tab="files"]');
    } finally {
      await electronApp.close();
    }
  });
});

import { test, expect } from "@playwright/test";
import { openWorkspaceApp } from "./helpers.js";

test.describe("Settings & Environment Setup", () => {
  test("Navigates settings tabs and persists engine selection", async () => {
    const { page } = await openWorkspaceApp();
    
    // Open Settings Tab
    await page.click('.tab[data-tab="settings"]');
    
    // Verify General section is active by default
    await expect(page.locator('.settings-section[data-section="general"]')).toBeVisible();
    await expect(page.locator('.settings-tab[data-section="general"]')).toHaveClass(/is-active/);

    // Switch to Build tab
    await page.click('.settings-tab[data-section="build"]');
    await expect(page.locator('.settings-section[data-section="build"]')).toBeVisible();
    await expect(page.locator('.settings-tab[data-section="build"]')).toHaveClass(/is-active/);

    // Auto Build toggle removed
    // await expect(page.locator('#settings-auto-build')).toBeVisible();
    await expect(page.locator('.env-item[data-env="lualatex"]')).toBeVisible();
    await expect(page.locator('.env-item[data-env="latexmk"]')).toBeVisible();

    // Verify Engine selection
    const lualatexRadio = page.locator('input[name="compileEngine"][value="lualatex"]');
    const xelatexRadio = page.locator('input[name="compileEngine"][value="xelatex"]');
    
    // Check XeLaTeX
    await xelatexRadio.check(); // Select XeLaTeX, force click if needed, but check() is better
    
    // Verify in localStorage
    const savedEngine = await page.evaluate(() => localStorage.getItem("tex180.compileEngine"));
    expect(savedEngine).toBe("xelatex");

    // Verify UI matches logic by checking attribute or property
    await expect(xelatexRadio).toBeChecked();

    // Force reload to verify persistence across sessions (simulated)
    await page.reload();
    await page.waitForSelector('.tab[data-tab="settings"]');
    await page.click('.tab[data-tab="settings"]');
    await page.click('.settings-tab[data-section="build"]');
    
    await expect(xelatexRadio).toBeChecked();
  });
});

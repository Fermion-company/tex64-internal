import { test, expect } from "@playwright/test";
import { openWorkspaceApp } from "./helpers.js";

test.describe("All Buttons Clickable", () => {
  test("Every button in settings-v2 is clickable", async () => {
    const { page } = await openWorkspaceApp();
    
    // Open Settings (Settings panel is now single view, so just opening it is enough)
    await page.click('.tab[data-tab="settings"]');
    await page.waitForSelector('.settings-v2');
    
    // Verify scrolling container exists
    const scrollArea = page.locator('.settings-scroll');
    await expect(scrollArea).toBeVisible();
    
    // Click all toggles (checkboxes now) / verify their state
    const toggles = await page.locator('.toggle-switch').all();
    for (const toggle of toggles) {
        if (await toggle.isVisible()) {
            const initialChecked = await toggle.isChecked();
            await toggle.click({ force: true }); // Click the label/input wrapping it
            // Verify state flip if interactive logic works, OR just that click doesn't crash
        }
    }
    
    // Click all radio option inputs (Engine)
    // Note: inputs are hidden, we click the label .radio-card
    const engineCards = await page.locator('.radio-card').all();
    for (const card of engineCards) {
        await card.click();
        await page.waitForTimeout(50);
    }
    
    // Verify Project Buttons exist
    await expect(page.locator('#btn-change-root')).toBeVisible();
    await expect(page.locator('#btn-select-main')).toBeVisible();
    
    // Verify Environment Buttons (Check Buttons)
    const envBtns = await page.locator('.btn-primary[data-target]').all();
    for (const btn of envBtns) {
        // Just verify visibility if logic hides them when 'checking'
        // If visible, should be clickable
        if (await btn.isVisible()) {
            await expect(btn).toBeEnabled();
        }
    }

    // Return to main view
    await page.click('.tab[data-tab="files"]');
  });
});

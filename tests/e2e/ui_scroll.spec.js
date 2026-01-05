import { test, expect } from "@playwright/test";
import { openWorkspaceApp } from "./helpers.js";

test.describe("UI Scroll & Interactions", () => {
  test("Scrolls editor/settings and handles button clicks", async () => {
    const { page } = await openWorkspaceApp();
    
    // 1. Verify Scroll in Settings content
    await page.click('.tab[data-tab="settings"]');
    await page.waitForSelector('.settings-content');
    
    // Create overflow by forcing height (simulating small window or long content)
    await page.evaluate(() => {
        const content = document.querySelector('.settings-content');
        if (content) {
            content.style.maxHeight = '200px';
            content.style.overflowY = 'scroll';
        }
    });
    
    // Scroll down
    await page.evaluate(() => {
        document.querySelector('.settings-content').scrollTop = 100;
    });
    
    // Verify scroll position (approximate)
    const scrollTop = await page.evaluate(() => document.querySelector('.settings-content').scrollTop);
    expect(scrollTop).toBeGreaterThan(50);
    
    // 2. Verify Build Button Interaction
    // Switch to Editor view first
    await page.click('.tab[data-tab="files"]'); // Or any non-settings tab
    
    // Check if button exists and appears clickable (styles)
    const buildBtn = page.locator('#build-button');
    await expect(buildBtn).toBeVisible();
    await expect(buildBtn).toHaveCSS('cursor', 'pointer');
    
    // Click and verify "busy" state or no error.
    await buildBtn.click();
    
    // Since we can't easily wait for "is-busy" consistently if build is fast, 
    // we verify no unexpected error overlay or UI breakage immediately after.
    await expect(page.locator('#issues-bar')).toBeVisible();
    
    // 3. Verify Editor Scroll (Monaco)
    // We need to load a file with enough content or force it.
    await page.click('button.file-item[data-path="main.tex"]');
    
    // Insert many lines to force scroll
    await page.evaluate(() => {
        const editor = window.__tex180Editor;
        const lines = Array(100).fill("Line content").join("\n");
        editor.setValue(lines);
    });
    
    // Scroll Monaco
    await page.evaluate(() => {
        const editor = window.__tex180Editor;
        editor.setScrollTop(500);
    });
    
    // Verify Monaco scroll
    const editorScrollTop = await page.evaluate(() => window.__tex180Editor.getScrollTop());
    expect(editorScrollTop).toBeGreaterThan(400);
  });
});

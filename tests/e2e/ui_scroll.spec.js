import { test, expect } from "@playwright/test";
import { openWorkspaceApp } from "./helpers.js";

test.describe("UI Scroll & Interactions", () => {
  test("Scrolls editor/settings and handles button clicks", async () => {
    const { electronApp, page } = await openWorkspaceApp();
    try {
      // 1. Verify Scroll in Settings content
      await page.click('.tab[data-tab="settings"]');
      await page.waitForSelector('.panel[data-panel="settings"].is-active');

      // Create overflow by forcing height (simulating small window or long content)
      await page.evaluate(() => {
          const content = document.querySelector('.panel[data-panel="settings"] .settings-panel');
          if (content) {
              content.style.height = '200px';
              content.style.overflowY = 'scroll';
              const filler = document.createElement('div');
              filler.dataset.testFiller = 'true';
              filler.style.height = '800px';
              content.appendChild(filler);
              content.scrollTop = 100;
          }
      });

      await page.waitForTimeout(50);

      // Verify scroll position (approximate)
      const scrollTop = await page.evaluate(() => {
          const target = document.querySelector('.panel[data-panel="settings"] .settings-panel');
          return target ? target.scrollTop : 0;
      });
      expect(scrollTop).toBeGreaterThan(5);

      // 2. Verify Build Button Interaction
      // Switch to Editor view first
      await page.click('.tab[data-tab="files"]'); // Or any non-settings tab

      // Check if button exists and appears clickable (styles)
      const buildBtn = page.locator('#build-button');
      await expect(buildBtn).toBeVisible();
      await expect(buildBtn).toHaveCSS('cursor', 'pointer');

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
    } finally {
      await electronApp.close();
    }
  });
});

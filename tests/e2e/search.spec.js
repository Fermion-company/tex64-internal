
import { test, expect } from "@playwright/test";
import { openWorkspaceApp } from "./helpers.js";

test.describe.serial("Search", () => {
  let electronApp;
  let page;

  test.beforeAll(async () => {
    ({ electronApp, page } = await openWorkspaceApp());
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test("search returns results and renders grouped by file", async () => {
    // Open Search Tab
    await page.click('.tab[data-tab="search"]');
    await page.waitForSelector('.panel[data-panel="search"].is-active');

    // Perform Search for "oi" (based on user screenshot)
    await page.fill("#search-input", "oi");
    await page.click("#search-button");

    // Wait for grouped results
    await page.waitForSelector(".search-file-group");
    await page.waitForSelector(".search-match-item");

    // Check grouping structure
    const groups = await page.$$(".search-file-group");
    expect(groups.length).toBeGreaterThan(0);

    const headers = await page.$$(".search-file-header");
    expect(headers.length).toBeGreaterThan(0);

    // Verify .tex files only
    const headerTexts = await Promise.all(headers.map(h => h.textContent()));
    for (const text of headerTexts) {
      expect(text.trim()).toMatch(/\.tex$/);
    }
    
    // Check match content
    const items = await page.$$(".search-match-item");
    expect(items.length).toBeGreaterThan(0);
  });
});

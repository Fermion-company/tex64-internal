import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  openWorkspaceApp,
  workspaceRoot,
  repoRoot,
  writeTestPdf,
} from "./helpers.js";

test("synctex auto forward toggle on build", async () => {
  test.setTimeout(60000);
  const stubPath = path.join(
    repoRoot,
    "tests",
    "e2e",
    "fixtures",
    "bin",
    "synctex"
  );
  const { electronApp, page } = await openWorkspaceApp({
    TEX180_E2E_SYNCTEX_PATH: stubPath,
  });

  try {
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
      window.__tex180SetLastBuildMainFile?.("main.tex");
    });

    await page.click('.tab[data-tab="settings"]');
    const autoToggle = page.locator("#editor-auto-synctex-build");
    if (!(await autoToggle.isChecked())) {
      await autoToggle.click();
    }
    await page.click('.tab[data-tab="files"]');

    await page.evaluate(() => {
      window.__tex180PostMessages.length = 0;
    });
    await page.evaluate(() => window.tex180SetBuildState({ state: "success" }));
    await page.waitForFunction(() =>
      window.__tex180PostMessages.some((message) => message.type === "synctex:forward")
    );

    await page.evaluate(() => {
      window.__tex180PostMessages.length = 0;
    });
    await page.click('.tab[data-tab="settings"]');
    if (await autoToggle.isChecked()) {
      await autoToggle.click();
    }
    await page.click('.tab[data-tab="files"]');
    await page.waitForTimeout(500);
    const forwardCount = await page.evaluate(() =>
      window.__tex180PostMessages.filter((message) => message.type === "synctex:forward").length
    );
    expect(forwardCount).toBe(0);
    await expect(page.locator("#synctex-button")).toHaveCount(0);
  } finally {
    await electronApp.close();
  }
});

test("synctex reverse from pdf viewer click", async () => {
  test.setTimeout(60000);
  const pdfPath = path.join(workspaceRoot, "reverse.pdf");
  await writeTestPdf(pdfPath, { width: 220, height: 180, pages: 1, textPrefix: "REVERSE" });

  const stubPath = path.join(
    repoRoot,
    "tests",
    "e2e",
    "fixtures",
    "bin",
    "synctex"
  );
  const { electronApp, page } = await openWorkspaceApp({
    TEX180_E2E_SYNCTEX_PATH: stubPath,
  });

  try {
    const pdfWindowPromise = electronApp.waitForEvent("window");
    await page.evaluate(() => {
      window.tex180Bridge.postMessage({
        type: "synctex:forward",
        path: "main.tex",
        line: 1,
        column: 1,
        pdfPath: "reverse.pdf",
      });
    });

    const pdfWindow = await pdfWindowPromise;
    await pdfWindow.waitForLoadState("domcontentloaded");
    await pdfWindow.waitForFunction(
      () => document.querySelectorAll("#pdf-pages .page").length > 0
    );

    await pdfWindow.click(".page", { position: { x: 120, y: 120 } });
    await expect(pdfWindow.locator("#pdf-jump-button")).toHaveClass(/is-visible/);

    const reversePromise = page.evaluate(() =>
      new Promise((resolve) => {
        const off = window.tex180Bridge.onMessage((message) => {
          if (message?.type === "synctex:reverseResult") {
            off();
            resolve(message.payload);
          }
        });
      })
    );

    await pdfWindow.click("#pdf-jump-button");
    const reverseResult = await reversePromise;
    expect(reverseResult?.ok).toBe(true);
    expect(reverseResult?.path).toBe("main.tex");
    expect(reverseResult?.line).toBe(3);

    await page.waitForFunction(() => {
      const editor = window.__tex180Editor;
      return editor && editor.getPosition?.().lineNumber === 3;
    });
  } finally {
    await electronApp.close();
    await fs.unlink(pdfPath).catch(() => {});
  }
});

import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  openWorkspaceApp,
  workspaceRoot,
  repoRoot,
  writeTestPdf,
} from "./helpers.js";

test("pdf preview renders in editor", async () => {
  test.setTimeout(60000);
  const pdfPath = path.join(workspaceRoot, "sample.pdf");
  await writeTestPdf(pdfPath, { width: 200, height: 200, pages: 1, textPrefix: "PREVIEW" });

  const { electronApp, page } = await openWorkspaceApp();

  try {
    await page.waitForSelector('button.file-item[data-path="sample.pdf"]');
    await page.click('button.file-item[data-path="sample.pdf"]');
    await page.waitForSelector('#editor-viewer[data-view="pdf"]');
    const viewerSrc = await page.getAttribute("#editor-viewer-pdf", "src");
    expect(viewerSrc?.startsWith("blob:")).toBe(true);
    await expect(page.locator("#editor")).toHaveClass(/is-hidden/);
  } finally {
    await electronApp.close();
    await fs.unlink(pdfPath).catch(() => {});
  }
});

test("pdf viewer reload and sync marker", async () => {
  test.setTimeout(60000);
  const pdfPath = path.join(workspaceRoot, "viewer-sample.pdf");
  await writeTestPdf(pdfPath, { width: 320, height: 200, pages: 2, textPrefix: "HELLO-PDF" });

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
        pdfPath: "viewer-sample.pdf",
      });
    });

    const pdfWindow = await pdfWindowPromise;
    await pdfWindow.waitForLoadState("domcontentloaded");
    await expect(pdfWindow.locator("#pdf-status")).toHaveText(/準備完了/);
    await pdfWindow.waitForFunction(
      () => document.querySelectorAll("#pdf-pages .page").length > 0
    );
    await expect(pdfWindow.locator("#pdf-title")).toContainText("viewer-sample.pdf");
    await pdfWindow.waitForSelector(".pdf-sync-marker");

    await expect(pdfWindow.locator("#pdf-fit-width")).toHaveCount(0);
    await expect(pdfWindow.locator("#pdf-fit-page")).toHaveCount(0);
    await expect(pdfWindow.locator("#pdf-zoom-in")).toHaveCount(0);
    await expect(pdfWindow.locator("#pdf-zoom-out")).toHaveCount(0);
    await expect(pdfWindow.locator("#pdf-download")).toHaveCount(0);
    await expect(pdfWindow.locator("#pdf-print")).toHaveCount(0);

    await pdfWindow.click("#pdf-reload");
    await expect(pdfWindow.locator("#pdf-status")).toHaveText(/準備完了/);
  } finally {
    await electronApp.close();
    await fs.unlink(pdfPath).catch(() => {});
  }
});

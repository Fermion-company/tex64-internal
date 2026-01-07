import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { openWorkspaceApp, workspaceRoot } from "./helpers.js";

const mainTexPath = path.join(workspaceRoot, "main.tex");

const readMarkerLines = () => {
  const content = fs.readFileSync(mainTexPath, "utf8");
  const lines = content.split(/\r?\n/);
  const map = new Map();
  lines.forEach((line, index) => {
    const match = line.match(/% TEST: (.+)/);
    if (match) {
      map.set(match[1].trim(), index + 1);
    }
  });
  return map;
};

const waitForBridgeMessage = (page, type, timeoutMs = 40000) =>
  page.evaluate(
    ({ messageType, timeout }) =>
      new Promise((resolve) => {
        const bridge = window.tex180Bridge;
        if (!bridge?.onMessage) {
          resolve(null);
          return;
        }
        const off = bridge.onMessage((message) => {
          if (message?.type === messageType) {
            clearTimeout(timer);
            off();
            resolve(message.payload);
          }
        });
        const timer = setTimeout(() => {
          off();
          resolve(null);
        }, timeout);
      }),
    { messageType: type, timeout: timeoutMs }
  );

const setEditorLine = async (page, line) => {
  await page.evaluate((lineNumber) => {
    const editor = window.__tex180Editor;
    if (!editor?.setPosition) return;
    editor.setPosition({ lineNumber, column: 1 });
    editor.revealLineInCenter?.(lineNumber);
  }, line);
};

const buildAndWaitForward = async (page, label, line) => {
  await page.waitForSelector("#build-button:not(.is-busy)");
  await page.click('button.file-item[data-path="main.tex"]');
  await page.waitForSelector('button.file-item[data-path="main.tex"].is-active');
  await setEditorLine(page, line);
  const forwardPromise = waitForBridgeMessage(page, "synctex:forwardResult", 70000);
  await page.click("#build-button");
  const forwardResult = await forwardPromise;
  expect(forwardResult?.ok, `forward failed for ${label}`).toBe(true);
  return forwardResult;
};

const waitForInlinePdfSync = async (page, pageNumber) =>
  page.waitForFunction(
    (targetPage) => {
      const frame = document.getElementById("editor-viewer-pdf");
      const lastSync = frame?.contentWindow?.__tex180PdfViewer?.state?.lastSync;
      return lastSync?.page === targetPage;
    },
    pageNumber,
    { timeout: 30000 }
  );

const isPdfWindow = async (win) => {
  if (!win || win.isClosed()) {
    return false;
  }
  const url = win.url();
  if (url && url.includes("pdf-viewer.html")) {
    return true;
  }
  try {
    return await win.evaluate(() => Boolean(window.tex180Pdf));
  } catch {
    return false;
  }
};

const waitForPdfWindow = async (electronApp, timeoutMs = 20000) => {
  const existing = electronApp.windows().filter((win) => !win.isClosed());
  for (const candidate of existing) {
    if (await isPdfWindow(candidate)) {
      return candidate;
    }
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const candidate = await electronApp
      .waitForEvent("window", { timeout: 1000 })
      .catch(() => null);
    if (candidate && !candidate.isClosed()) {
      await candidate.waitForLoadState("domcontentloaded").catch(() => {});
      if (await isPdfWindow(candidate)) {
        return candidate;
      }
    }
  }
  throw new Error("PDF window not found");
};

const waitForPdfReady = async (pdfWindow) => {
  await pdfWindow.waitForLoadState("domcontentloaded");
  await pdfWindow.waitForFunction(
    () => document.querySelectorAll("#pdf-pages .page").length > 0,
    { timeout: 20000 }
  );
  await expect(pdfWindow.locator("#pdf-status")).toHaveText(/準備完了/);
};

const waitForPdfSync = async (pdfWindow, pageNumber) =>
  pdfWindow.waitForFunction(
    (pageNo) => {
      const lastSync = window.__tex180PdfViewer?.state?.lastSync;
      return lastSync?.page === pageNo;
    },
    pageNumber,
    { timeout: 20000 }
  );

const ensureSettings = async (page) => {
  await page.click('.tab[data-tab="settings"]');
  const autoFormatToggle = page.locator("#editor-auto-format");
  if (await autoFormatToggle.count()) {
    if (await autoFormatToggle.isChecked()) {
      await autoFormatToggle.click();
    }
  }
  await page.click('.tab[data-tab="files"]');
};

const setPdfViewerMode = async (page, mode) => {
  await page.click('.tab[data-tab="settings"]');
  const toggle = page.locator("#editor-pdf-window");
  const shouldBeChecked = mode === "window";
  if ((await toggle.isChecked()) !== shouldBeChecked) {
    await toggle.click();
  }
  await page.click('.tab[data-tab="files"]');
};

test("synctex forward with embedded viewer + fallback, then window mode", async () => {
  test.setTimeout(900000);
  const markerLines = readMarkerLines();
  const getLine = (marker, offset = 1) => {
    const line = markerLines.get(marker);
    if (!line) {
      throw new Error(`Marker not found: ${marker}`);
    }
    return line + offset;
  };
  const forwardTargets = [
    { marker: "section-text" },
    { marker: "paragraph" },
    { marker: "subparagraph" },
    { marker: "inline-math" },
    { marker: "equation" },
    { marker: "alignat" },
    { marker: "gather" },
    { marker: "multline" },
    { marker: "cases" },
    { marker: "array" },
    { marker: "itemize" },
    { marker: "enumerate" },
    { marker: "description" },
    { marker: "quote" },
    { marker: "verbatim" },
    { marker: "table" },
    { marker: "figure" },
    { marker: "fallback", offset: 0, expectFallback: true },
  ];

  const { electronApp, page } = await openWorkspaceApp();
  try {
    await page.click('button.file-item[data-path="main.tex"]');
    await page.waitForSelector('button.file-item[data-path="main.tex"].is-active');
    await ensureSettings(page);

    await setPdfViewerMode(page, "tab");

    for (const target of forwardTargets) {
      const line = getLine(target.marker, target.offset ?? 1);
      const forwardResult = await buildAndWaitForward(page, target.marker, line);
      await waitForInlinePdfSync(page, forwardResult.page);
      if (target.expectFallback) {
        expect(forwardResult.fallback).toBe(true);
      }
    }

    await setPdfViewerMode(page, "window");
    const windowTarget = forwardTargets[0];
    const windowLine = getLine(windowTarget.marker, windowTarget.offset ?? 1);
    const windowForward = await buildAndWaitForward(page, "window-mode", windowLine);
    const pdfWindow = await waitForPdfWindow(electronApp);
    await waitForPdfReady(pdfWindow);
    await waitForPdfSync(pdfWindow, windowForward.page);
  } finally {
    await electronApp.close();
  }
});

test("sidebar context menu toggles primary tabs", async () => {
  const { electronApp, page } = await openWorkspaceApp();
  try {
    const gitTab = page.locator('.tab[data-tab="git"]');
    if (!(await gitTab.isVisible())) {
      await page.click(".sidebar", { button: "right" });
      await page.locator(".context-menu-item", { hasText: "Git" }).click();
      await expect(gitTab).toBeVisible();
    }
    await page.click('.tab[data-tab="git"]');
    await page.click(".sidebar", { button: "right" });
    await page.locator(".context-menu-item", { hasText: "Git" }).click();
    await expect(gitTab).toHaveClass(/is-hidden/);
    await page.click(".sidebar", { button: "right" });
    await page.locator(".context-menu-item", { hasText: "Git" }).click();
    await expect(gitTab).not.toHaveClass(/is-hidden/);
  } finally {
    await electronApp.close();
  }
});

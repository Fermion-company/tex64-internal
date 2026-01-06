import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { openWorkspaceApp, workspaceRoot, setEditorContent } from "./helpers.js";

test("file edit marks dirty and save clears state", async () => {
  test.setTimeout(90000);
  const targetPath = "notes/results.tex";
  const { electronApp, page } = await openWorkspaceApp();
  try {
    await page.click(`button.file-item[data-path="${targetPath}"]`);
    await page.waitForSelector(
      `button.file-item[data-path="${targetPath}"].is-active`
    );

    const original = await page.evaluate(() => window.__tex180Editor.getValue());
    const updated = `${original}\nE2E_EDIT`;
    await setEditorContent(page, updated);
    await page.waitForFunction(
      (pathValue) =>
        document
          .querySelector(`button.file-item[data-path="${pathValue}"]`)
          ?.classList.contains("is-dirty"),
      targetPath
    );
    await page.waitForFunction(
      (pathValue) =>
        document
          .querySelector(`button.editor-tab[title="${pathValue}"]`)
          ?.classList.contains("is-dirty"),
      targetPath
    );

    await page.evaluate((pathValue) => {
      window.__e2eSaveResult = null;
      const content = window.__tex180Editor?.getValue?.() ?? "";
      window.tex180Bridge?.onMessage?.((message) => {
        if (message?.type === "saveResult" && message.payload?.path === pathValue) {
          window.__e2eSaveResult = message.payload;
        }
      });
      window.tex180Bridge?.postMessage?.({
        type: "saveFile",
        path: pathValue,
        content,
        format: false,
        formatSource: "e2e",
      });
    }, targetPath);
    await page.waitForFunction(
      () => window.__e2eSaveResult && window.__e2eSaveResult.ok === true
    );
    await page.waitForFunction(
      (pathValue) =>
        !document
          .querySelector(`button.file-item[data-path="${pathValue}"]`)
          ?.classList.contains("is-dirty"),
      targetPath
    );
    await page.waitForFunction(
      (pathValue) =>
        !document
          .querySelector(`button.editor-tab[title="${pathValue}"]`)
          ?.classList.contains("is-dirty"),
      targetPath
    );

    const saved = await fs.readFile(path.join(workspaceRoot, targetPath), "utf8");
    expect(saved).toContain("E2E_EDIT");

    await setEditorContent(page, original);
    await page.waitForFunction(
      (pathValue) =>
        document
          .querySelector(`button.file-item[data-path="${pathValue}"]`)
          ?.classList.contains("is-dirty"),
      targetPath
    );
    await page.evaluate((pathValue) => {
      window.__e2eSaveResult = null;
      const content = window.__tex180Editor?.getValue?.() ?? "";
      window.tex180Bridge?.onMessage?.((message) => {
        if (message?.type === "saveResult" && message.payload?.path === pathValue) {
          window.__e2eSaveResult = message.payload;
        }
      });
      window.tex180Bridge?.postMessage?.({
        type: "saveFile",
        path: pathValue,
        content,
        format: false,
        formatSource: "e2e",
      });
    }, targetPath);
    await page.waitForFunction(
      () => window.__e2eSaveResult && window.__e2eSaveResult.ok === true
    );
    await page.waitForFunction(
      (pathValue) =>
        !document
          .querySelector(`button.file-item[data-path="${pathValue}"]`)
          ?.classList.contains("is-dirty"),
      targetPath
    );
    const reverted = await fs.readFile(path.join(workspaceRoot, targetPath), "utf8");
    expect(reverted).toBe(original);
  } finally {
    await electronApp.close();
  }
});

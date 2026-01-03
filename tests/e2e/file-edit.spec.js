import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { openWorkspaceApp, workspaceRoot, setEditorContent } from "./helpers.js";

test("file edit marks dirty and save clears state", async () => {
  test.setTimeout(90000);
  const targetPath = "notes/keywords.txt";
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

    await page.click("#save-file-button");
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
    await page.click("#save-file-button");
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

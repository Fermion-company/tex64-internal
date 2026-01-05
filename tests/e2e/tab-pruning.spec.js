import { test, expect } from "@playwright/test";
import { openWorkspaceApp, setEditorContent } from "./helpers.js";

const waitForTab = (page, path) =>
  page.waitForSelector(`button.editor-tab[title="${path}"]`);

const waitForNoTab = (page, path) =>
  page.waitForFunction(
    (value) => !document.querySelector(`button.editor-tab[title="${value}"]`),
    path
  );

test("auto closes non-pinned tabs when switching files", async () => {
  test.setTimeout(90000);
  const { electronApp, page } = await openWorkspaceApp();
  try {
    await page.click('button.file-item[data-path="main.tex"]');
    await waitForTab(page, "main.tex");

    await page.click('button.file-item[data-path="refs.bib"]');
    await waitForTab(page, "refs.bib");
    await page.waitForFunction(
      () =>
        !!document.querySelector('button.editor-tab[title="main.tex"]') &&
        !!document.querySelector('button.editor-tab[title="refs.bib"]')
    );

    await page.click('button.file-item[data-path="notes/keywords.txt"]');
    await waitForTab(page, "notes/keywords.txt");

    await page.click('button.file-item[data-path="sections/intro.tex"]');
    await waitForTab(page, "sections/intro.tex");

    await waitForNoTab(page, "notes/keywords.txt");
    await expect(page.locator('button.editor-tab[title="refs.bib"]')).toHaveCount(
      1
    );
  } finally {
    await electronApp.close();
  }
});

test("dirty pinned tabs close when another file is opened", async () => {
  test.setTimeout(90000);
  const { electronApp, page } = await openWorkspaceApp();
  try {
    await page.click('button.file-item[data-path="main.tex"]');
    await waitForTab(page, "main.tex");
    const original = await page.evaluate(() => window.__tex180Editor.getValue());
    await setEditorContent(page, `${original}\nE2E_DIRTY`);
    await page.waitForFunction(
      (pathValue) =>
        document
          .querySelector(`button.file-item[data-path="${pathValue}"]`)
          ?.classList.contains("is-dirty"),
      "main.tex"
    );

    await page.click('button.file-item[data-path="refs.bib"]');
    await waitForTab(page, "refs.bib");
    await waitForNoTab(page, "main.tex");
  } finally {
    await electronApp.close();
  }
});

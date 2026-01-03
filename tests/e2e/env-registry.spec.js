import { test } from "@playwright/test";
import {
  openEditor,
  setEditorContent,
  moveCursorTo,
  waitForAutoDetected,
  toggleEnvRegistry,
} from "./helpers.js";

test("env registry ui toggles detection and allows custom envs", async () => {
  test.setTimeout(90000);
  const { electronApp, page } = await openEditor();
  try {
    const content = [
      "\\begin{align}",
      "  alOne &= alTwo",
      "\\end{align}",
      "",
      "\\begin{myequation}",
      "  myOne",
      "\\end{myequation}",
      "",
    ].join("\n");
    await setEditorContent(page, content);

    await moveCursorTo(page, "alOne");
    await waitForAutoDetected(page, true, "align enabled");

    await page.click('.tab[data-tab="settings"]');
    await page.waitForSelector('.panel[data-panel="settings"].is-active');
    await toggleEnvRegistry(page, "align", "math", false);

    await page.click('.tab[data-tab="blocks"]');
    await page.waitForSelector('.panel[data-panel="blocks"].is-active');
    await moveCursorTo(page, "alOne");
    await waitForAutoDetected(page, false, "align disabled");

    await page.click('.tab[data-tab="settings"]');
    await page.waitForSelector('.panel[data-panel="settings"].is-active');
    await toggleEnvRegistry(page, "align", "math", true);

    await page.click('.tab[data-tab="blocks"]');
    await moveCursorTo(page, "alOne");
    await waitForAutoDetected(page, true, "align re-enabled");

    await page.click('.tab[data-tab="settings"]');
    await page.waitForSelector("#env-registry-input");
    await page.fill("#env-registry-input", "myequation");
    await page.selectOption("#env-registry-kind", "math");
    await page.click("#env-registry-add");

    await page.click('.tab[data-tab="blocks"]');
    await moveCursorTo(page, "myOne");
    await waitForAutoDetected(page, true, "custom env");
  } finally {
    await electronApp.close();
  }
});

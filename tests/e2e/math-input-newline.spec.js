import { test, expect, _electron as electron } from "@playwright/test";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs/promises";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const templateWorkspace = path.join(repoRoot, "test-workspace");

test.describe.configure({ mode: "serial" });

const copyWorkspace = async (targetPath) => {
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(targetPath, { recursive: true });
  await fs.cp(templateWorkspace, targetPath, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("__e2e__"),
  });
};

const launchApp = async (testInfo) => {
  const workspacePath = testInfo.outputPath("workspace");
  const userDataPath = testInfo.outputPath("userdata");
  await copyWorkspace(workspacePath);
  await fs.mkdir(userDataPath, { recursive: true });

  const env = {
    ...process.env,
    TEX180_E2E: "1",
    TEX180_E2E_WORKSPACE: workspacePath,
    TEX180_E2E_USERDATA: userDataPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot],
    cwd: repoRoot,
    env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector("#file-tree .file-item");
  return { app, page };
};

const ensureMathField = async (page) => {
  await page.click('.tab[data-tab="blocks"]');
  await expect(page.locator('.panel[data-panel="blocks"]')).toBeVisible();

  await page.evaluate(() => {
    const mathForm = document.querySelector('.block-form[data-form="math"]');
    if (mathForm) {
      mathForm.classList.add("is-active");
      mathForm.style.display = "flex";
    }
    const blocksPanel = document.querySelector(".blocks-panel");
    if (blocksPanel) {
      blocksPanel.style.display = "flex";
    }
  });

  const selector = "math-field.block-math-field";
  await page.waitForSelector(selector, { timeout: 10000 });
  return selector;
};

const readMathMetrics = async (page, selector) =>
  page.evaluate((mathFieldSelector) => {
    const mf = document.querySelector(mathFieldSelector);
    const root = mf?.shadowRoot ?? null;
    const mtable = root?.querySelector(".ML__mtable") ?? null;
    const errorCount = root?.querySelectorAll(".ML__error").length ?? 0;
    const model = mf?._mathfield?.model;
    const arrayAtom = Array.isArray(model?.root?.children)
      ? model.root.children.find((child) => child?.type === "array")
      : null;
    const rowCount = Array.isArray(arrayAtom?._rows) ? arrayAtom._rows.length : null;
    const readValue = () => {
      if (typeof window.__tex64GetMathInputValue === "function") {
        return window.__tex64GetMathInputValue();
      }
      if (mf && typeof mf.getValue === "function") {
        const value = mf.getValue("latex");
        return typeof value === "string" ? value : "";
      }
      if (mf && typeof mf.value === "string") {
        return mf.value;
      }
      return "";
    };
    return {
      value: readValue(),
      errorCount,
      hasTable: !!mtable,
      rowCount,
    };
  }, selector);

test("Math input supports &/\\\\ insertion, deletion, and display", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);
  try {
    const selector = await ensureMathField(page);

    await page.evaluate((mathFieldSelector) => {
      const mf = document.querySelector(mathFieldSelector);
      if (!mf) return;
      if (typeof mf.setValue === "function") {
        mf.setValue("");
      } else if ("value" in mf) {
        mf.value = "";
      }
      mf.focus?.();
    }, selector);

    await page.evaluate(
      ([mathFieldSelector, value]) => {
        const mf = document.querySelector(mathFieldSelector);
        if (!mf || typeof mf.executeCommand !== "function") return;
        mf.focus?.();
        mf.executeCommand("insert", value);
      },
      [selector, String.raw`a&b`]
    );
    await page.waitForTimeout(200);

    const baseMetrics = await readMathMetrics(page, selector);
    expect(baseMetrics.value).toContain("&");
    expect(baseMetrics.value).not.toContain("\\\\");
    expect(baseMetrics.value).not.toContain("\\begin{aligned}");
    expect(baseMetrics.errorCount).toBe(0);
    expect(baseMetrics.hasTable).toBe(true);
    expect(baseMetrics.rowCount).toBe(1);

    await page.evaluate((mathFieldSelector) => {
      const mf = document.querySelector(mathFieldSelector);
      if (!mf || typeof mf.position !== "number" || typeof mf.lastOffset !== "number") return;
      mf.position = Math.max(0, mf.lastOffset - 1);
    }, selector);

    await page.evaluate(
      ([mathFieldSelector, parts]) => {
        const mf = document.querySelector(mathFieldSelector);
        if (!mf || typeof mf.executeCommand !== "function") return;
        mf.focus?.();
        for (const part of parts) {
          mf.executeCommand("insert", part);
        }
      },
      [selector, ["\\\\", "c", "&", "d"]]
    );
    await page.waitForTimeout(200);

    const newlineMetrics = await readMathMetrics(page, selector);
    expect(newlineMetrics.value).toContain("&");
    expect(newlineMetrics.value).toContain("\\\\");
    expect(newlineMetrics.value).not.toContain("\\begin{aligned}");
    expect(newlineMetrics.errorCount).toBe(0);
    expect(newlineMetrics.hasTable).toBe(true);
    expect(newlineMetrics.rowCount).toBeGreaterThan(1);

    await page.evaluate((mathFieldSelector) => {
      const mf = document.querySelector(mathFieldSelector);
      mf?.focus?.();
    }, selector);
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press("Backspace");
    }
    await page.waitForTimeout(200);

    const deletedMetrics = await readMathMetrics(page, selector);
    expect(deletedMetrics.value).not.toContain("\\\\");
    expect(deletedMetrics.value).not.toContain("\\begin{aligned}");
    expect(deletedMetrics.errorCount).toBe(0);
    if (deletedMetrics.rowCount !== null) {
      expect(deletedMetrics.rowCount).toBeLessThanOrEqual(1);
    }
  } finally {
    await app.close();
  }
});

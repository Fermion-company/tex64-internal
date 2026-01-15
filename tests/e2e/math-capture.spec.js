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

const injectFormulaOverlay = async (page, latex) => {
  await page.evaluate((value) => {
    const existing = document.getElementById("__e2e-math-capture");
    if (existing) {
      existing.remove();
    }
    const overlay = document.createElement("div");
    overlay.id = "__e2e-math-capture";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "#fff";
    overlay.style.zIndex = "9999999";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.pointerEvents = "none";

    const formula = document.createElement("div");
    formula.style.fontFamily = "KaTeX_Main, 'Times New Roman', serif";
    formula.style.fontSize = "140px";
    formula.style.color = "#000";
    formula.style.lineHeight = "1";
    formula.style.whiteSpace = "nowrap";
    if (value === "E=mc^2") {
      formula.innerHTML = "E=mc<sup>2</sup>";
    } else {
      formula.textContent = value;
    }
    overlay.appendChild(formula);
    document.body.appendChild(overlay);
  }, latex);
  await page.waitForTimeout(300);
};

const removeFormulaOverlay = async (page) => {
  await page.evaluate(() => {
    document.getElementById("__e2e-math-capture")?.remove();
  });
};

const waitForCropImageReady = async (page) => {
  await page.waitForFunction(() => {
    const img = document.getElementById("math-capture-crop-image");
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  });
};

const waitForMathValue = async (page) => {
  await page.waitForFunction(() => {
    const readValue = () => {
      if (typeof window.__tex64GetMathInputValue === "function") {
        return window.__tex64GetMathInputValue() || "";
      }
      const mf = document.querySelector("math-field.block-math-field");
      if (mf && typeof mf.getValue === "function") {
        const latex = mf.getValue("latex");
        return typeof latex === "string" ? latex : "";
      }
      if (mf && typeof mf.value === "string") {
        return mf.value;
      }
      return "";
    };
    return readValue().trim().length > 0;
  }, null, { timeout: 60000 });

  return page.evaluate(() => {
    if (typeof window.__tex64GetMathInputValue === "function") {
      return window.__tex64GetMathInputValue() || "";
    }
    const mf = document.querySelector("math-field.block-math-field");
    if (mf && typeof mf.getValue === "function") {
      const latex = mf.getValue("latex");
      return typeof latex === "string" ? latex : "";
    }
    if (mf && typeof mf.value === "string") {
      return mf.value;
    }
    return "";
  });
};

const normalizeLatex = (value) => {
  if (!value) return "";
  let result = value.trim().replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
  result = result.replace(/^\\\[(.*)\\\]$/, "$1");
  result = result.replace(/^\\\((.*)\\\)$/, "$1");
  result = result.replace(/^\$\$(.*)\$\$$/, "$1");
  result = result.replace(/^\$(.*)\$$/, "$1");
  result = result.replace(/\^\{([0-9])\}/g, "^$1");
  result = result.replace(/_\{([0-9])\}/g, "_$1");
  return result.trim();
};

test("Math capture screenshots and inserts OCR result", async ({}, testInfo) => {
  test.setTimeout(120000);
  const { app, page } = await launchApp(testInfo);
  const expectedLatex = "E=mc^2";
  try {
    await ensureMathField(page);
    await injectFormulaOverlay(page, expectedLatex);
    await page.screenshot({ path: testInfo.outputPath("overlay.png"), fullPage: true });

    await page.click("#block-capture-button");
    await expect(page.locator("#math-capture-window-modal")).toHaveClass(/is-open/);
    await removeFormulaOverlay(page);

    await page.click("#math-capture-window-grid .capture-window-item");
    await expect(page.locator("#math-capture-crop-modal")).toHaveClass(/is-open/);
    await waitForCropImageReady(page);
    const cropDataUrl = await page.evaluate(() => {
      const img = document.getElementById("math-capture-crop-image");
      return img instanceof HTMLImageElement ? img.src : "";
    });
    if (cropDataUrl.startsWith("data:image/png;base64,")) {
      const buffer = Buffer.from(cropDataUrl.split(",")[1], "base64");
      await fs.writeFile(testInfo.outputPath("crop.png"), buffer);
    }
    await page.click("#math-capture-crop-apply");

    const value = await waitForMathValue(page);
    const normalized = normalizeLatex(value);
    expect(normalized).toBe(expectedLatex);
  } finally {
    await app.close();
  }
});

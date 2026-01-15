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

const injectFormulaOverlay = async (page, latex, options = {}) => {
  await page.evaluate(({ value, degrade }) => new Promise((resolve) => {
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

    const resolvedDegrade = (() => {
      if (!degrade) return { blur: 0, contrast: 1, fontScale: 1 };
      if (degrade === true) return { blur: 0.6, contrast: 0.92, fontScale: 1 };
      const blur = typeof degrade.blur === "number" ? degrade.blur : 0;
      const contrast = typeof degrade.contrast === "number" ? degrade.contrast : 1;
      const fontScale = typeof degrade.fontScale === "number" ? degrade.fontScale : 1;
      return { blur, contrast, fontScale };
    })();
    const filters = [];
    if (resolvedDegrade.blur > 0) {
      filters.push(`blur(${resolvedDegrade.blur}px)`);
    }
    if (resolvedDegrade.contrast !== 1) {
      filters.push(`contrast(${resolvedDegrade.contrast})`);
    }
    if (filters.length > 0) {
      overlay.style.filter = filters.join(" ");
    }

    const hasMathField = typeof customElements !== "undefined" &&
      typeof customElements.get === "function" &&
      customElements.get("math-field");
    let content;
    if (hasMathField) {
      const mathField = document.createElement("math-field");
      mathField.setAttribute("read-only", "true");
      mathField.setAttribute("virtual-keyboard-mode", "off");
      mathField.style.fontSize = `${120 * resolvedDegrade.fontScale}px`;
      mathField.style.color = "#000";
      mathField.style.lineHeight = "1.1";
      mathField.style.whiteSpace = "nowrap";
      mathField.style.background = "transparent";
      if (typeof mathField.setValue === "function") {
        mathField.setValue(value);
      } else {
        mathField.value = value;
      }
      content = mathField;
      overlay.appendChild(mathField);
    } else {
      const formula = document.createElement("div");
      formula.style.fontFamily = "KaTeX_Main, 'Times New Roman', serif";
      formula.style.fontSize = `${140 * resolvedDegrade.fontScale}px`;
      formula.style.color = "#000";
      formula.style.lineHeight = "1";
      formula.style.whiteSpace = "nowrap";
      if (value === "E=mc^2") {
        formula.innerHTML = "E=mc<sup>2</sup>";
      } else {
        formula.textContent = value;
      }
      content = formula;
      overlay.appendChild(formula);
    }
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      if (content) {
        const rect = content.getBoundingClientRect();
        const maxWidth = window.innerWidth * 0.92;
        const maxHeight = window.innerHeight * 0.82;
        if (rect.width > 0 && rect.height > 0) {
          const fitScale = Math.min(1, maxWidth / rect.width, maxHeight / rect.height);
          if (fitScale < 1) {
            content.style.transformOrigin = "center";
            content.style.transform = `scale(${fitScale})`;
          }
        }
      }
      resolve();
    });
  }), { value: latex, degrade: options.degrade });
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
  result = result.replace(/\^\{\s*([0-9]+)\s*\}/g, "^$1");
  result = result.replace(/_\{\s*([0-9]+)\s*\}/g, "_$1");
  result = result.replace(/\^\{\s*([A-Za-z])\s*\}/g, "^$1");
  result = result.replace(/_\{\s*([A-Za-z])\s*\}/g, "_$1");
  result = result.replace(/\\dfrac/g, "\\frac");
  result = result.replace(/\\tfrac/g, "\\frac");
  result = result.replace(
    /\\operatorname\{(arcsin|arccos|arctan|sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|log|ln|lim|inf|max|min|sup)\}/g,
    "\\$1"
  );
  result = result.replace(/\\operatorname\*?\{lim\}/g, "\\lim");
  result = result.replace(/\^\{\\prime\}/g, "'");
  result = result.replace(/\\prime/g, "'");
  result = result.replace(/\\left/g, "").replace(/\\right/g, "");
  result = result.replace(/\\begin\{(?:p|b|B|v|V)?matrix\}/g, "\\begin{matrix}");
  result = result.replace(/\\end\{(?:p|b|B|v|V)?matrix\}/g, "\\end{matrix}");
  result = result.replace(/\\begin\{array\}\{[^}]*\}/g, "\\begin{matrix}");
  result = result.replace(/\\end\{array\}/g, "\\end{matrix}");
  result = result.replace(/\[\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\]/g, "\\begin{matrix}$1\\end{matrix}");
  result = result.replace(
    /\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}/g,
    (match, body) => {
      if (body.includes("&") || body.includes("\\\\")) {
        return match;
      }
      const cells = [];
      let i = 0;
      let valid = true;
      while (i < body.length) {
        const ch = body[i];
        if (ch === "{") {
          let depth = 0;
          const start = i + 1;
          for (; i < body.length; i += 1) {
            const inner = body[i];
            if (inner === "{") depth += 1;
            if (inner === "}") {
              depth -= 1;
              if (depth === 0) {
                cells.push(body.slice(start, i).trim());
                i += 1;
                break;
              }
            }
          }
          if (depth !== 0) {
            valid = false;
            break;
          }
          continue;
        }
        if (!/\s/.test(ch)) {
          const start = i;
          while (i < body.length && !/\s/.test(body[i])) {
            i += 1;
          }
          cells.push(body.slice(start, i).trim());
          continue;
        }
        i += 1;
      }
      if (!valid) {
        return match;
      }
      const filtered = cells.filter((cell) => cell.length > 0);
      if (filtered.length === 0) {
        return match;
      }
      const size = Math.sqrt(filtered.length);
      const n = Math.round(size);
      if (!Number.isFinite(size) || n * n !== filtered.length) {
        return match;
      }
      const rows = [];
      for (let r = 0; r < n; r += 1) {
        rows.push(filtered.slice(r * n, (r + 1) * n).join("&"));
      }
      return `\\begin{matrix}${rows.join("\\\\")}\\end{matrix}`;
    }
  );
  result = result.replace(/\\,/g, "");
  result = result.replace(/\\!/g, "");
  result = result.replace(/\s+/g, "");
  return result.trim();
};

const runCaptureScenario = async (page, testInfo, scenario) => {
  await ensureMathField(page);
  await injectFormulaOverlay(page, scenario.latex, { degrade: scenario.degrade });
  await page.screenshot({ path: testInfo.outputPath(`${scenario.id}-overlay.png`), fullPage: true });

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
    await fs.writeFile(testInfo.outputPath(`${scenario.id}-crop.png`), buffer);
  }
  await page.click("#math-capture-crop-apply");

  const value = await waitForMathValue(page);
  const normalized = normalizeLatex(value);
  expect(normalized).toBe(normalizeLatex(scenario.expected));
};

const scenarios = [
  {
    id: "simple-eq",
    latex: "E=mc^2",
    expected: "E=mc^2",
    degrade: false,
  },
  {
    id: "gaussian-integral",
    latex: "\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}",
    expected: "\\int_{-\\infty}^{\\infty} e^{-x^2} dx=\\sqrt{\\pi}",
    degrade: true,
  },
  {
    id: "sigma-series",
    latex: "\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}",
    expected: "\\sum_{n=1}^{\\infty} \\frac{1}{n^2}=\\frac{\\pi^2}{6}",
    degrade: true,
  },
  {
    id: "matrix-3x3",
    latex: "\\begin{matrix}1&0&-1\\\\2&3&4\\\\5&-6&7\\end{matrix}",
    expected: "\\begin{matrix}1&0&-1\\\\2&3&4\\\\5&-6&7\\end{matrix}",
    degrade: false,
  },
  {
    id: "matrix-4x4-lowres",
    latex: "\\begin{bmatrix}1&0&0&0\\\\0&1&0&0\\\\0&0&1&0\\\\0&0&0&1\\end{bmatrix}",
    expected:
      "\\begin{bmatrix}1&0&0&0\\\\0&1&0&0\\\\0&0&1&0\\\\0&0&0&1\\end{bmatrix}",
    degrade: { blur: 1.2, contrast: 0.85, fontScale: 0.75 },
  },
  {
    id: "nested-fraction",
    latex: "\\frac{1}{1+\\frac{1}{1+\\frac{1}{x}}}",
    expected: "\\frac{1}{1+\\frac{1}{1+\\frac{1}{x}}}",
    degrade: false,
  },
  {
    id: "gaussian-pdf-lowres",
    latex:
      "\\frac{1}{\\sqrt{2\\pi}\\sigma} e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}",
    expected:
      "\\frac{1}{\\sqrt{2\\pi}\\sigma}e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}",
    degrade: { blur: 1.1, contrast: 0.86, fontScale: 0.74 },
  },
  {
    id: "integral-fraction",
    latex: "\\int_0^{\\infty} e^{-ax^2} \\, dx = \\frac{1}{2}\\sqrt{\\frac{\\pi}{a}}",
    expected: "\\int_0^{\\infty} e^{-ax^2} dx=\\frac{1}{2}\\sqrt{\\frac{\\pi}{a}}",
    degrade: { blur: 1.0, contrast: 0.88, fontScale: 0.78 },
  },
  {
    id: "binomial-theorem-lowres",
    latex:
      "(a+b)^n = \\sum_{k=0}^{n} \\binom{n}{k} a^{n-k} b^k",
    expected:
      "(a+b)^n=\\sum_{k=0}^{n}\\binom{n}{k}a^{n-k}b^k",
    degrade: { blur: 1.3, contrast: 0.83, fontScale: 0.72 },
  },
  {
    id: "fourier-series-lowres",
    latex:
      "f(x)=\\frac{a_0}{2}+\\sum_{n=1}^{\\infty}(a_n\\cos nx + b_n\\sin nx)",
    expected:
      "f(x)=\\frac{a_0}{2}+\\sum_{n=1}^{\\infty}(a_n\\cos nx+b_n\\sin nx)",
    degrade: { blur: 1.2, contrast: 0.84, fontScale: 0.7 },
  },
  {
    id: "limit-derivative-lowres",
    latex: "\\lim_{h\\to0} \\frac{f(x+h)-f(x)}{h} = f'(x)",
    expected: "\\lim_{h\\to0}\\frac{f(x+h)-f(x)}{h}=f'(x)",
    degrade: { blur: 1.1, contrast: 0.86, fontScale: 0.7 },
  },
  {
    id: "product-sum-lowres",
    latex: "\\prod_{k=1}^{n} (1+\\frac{1}{k}) = \\sum_{k=1}^{n+1} \\frac{1}{k}",
    expected: "\\prod_{k=1}^{n}(1+\\frac{1}{k})=\\sum_{k=1}^{n+1}\\frac{1}{k}",
    degrade: { blur: 1.3, contrast: 0.82, fontScale: 0.68 },
  },
];

test.describe("Math capture accuracy", () => {
  for (const scenario of scenarios) {
    test(`captures ${scenario.id}`, async ({}, testInfo) => {
      test.setTimeout(120000);
      const { app, page } = await launchApp(testInfo);
      try {
        await runCaptureScenario(page, testInfo, scenario);
      } finally {
        await app.close();
      }
    });
  }
});

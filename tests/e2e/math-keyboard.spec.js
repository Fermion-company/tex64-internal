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
  await page.waitForFunction(() => window.__tex64Editor);
  return { app, page };
};

const openMainTex = async (page) => {
  await page.click('.file-item[data-path="main.tex"]');
  await page.waitForFunction(() => {
    const editor = window.__tex64Editor;
    return Boolean(editor && editor.getValue?.().includes("\\documentclass"));
  });
};

const openBlocksTab = async (page) => {
  await page.click('.tab[data-tab="blocks"]');
  await expect(page.locator('.tab[data-tab="blocks"]')).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.waitForSelector("#math-keyboard-dock.is-open");
};

const waitForMathInput = async (page) => {
  await page.waitForSelector("math-field#block-math-input");
  await page.waitForFunction(() => Boolean(window.__tex64GetMathInputValue));
};

const getMathValue = async (page) =>
  page.evaluate(() => window.__tex64GetMathInputValue?.() ?? "");

const setMathValue = async (page, value) => {
  await page.evaluate((nextValue) => {
    const field = document.querySelector("math-field#block-math-input");
    if (!field) return;
    if (typeof field.setValue === "function") {
      field.setValue(nextValue);
    } else {
      field.value = nextValue;
    }
  }, value);
};

const setMathSelection = async (page, start, end) => {
  await page.evaluate(({ start, end }) => {
    const field = document.querySelector("math-field#block-math-input");
    if (!field) return;
    const toOffset = (targetIndex) => {
      if (typeof field.getValue !== "function") {
        return targetIndex;
      }
      const fullValue = field.getValue("latex");
      const fullLength = typeof fullValue === "string" ? fullValue.length : 0;
      const lastOffset = typeof field.lastOffset === "number" ? field.lastOffset : fullLength;
      if (targetIndex <= 0) return 0;
      if (targetIndex >= fullLength) return lastOffset;
      let low = 0;
      let high = lastOffset;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const prefix = field.getValue(0, mid, "latex");
        const length = typeof prefix === "string" ? prefix.length : 0;
        if (length < targetIndex) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      return low;
    };
    const startOffset = toOffset(start);
    const endOffset = toOffset(end);
    field.selection = { ranges: [[startOffset, endOffset]] };
  }, { start, end });
};

const setCursorToEnd = async (page) => {
  const value = await getMathValue(page);
  await setMathSelection(page, value.length, value.length);
};

const selectAllMath = async (page) => {
  const value = await getMathValue(page);
  await setMathSelection(page, 0, value.length);
};

const setShift = async (page, enabled) => {
  const shiftButton = page.locator("#math-keyboard-shift");
  const pressed = await shiftButton.getAttribute("aria-pressed");
  const isActive = pressed === "true";
  if (isActive !== enabled) {
    await shiftButton.click();
  }
};

const ensureShiftOff = async (page) => {
  await setShift(page, false);
};

const clickFixedKey = async (page, name) =>
  page
    .locator("#math-keyboard-fixed-grid")
    .getByRole("button", { name, exact: true })
    .click();

const clickGridKey = async (page, name) =>
  page.locator("#math-keyboard-grid").getByRole("button", { name, exact: true }).click();

const setMathTab = async (page, tab) => {
  await page.click(`.math-keyboard-tab[data-math-tab="${tab}"]`);
  await expect(page.locator(`.math-keyboard-tab[data-math-tab="${tab}"]`)).toHaveClass(
    /is-active/
  );
  await page.waitForSelector("#math-keyboard-grid .math-keyboard-key");
};

test("Math keyboard: script/template operations", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);
  try {
    await openMainTex(page);
    await openBlocksTab(page);
    await waitForMathInput(page);
    await ensureShiftOff(page);
    await page.click("#block-math-input-container");

    await test.step("SUP attaches to a simple atom", async () => {
      await setMathValue(page, "x");
      await setCursorToEnd(page);
      await clickFixedKey(page, "pow");
      await expect.poll(() => getMathValue(page)).toBe("x^{\\placeholder{}}");
    });

    await test.step("SUP inserts placeholders with empty input", async () => {
      await setMathValue(page, "");
      await setCursorToEnd(page);
      await clickFixedKey(page, "pow");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\placeholder{}^{\\placeholder{}}"
      );
    });

    await test.step("SUB inserts before existing SUP", async () => {
      await setMathValue(page, "x^{2}");
      await setCursorToEnd(page);
      await clickFixedKey(page, "sub");
      await expect.poll(() => getMathValue(page)).toBe("x_{\\placeholder{}}^{2}");
    });

    await test.step("SUB does not duplicate when already present", async () => {
      await setMathValue(page, "x_{i}");
      await setCursorToEnd(page);
      await clickFixedKey(page, "sub");
      await expect.poll(() => getMathValue(page)).toBe("x_{i}");
    });

    await test.step("SUP inserts after existing SUB", async () => {
      await setMathValue(page, "x_{i}");
      await setCursorToEnd(page);
      await clickFixedKey(page, "pow");
      await expect.poll(() => getMathValue(page)).toBe("x_{i}^{\\placeholder{}}");
    });

    await test.step("SUBSUP adds both scripts", async () => {
      await setMathValue(page, "x");
      await setCursorToEnd(page);
      await clickFixedKey(page, "subsup");
      await expect.poll(() => getMathValue(page)).toBe(
        "x_{\\placeholder{}}^{\\placeholder{}}"
      );
    });

    await test.step("SUBSUP adds missing sub before existing sup", async () => {
      await setMathValue(page, "x^{2}");
      await setCursorToEnd(page);
      await clickFixedKey(page, "subsup");
      await expect.poll(() => getMathValue(page)).toBe("x_{\\placeholder{}}^{2}");
    });

    await test.step("Scripts treat \\frac as one atom", async () => {
      await setMathValue(page, "\\frac{a}{b}");
      await setCursorToEnd(page);
      await clickFixedKey(page, "pow");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\frac{a}{b}^{\\placeholder{}}"
      );
    });

    await test.step("Scripts treat \\left...\\right as one atom", async () => {
      await setMathValue(page, "\\left(x+y\\right)");
      await setCursorToEnd(page);
      await clickFixedKey(page, "pow");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\left(x+y\\right)^{\\placeholder{}}"
      );
    });

    await test.step("Scripts treat \\sqrt[n]{...} as one atom", async () => {
      await setMathValue(page, "\\sqrt[3]{x}");
      await setCursorToEnd(page);
      await clickFixedKey(page, "sub");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\sqrt[3]{x}_{\\placeholder{}}"
      );
    });

    await test.step("Scripts handle commands and digits", async () => {
      const cases = [
        {
          value: "\\alpha",
          key: "sub",
          expected: "\\alpha_{\\placeholder{}}",
        },
        {
          value: "12",
          key: "pow",
          expected: "12^{\\placeholder{}}",
        },
        {
          value: "\\mathbb{R}",
          key: "pow",
          expected: "\\mathbb{R}^{\\placeholder{}}",
        },
      ];
      for (const entry of cases) {
        await setMathValue(page, entry.value);
        await setCursorToEnd(page);
        await clickFixedKey(page, entry.key);
        await expect.poll(() => getMathValue(page)).toBe(entry.expected);
      }
    });

    await test.step("Scripts handle unbraced scripts", async () => {
      await setMathValue(page, "x^2");
      await setCursorToEnd(page);
      await clickFixedKey(page, "sub");
      await expect.poll(() => getMathValue(page)).toBe("x_{\\placeholder{}}^2");

      await setMathValue(page, "x_2");
      await setCursorToEnd(page);
      await clickFixedKey(page, "pow");
      await expect.poll(() => getMathValue(page)).toBe("x_2^{\\placeholder{}}");
    });

    await test.step("Selection wraps before script", async () => {
      await setMathValue(page, "x+y");
      await selectAllMath(page);
      await clickFixedKey(page, "pow");
      await expect.poll(() => getMathValue(page)).toBe("{x+y}^{\\placeholder{}}");
    });

    await test.step("Templates wrap selection", async () => {
      await setMathValue(page, "x+1");
      await selectAllMath(page);
      await clickFixedKey(page, "sqrt");
      await expect.poll(() => getMathValue(page)).toBe("\\sqrt{x+1}");

      await setMathValue(page, "x+1");
      await selectAllMath(page);
      await clickFixedKey(page, "frac");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\frac{x+1}{\\placeholder{}}"
      );

      await setMathValue(page, "x+1");
      await selectAllMath(page);
      await clickFixedKey(page, "abs");
      await expect.poll(() => getMathValue(page)).toBe("\\left|x+1\\right|");
    });

    await test.step("Templates with no selection don't wrap previous atom", async () => {
      await setMathValue(page, "x");
      await setCursorToEnd(page);
      await clickFixedKey(page, "sqrt");
      await expect.poll(() => getMathValue(page)).toBe(
        "x\\sqrt{\\placeholder{}}"
      );
    });

    await test.step("Selection-only templates don't grab previous atom", async () => {
      await setMathTab(page, "algebra");
      await setMathValue(page, "x");
      await setCursorToEnd(page);
      await clickGridKey(page, "x\u22600");
      const value = await getMathValue(page);
      expect(value.startsWith("x")).toBe(true);
      expect(value).toContain("\\placeholder{}");
      expect(value).toContain("\\neq 0");
    });

    await test.step("Selection templates replace placeholders", async () => {
      await setMathTab(page, "algebra");
      await setMathValue(page, "x");
      await selectAllMath(page);
      await clickGridKey(page, "x\u22600");
      await expect.poll(() => getMathValue(page)).toBe("x \\neq 0");

      await setMathValue(page, "x");
      await selectAllMath(page);
      await clickGridKey(page, "x\u226ay");
      await expect.poll(() => getMathValue(page)).toBe(
        "x \\ll \\placeholder{}"
      );
    });

    await test.step("Shift templates for root and log", async () => {
      await setShift(page, true);
      await setMathValue(page, "x");
      await selectAllMath(page);
      await clickFixedKey(page, "root");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\sqrt[\\placeholder{}]{x}"
      );

      await setMathValue(page, "x");
      await selectAllMath(page);
      await clickFixedKey(page, "log_b");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\log_{\\placeholder{}} x"
      );
      await setShift(page, false);
    });

    await test.step("Algebra templates across variants", async () => {
      await setMathTab(page, "algebra");
      await setMathValue(page, "x");
      await selectAllMath(page);
      await clickGridKey(page, "\u221an");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\sqrt[\\placeholder{}]{x}"
      );

      await setShift(page, true);
      await setMathValue(page, "x+1");
      await selectAllMath(page);
      await clickGridKey(page, "x^y");
      await expect.poll(() => getMathValue(page)).toBe(
        "{x+1}^{\\placeholder{}}"
      );
      await setShift(page, false);
    });

    await test.step("After-templates append selection", async () => {
      await setMathTab(page, "analysis");
      await setMathValue(page, "x");
      await selectAllMath(page);
      await clickGridKey(page, "\u222b_a^b");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\int_{\\placeholder{}}^{\\placeholder{}} x"
      );
    });

    await test.step("Analysis templates for derivative and sum", async () => {
      await setMathTab(page, "analysis");
      await setMathValue(page, "f");
      await selectAllMath(page);
      await clickGridKey(page, "d/dx");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\frac{d}{d\\placeholder{}}f"
      );

      await setMathValue(page, "g");
      await selectAllMath(page);
      await clickGridKey(page, "\u2202/\u2202x");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\frac{\\partial}{\\partial \\placeholder{}}g"
      );

      await setMathValue(page, "x");
      await selectAllMath(page);
      await clickGridKey(page, "\u2211");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\sum_{\\placeholder{}}^{\\placeholder{}} x"
      );

      await setMathValue(page, "x");
      await selectAllMath(page);
      await clickGridKey(page, "lim");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\lim_{\\placeholder{} \\to \\placeholder{}} x"
      );
    });

    await test.step("Sets templates for probability and sum", async () => {
      await setMathTab(page, "sets");
      await setMathValue(page, "A");
      await selectAllMath(page);
      await clickGridKey(page, "P(A)");
      await expect.poll(() => getMathValue(page)).toBe("\\mathbb{P}(A)");

      await setMathValue(page, "A");
      await selectAllMath(page);
      await clickGridKey(page, "|A|");
      await expect.poll(() => getMathValue(page)).toBe("\\left|A\\right|");

      await setMathValue(page, "A");
      await selectAllMath(page);
      await clickGridKey(page, "\u2211");
      await expect.poll(() => getMathValue(page)).toBe(
        "\\sum_{\\placeholder{}}A"
      );
    });
  } finally {
    await app.close();
  }
});

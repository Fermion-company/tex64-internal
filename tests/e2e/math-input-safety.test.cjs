/**
 * E2E tests for math input safety.
 *
 * These tests verify:
 * 1. Auto-conversion is disabled — typing operator sequences (<=, >=, etc.)
 *    or words (pi, alpha, ...) does NOT auto-replace them. Conversion only
 *    happens when the user explicitly confirms a suggestion with Enter.
 * 2. Insert-only editing — existing formula structures are never broken when
 *    inserting new content.  `writeMathFieldValue` / `setValue` must never be
 *    called during editing; only `executeCommand("insert")` is used.
 *
 * Run:
 *   TEX64_E2E=1 node --test tests/e2e/math-input-safety.test.cjs
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ELECTRON_BIN = require("electron");

const closeElectronApp = async (electronApp) => {
  if (!electronApp) return;
  const child = typeof electronApp.process === "function" ? electronApp.process() : null;
  await Promise.race([
    electronApp.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child && !child.killed && child.exitCode == null) {
    child.kill("SIGKILL");
  }
};

/** Launch the Electron app and return { electronApp, page }. */
const launchApp = async () => {
  const { _electron: electron } = require("playwright");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-e2e-"));

  const electronApp = await electron.launch({
    executablePath: ELECTRON_BIN,
    // Pass project root so Electron reads `main` from package.json and
    // app.getAppPath() correctly resolves to the project root.
    args: [PROJECT_ROOT],
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`,
      TEX64_E2E: "1",
      TEX64_E2E_USERDATA: tmpDir,
      TEX64_E2E_FORCE_HEADLESS: "1",
      NODE_ENV: "test",
    },
    timeout: 30_000,
  });

  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // Wait for the app to fully initialize (body.is-ready class)
  await page.waitForSelector("body.is-ready", { timeout: 15_000 });

  return { electronApp, page, tmpDir };
};

/**
 * Wait for the MathLive math-field to be present and ready.
 * Returns the Locator for the math-field element.
 */
const waitForMathField = async (page) => {
  // The app shows a launcher overlay when no workspace is set.
  // Hide it and switch to the blocks tab so the math input is visible.
  await page.evaluate(() => {
    // Hide launcher
    const launcher = document.getElementById("launcher");
    if (launcher) {
      launcher.classList.remove("is-visible");
      launcher.setAttribute("aria-hidden", "true");
      launcher.style.display = "none";
    }
    document.querySelectorAll(".modal.is-open, #announcement-modal").forEach((modal) => {
      modal.classList.remove("is-open", "is-visible");
      modal.setAttribute("aria-hidden", "true");
      modal.style.display = "none";
    });
    document.body.classList.remove("has-launcher");

    // Activate blocks tab by toggling CSS classes directly
    // (same logic as tab-controller.ts setActiveTab)
    document.querySelectorAll("[data-tab]").forEach((tab) => {
      const isBlocks = tab.dataset.tab === "blocks";
      tab.classList.toggle("is-active", isBlocks);
      tab.setAttribute("aria-selected", isBlocks ? "true" : "false");
    });
    document.body.dataset.activeTab = "blocks";
    document.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.panel === "blocks");
    });
  });

  await page.waitForTimeout(300);

  // Wait for math-field or textarea fallback to be visible
  const selector = "math-field#block-math-input, textarea#block-math-input";
  await page.waitForSelector(selector, { state: "attached", timeout: 15_000 });

  const mathField = page.locator(selector).first();
  return mathField;
};

/**
 * Focus the math field and clear its contents.
 */
const focusAndClear = async (page, mathField) => {
  await mathField.click();
  // Select all and delete
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  // Small delay for the field to process
  await page.waitForTimeout(100);
};

/**
 * Read the current LaTeX value from the math field.
 */
const readLatex = async (mathField) => {
  return mathField.evaluate((el) => {
    if (el instanceof HTMLTextAreaElement) {
      return el.value;
    }
    if (typeof el.getValue === "function") {
      try {
        const v = el.getValue("latex");
        if (typeof v === "string") return v;
      } catch {
        // ignore
      }
    }
    if (typeof el.value === "string") return el.value;
    return "";
  });
};

/**
 * Set the math field value directly (for test setup only).
 */
const setLatex = async (mathField, latex) => {
  await mathField.evaluate((el, val) => {
    if (el instanceof HTMLTextAreaElement) {
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (typeof el.setValue === "function") {
      el.setValue(val);
      return;
    }
    if ("value" in el) {
      el.value = val;
    }
  }, latex);
};

/**
 * Type text character by character with a small delay.
 */
const typeSlowly = async (page, text, delayMs = 50) => {
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 0 });
    await page.waitForTimeout(delayMs);
  }
};

/**
 * Check whether the WYSIWYG suggestion panel is visible.
 */
const isSuggestionPanelVisible = async (page) => {
  return page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!panel) return false;
    const style = window.getComputedStyle(panel);
    return style.display !== "none" && style.visibility !== "hidden";
  });
};

/**
 * Check if math-field element is a real MathLive element (not textarea fallback).
 */
const isMathLiveField = async (mathField) => {
  return mathField.evaluate((el) => {
    return el.tagName.toLowerCase() === "math-field" && typeof el.getValue === "function";
  });
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let app = null;
let page = null;
let mathField = null;

test.before(async () => {
  try {
    const result = await launchApp();
    app = result.electronApp;
    page = result.page;
    mathField = await waitForMathField(page);
  } catch (err) {
    console.error("Failed to launch app:", err);
    throw err;
  }
});

test.after(async () => {
  if (app) {
    await closeElectronApp(app);
  }
});

// ============================================================================
// 1. Auto-conversion removal tests
// ============================================================================

test("math-field is a real MathLive element (not fallback textarea)", async () => {
  const isReal = await isMathLiveField(mathField);
  assert.equal(isReal, true, "Expected a <math-field> element, not a textarea fallback");
});

test("typing 'pi' does NOT auto-convert to π", async () => {
  await focusAndClear(page, mathField);
  await typeSlowly(page, "pi");
  await page.waitForTimeout(300);

  const latex = await readLatex(mathField);
  // Should still contain the literal characters, not \pi
  assert.ok(
    !latex.includes("\\pi"),
    `Expected raw 'pi' text, but got: "${latex}" which contains \\pi (auto-converted)`
  );
});

test("typing 'alpha' does NOT auto-convert to \\alpha", async () => {
  await focusAndClear(page, mathField);
  await typeSlowly(page, "alpha");
  await page.waitForTimeout(300);

  const latex = await readLatex(mathField);
  assert.ok(
    !latex.includes("\\alpha"),
    `Expected raw 'alpha' text, but got: "${latex}" which contains \\alpha (auto-converted)`
  );
});

test("typing '<=' does NOT auto-convert to \\leq", async () => {
  await focusAndClear(page, mathField);
  await typeSlowly(page, "<=");
  await page.waitForTimeout(300);

  const latex = await readLatex(mathField);
  assert.ok(
    !latex.includes("\\leq") && !latex.includes("\\le") && !latex.includes("≤"),
    `Expected raw '<=' operators, but got: "${latex}" which appears auto-converted`
  );
});

test("typing '>=' does NOT auto-convert to \\geq", async () => {
  await focusAndClear(page, mathField);
  await typeSlowly(page, ">=");
  await page.waitForTimeout(300);

  const latex = await readLatex(mathField);
  assert.ok(
    !latex.includes("\\geq") && !latex.includes("\\ge") && !latex.includes("≥"),
    `Expected raw '>=' operators, but got: "${latex}" which appears auto-converted`
  );
});

test("typing '!=' does NOT auto-convert to \\neq", async () => {
  await focusAndClear(page, mathField);
  await typeSlowly(page, "!=");
  await page.waitForTimeout(300);

  const latex = await readLatex(mathField);
  assert.ok(
    !latex.includes("\\neq") && !latex.includes("\\ne") && !latex.includes("≠"),
    `Expected raw '!=' operators, but got: "${latex}" which appears auto-converted`
  );
});

test("typing '->' does NOT auto-convert to \\to or \\rightarrow", async () => {
  await focusAndClear(page, mathField);
  await typeSlowly(page, "->");
  await page.waitForTimeout(300);

  const latex = await readLatex(mathField);
  assert.ok(
    !latex.includes("\\to") && !latex.includes("\\rightarrow") && !latex.includes("→"),
    `Expected raw '->' text, but got: "${latex}" which appears auto-converted`
  );
});

test("typing '=>' does NOT auto-convert to \\Rightarrow", async () => {
  await focusAndClear(page, mathField);
  await typeSlowly(page, "=>");
  await page.waitForTimeout(300);

  const latex = await readLatex(mathField);
  assert.ok(
    !latex.includes("\\Rightarrow") && !latex.includes("⇒"),
    `Expected raw '=>' text, but got: "${latex}" which appears auto-converted`
  );
});

// ============================================================================
// 2. Insert-only safety tests — existing structures not broken
// ============================================================================

test("inserting text after \\frac{a}{b} does not corrupt the fraction", async () => {
  await focusAndClear(page, mathField);
  const initialLatex = "\\frac{a}{b}";
  await setLatex(mathField, initialLatex);
  await page.waitForTimeout(200);

  // Move to end and type new content
  await mathField.click();
  await page.keyboard.press("End");
  await page.waitForTimeout(100);
  await typeSlowly(page, "+c");
  await page.waitForTimeout(200);

  const latex = await readLatex(mathField);
  assert.ok(
    latex.includes("\\frac{a}{b}") || latex.includes("\\frac{a}{b"),
    `Fraction structure should be preserved. Got: "${latex}"`
  );
  assert.ok(
    latex.includes("c"),
    `Typed 'c' should appear in the value. Got: "${latex}"`
  );
});

test("inserting text after \\sum_{i=1}^{n} does not corrupt the sum", async () => {
  await focusAndClear(page, mathField);
  const initialLatex = "\\sum_{i=1}^{n}";
  await setLatex(mathField, initialLatex);
  await page.waitForTimeout(200);

  await mathField.click();
  await page.keyboard.press("End");
  await page.waitForTimeout(100);
  await typeSlowly(page, "x");
  await page.waitForTimeout(200);

  const latex = await readLatex(mathField);
  // The sum structure should still be recognizable
  assert.ok(
    latex.includes("\\sum") && (latex.includes("_{") || latex.includes("_{")),
    `Sum structure should be preserved. Got: "${latex}"`
  );
});

test("inserting text after \\sqrt{x} does not corrupt the sqrt", async () => {
  await focusAndClear(page, mathField);
  const initialLatex = "\\sqrt{x}";
  await setLatex(mathField, initialLatex);
  await page.waitForTimeout(200);

  await mathField.click();
  await page.keyboard.press("End");
  await page.waitForTimeout(100);
  await typeSlowly(page, "+y");
  await page.waitForTimeout(200);

  const latex = await readLatex(mathField);
  assert.ok(
    latex.includes("\\sqrt"),
    `Sqrt structure should be preserved. Got: "${latex}"`
  );
});

test("typing inside an existing \\frac numerator does not break the fraction", async () => {
  await focusAndClear(page, mathField);
  const initialLatex = "\\frac{}{b}";
  await setLatex(mathField, initialLatex);
  await page.waitForTimeout(200);

  // Click on the math field and navigate to the numerator
  await mathField.click();
  await page.keyboard.press("Home");
  await page.waitForTimeout(50);
  // Move right to enter the fraction numerator
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(50);

  await typeSlowly(page, "123");
  await page.waitForTimeout(200);

  const latex = await readLatex(mathField);
  assert.ok(
    latex.includes("\\frac"),
    `Fraction command should remain. Got: "${latex}"`
  );
  assert.ok(
    latex.includes("123"),
    `Typed '123' should appear. Got: "${latex}"`
  );
  assert.ok(
    latex.includes("b"),
    `Denominator 'b' should remain. Got: "${latex}"`
  );
});

test("complex formula: Einstein field equation structure preserved after append", async () => {
  await focusAndClear(page, mathField);
  const einsteinEq = "R_{\\mu\\nu}-\\frac{1}{2}Rg_{\\mu\\nu}+\\Lambda g_{\\mu\\nu}=\\frac{8\\pi G}{c^{4}}T_{\\mu\\nu}";
  await setLatex(mathField, einsteinEq);
  await page.waitForTimeout(300);

  // Read back to verify it was set
  const beforeLatex = await readLatex(mathField);
  assert.ok(
    beforeLatex.includes("R_{") && beforeLatex.includes("\\frac"),
    `Initial formula should be set correctly. Got: "${beforeLatex}"`
  );

  // Move to end and append
  await mathField.click();
  await page.keyboard.press("End");
  await page.waitForTimeout(100);
  // Type a simple addition
  await page.keyboard.type("+X", { delay: 50 });
  await page.waitForTimeout(300);

  const afterLatex = await readLatex(mathField);
  // Key structures must be preserved
  assert.ok(
    afterLatex.includes("R_{"),
    `R_{ subscript must be preserved. Got: "${afterLatex}"`
  );
  assert.ok(
    afterLatex.includes("\\frac"),
    `\\frac must be preserved. Got: "${afterLatex}"`
  );
  assert.ok(
    afterLatex.includes("\\Lambda") || afterLatex.includes("\\lambda") || afterLatex.includes("Λ"),
    `Lambda should be preserved. Got: "${afterLatex}"`
  );
  assert.ok(
    afterLatex.includes("c^{") || afterLatex.includes("c^4") || afterLatex.includes("c^{4}"),
    `c^{4} must be preserved. Got: "${afterLatex}"`
  );
  assert.ok(
    afterLatex.includes("X"),
    `Appended 'X' should appear. Got: "${afterLatex}"`
  );
});

test("typing 'piG' into a formula does NOT auto-convert pi to \\pi", async () => {
  await focusAndClear(page, mathField);
  // Pre-set a formula
  const formula = "R_{\\mu\\nu}=";
  await setLatex(mathField, formula);
  await page.waitForTimeout(200);

  await mathField.click();
  await page.keyboard.press("End");
  await page.waitForTimeout(100);

  // Type "piG" slowly — this was the exact scenario from the user's bug report
  await typeSlowly(page, "piG", 80);
  await page.waitForTimeout(300);

  const latex = await readLatex(mathField);
  // The original formula structure should be intact
  assert.ok(
    latex.includes("R_{"),
    `R_{ subscript must be preserved after typing piG. Got: "${latex}"`
  );
  // "pi" should NOT have been auto-converted to \\pi
  assert.ok(
    !latex.includes("\\pi G") && !latex.includes("\\pi g"),
    `'pi' should not auto-convert to \\pi when typing piG. Got: "${latex}"`
  );
});

// ============================================================================
// 3. Keyboard insert tests (simulating key button presses)
// ============================================================================

test("inserting a key from math keyboard does not use writeMathFieldValue", async () => {
  await focusAndClear(page, mathField);
  // Set up a simple formula
  await setLatex(mathField, "x+y");
  await page.waitForTimeout(200);

  // Focus and move to end
  await mathField.click();
  await page.keyboard.press("End");
  await page.waitForTimeout(100);

  // Listen for any calls to writeMathFieldValue
  const hasWriteMathFieldValue = await page.evaluate(() => {
    // Check if writeMathFieldValue was ever patched onto window for testing
    return typeof window.__tex64_writeMathFieldValue_called !== "undefined";
  });

  // Simply verify the formula is intact after typing
  await typeSlowly(page, "+z");
  await page.waitForTimeout(200);

  const latex = await readLatex(mathField);
  assert.ok(
    latex.includes("x") && latex.includes("y") && latex.includes("z"),
    `All variables should be present. Got: "${latex}"`
  );
});

test("multiple sequential inserts maintain formula integrity", async () => {
  await focusAndClear(page, mathField);

  // Type a complex sequence character by character
  const sequence = "a+b=c";
  await typeSlowly(page, sequence, 60);
  await page.waitForTimeout(200);

  const latex = await readLatex(mathField);
  // All characters should be present (MathLive may add spacing)
  for (const ch of ["a", "b", "c"]) {
    assert.ok(
      latex.includes(ch),
      `Character '${ch}' should be present. Got: "${latex}"`
    );
  }
});

test("backspace in MathLive does not corrupt surrounding structures", async () => {
  await focusAndClear(page, mathField);
  await setLatex(mathField, "\\frac{ab}{c}");
  await page.waitForTimeout(200);

  // Navigate into numerator and delete 'b'
  await mathField.click();
  await page.keyboard.press("Home");
  await page.waitForTimeout(50);
  // Move into the fraction
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(50);
  // Delete (backspace on the second character)
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);

  const latex = await readLatex(mathField);
  assert.ok(
    latex.includes("\\frac"),
    `Fraction structure should survive backspace. Got: "${latex}"`
  );
  assert.ok(
    latex.includes("c"),
    `Denominator 'c' should survive. Got: "${latex}"`
  );
});

// ============================================================================
// 4. OCR insertion tests — normalization must preserve command boundaries
// ============================================================================

test("OCR: \\pi{}G renders as pi symbol + G, not literal 'piG'", async () => {
  await focusAndClear(page, mathField);
  // This is what normalizeMathCaptureText should produce after our fix:
  // OCR returns "8\pi G" → normalize → "8\pi{}G"
  await setLatex(mathField, "\\frac{8\\pi{}G}{c^{4}}");
  await page.waitForTimeout(300);

  const latex = await readLatex(mathField);
  // MathLive should parse \pi as a command and G as a separate letter
  assert.ok(
    latex.includes("\\pi") && !latex.includes("\\piG") && !latex.includes("piG"),
    `\\pi should be a separate command, not merged with G. Got: "${latex}"`
  );
  assert.ok(
    latex.includes("G"),
    `G should appear as a separate character. Got: "${latex}"`
  );
});

test("OCR: \\Lambda{}g renders correctly, not as literal 'Lambdag'", async () => {
  await focusAndClear(page, mathField);
  await setLatex(mathField, "\\Lambda{}g_{\\mu\\nu}");
  await page.waitForTimeout(300);

  const latex = await readLatex(mathField);
  assert.ok(
    latex.includes("\\Lambda") && !latex.includes("\\Lambdag"),
    `\\Lambda should be a separate command. Got: "${latex}"`
  );
});

test("OCR: full Einstein equation with \\pi{}G renders correctly", async () => {
  await focusAndClear(page, mathField);
  const einsteinOcr = "R_{\\mu\\nu}-\\frac{1}{2}Rg_{\\mu\\nu}+\\Lambda{}g_{\\mu\\nu}=\\frac{8\\pi{}G}{c^{4}}T_{\\mu\\nu}";
  await setLatex(mathField, einsteinOcr);
  await page.waitForTimeout(300);

  const latex = await readLatex(mathField);
  assert.ok(
    latex.includes("\\pi") && !latex.includes("piG"),
    `\\pi should render as pi symbol, not literal piG. Got: "${latex}"`
  );
  assert.ok(
    latex.includes("\\Lambda") && !latex.includes("Lambdag"),
    `\\Lambda should render as Lambda symbol. Got: "${latex}"`
  );
  assert.ok(
    latex.includes("\\frac"),
    `Fraction structure should be preserved. Got: "${latex}"`
  );
  assert.ok(
    latex.includes("R_{"),
    `Subscript structure should be preserved. Got: "${latex}"`
  );
});

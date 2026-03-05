import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  repoRoot,
  sourceWorkspace,
  explicitSuggestShortcut,
  selectAllShortcut,
  typeDelayMs,
  verboseDebug,
  log,
  pause,
  normalizeLatex,
} from "./runtime.mjs";

export const cleanupStaleElectron = () => {
  try {
    execSync(
      `pkill -f "${path.join(
        repoRoot,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
      )}"`,
      { stdio: "ignore" }
    );
  } catch {
    // no stale process
  }
};

export const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-ui-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

export const postToBridge = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64Bridge.postMessage(value);
  }, payload);
};

export const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 15000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 20000,
  });
};

export const openSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 12000,
  });
  await pause(60);
};

export const waitForMathFieldReady = async (page) => {
  await page.waitForFunction(
    () => {
      const field = document.getElementById("block-math-input");
      return Boolean(
        field &&
          field.tagName.toLowerCase() === "math-field" &&
          typeof field.getValue === "function" &&
          field.shadowRoot
      );
    },
    undefined,
    { timeout: 20000 }
  );
};

export const focusMathField = async (page) => {
  const field = page.locator("#block-math-input");
  await field.waitFor({ state: "visible", timeout: 10000 });
  await field.click({ timeout: 4000 });
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active?.id === "block-math-input" || active?.closest?.("#block-math-input");
  });
  await pause(50);
};

export const getMathFieldLatex = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field || typeof field.getValue !== "function") return "";
    try {
      return String(field.getValue("latex") ?? "");
    } catch {
      return "";
    }
  });

export const getMathFieldState = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field || typeof field.getValue !== "function") {
      return null;
    }
    const api = /** @type {any} */ (field);
    return {
      latex: String(api.getValue("latex") ?? ""),
      selection: api.selection ?? null,
      position: typeof api.position === "number" ? api.position : null,
      environmentContext:
        typeof api.getEnvironmentContext === "function" ? api.getEnvironmentContext() : null,
    };
  });

export const clearMathField = async (page) => {
  await focusMathField(page);
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press(selectAllShortcut);
    await page.keyboard.press("Backspace");
    await pause(40);
    const current = normalizeLatex(await getMathFieldLatex(page));
    if (!current) return;
  }
  assert.equal(normalizeLatex(await getMathFieldLatex(page)), "", "failed to clear math-field");
};

export const waitForSuggestions = async (page, expectedHint = "") => {
  const needle = String(expectedHint ?? "").trim().toLowerCase();
  await page.waitForFunction(
    (hint) => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return false;
      if (panel.getAttribute("aria-hidden") !== "false") return false;
      const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
      if (items.length === 0) return false;
      if (!hint) return true;
      return items.some((item) => {
        const label = (item.querySelector(".math-wysiwyg-label")?.textContent ?? "")
          .trim()
          .toLowerCase();
        return label === hint;
      });
    },
    needle,
    { timeout: 10000 }
  );
};

export const getSuggestionSnapshot = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement)) {
      return { visible: false, items: [] };
    }
    const visible = panel.getAttribute("aria-hidden") === "false";
    const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item")).map((item) => ({
      hint: (item.querySelector(".math-wysiwyg-label")?.textContent ?? "").trim(),
      text: (item.textContent ?? "").replace(/\s+/g, " ").trim(),
    }));
    return { visible, items };
  });

export const getActiveSuggestionState = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement)) {
      return { visible: false, count: 0, activeIndex: -1 };
    }
    const visible = panel.getAttribute("aria-hidden") === "false";
    const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
    const activeIndex = items.findIndex((item) => item.classList.contains("is-active"));
    return { visible, count: items.length, activeIndex };
  });

export const waitForSuggestionsClosed = async (page, timeout = 5000) => {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return true;
      return panel.getAttribute("aria-hidden") !== "false";
    },
    undefined,
    { timeout }
  );
};

export const normalizeCandidateLabel = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export const moveToSuggestion = async (
  page,
  options = /** @type {{ pickIndex?: number; targetLabel?: string }} */ ({})
) => {
  const pickIndex = Number.isFinite(options.pickIndex) ? Math.max(0, options.pickIndex) : 0;
  let targetIndex = pickIndex;
  if (options.targetLabel) {
    const target = normalizeCandidateLabel(options.targetLabel);
    const labels = await page.evaluate(() => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) {
        return [];
      }
      return Array.from(panel.querySelectorAll(".math-wysiwyg-item .math-wysiwyg-label")).map(
        (node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()
      );
    });
    targetIndex = labels.findIndex((label) => normalizeCandidateLabel(label) === target);
    if (targetIndex < 0) {
      throw new Error(
        `target label not found: ${options.targetLabel} (labels=${JSON.stringify(labels)})`
      );
    }
  }
  for (let i = 0; i < targetIndex; i += 1) {
    await page.keyboard.press("ArrowDown");
    await pause(30);
  }
};

export const applySuggestionByTyping = async (
  page,
  token,
  options = /** @type {{ pickIndex?: number; expectedHint?: string; keepCursor?: boolean; targetLabel?: string }} */ ({})
) => {
  const expectedHint = options.expectedHint ?? token.replace(/^\/\/+/, "");
  if (!options.keepCursor) {
    await focusMathField(page);
  }
  await page.keyboard.type(token, { delay: typeDelayMs });
  try {
    await waitForSuggestions(page, expectedHint);
  } catch {
    if (verboseDebug) {
      const debugState = await getMathFieldState(page);
      const debugPanel = await getSuggestionSnapshot(page);
      log(
        `[debug] suggestion miss token=${token} hint=${expectedHint} state=${JSON.stringify(
          debugState
        )} panel=${JSON.stringify(debugPanel)}`
      );
    }
    await page.keyboard.press(explicitSuggestShortcut);
    await waitForSuggestions(page, expectedHint);
  }
  await moveToSuggestion(page, { pickIndex: options.pickIndex, targetLabel: options.targetLabel });
  if (verboseDebug && token === "sum") {
    const beforeApply = await getMathFieldState(page);
    log(`[debug] before sum apply: ${JSON.stringify(beforeApply)}`);
  }
  await page.keyboard.press("Enter");
  try {
    await waitForSuggestionsClosed(page, 1200);
  } catch {
    await page.keyboard.press("Escape");
    await waitForSuggestionsClosed(page, 5000);
  }
  if (verboseDebug && token === "sum") {
    const afterApply = await getMathFieldState(page);
    log(`[debug] after sum apply: ${JSON.stringify(afterApply)}`);
  }
  await pause(60);
};

export const applySuggestionViaExplicitSession = async (
  page,
  token,
  options = /** @type {{ expectedHint?: string; pickIndex?: number; keepCursor?: boolean; targetLabel?: string }} */ ({})
) => {
  const expectedHint = options.expectedHint ?? token;
  if (!options.keepCursor) {
    await focusMathField(page);
  }
  await page.keyboard.press("Backslash");
  try {
    await waitForSuggestions(page);
  } catch {
    await page.keyboard.press(explicitSuggestShortcut);
    await waitForSuggestions(page);
  }
  await page.keyboard.type(token, { delay: typeDelayMs });
  await waitForSuggestions(page, expectedHint);
  await moveToSuggestion(page, { pickIndex: options.pickIndex, targetLabel: options.targetLabel });
  if (verboseDebug) {
    const state = await getMathFieldState(page);
    log(`[debug] explicit before apply token=${token} state=${JSON.stringify(state)}`);
  }
  await page.keyboard.press("Enter");
  await waitForSuggestionsClosed(page, 5000);
  if (verboseDebug) {
    const state = await getMathFieldState(page);
    log(`[debug] explicit commit token=${token} state=${JSON.stringify(state)}`);
  }
  await pause(60);
};

export const getRenderSnapshot = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!(field instanceof HTMLElement) || field.tagName.toLowerCase() !== "math-field") {
      return null;
    }
    const root = field.shadowRoot;
    if (!(root instanceof ShadowRoot)) {
      return null;
    }
    const visibleRoot = root.querySelector(".ML__latex") ?? root;
    return {
      rawText: (visibleRoot.textContent ?? "").replace(/\s+/g, " ").trim(),
      errorCount: root.querySelectorAll(".ML__error").length,
      placeholderCount: root.querySelectorAll(".ML__placeholder, .ML__prompt, .ML__editablePromptBox")
        .length,
    };
  });

export const getAudioFeedbackConfig = async (page) =>
  page.evaluate(() => {
    const stringify = (value) => {
      if (value === null) return "null";
      if (value === undefined) return "undefined";
      if (typeof value === "string") return value;
      if (typeof value === "boolean") return value ? "true" : "false";
      return String(value);
    };

    const mathfieldElement = window.MathLive?.MathfieldElement ?? window.MathfieldElement ?? null;
    const mathVirtualKeyboard = window.mathVirtualKeyboard ?? null;

    return {
      global: {
        soundsDirectory: stringify(mathfieldElement?.soundsDirectory),
        keypressSound: stringify(mathfieldElement?.keypressSound),
        plonkSound: stringify(mathfieldElement?.plonkSound),
        keypressVibration: stringify(mathfieldElement?.keypressVibration),
      },
      virtualKeyboard: {
        exists: Boolean(mathVirtualKeyboard),
        keypressSound: stringify(mathVirtualKeyboard?.keypressSound),
        plonkSound: stringify(mathVirtualKeyboard?.plonkSound),
        keypressVibration: stringify(mathVirtualKeyboard?.keypressVibration),
      },
    };
  });

export const assertRenderHealthy = async (page, label, { allowPlaceholder = true } = {}) => {
  const snapshot = await getRenderSnapshot(page);
  assert.ok(snapshot, `${label}: render snapshot unavailable`);
  assert.equal(snapshot.errorCount, 0, `${label}: render has MathLive error node(s)`);
  if (!allowPlaceholder) {
    assert.equal(snapshot.placeholderCount, 0, `${label}: unresolved placeholder remains`);
  }
  assert.ok(
    !snapshot.rawText.includes("\\"),
    `${label}: raw LaTeX leaked in render (${snapshot.rawText})`
  );
};

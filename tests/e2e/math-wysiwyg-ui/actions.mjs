import { pause, typeDelayMs } from "./runtime.mjs";
import { applySuggestionViaExplicitSession, focusMathField } from "./ui.mjs";

export const typeMathText = async (page, text) => {
  await page.keyboard.type(String(text ?? ""), { delay: typeDelayMs });
  await pause(40);
};

export const moveCursorLeft = async (page, count) => {
  const steps = Math.max(0, Math.floor(count));
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press("ArrowLeft");
  }
  await pause(40);
};

export const moveToNextPlaceholder = async (page) => {
  await page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    const api = /** @type {{ executeCommand?: (command: string) => boolean | void } | null } */ (
      field
    );
    const executeCommand = api?.executeCommand;
    if (typeof executeCommand === "function") {
      executeCommand.call(field, "moveToNextPlaceholder");
    }
  });
  await pause(40);
};

export const insertCommandSuggestion = async (
  page,
  token,
  options = /** @type {{ expectedHint?: string; pickIndex?: number }} */ ({})
) => {
  await applySuggestionViaExplicitSession(page, token, {
    expectedHint: options.expectedHint ?? token,
    pickIndex: options.pickIndex,
    keepCursor: true,
  });
};

export const fillPlaceholderTemplateFromSuggestion = async (
  page,
  step,
  options = /** @type {{ moveNext?: boolean; caseLabel?: string; cellIndex?: number }} */ ({})
) => {
  const moveNext = options.moveNext ?? true;
  try {
    await applySuggestionViaExplicitSession(page, step.token, {
      expectedHint: step.expectedHint ?? step.token,
      pickIndex: Number.isFinite(step.pickIndex) ? step.pickIndex : 0,
      targetLabel: step.targetLabel,
      keepCursor: true,
    });
  } catch (error) {
    const prefix =
      options.caseLabel || Number.isFinite(options.cellIndex)
        ? `${options.caseLabel ?? "complex"} cell=${(options.cellIndex ?? -1) + 1}`
        : "complex";
    throw new Error(
      `${prefix}: suggestion apply failed token=${step.token} pickIndex=${String(
        step.pickIndex ?? 0
      )} hint=${step.expectedHint ?? step.token}: ${String(error)}`
    );
  }
  const values = Array.isArray(step.values) ? step.values : [];
  for (let i = 0; i < values.length; i += 1) {
    await page.keyboard.type(String(values[i] ?? ""), { delay: typeDelayMs });
    await pause(40);
    if (i < values.length - 1) {
      await moveToNextPlaceholder(page);
      await pause(40);
    }
  }
  if (moveNext && values.length > 0) {
    await moveToNextPlaceholder(page);
    await pause(40);
  }
};

export const ensureMathFieldFocused = async (page) => {
  await focusMathField(page);
};


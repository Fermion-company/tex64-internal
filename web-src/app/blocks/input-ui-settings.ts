export type MathInsertMode = "inline" | "display" | "align" | "gather" | "none";
export type MathInlineWrap = "inline-dollar" | "inline-paren";
export type MathDisplayWrap = "display-dollar" | "display-bracket";

export type MathInsertSettings = {
  mode: MathInsertMode;
  inlineWrap: MathInlineWrap;
  displayWrap: MathDisplayWrap;
};

const MATH_INSERT_MODE_KEY = "tex64.math-insert-mode";
const MATH_INSERT_INLINE_KEY = "tex64.math-insert-inline-wrap";
const MATH_INSERT_DISPLAY_KEY = "tex64.math-insert-display-wrap";
const MATH_INSERT_LEGACY_KEY = "tex64.math-insert-format";
const MATH_INSERT_MODES: Array<{
  value: MathInsertMode;
  label: string;
  shortLabel: string;
}> = [
  { value: "inline", label: "inline", shortLabel: "INL" },
  { value: "display", label: "Separate line", shortLabel: "DSP" },
  { value: "align", label: "align*", shortLabel: "ALN" },
  { value: "gather", label: "gather*", shortLabel: "GTH" },
  { value: "none", label: "Not enclosed", shortLabel: "RAW" },
];

export const getFormatLabel = (value: MathInsertMode) =>
  MATH_INSERT_MODES.find((entry) => entry.value === value)?.label ?? value;

export const getFormatShortLabel = (value: MathInsertMode) =>
  MATH_INSERT_MODES.find((entry) => entry.value === value)?.shortLabel ?? value;

export const loadMathInsertSettings = (
  defaults: MathInsertSettings
): MathInsertSettings => {
  if (typeof localStorage === "undefined") {
    return defaults;
  }
  const storedMode = localStorage.getItem(MATH_INSERT_MODE_KEY);
  const storedInline = localStorage.getItem(MATH_INSERT_INLINE_KEY);
  const storedDisplay = localStorage.getItem(MATH_INSERT_DISPLAY_KEY);
  const legacy = localStorage.getItem(MATH_INSERT_LEGACY_KEY);

  const modeMatch = MATH_INSERT_MODES.find((entry) => entry.value === storedMode)?.value;
  const inlineMatch =
    storedInline === "inline-dollar" || storedInline === "inline-paren"
      ? (storedInline as MathInlineWrap)
      : null;
  const displayMatch =
    storedDisplay === "display-dollar" || storedDisplay === "display-bracket"
      ? (storedDisplay as MathDisplayWrap)
      : null;

  let resolvedMode = modeMatch ?? defaults.mode;
  let resolvedInline = inlineMatch ?? defaults.inlineWrap;
  let resolvedDisplay = displayMatch ?? defaults.displayWrap;

  if (!modeMatch && legacy) {
    if (legacy === "none") {
      resolvedMode = "none";
    } else if (legacy === "inline-dollar" || legacy === "inline-paren") {
      resolvedMode = "inline";
      resolvedInline = legacy;
    } else if (legacy === "display-dollar" || legacy === "display-bracket") {
      resolvedMode = "display";
      resolvedDisplay = legacy;
    }
  }

  return {
    mode: resolvedMode,
    inlineWrap: resolvedInline,
    displayWrap: resolvedDisplay,
  };
};

export const saveMathInsertMode = (value: MathInsertMode) => {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(MATH_INSERT_MODE_KEY, value);
  } catch {
    // ignore storage failures
  }
};

export const saveMathInlineWrap = (value: MathInlineWrap) => {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(MATH_INSERT_INLINE_KEY, value);
  } catch {
    // ignore storage failures
  }
};

export const saveMathDisplayWrap = (value: MathDisplayWrap) => {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(MATH_INSERT_DISPLAY_KEY, value);
  } catch {
    // ignore storage failures
  }
};

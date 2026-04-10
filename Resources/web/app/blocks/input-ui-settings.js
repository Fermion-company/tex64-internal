const MATH_INSERT_MODE_KEY = "tex64.math-insert-mode";
const MATH_INSERT_INLINE_KEY = "tex64.math-insert-inline-wrap";
const MATH_INSERT_DISPLAY_KEY = "tex64.math-insert-display-wrap";
const MATH_INSERT_LEGACY_KEY = "tex64.math-insert-format";
const MATH_INSERT_MODES = [
    { value: "inline", label: "inline", shortLabel: "INL" },
    { value: "display", label: "Separate line", shortLabel: "DSP" },
    { value: "align", label: "align*", shortLabel: "ALN" },
    { value: "gather", label: "gather*", shortLabel: "GTH" },
    { value: "none", label: "Not enclosed", shortLabel: "RAW" },
];
export const getFormatLabel = (value) => { var _a, _b; return (_b = (_a = MATH_INSERT_MODES.find((entry) => entry.value === value)) === null || _a === void 0 ? void 0 : _a.label) !== null && _b !== void 0 ? _b : value; };
export const getFormatShortLabel = (value) => { var _a, _b; return (_b = (_a = MATH_INSERT_MODES.find((entry) => entry.value === value)) === null || _a === void 0 ? void 0 : _a.shortLabel) !== null && _b !== void 0 ? _b : value; };
export const loadMathInsertSettings = (defaults) => {
    var _a;
    if (typeof localStorage === "undefined") {
        return defaults;
    }
    const storedMode = localStorage.getItem(MATH_INSERT_MODE_KEY);
    const storedInline = localStorage.getItem(MATH_INSERT_INLINE_KEY);
    const storedDisplay = localStorage.getItem(MATH_INSERT_DISPLAY_KEY);
    const legacy = localStorage.getItem(MATH_INSERT_LEGACY_KEY);
    const modeMatch = (_a = MATH_INSERT_MODES.find((entry) => entry.value === storedMode)) === null || _a === void 0 ? void 0 : _a.value;
    const inlineMatch = storedInline === "inline-dollar" || storedInline === "inline-paren"
        ? storedInline
        : null;
    const displayMatch = storedDisplay === "display-dollar" || storedDisplay === "display-bracket"
        ? storedDisplay
        : null;
    let resolvedMode = modeMatch !== null && modeMatch !== void 0 ? modeMatch : defaults.mode;
    let resolvedInline = inlineMatch !== null && inlineMatch !== void 0 ? inlineMatch : defaults.inlineWrap;
    let resolvedDisplay = displayMatch !== null && displayMatch !== void 0 ? displayMatch : defaults.displayWrap;
    if (!modeMatch && legacy) {
        if (legacy === "none") {
            resolvedMode = "none";
        }
        else if (legacy === "inline-dollar" || legacy === "inline-paren") {
            resolvedMode = "inline";
            resolvedInline = legacy;
        }
        else if (legacy === "display-dollar" || legacy === "display-bracket") {
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
export const saveMathInsertMode = (value) => {
    if (typeof localStorage === "undefined") {
        return;
    }
    try {
        localStorage.setItem(MATH_INSERT_MODE_KEY, value);
    }
    catch {
        // ignore storage failures
    }
};
export const saveMathInlineWrap = (value) => {
    if (typeof localStorage === "undefined") {
        return;
    }
    try {
        localStorage.setItem(MATH_INSERT_INLINE_KEY, value);
    }
    catch {
        // ignore storage failures
    }
};
export const saveMathDisplayWrap = (value) => {
    if (typeof localStorage === "undefined") {
        return;
    }
    try {
        localStorage.setItem(MATH_INSERT_DISPLAY_KEY, value);
    }
    catch {
        // ignore storage failures
    }
};

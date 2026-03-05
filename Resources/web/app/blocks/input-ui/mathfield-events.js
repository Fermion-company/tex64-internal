import { PLACEHOLDER_LATEX, getMathFieldSelectionRange } from "../math-input-utils.js";
import { readMathFieldValue } from "../input-ui-math-field.js";
import { normalizeLegacyEnvMarkers, shouldWrapAligned, stripEmptyAlignedRows, unwrapAligned, } from "../input-ui-latex-format.js";
import { blockDirectLatexCommandInput } from "./direct-command-input.js";
import { createMathfieldMatrixOps } from "./mathfield-matrix-ops.js";
export const createBlockMathfieldEventsOps = (runtime, deps) => {
    const attachMathFieldEvents = (mathfield) => {
        var _a;
        const closeWysiwygSuggestions = () => {
            var _a;
            (_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.close();
        };
        const readMathFieldLatex = (target, ...args) => {
            if (typeof target.getValue !== "function") {
                return null;
            }
            try {
                const value = target.getValue(...args);
                return typeof value === "string" ? value : null;
            }
            catch {
                return null;
            }
        };
        const syncMathFieldValue = () => {
            const rawValue = normalizeLegacyEnvMarkers(readMathFieldValue(mathfield));
            if (runtime.state.mathFieldWrapped) {
                const { value: unwrapped, didUnwrap } = unwrapAligned(rawValue);
                if (didUnwrap) {
                    const trimmed = stripEmptyAlignedRows(unwrapped);
                    runtime.state.currentMathValue = normalizeLegacyEnvMarkers(unwrapped);
                    if (trimmed !== unwrapped) {
                        runtime.state.currentMathValue = normalizeLegacyEnvMarkers(trimmed);
                    }
                    return;
                }
                runtime.state.mathFieldWrapped = false;
            }
            runtime.state.mathFieldWrapped = shouldWrapAligned(rawValue);
            runtime.state.currentMathValue = normalizeLegacyEnvMarkers(rawValue);
        };
        mathfield.addEventListener("input", syncMathFieldValue);
        mathfield.addEventListener("change", syncMathFieldValue);
        const tryWrapSelectionWithFraction = () => {
            var _a;
            const mathfieldApi = mathfield;
            if (typeof mathfieldApi.getValue !== "function") {
                return false;
            }
            const selection = getMathFieldSelectionRange(mathfieldApi);
            if (selection.start === selection.end) {
                return false;
            }
            const selectedLatex = readMathFieldLatex(mathfieldApi, selection.start, selection.end, "latex");
            if (!selectedLatex) {
                return false;
            }
            const insertLatex = `\\frac{${selectedLatex}}{${PLACEHOLDER_LATEX}}`;
            let inserted = false;
            if (typeof mathfieldApi.executeCommand === "function") {
                const beforeValue = readMathFieldLatex(mathfieldApi, "latex");
                try {
                    const ok = mathfieldApi.executeCommand("insert", insertLatex, {
                        selectionMode: "placeholder",
                        focus: true,
                        feedback: false,
                        format: "latex",
                    });
                    const afterValue = readMathFieldLatex(mathfieldApi, "latex");
                    const changed = typeof beforeValue === "string" && typeof afterValue === "string" && afterValue !== beforeValue;
                    inserted = ok !== false || changed;
                }
                catch {
                    inserted = false;
                }
            }
            if (!inserted && typeof mathfieldApi.insert === "function") {
                mathfieldApi.insert(insertLatex, {
                    selectionMode: "placeholder",
                    focus: true,
                    feedback: false,
                    format: "latex",
                });
                inserted = true;
            }
            if (!inserted) {
                return false;
            }
            (_a = mathfieldApi.focus) === null || _a === void 0 ? void 0 : _a.call(mathfieldApi);
            mathfield.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        };
        const matrixOps = createMathfieldMatrixOps({
            mathfield,
            mathWysiwygApi: runtime.state.mathWysiwygApi,
            readMathFieldLatex,
        });
        const stripPlaceholderAndWhitespace = (value) => value
            .replace(/\\placeholder(?:\\[[^\\]]*\\])?\\{(?:[^{}]|\\.)*\\}/g, "")
            .replace(/\\s+/g, "");
        const extractSingleEnvironmentInner = (value) => {
            const match = value.match(/^\\begin\\{([A-Za-z*]+)\\}([\\s\\S]*)\\end\\{\\1\\}$/);
            return match ? match[2] : value;
        };
        const isSubsequence = (needle, haystack) => {
            if (!needle)
                return true;
            let i = 0;
            for (let j = 0; j < haystack.length; j += 1) {
                if (haystack[j] === needle[i]) {
                    i += 1;
                    if (i >= needle.length) {
                        return true;
                    }
                }
            }
            return false;
        };
        const isRowInsertionStable = (before, after) => {
            const beforeCore = stripPlaceholderAndWhitespace(extractSingleEnvironmentInner(before));
            const afterCore = stripPlaceholderAndWhitespace(extractSingleEnvironmentInner(after));
            if (!beforeCore) {
                return afterCore.length > 0;
            }
            // Row insertion may split the original `\\\\`-separated body, so `includes()` is too strict.
            // Require that the original core sequence is preserved in order.
            return isSubsequence(beforeCore, afterCore);
        };
        const handleMathFieldKeydown = (event) => {
            var _a, _b, _c;
            if (event.isComposing) {
                return;
            }
            if ((_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.handleKeydown(event)) {
                event.stopImmediatePropagation();
                return;
            }
            if (blockDirectLatexCommandInput(runtime, event)) {
                return;
            }
            if (event.key === "/" &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                !event.shiftKey) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!tryWrapSelectionWithFraction()) {
                    deps.insertMathKey({ label: "/", latex: "/" });
                    mathfield.dispatchEvent(new Event("input", { bubbles: true }));
                }
                closeWysiwygSuggestions();
                return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
                const mathfieldApi = mathfield;
                if (!event.metaKey && !event.ctrlKey) {
                    let handled = matrixOps.tryInsertMatrixRow();
                    if (!handled && typeof mathfieldApi.executeCommand === "function") {
                        const before = readMathFieldLatex(mathfieldApi, "latex");
                        try {
                            const ok = mathfieldApi.executeCommand("addRowAfter");
                            const after = readMathFieldLatex(mathfieldApi, "latex");
                            const changed = typeof before === "string" && typeof after === "string" && after !== before;
                            if (ok !== false || changed) {
                                handled = changed ? isRowInsertionStable(before !== null && before !== void 0 ? before : "", after !== null && after !== void 0 ? after : "") : Boolean(ok);
                                if (!handled) {
                                    try {
                                        mathfieldApi.executeCommand("undo");
                                    }
                                    catch {
                                        // ignore undo failure
                                    }
                                }
                            }
                        }
                        catch {
                            handled = false;
                        }
                    }
                    if (!handled) {
                        const rawValue = readMathFieldLatex(mathfieldApi, "latex");
                        if (typeof rawValue === "string" && shouldWrapAligned(rawValue)) {
                            if (typeof mathfieldApi.executeCommand === "function") {
                                try {
                                    const ok = mathfieldApi.executeCommand("insert", "\\\\", {
                                        selectionMode: "after",
                                        focus: true,
                                        feedback: false,
                                        format: "latex",
                                    });
                                    handled = ok !== false;
                                }
                                catch {
                                    handled = false;
                                }
                            }
                            if (!handled && typeof mathfieldApi.insert === "function") {
                                const before = readMathFieldLatex(mathfieldApi, "latex");
                                try {
                                    mathfieldApi.insert("\\\\", {
                                        selectionMode: "after",
                                        focus: true,
                                        feedback: false,
                                        format: "latex",
                                    });
                                    const after = readMathFieldLatex(mathfieldApi, "latex");
                                    handled =
                                        typeof before === "string" && typeof after === "string" ? after !== before : true;
                                }
                                catch {
                                    handled = false;
                                }
                            }
                        }
                    }
                    if (handled) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        closeWysiwygSuggestions();
                        mathfield.dispatchEvent(new Event("input", { bubbles: true }));
                        return;
                    }
                }
                else {
                    let handled = false;
                    if (typeof mathfieldApi.executeCommand === "function") {
                        const before = readMathFieldLatex(mathfieldApi, "latex");
                        try {
                            const ok = mathfieldApi.executeCommand("addColumnAfter");
                            const after = readMathFieldLatex(mathfieldApi, "latex");
                            const changed = typeof before === "string" && typeof after === "string" && after !== before;
                            if (ok !== false || changed) {
                                handled = changed ? true : Boolean(ok);
                            }
                        }
                        catch {
                            handled = false;
                        }
                    }
                    if (!handled) {
                        handled = matrixOps.tryInsertMatrixColumn();
                    }
                    if (handled) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        closeWysiwygSuggestions();
                        mathfield.dispatchEvent(new Event("input", { bubbles: true }));
                        return;
                    }
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    closeWysiwygSuggestions();
                    (_c = (_b = runtime.deps).onMathFieldSubmit) === null || _c === void 0 ? void 0 : _c.call(_b);
                    return;
                }
            }
            if (event.defaultPrevented) {
                return;
            }
        };
        mathfield.addEventListener("keydown", handleMathFieldKeydown, { capture: true });
        const shadowRoot = mathfield.shadowRoot;
        if (shadowRoot) {
            shadowRoot.addEventListener("keydown", handleMathFieldKeydown, { capture: true });
        }
        if (!runtime.state.globalWysiwygKeydownBound) {
            runtime.state.globalWysiwygKeydownBound = true;
            document.addEventListener("keydown", (event) => {
                if (!runtime.state.mathWysiwygApi) {
                    return;
                }
                if (runtime.state.mathWysiwygApi.handleKeydown(event)) {
                    event.stopImmediatePropagation();
                }
            }, { capture: true });
        }
        mathfield.addEventListener("keydown", (e) => {
            var _a, _b;
            if ((_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.handleKeydown(e)) {
                return;
            }
            if (blockDirectLatexCommandInput(runtime, e)) {
                return;
            }
            if (e.isComposing) {
                return;
            }
            if (!e.metaKey && !e.altKey && e.ctrlKey && e.key === ".") {
                const opened = Boolean((_b = runtime.state.mathWysiwygApi) === null || _b === void 0 ? void 0 : _b.openExplicitSuggestions());
                const fallbackOpened = opened ? false : matrixOps.openMatrixOpsPalette();
                if (opened || fallbackOpened) {
                    e.preventDefault();
                }
                return;
            }
            if (e.key === "Escape") {
                closeWysiwygSuggestions();
                mathfield.blur();
                return;
            }
        });
        mathfield.addEventListener("focus", () => {
            runtime.state.mathKeyboardVisibilityHandler();
            mathfield.classList.add("is-focused");
        });
        mathfield.addEventListener("blur", () => {
            mathfield.classList.remove("is-focused");
            closeWysiwygSuggestions();
        });
        mathfield.addEventListener("compositionstart", (e) => {
            var _a;
            e.stopPropagation();
            (_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.setComposing(true);
        });
        mathfield.addEventListener("compositionend", (e) => {
            var _a;
            e.stopPropagation();
            (_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.setComposing(false);
        });
        mathfield.addEventListener("pointerdown", () => {
            // Keep suggestions in sync with caret movement.
        });
        mathfield.addEventListener("selection-change", () => {
            // Handled by the MathWysiwyg auto-suggest listener.
        });
        mathfield.addEventListener("move-out", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        (_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.attach(mathfield);
    };
    return { attachMathFieldEvents };
};

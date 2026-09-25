import { PLACEHOLDER_LATEX, getMathFieldSelectionRange } from "../../app/blocks/math-input-utils.js";
import { createMathfieldMatrixOps } from "../../app/blocks/input-ui/mathfield-matrix-ops.js";
/** Common input policy for Code and every AI paper math field. */
export const configureMathfield = (field) => {
    var _a;
    field.smartMode = false;
    field.smartFence = false;
    field.smartSuperscript = false;
    field.defaultMode = "math";
    field.inlineShortcuts = {};
    field.onInlineShortcut = () => "";
    field.constructor.scientificNotationTemplate = null;
    field.mathVirtualKeyboardPolicy = "manual";
    field.macros = { ...((_a = field.macros) !== null && _a !== void 0 ? _a : {}), mathds: { def: "\\mathbb{#1}", args: 1 } };
};
export const attachMathfieldController = (mathfield, api, insertMathKey, onEscape) => {
    configureMathfield(mathfield);
    const controller = new AbortController();
    const { signal } = controller;
    const closeWysiwygSuggestions = () => api.close();
    const readMathFieldLatex = (target, ...args) => {
        var _a;
        try {
            const value = (_a = target.getValue) === null || _a === void 0 ? void 0 : _a.call(target, ...args);
            return typeof value === "string" ? value : null;
        }
        catch {
            return null;
        }
    };
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
        mathWysiwygApi: api,
        readMathFieldLatex,
    });
    const handleMathFieldKeydown = (event) => {
        if (event.isComposing) {
            return;
        }
        const isEnter = event.key === "Enter" ||
            event.key === "Return" ||
            event.code === "Enter" ||
            event.code === "NumpadEnter" ||
            event.keyCode === 13 ||
            event.which === 13;
        if (event.defaultPrevented && !isEnter) {
            return;
        }
        if (api === null || api === void 0 ? void 0 : api.handleKeydown(event)) {
            event.stopImmediatePropagation();
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
                insertMathKey({ label: "frac", latex: "\\frac{#?}{#?}" });
                mathfield.dispatchEvent(new Event("input", { bubbles: true }));
            }
            closeWysiwygSuggestions();
            return;
        }
        if (isEnter && !event.metaKey && !event.shiftKey && !event.altKey) {
            if (!event.metaKey && !event.ctrlKey) {
                const handled = matrixOps.tryInsertMatrixRow();
                if (handled) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    closeWysiwygSuggestions();
                    mathfield.dispatchEvent(new Event("input", { bubbles: true }));
                    return;
                }
            }
            else {
                const handled = matrixOps.tryInsertMatrixColumn();
                if (handled) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    closeWysiwygSuggestions();
                    mathfield.dispatchEvent(new Event("input", { bubbles: true }));
                    return;
                }
                // Column insertion failed — do nothing rather than falling back to submit,
                // which would be surprising when the user intended to add a column.
            }
            // Outside an array, Enter has no structural meaning in a math field.
            // In an AI paragraph it must not insert a line break into the editable
            // prose surrounding the field.
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (event.defaultPrevented) {
            return;
        }
        if (!event.metaKey &&
            !event.altKey &&
            event.ctrlKey &&
            event.key === ".") {
            const opened = Boolean(api === null || api === void 0 ? void 0 : api.openExplicitSuggestions());
            const fallbackOpened = opened ? false : matrixOps.openMatrixOpsPalette();
            if (opened || fallbackOpened) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
            return;
        }
        if (event.key === "Escape") {
            closeWysiwygSuggestions();
            onEscape === null || onEscape === void 0 ? void 0 : onEscape();
            return;
        }
    };
    mathfield.addEventListener("keydown", handleMathFieldKeydown, { capture: true, signal });
    mathfield.addEventListener("focus", () => mathfield.classList.add("is-focused"), { signal });
    mathfield.addEventListener("blur", () => { mathfield.classList.remove("is-focused"); api.close(); }, { signal });
    mathfield.addEventListener("compositionstart", () => api.setComposing(true), { signal });
    mathfield.addEventListener("compositionend", () => api.setComposing(false), { signal });
    mathfield.addEventListener("move-out", (event) => { event.preventDefault(); event.stopPropagation(); }, { signal });
    api.attach(mathfield);
    return () => { controller.abort(); api.detach(); };
};

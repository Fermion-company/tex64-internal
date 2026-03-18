import { PLACEHOLDER_LATEX, applyScriptToText, applyTemplateToText, getMathFieldSelectionRange, } from "../math-input-utils.js";
import { readMathFieldValue, } from "../input-ui-math-field.js";
export const createBlockInsertKeyOps = (runtime) => {
    const resolveInsertValue = (key, isTextArea, options) => {
        const source = isTextArea && key.fallback ? key.fallback : key.latex;
        if (!isTextArea && (options === null || options === void 0 ? void 0 : options.preserveTemplateMarkers)) {
            return source;
        }
        const placeholder = isTextArea ? "" : PLACEHOLDER_LATEX;
        return source.replace(/#\\?/g, placeholder);
    };
    const insertMathKey = (key) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
        const mathInput = runtime.state.mathInput;
        if (!mathInput) {
            return;
        }
        const isTextArea = mathInput instanceof HTMLTextAreaElement;
        const placeholder = isTextArea ? "" : PLACEHOLDER_LATEX;
        const scriptKind = key.scriptKind;
        const templateKind = key.templateKind;
        if (mathInput instanceof HTMLTextAreaElement) {
            const textArea = mathInput;
            const start = (_a = textArea.selectionStart) !== null && _a !== void 0 ? _a : textArea.value.length;
            const end = (_b = textArea.selectionEnd) !== null && _b !== void 0 ? _b : textArea.value.length;
            const selection = { start, end };
            if (scriptKind) {
                const result = applyScriptToText(textArea.value, selection, scriptKind, {
                    placeholder,
                    base: (_c = key.scriptBase) !== null && _c !== void 0 ? _c : null,
                    subValue: scriptKind === "sub" ? (_d = key.scriptValue) !== null && _d !== void 0 ? _d : null : (_e = key.scriptSubValue) !== null && _e !== void 0 ? _e : null,
                    supValue: scriptKind === "sup" ? (_f = key.scriptValue) !== null && _f !== void 0 ? _f : null : (_g = key.scriptSupValue) !== null && _g !== void 0 ? _g : null,
                });
                textArea.value = result.text;
                textArea.setSelectionRange(result.selectionStart, result.selectionEnd);
                textArea.focus();
                textArea.dispatchEvent(new Event("input", { bubbles: true }));
                return;
            }
            if (templateKind) {
                const result = applyTemplateToText(textArea.value, selection, key.latex, {
                    placeholder,
                    baseMode: templateKind,
                    baseIndex: key.templateTarget,
                    baseSeparator: key.templateSeparator,
                    baseScope: key.templateScope,
                });
                textArea.value = result.text;
                textArea.setSelectionRange(result.selectionStart, result.selectionEnd);
                textArea.focus();
                textArea.dispatchEvent(new Event("input", { bubbles: true }));
                return;
            }
            const insertValue = resolveInsertValue(key, true);
            if (!insertValue) {
                return;
            }
            textArea.value = textArea.value.slice(0, start) + insertValue + textArea.value.slice(end);
            const nextPos = start + insertValue.length;
            textArea.setSelectionRange(nextPos, nextPos);
            textArea.focus();
            textArea.dispatchEvent(new Event("input", { bubbles: true }));
            return;
        }
        const mathField = mathInput;
        (_h = mathField.focus) === null || _h === void 0 ? void 0 : _h.call(mathField);
        // Template keys with a selection: read selected LaTeX and build the
        // template before inserting, so we never have to rewrite the full value.
        if (templateKind && typeof mathField.getValue === "function") {
            const selectionOffset = getMathFieldSelectionRange(mathField);
            const hasSelection = selectionOffset.start !== selectionOffset.end;
            if (hasSelection) {
                const readFn = mathField.getValue;
                let selectedLatex = null;
                try {
                    const val = readFn(selectionOffset.start, selectionOffset.end, "latex");
                    if (typeof val === "string")
                        selectedLatex = val;
                }
                catch { /* ignore */ }
                if (selectedLatex) {
                    let builtLatex;
                    if (templateKind === "wrap") {
                        const parts = key.latex.split("#?");
                        const placeholderCount = Math.max(0, parts.length - 1);
                        const targetIndex = placeholderCount === 0
                            ? null
                            : Math.max(0, Math.min((_j = key.templateTarget) !== null && _j !== void 0 ? _j : 0, placeholderCount - 1));
                        builtLatex = (_k = parts[0]) !== null && _k !== void 0 ? _k : "";
                        for (let i = 0; i < placeholderCount; i += 1) {
                            builtLatex += (targetIndex !== null && i === targetIndex) ? selectedLatex : "#?";
                            builtLatex += (_l = parts[i + 1]) !== null && _l !== void 0 ? _l : "";
                        }
                    }
                    else {
                        // "after" mode: template placeholders + separator + selected content
                        builtLatex = key.latex + ((_m = key.templateSeparator) !== null && _m !== void 0 ? _m : "") + selectedLatex;
                    }
                    const insertOpts = { selectionMode: "placeholder", focus: true, feedback: false, format: "latex" };
                    if (typeof mathField.executeCommand === "function") {
                        mathField.executeCommand("insert", builtLatex, insertOpts);
                        mathInput.dispatchEvent(new Event("input", { bubbles: true }));
                        return;
                    }
                    if (typeof mathField.insert === "function") {
                        mathField.insert(builtLatex, insertOpts);
                        mathInput.dispatchEvent(new Event("input", { bubbles: true }));
                        return;
                    }
                }
            }
            // No selection or reading failed: fall through to normal insert path
        }
        // Script keys: fall through to normal insert path (MathLive handles scripts natively)
        // Style wrapper templates (e.g. \mathbb{#?}, \mathcal{#?}):
        // use MathLive's insert API instead of rewriting the full value.
        if (!scriptKind &&
            !templateKind &&
            typeof mathField.getValue === "function" &&
            runtime.STYLE_WRAPPER_TEMPLATE_RE.test(key.latex)) {
            const selectionOffset = getMathFieldSelectionRange(mathField);
            let selectedLatex = null;
            if (selectionOffset.start !== selectionOffset.end) {
                try {
                    const readFn = mathField.getValue;
                    const val = readFn(selectionOffset.start, selectionOffset.end, "latex");
                    if (typeof val === "string")
                        selectedLatex = val;
                }
                catch { /* ignore */ }
            }
            const seed = selectedLatex && selectedLatex.length > 0 ? selectedLatex : "#?";
            const builtLatex = key.latex.replace(/#\?/g, seed);
            const insertOpts = {
                selectionMode: selectedLatex ? "after" : "placeholder",
                focus: true,
                feedback: false,
                format: "latex",
            };
            let inserted = false;
            if (typeof mathField.executeCommand === "function") {
                try {
                    const ok = mathField.executeCommand("insert", builtLatex, insertOpts);
                    inserted = ok !== false;
                }
                catch { /* ignore */ }
            }
            if (!inserted && typeof mathField.insert === "function") {
                try {
                    mathField.insert(builtLatex, insertOpts);
                    inserted = true;
                }
                catch { /* ignore */ }
            }
            if (inserted) {
                mathInput.dispatchEvent(new Event("input", { bubbles: true }));
                return;
            }
        }
        const insertValue = resolveInsertValue(key, false, {
            preserveTemplateMarkers: true,
        });
        const fallbackInsertValue = resolveInsertValue(key, false);
        if (!insertValue && !fallbackInsertValue) {
            return;
        }
        const hasTemplateMarkers = typeof key.latex === "string" && key.latex.includes("#?");
        const insertOptions = {
            selectionMode: hasTemplateMarkers ? "placeholder" : "after",
            focus: true,
            feedback: false,
            format: "latex",
        };
        if (typeof mathField.executeCommand === "function") {
            const beforeValue = typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
            try {
                const ok = mathField.executeCommand("insert", insertValue, insertOptions);
                const afterValue = typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
                const changed = typeof beforeValue === "string" && typeof afterValue === "string" && afterValue !== beforeValue;
                if (ok !== false || changed) {
                    mathInput.dispatchEvent(new Event("input", { bubbles: true }));
                    return;
                }
            }
            catch (e) {
                console.warn("executeCommand failed:", e);
            }
        }
        if (typeof mathField.insert === "function") {
            const beforeValue = typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
            try {
                mathField.insert(insertValue, insertOptions);
                const afterValue = typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
                if (typeof beforeValue === "string" && typeof afterValue === "string" && afterValue === beforeValue) {
                    throw new Error("insert() completed without content change");
                }
                mathInput.dispatchEvent(new Event("input", { bubbles: true }));
                return;
            }
            catch {
                // ignore and continue fallback
            }
        }
        console.warn("mathfield insertion failed; skipping unsafe fallback append", key.latex, fallbackInsertValue);
    };
    return { insertMathKey };
};

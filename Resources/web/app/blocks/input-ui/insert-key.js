import { PLACEHOLDER_LATEX, applyScriptToText, applyTemplateToText, getMathFieldSelectionRange, indexToOffset, offsetToIndex, } from "../math-input-utils.js";
import { readMathFieldValue, setSelectionRange, writeMathFieldValue, } from "../input-ui-math-field.js";
export const createBlockInsertKeyOps = (runtime, deps) => {
    const resolveInsertValue = (key, isTextArea, options) => {
        const source = isTextArea && key.fallback ? key.fallback : key.latex;
        if (!isTextArea && (options === null || options === void 0 ? void 0 : options.preserveTemplateMarkers)) {
            return source;
        }
        const placeholder = isTextArea ? "" : PLACEHOLDER_LATEX;
        return source.replace(/#\\?/g, placeholder);
    };
    const insertMathKey = (key) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
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
        const applyMathFieldTextEdit = (next) => {
            writeMathFieldValue(mathField, next.text);
            const startOffset = indexToOffset(mathField, next.selectionStart);
            const endOffset = indexToOffset(mathField, next.selectionEnd);
            setSelectionRange(mathField, startOffset, endOffset);
            mathInput.dispatchEvent(new Event("input", { bubbles: true }));
        };
        if ((scriptKind || templateKind) && typeof mathField.getValue === "function") {
            const rawValue = readMathFieldValue(mathField);
            if (typeof rawValue === "string") {
                const selectionOffset = getMathFieldSelectionRange(mathField);
                const selectionIndex = {
                    start: offsetToIndex(mathField, selectionOffset.start),
                    end: offsetToIndex(mathField, selectionOffset.end),
                };
                if (scriptKind) {
                    const result = applyScriptToText(rawValue, selectionIndex, scriptKind, {
                        placeholder,
                        base: (_j = key.scriptBase) !== null && _j !== void 0 ? _j : null,
                        subValue: scriptKind === "sub" ? (_k = key.scriptValue) !== null && _k !== void 0 ? _k : null : (_l = key.scriptSubValue) !== null && _l !== void 0 ? _l : null,
                        supValue: scriptKind === "sup" ? (_m = key.scriptValue) !== null && _m !== void 0 ? _m : null : (_o = key.scriptSupValue) !== null && _o !== void 0 ? _o : null,
                    });
                    applyMathFieldTextEdit(result);
                    return;
                }
                if (templateKind) {
                    const result = applyTemplateToText(rawValue, selectionIndex, key.latex, {
                        placeholder,
                        baseMode: templateKind,
                        baseIndex: key.templateTarget,
                        baseSeparator: key.templateSeparator,
                        baseScope: key.templateScope,
                    });
                    applyMathFieldTextEdit(result);
                    return;
                }
            }
        }
        if (!scriptKind &&
            !templateKind &&
            typeof mathField.getValue === "function" &&
            runtime.STYLE_WRAPPER_TEMPLATE_RE.test(key.latex)) {
            const rawValue = readMathFieldValue(mathField);
            if (typeof rawValue === "string") {
                const selectionOffset = getMathFieldSelectionRange(mathField);
                const selectionIndex = {
                    start: offsetToIndex(mathField, selectionOffset.start),
                    end: offsetToIndex(mathField, selectionOffset.end),
                };
                const selectedText = rawValue.slice(selectionIndex.start, selectionIndex.end);
                const seed = selectedText.length > 0 ? selectedText : "\\\\,";
                const replacement = key.latex.replace(/#\\?/g, seed);
                const nextText = rawValue.slice(0, selectionIndex.start) + replacement + rawValue.slice(selectionIndex.end);
                writeMathFieldValue(mathField, nextText);
                const slotPrefix = (_p = key.latex.split("#?")[0]) !== null && _p !== void 0 ? _p : "";
                const slotStartIndex = selectionIndex.start + slotPrefix.length;
                const slotEndIndex = slotStartIndex + seed.length;
                const slotStartOffset = indexToOffset(mathField, slotStartIndex);
                const slotEndOffset = indexToOffset(mathField, slotEndIndex);
                if (selectedText.length === 0) {
                    setSelectionRange(mathField, slotStartOffset, slotEndOffset);
                }
                else {
                    setSelectionRange(mathField, slotEndOffset, slotEndOffset);
                }
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
                    deps.updateMathPreview();
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
                deps.updateMathPreview();
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

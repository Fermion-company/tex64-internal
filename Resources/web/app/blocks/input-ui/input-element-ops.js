import { readMathFieldValue, writeMathFieldValue } from "../input-ui-math-field.js";
import { normalizeLegacyEnvMarkers, unwrapAligned } from "../input-ui-latex-format.js";
import { decorateTextareaAsMathfield } from "./textarea-shim.js";
import { blockDirectLatexCommandInput } from "./direct-command-input.js";
export const createBlockMathInputElementOps = (runtime, mathValueOps) => {
    const setMathInputElement = (element) => {
        runtime.state.mathInput = element;
        runtime.state.mathFieldWrapped = false;
        if (!runtime.state.mathInput) {
            return;
        }
        if (runtime.state.mathInput instanceof HTMLTextAreaElement) {
            decorateTextareaAsMathfield(runtime, runtime.state.mathInput);
        }
        if (!runtime.state.currentMathValue) {
            if (runtime.state.mathInput instanceof HTMLTextAreaElement) {
                attachMathInputListener();
            }
            return;
        }
        const resolvedValue = runtime.state.mathInput instanceof HTMLTextAreaElement
            ? { value: runtime.state.currentMathValue, wrapped: false }
            : mathValueOps.prepareMathValueForField(runtime.state.currentMathValue);
        if (runtime.state.mathInput instanceof HTMLTextAreaElement) {
            runtime.state.mathInput.value = resolvedValue.value;
            attachMathInputListener();
            return;
        }
        runtime.state.mathFieldWrapped = resolvedValue.wrapped;
        writeMathFieldValue(runtime.state.mathInput, resolvedValue.value);
    };
    const setMathInputFallback = (value) => {
        runtime.state.mathInputFallback = typeof value === "string" ? value : null;
    };
    const getMathInputFallback = () => runtime.state.mathInputFallback;
    const getMathInputValue = () => {
        if (runtime.state.mathInputFallback !== null) {
            return mathValueOps.normalizeMathValueForOutput(runtime.state.mathInputFallback);
        }
        if (!runtime.state.mathInput) {
            return "";
        }
        if (runtime.state.mathInput instanceof HTMLElement &&
            runtime.state.mathInput.tagName.toLowerCase() === "math-field") {
            const rawValue = readMathFieldValue(runtime.state.mathInput);
            const normalizedValue = normalizeLegacyEnvMarkers(rawValue);
            if (runtime.state.mathFieldWrapped) {
                const { value: unwrapped, didUnwrap } = unwrapAligned(normalizedValue);
                if (didUnwrap) {
                    runtime.state.currentMathValue = unwrapped;
                    return unwrapped;
                }
                runtime.state.mathFieldWrapped = false;
            }
            runtime.state.currentMathValue = normalizedValue;
            return normalizedValue;
        }
        if (runtime.state.mathInput instanceof HTMLTextAreaElement) {
            runtime.state.mathFieldWrapped = false;
            runtime.state.currentMathValue = normalizeLegacyEnvMarkers(runtime.state.mathInput.value);
            return runtime.state.currentMathValue;
        }
        runtime.state.mathFieldWrapped = false;
        const value = runtime.state.mathInput.value;
        return typeof value === "string" ? normalizeLegacyEnvMarkers(value) : "";
    };
    const setMathInputValue = (value) => {
        if (!runtime.state.mathInput) {
            runtime.state.currentMathValue = value;
            runtime.state.mathFieldWrapped = false;
            return;
        }
        if (runtime.state.mathInput instanceof HTMLTextAreaElement) {
            runtime.state.mathFieldWrapped = false;
            runtime.state.currentMathValue = value;
            runtime.state.mathInput.value = value;
            return;
        }
        const preparedValue = mathValueOps.prepareMathValueForField(value);
        runtime.state.mathFieldWrapped = preparedValue.wrapped;
        runtime.state.currentMathValue = value;
        writeMathFieldValue(runtime.state.mathInput, preparedValue.value);
    };
    const isMathInputFocused = () => {
        const mathInput = runtime.state.mathInput;
        if (!mathInput) {
            return false;
        }
        if (document.activeElement === mathInput) {
            return true;
        }
        if (mathInput.classList.contains("is-focused")) {
            return true;
        }
        if (typeof mathInput.matches === "function" && mathInput.matches(":focus-within")) {
            return true;
        }
        return false;
    };
    const attachMathInputListener = () => {
        var _a;
        const mathInput = runtime.state.mathInput;
        if (!mathInput) {
            return;
        }
        if (mathInput instanceof HTMLElement && mathInput.tagName.toLowerCase() === "math-field") {
            return;
        }
        const inputElement = mathInput;
        if (runtime.attachedMathInputListeners.has(inputElement)) {
            return;
        }
        runtime.attachedMathInputListeners.add(inputElement);
        if (inputElement instanceof HTMLTextAreaElement) {
            decorateTextareaAsMathfield(runtime, inputElement);
            (_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.attach(inputElement);
        }
        inputElement.addEventListener("input", () => {
            if (inputElement instanceof HTMLTextAreaElement) {
                runtime.state.mathFieldWrapped = false;
                runtime.state.currentMathValue = inputElement.value;
                return;
            }
            runtime.state.mathFieldWrapped = false;
            const value = inputElement.value;
            runtime.state.currentMathValue = typeof value === "string" ? value : "";
        });
        if (inputElement instanceof HTMLTextAreaElement) {
            const textArea = inputElement;
            textArea.addEventListener("keydown", (event) => {
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
                const isSuggestShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && event.key === ".";
                if (isSuggestShortcut) {
                    const opened = Boolean((_b = runtime.state.mathWysiwygApi) === null || _b === void 0 ? void 0 : _b.openExplicitSuggestions());
                    if (opened) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                    }
                    return;
                }
                if (event.key === "Escape") {
                    (_c = runtime.state.mathWysiwygApi) === null || _c === void 0 ? void 0 : _c.close();
                    return;
                }
            });
            textArea.addEventListener("focus", () => {
                runtime.state.mathKeyboardVisibilityHandler();
                textArea.classList.add("is-focused");
            });
            textArea.addEventListener("blur", () => {
                var _a;
                textArea.classList.remove("is-focused");
                (_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.close();
            });
            textArea.addEventListener("compositionstart", (event) => {
                var _a;
                event.stopPropagation();
                (_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.setComposing(true);
            });
            textArea.addEventListener("compositionend", (event) => {
                var _a;
                event.stopPropagation();
                (_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.setComposing(false);
            });
        }
    };
    return {
        setMathInputElement,
        setMathInputFallback,
        getMathInputFallback,
        getMathInputValue,
        setMathInputValue,
        isMathInputFocused,
        attachMathInputListener,
    };
};

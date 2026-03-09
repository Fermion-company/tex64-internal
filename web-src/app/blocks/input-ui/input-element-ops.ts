import { readMathFieldValue, writeMathFieldValue } from "../input-ui-math-field.js";
import { normalizeLegacyEnvMarkers, unwrapAligned } from "../input-ui-latex-format.js";
import type { BlockInputRuntime } from "./runtime.js";
import type { MathValueOps } from "./math-normalize.js";
import { decorateTextareaAsMathfield } from "./textarea-shim.js";
import { blockDirectLatexCommandInput } from "./direct-command-input.js";

export type BlockMathInputElementOps = {
  setMathInputElement: (element: HTMLElement | null) => void;
  setMathInputFallback: (value: string | null) => void;
  getMathInputFallback: () => string | null;
  getMathInputValue: () => string;
  setMathInputValue: (value: string) => void;
  isMathInputFocused: () => boolean;
  attachMathInputListener: () => void;
};

export const createBlockMathInputElementOps = (
  runtime: BlockInputRuntime,
  mathValueOps: MathValueOps
): BlockMathInputElementOps => {
  const setMathInputElement = (element: HTMLElement | null) => {
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
    const resolvedValue =
      runtime.state.mathInput instanceof HTMLTextAreaElement
        ? { value: runtime.state.currentMathValue, wrapped: false }
        : mathValueOps.prepareMathValueForField(runtime.state.currentMathValue);
    if (runtime.state.mathInput instanceof HTMLTextAreaElement) {
      runtime.state.mathInput.value = resolvedValue.value;
      attachMathInputListener();
      return;
    }
    runtime.state.mathFieldWrapped = resolvedValue.wrapped;
    writeMathFieldValue(
      runtime.state.mathInput as { setValue?: (value: string) => void; value?: string },
      resolvedValue.value
    );
  };

  const setMathInputFallback = (value: string | null) => {
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
    if (
      runtime.state.mathInput instanceof HTMLElement &&
      runtime.state.mathInput.tagName.toLowerCase() === "math-field"
    ) {
      const rawValue = readMathFieldValue(
        runtime.state.mathInput as { getValue?: (format?: string) => unknown; value?: unknown }
      );
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
    const value = (runtime.state.mathInput as { value?: string }).value;
    return typeof value === "string" ? normalizeLegacyEnvMarkers(value) : "";
  };

  const setMathInputValue = (value: string) => {
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
    writeMathFieldValue(
      runtime.state.mathInput as { setValue?: (value: string) => void; value?: string },
      preparedValue.value
    );
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
      runtime.state.mathWysiwygApi?.attach(inputElement);
    }

    inputElement.addEventListener("input", () => {
      if (inputElement instanceof HTMLTextAreaElement) {
        runtime.state.mathFieldWrapped = false;
        runtime.state.currentMathValue = inputElement.value;
        return;
      }
      runtime.state.mathFieldWrapped = false;
      const value = (inputElement as { value?: string }).value;
      runtime.state.currentMathValue = typeof value === "string" ? value : "";
    });

    if (inputElement instanceof HTMLTextAreaElement) {
      const textArea = inputElement;
      textArea.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.isComposing) {
          return;
        }
        if (runtime.state.mathWysiwygApi?.handleKeydown(event)) {
          event.stopImmediatePropagation();
          return;
        }
        if (blockDirectLatexCommandInput(runtime, event)) {
          return;
        }
        const isSuggestShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && event.key === ".";
        if (isSuggestShortcut) {
          const opened = Boolean(runtime.state.mathWysiwygApi?.openExplicitSuggestions());
          if (opened) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
          return;
        }
        if (event.key === "Escape") {
          runtime.state.mathWysiwygApi?.close();
          return;
        }
      });
      textArea.addEventListener("focus", () => {
        runtime.state.mathKeyboardVisibilityHandler();
        textArea.classList.add("is-focused");
      });
      textArea.addEventListener("blur", () => {
        textArea.classList.remove("is-focused");
        runtime.state.mathWysiwygApi?.close();
      });
      textArea.addEventListener("compositionstart", (event) => {
        event.stopPropagation();
        runtime.state.mathWysiwygApi?.setComposing(true);
      });
      textArea.addEventListener("compositionend", (event) => {
        event.stopPropagation();
        runtime.state.mathWysiwygApi?.setComposing(false);
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

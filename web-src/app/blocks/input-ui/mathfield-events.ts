import { PLACEHOLDER_LATEX, getMathFieldSelectionRange } from "../math-input-utils.js";
import { readMathFieldValue } from "../input-ui-math-field.js";
import {
  normalizeLegacyEnvMarkers,
  shouldWrapAligned,
  stripEmptyAlignedRows,
  unwrapAligned,
} from "../input-ui-latex-format.js";
import type { MathKey } from "../../types.js";
import type { BlockInputRuntime } from "./runtime.js";
import { blockDirectLatexCommandInput } from "./direct-command-input.js";
import { createMathfieldMatrixOps, type ReadMathFieldLatex } from "./mathfield-matrix-ops.js";

export type BlockMathfieldEventsOps = {
  attachMathFieldEvents: (mathfield: HTMLElement) => void;
};

export const createBlockMathfieldEventsOps = (runtime: BlockInputRuntime, deps: { insertMathKey: (key: MathKey) => void }): BlockMathfieldEventsOps => {
  const attachMathFieldEvents = (mathfield: HTMLElement) => {
    const closeWysiwygSuggestions = () => {
      runtime.state.mathWysiwygApi?.close();
    };

    const readMathFieldLatex: ReadMathFieldLatex = (target, ...args) => {
      if (typeof target.getValue !== "function") {
        return null;
      }
      try {
        const value = target.getValue(...args);
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    };

    const syncMathFieldValue = () => {
      try {
        const rawValue = normalizeLegacyEnvMarkers(
          readMathFieldValue(mathfield as { getValue?: (format?: string) => unknown; value?: unknown })
        );
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
      } catch {
        // Ensure we never lose the current value due to a processing error.
        // readMathFieldValue already has its own fallbacks, so this is a last-resort guard.
      }
    };

    mathfield.addEventListener("input", syncMathFieldValue);
    mathfield.addEventListener("change", syncMathFieldValue);

    const tryWrapSelectionWithFraction = () => {
      const mathfieldApi = mathfield as {
        getValue?: (...args: unknown[]) => unknown;
        executeCommand?: (command: string, ...args: unknown[]) => boolean;
        insert?: (value: string, options?: Record<string, unknown>) => void;
        focus?: () => void;
      };
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
        } catch {
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
      mathfieldApi.focus?.();
      mathfield.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };

    const matrixOps = createMathfieldMatrixOps({
      mathfield,
      mathWysiwygApi: runtime.state.mathWysiwygApi,
      readMathFieldLatex,
    });

    const stripPlaceholderAndWhitespace = (value: string) =>
      value
        .replace(/\\placeholder(?:\\[[^\\]]*\\])?\\{(?:[^{}]|\\.)*\\}/g, "")
        .replace(/\\s+/g, "");

    const extractSingleEnvironmentInner = (value: string) => {
      const match = value.match(/^\\begin\\{([A-Za-z*]+)\\}([\\s\\S]*)\\end\\{\\1\\}$/);
      return match ? match[2] : value;
    };

    const isSubsequence = (needle: string, haystack: string) => {
      if (!needle) return true;
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

    const isRowInsertionStable = (before: string, after: string) => {
      const beforeCore = stripPlaceholderAndWhitespace(extractSingleEnvironmentInner(before));
      const afterCore = stripPlaceholderAndWhitespace(extractSingleEnvironmentInner(after));
      if (!beforeCore) {
        return afterCore.length > 0;
      }
      // Row insertion may split the original `\\\\`-separated body, so `includes()` is too strict.
      // Require that the original core sequence is preserved in order.
      return isSubsequence(beforeCore, afterCore);
    };

    const handleMathFieldKeydown = (event: KeyboardEvent) => {
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
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!tryWrapSelectionWithFraction()) {
          deps.insertMathKey({ label: "frac", latex: "\\frac{#?}{#?}" });
          mathfield.dispatchEvent(new Event("input", { bubbles: true }));
        }
        closeWysiwygSuggestions();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
        const mathfieldApi = mathfield as {
          executeCommand?: (command: string, ...args: unknown[]) => boolean;
          getValue?: (format?: string) => unknown;
          insert?: (value: string, options?: Record<string, unknown>) => void;
        };
        if (!event.metaKey && !event.ctrlKey) {
          let handled = matrixOps.tryInsertMatrixRow();
          if (!handled && typeof mathfieldApi.executeCommand === "function") {
            const before = readMathFieldLatex(mathfieldApi, "latex");
            try {
              const ok = mathfieldApi.executeCommand("addRowAfter");
              const after = readMathFieldLatex(mathfieldApi, "latex");
              const changed = typeof before === "string" && typeof after === "string" && after !== before;
              if (ok !== false || changed) {
                handled = changed ? isRowInsertionStable(before ?? "", after ?? "") : Boolean(ok);
                if (!handled) {
                  try {
                    mathfieldApi.executeCommand("undo");
                  } catch {
                    // ignore undo failure
                  }
                }
              }
            } catch {
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
                } catch {
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
                } catch {
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
        } else {
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
            } catch {
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
          runtime.deps.onMathFieldSubmit?.();
          return;
        }
      }
      if (event.defaultPrevented) {
        return;
      }
      if (
        !event.metaKey &&
        !event.altKey &&
        event.ctrlKey &&
        event.key === "."
      ) {
        const opened = Boolean(runtime.state.mathWysiwygApi?.openExplicitSuggestions());
        const fallbackOpened = opened ? false : matrixOps.openMatrixOpsPalette();
        if (opened || fallbackOpened) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      if (event.key === "Escape") {
        closeWysiwygSuggestions();
        mathfield.blur();
        return;
      }
    };

    mathfield.addEventListener("keydown", handleMathFieldKeydown, { capture: true });
    const shadowRoot = (mathfield as { shadowRoot?: ShadowRoot }).shadowRoot;
    if (shadowRoot) {
      shadowRoot.addEventListener("keydown", handleMathFieldKeydown, { capture: true });
    }

    if (!runtime.state.globalWysiwygKeydownBound) {
      runtime.state.globalWysiwygKeydownBound = true;
      document.addEventListener(
        "keydown",
        (event: KeyboardEvent) => {
          if (!runtime.state.mathWysiwygApi) {
            return;
          }
          if (runtime.state.mathWysiwygApi.handleKeydown(event)) {
            event.stopImmediatePropagation();
          }
        },
        { capture: true }
      );
    }

    mathfield.addEventListener("focus", () => {
      runtime.state.mathKeyboardVisibilityHandler();
      mathfield.classList.add("is-focused");
    });

    mathfield.addEventListener("blur", () => {
      mathfield.classList.remove("is-focused");
      closeWysiwygSuggestions();
    });

    mathfield.addEventListener("compositionstart", (e) => {
      e.stopPropagation();
      runtime.state.mathWysiwygApi?.setComposing(true);
    });
    mathfield.addEventListener("compositionend", (e) => {
      e.stopPropagation();
      runtime.state.mathWysiwygApi?.setComposing(false);
    });

    mathfield.addEventListener("move-out", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    runtime.state.mathWysiwygApi?.attach(mathfield);
  };

  return { attachMathFieldEvents };
};

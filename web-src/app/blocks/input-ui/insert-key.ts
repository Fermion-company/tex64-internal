import type { MathKey } from "../../types.js";
import {
  PLACEHOLDER_LATEX,
  applyScriptToText,
  applyTemplateToText,
  getMathFieldSelectionRange,
} from "../math-input-utils.js";
import {
  readMathFieldValue,
} from "../input-ui-math-field.js";
import type { BlockInputRuntime } from "./runtime.js";

export type BlockInsertKeyOps = {
  insertMathKey: (key: MathKey) => void;
};

export const createBlockInsertKeyOps = (
  runtime: BlockInputRuntime
): BlockInsertKeyOps => {
  const resolveInsertValue = (
    key: MathKey,
    isTextArea: boolean,
    options?: { preserveTemplateMarkers?: boolean }
  ) => {
    const source = isTextArea && key.fallback ? key.fallback : key.latex;
    if (!isTextArea && options?.preserveTemplateMarkers) {
      return source;
    }
    const placeholder = isTextArea ? "" : PLACEHOLDER_LATEX;
    return source.replace(/#\\?/g, placeholder);
  };

  const insertMathKey = (key: MathKey) => {
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
      const start = textArea.selectionStart ?? textArea.value.length;
      const end = textArea.selectionEnd ?? textArea.value.length;
      const selection = { start, end };

      if (scriptKind) {
        const result = applyScriptToText(textArea.value, selection, scriptKind, {
          placeholder,
          base: key.scriptBase ?? null,
          subValue: scriptKind === "sub" ? key.scriptValue ?? null : key.scriptSubValue ?? null,
          supValue: scriptKind === "sup" ? key.scriptValue ?? null : key.scriptSupValue ?? null,
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

    const mathField = mathInput as {
      getValue?: (format?: string) => unknown;
      setValue?: (value: string) => void;
      value?: string;
      insert?: (value: string, options?: Record<string, unknown>) => void;
      executeCommand?: (...args: unknown[]) => boolean;
      focus?: () => void;
      select?: (start: number, end: number) => void;
      setSelection?: (start: number, end: number) => void;
      selection?: unknown;
      position?: number;
    };

    mathField.focus?.();

    // Template keys with a selection: read selected LaTeX and build the
    // template before inserting, so we never have to rewrite the full value.
    if (templateKind && typeof mathField.getValue === "function") {
      const selectionOffset = getMathFieldSelectionRange(mathField);
      const hasSelection = selectionOffset.start !== selectionOffset.end;
      if (hasSelection) {
        const readFn = mathField.getValue as (...args: unknown[]) => unknown;
        let selectedLatex: string | null = null;
        try {
          const val = readFn(selectionOffset.start, selectionOffset.end, "latex");
          if (typeof val === "string") selectedLatex = val;
        } catch { /* ignore */ }
        if (selectedLatex) {
          let builtLatex: string;
          if (templateKind === "wrap") {
            const parts = key.latex.split("#?");
            const placeholderCount = Math.max(0, parts.length - 1);
            const targetIndex = placeholderCount === 0
              ? null
              : Math.max(0, Math.min(key.templateTarget ?? 0, placeholderCount - 1));
            builtLatex = parts[0] ?? "";
            for (let i = 0; i < placeholderCount; i += 1) {
              builtLatex += (targetIndex !== null && i === targetIndex) ? selectedLatex : "#?";
              builtLatex += parts[i + 1] ?? "";
            }
          } else {
            // "after" mode: template placeholders + separator + selected content
            builtLatex = key.latex + (key.templateSeparator ?? "") + selectedLatex;
          }
          const insertOpts = { selectionMode: "placeholder", focus: true, feedback: false, format: "latex" as const };
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
    if (
      !scriptKind &&
      !templateKind &&
      typeof mathField.getValue === "function" &&
      runtime.STYLE_WRAPPER_TEMPLATE_RE.test(key.latex)
    ) {
      const selectionOffset = getMathFieldSelectionRange(mathField);
      let selectedLatex: string | null = null;
      if (selectionOffset.start !== selectionOffset.end) {
        try {
          const readFn = mathField.getValue as (...args: unknown[]) => unknown;
          const val = readFn(selectionOffset.start, selectionOffset.end, "latex");
          if (typeof val === "string") selectedLatex = val;
        } catch { /* ignore */ }
      }
      const seed = selectedLatex && selectedLatex.length > 0 ? selectedLatex : "#?";
      const builtLatex = key.latex.replace(/#\?/g, seed);
      const insertOpts = {
        selectionMode: selectedLatex ? "after" : "placeholder",
        focus: true,
        feedback: false,
        format: "latex" as const,
      };
      let inserted = false;
      if (typeof mathField.executeCommand === "function") {
        try {
          const ok = mathField.executeCommand("insert", builtLatex, insertOpts);
          inserted = ok !== false;
        } catch { /* ignore */ }
      }
      if (!inserted && typeof mathField.insert === "function") {
        try {
          mathField.insert(builtLatex, insertOpts);
          inserted = true;
        } catch { /* ignore */ }
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
      format: "latex" as const,
    };

    if (typeof mathField.executeCommand === "function") {
      const beforeValue = typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
      try {
        const ok = mathField.executeCommand("insert", insertValue, insertOptions);
        const afterValue = typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
        const changed =
          typeof beforeValue === "string" && typeof afterValue === "string" && afterValue !== beforeValue;
        if (ok !== false || changed) {
          mathInput.dispatchEvent(new Event("input", { bubbles: true }));

          return;
        }
      } catch (e) {
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
      } catch {
        // ignore and continue fallback
      }
    }

    console.warn(
      "mathfield insertion failed; skipping unsafe fallback append",
      key.latex,
      fallbackInsertValue
    );
  };

  return { insertMathKey };
};


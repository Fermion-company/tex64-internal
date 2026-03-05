import type { MathKey } from "../../types.js";
import {
  PLACEHOLDER_LATEX,
  applyScriptToText,
  applyTemplateToText,
  getMathFieldSelectionRange,
  indexToOffset,
  offsetToIndex,
} from "../math-input-utils.js";
import {
  readMathFieldValue,
  setSelectionRange,
  type MathFieldPlaceholderApi,
  writeMathFieldValue,
} from "../input-ui-math-field.js";
import type { BlockInputRuntime } from "./runtime.js";

export type BlockInsertKeyOps = {
  insertMathKey: (key: MathKey) => void;
};

export const createBlockInsertKeyOps = (
  runtime: BlockInputRuntime,
  deps: { updateMathPreview: () => void }
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

    const applyMathFieldTextEdit = (next: { text: string; selectionStart: number; selectionEnd: number }) => {
      writeMathFieldValue(mathField, next.text);

      const startOffset = indexToOffset(mathField, next.selectionStart);
      const endOffset = indexToOffset(mathField, next.selectionEnd);
      setSelectionRange(mathField as MathFieldPlaceholderApi, startOffset, endOffset);
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
            base: key.scriptBase ?? null,
            subValue: scriptKind === "sub" ? key.scriptValue ?? null : key.scriptSubValue ?? null,
            supValue: scriptKind === "sup" ? key.scriptValue ?? null : key.scriptSupValue ?? null,
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

    if (
      !scriptKind &&
      !templateKind &&
      typeof mathField.getValue === "function" &&
      runtime.STYLE_WRAPPER_TEMPLATE_RE.test(key.latex)
    ) {
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
        const nextText =
          rawValue.slice(0, selectionIndex.start) + replacement + rawValue.slice(selectionIndex.end);
        writeMathFieldValue(mathField, nextText);

        const slotPrefix = key.latex.split("#?")[0] ?? "";
        const slotStartIndex = selectionIndex.start + slotPrefix.length;
        const slotEndIndex = slotStartIndex + seed.length;
        const slotStartOffset = indexToOffset(mathField, slotStartIndex);
        const slotEndOffset = indexToOffset(mathField, slotEndIndex);
        if (selectedText.length === 0) {
          setSelectionRange(mathField as MathFieldPlaceholderApi, slotStartOffset, slotEndOffset);
        } else {
          setSelectionRange(mathField as MathFieldPlaceholderApi, slotEndOffset, slotEndOffset);
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
          deps.updateMathPreview();
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
        deps.updateMathPreview();
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


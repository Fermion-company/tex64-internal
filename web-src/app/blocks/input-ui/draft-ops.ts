import { reconstructionBlock } from "../context.js";
import type { BlockContent } from "../../types.js";
import type { MathDisplayWrap, MathInlineWrap, MathInsertMode } from "../input-ui-settings.js";
import type { BlockInputRuntime } from "./runtime.js";

export type BlockDraftOps = {
  buildMathSnippet: (formula: string) => string;
  getBlockDraft: () => { snippet: string; content: BlockContent } | null;
};

export const createBlockDraftOps = (runtime: BlockInputRuntime, deps: {
  getMathInputValue: () => string;
  normalizeMathValueForOutput: (value: string) => string;
}): BlockDraftOps => {
  const buildMathSnippet = (formula: string) => {
    const context = runtime.deps.getActiveBlockContext();
    if (context) {
      return reconstructionBlock(context, formula);
    }

    const trimmed = formula.trim();
    if (!trimmed) {
      return "";
    }

    if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
      return trimmed;
    }
    if (trimmed.startsWith("$") && trimmed.endsWith("$")) {
      return trimmed;
    }
    if (trimmed.startsWith("\\(") && trimmed.endsWith("\\)")) {
      return trimmed;
    }
    if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
      return trimmed;
    }
    if (trimmed.startsWith("\\begin{")) {
      return trimmed;
    }

    const mathInsertMode = runtime.state.mathInsertMode as MathInsertMode;
    const mathInlineWrap = runtime.state.mathInlineWrap as MathInlineWrap;
    const mathDisplayWrap = runtime.state.mathDisplayWrap as MathDisplayWrap;

    switch (mathInsertMode) {
      case "inline":
        if (mathInlineWrap === "inline-paren") {
          return ["\\(", trimmed, "\\)"].join("");
        }
        return `$${trimmed}$`;
      case "display":
        if (mathDisplayWrap === "display-dollar") {
          return `$$${trimmed}$$`;
        }
        return `\\[${trimmed}\\]`;
      case "align":
        return ["\\begin{align*}", trimmed, "\\end{align*}"].join("\n");
      case "gather":
        return ["\\begin{gather*}", trimmed, "\\end{gather*}"].join("\n");
      case "none":
        return trimmed;
      default:
        return `$${trimmed}$`;
    }
  };

  const getBlockDraft = (): { snippet: string; content: BlockContent } | null => {
    const formula = deps.getMathInputValue();
    const normalizedFormula = deps.normalizeMathValueForOutput(formula);
    const snippet = buildMathSnippet(normalizedFormula);
    if (!snippet.trim()) {
      return null;
    }
    return { snippet, content: { formula: normalizedFormula.trim() } };
  };

  return { buildMathSnippet, getBlockDraft };
};


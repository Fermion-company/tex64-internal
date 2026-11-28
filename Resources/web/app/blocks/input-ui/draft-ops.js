import { reconstructionBlock } from "../context.js";
export const createBlockDraftOps = (runtime, deps) => {
    const buildMathSnippet = (formula) => {
        var _a;
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
        const environment = (_a = /^\\begin\{([^}]+)\}/.exec(trimmed)) === null || _a === void 0 ? void 0 : _a[1];
        // Matrices and aligned fragments need an enclosing math mode. Display
        // environments such as equation and align already provide their own.
        if (environment === "split") {
            // amsmath only accepts split inside an AMS display, including \[...\].
            // Neither inline delimiters nor a primitive $$ display can contain it.
            if (runtime.state.mathInsertMode === "inline" || runtime.state.mathInsertMode === "display") {
                return `\\[${trimmed}\\]`;
            }
        }
        else if (environment && !/^(?:[pbBvV]?(?:small)?matrix|array|subarray|d?r?cases|aligned(?:at)?|gathered)\*?$/.test(environment)) {
            return trimmed;
        }
        const mathInsertMode = runtime.state.mathInsertMode;
        const mathInlineWrap = runtime.state.mathInlineWrap;
        const mathDisplayWrap = runtime.state.mathDisplayWrap;
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
    const getBlockDraft = () => {
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

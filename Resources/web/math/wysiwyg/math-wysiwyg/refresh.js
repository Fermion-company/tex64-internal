import { getMathFieldSelectionRange } from "../../../app/blocks/math-input-utils.js";
import { buildOperatorCandidates } from "../math-wysiwyg-candidates.js";
import { getInternalSelectionRanges, indexToOffsetInRange, offsetToIndexInRange, setSelectionRange, } from "../math-wysiwyg-selection.js";
import { getMathfieldModeAtOffset } from "../../mathfield-private-adapter.js";
import { AUTO_REPLACE_OPERATORS, findAutoReplaceCorrection, findOperatorToken, findSlashCommandToken, findWordToken, } from "../math-wysiwyg-token-matching.js";
import { AUTO_COMMAND_MIN_LENGTH, AUTO_WORD_ALLOWLIST, AUTO_WORD_MIN_LENGTH, } from "./constants.js";
import { clearEditAnchor, readMathfieldLatex, resolveAnalysisRange, resolveCursorOffset } from "./mathfield.js";
const isInSuppressedTextLiteralContext = (rawValue, cursorIndex) => {
    if (!rawValue || cursorIndex <= 0) {
        return false;
    }
    const beforeCursor = rawValue.slice(0, Math.max(0, cursorIndex));
    const normalizedBeforeCursor = beforeCursor.replace(/\\lbrace/g, "{").replace(/\\rbrace/g, "}");
    const textLikeRe = /\\(?:text|operatorname\\*?|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathfrak|mathscr|mathbb|mathds|bm|textrm|textsf|texttt|textit|textbf|mbox)\\s*\\{[^{}]*$/;
    const textLikeClosedAtCursorRe = /\\(?:text|operatorname\\*?|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathfrak|mathscr|mathbb|mathds|bm|textrm|textsf|texttt|textit|textbf|mbox)\\s*\\{[^{}]*\\}$/;
    return textLikeRe.test(normalizedBeforeCursor) || textLikeClosedAtCursorRe.test(normalizedBeforeCursor);
};
const getModeAtOffset = (mathfieldApi, offset) => {
    var _a;
    if (offset < 0) {
        return null;
    }
    if (typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.getElementInfo) === "function") {
        try {
            const info = mathfieldApi.getElementInfo(offset);
            const mode = (_a = info === null || info === void 0 ? void 0 : info.mode) !== null && _a !== void 0 ? _a : null;
            if (mode === "math" || mode === "text" || mode === "latex") {
                return mode;
            }
        }
        catch {
            // ignore
        }
    }
    return getMathfieldModeAtOffset(mathfieldApi, offset);
};
const isInSuppressedTextContext = (mathfieldApi, cursorOffset) => {
    var _a, _b, _c, _d, _e, _f;
    const mode = typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.mode) === "string" ? mathfieldApi.mode : null;
    if (mode === "text") {
        return true;
    }
    const modeAtCursor = (_a = getModeAtOffset(mathfieldApi, cursorOffset)) !== null && _a !== void 0 ? _a : getModeAtOffset(mathfieldApi, cursorOffset - 1);
    if (modeAtCursor === "text") {
        return true;
    }
    const latex = readMathfieldLatex(mathfieldApi, "latex");
    if (!latex) {
        return false;
    }
    const cursorIndex = offsetToIndexInRange(mathfieldApi, 0, cursorOffset);
    if (cursorIndex <= 0) {
        return false;
    }
    const textLikeCommands = new Set([
        "text",
        "operatorname",
        "operatorname*",
        "mathrm",
        "mathbf",
        "mathit",
        "mathsf",
        "mathtt",
        "mathcal",
        "mathfrak",
        "mathscr",
        "mathbb",
        "mathds",
        "bm",
        "textrm",
        "textsf",
        "texttt",
        "textit",
        "textbf",
        "mbox",
    ]);
    let depth = 0;
    const stack = [];
    const isLetter = (ch) => /[A-Za-z]/.test(ch);
    const isEscapedAtLiteral = (text, index) => {
        let slashCount = 0;
        for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
            slashCount += 1;
        }
        return slashCount % 2 === 1;
    };
    for (let i = 0; i < latex.length && i < cursorIndex; i += 1) {
        const ch = latex[i];
        if (ch === "\\") {
            let j = i + 1;
            if (j >= cursorIndex) {
                break;
            }
            let command = "";
            if (isLetter((_b = latex[j]) !== null && _b !== void 0 ? _b : "")) {
                const start = j;
                while (j < cursorIndex && isLetter((_c = latex[j]) !== null && _c !== void 0 ? _c : "")) {
                    j += 1;
                }
                command = latex.slice(start, j);
            }
            else {
                command = (_d = latex[j]) !== null && _d !== void 0 ? _d : "";
                j += 1;
            }
            if (command === "lbrace") {
                depth += 1;
                i = Math.max(i, j - 1);
                continue;
            }
            if (command === "rbrace") {
                depth = Math.max(0, depth - 1);
                while (stack.length > 0 && ((_e = stack[stack.length - 1]) !== null && _e !== void 0 ? _e : 0) > depth) {
                    stack.pop();
                }
                i = Math.max(i, j - 1);
                continue;
            }
            let normalizedCommand = command;
            let k = j;
            while (k < cursorIndex && latex[k] === " ") {
                k += 1;
            }
            if (k < cursorIndex && latex[k] === "*" && textLikeCommands.has(`${command}*`)) {
                normalizedCommand = `${command}*`;
                k += 1;
                while (k < cursorIndex && latex[k] === " ") {
                    k += 1;
                }
            }
            if (textLikeCommands.has(normalizedCommand)) {
                if (latex[k] === "{") {
                    stack.push(depth + 1);
                }
                else if (k < cursorIndex && latex.startsWith("\\lbrace", k) && !isEscapedAtLiteral(latex, k)) {
                    depth += 1;
                    stack.push(depth);
                    i = Math.max(i, k + "\\lbrace".length - 1);
                    continue;
                }
            }
            i = Math.max(i, j - 1);
            continue;
        }
        if (ch === "{") {
            depth += 1;
            continue;
        }
        if (ch === "}") {
            depth = Math.max(0, depth - 1);
            while (stack.length > 0 && ((_f = stack[stack.length - 1]) !== null && _f !== void 0 ? _f : 0) > depth) {
                stack.pop();
            }
        }
    }
    return stack.length > 0;
};
const findScopedSlashCommandMatch = (mathfieldApi, cursorOffset) => {
    var _a;
    const beforeCursor = readMathfieldLatex(mathfieldApi, 0, cursorOffset, "latex");
    if (typeof beforeCursor !== "string") {
        return null;
    }
    const match = /\/\/([A-Za-z*]*)$/.exec(beforeCursor);
    if (!match) {
        return null;
    }
    const token = (_a = match[1]) !== null && _a !== void 0 ? _a : "";
    const endIndex = beforeCursor.length;
    const startIndex = endIndex - token.length - 2;
    if (startIndex < 0) {
        return null;
    }
    const startOffset = indexToOffsetInRange(mathfieldApi, 0, cursorOffset, startIndex, "floor");
    if (!Number.isFinite(startOffset) || startOffset < 0) {
        return null;
    }
    return { token, range: { start: startOffset, end: cursorOffset }, kind: "slash-command" };
};
export const createMathWysiwygRefreshOps = (runtime, deps) => {
    const { candidateOps, panelOps, finalizeMutationSession } = deps;
    const refresh = (options = {}) => {
        var _a;
        try {
            if (!runtime.mathfield || runtime.composing) {
                return;
            }
            if (runtime.suppressNextUpdate) {
                runtime.suppressNextUpdate = false;
                if (!options.explicit) {
                    return;
                }
            }
            const mathfieldApi = runtime.mathfield;
            if (typeof mathfieldApi.getValue !== "function") {
                candidateOps.updateCandidates(null, options);
                return;
            }
            const selection = getMathFieldSelectionRange(mathfieldApi);
            const selectionRanges = selection.start !== selection.end ? getInternalSelectionRanges(mathfieldApi) : [];
            const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
            if (!options.explicit && runtime.editAnchorOffset === null) {
                // IME-like behavior: only analyze tokens while an active edit session exists.
                candidateOps.updateCandidates(null, options);
                return;
            }
            const mode = typeof mathfieldApi.mode === "string" ? mathfieldApi.mode : null;
            if (mode === "text" && !options.explicit) {
                // Avoid noisy suggestions while typing inside \\text{...} and similar text-mode segments.
                candidateOps.updateCandidates(null, options);
                return;
            }
            const isPlaceholderSelection = selection.start !== selection.end &&
                selectionRanges.some((range) => cursorOffset >= range.start && cursorOffset <= range.end);
            if (selection.start !== selection.end && !isPlaceholderSelection) {
                const selectionLength = Math.abs(selection.end - selection.start);
                const now = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
                if (selectionLength > 1 && now - runtime.lastInputTime > 120) {
                    candidateOps.updateCandidates(null, options);
                    return;
                }
            }
            const analysisRange = resolveAnalysisRange(runtime, mathfieldApi, cursorOffset);
            const rawValue = readMathfieldLatex(mathfieldApi, analysisRange.start, analysisRange.end, "latex");
            if (typeof rawValue !== "string") {
                candidateOps.updateCandidates(null, options);
                return;
            }
            const cursorIndex = offsetToIndexInRange(mathfieldApi, analysisRange.start, cursorOffset);
            const fullRawValue = readMathfieldLatex(mathfieldApi, "latex");
            const globalCursorIndex = offsetToIndexInRange(mathfieldApi, 0, cursorOffset);
            const inSuppressedTextContext = isInSuppressedTextContext(mathfieldApi, cursorOffset) ||
                isInSuppressedTextLiteralContext(rawValue, cursorIndex) ||
                isInSuppressedTextLiteralContext(fullRawValue, globalCursorIndex);
            if (inSuppressedTextContext) {
                candidateOps.updateCandidates(null, options);
                return;
            }
            const toOffsetMatch = (match) => {
                if (!match) {
                    return null;
                }
                const startOffset = indexToOffsetInRange(mathfieldApi, analysisRange.start, analysisRange.end, match.range.start, "floor");
                const endOffset = indexToOffsetInRange(mathfieldApi, analysisRange.start, analysisRange.end, match.range.end, "ceil");
                return { token: match.token, range: { start: startOffset, end: endOffset }, kind: match.kind };
            };
            const operatorCorrectionMatch = toOffsetMatch(findAutoReplaceCorrection(rawValue, cursorIndex));
            if (operatorCorrectionMatch &&
                !options.explicit &&
                runtime.autoSuggest &&
                AUTO_REPLACE_OPERATORS.has(operatorCorrectionMatch.token)) {
                const candidates = buildOperatorCandidates(operatorCorrectionMatch.token);
                const candidate = candidates[0];
                if (candidate) {
                    const mutationId = runtime.beginMutationSession();
                    runtime.suppressNextUpdate = true;
                    panelOps.setPanelVisible(false);
                    setSelectionRange(mathfieldApi, operatorCorrectionMatch.range.start, operatorCorrectionMatch.range.end);
                    runtime.deps.insertKey(candidate.key);
                    finalizeMutationSession(mutationId);
                    return;
                }
            }
            const slashCommandMatch = (_a = findScopedSlashCommandMatch(mathfieldApi, cursorOffset)) !== null && _a !== void 0 ? _a : toOffsetMatch(findSlashCommandToken(rawValue, cursorIndex));
            if (slashCommandMatch) {
                candidateOps.updateCandidates(slashCommandMatch, { explicit: true });
                return;
            }
            const operatorMatch = toOffsetMatch(findOperatorToken(rawValue, cursorIndex));
            if (operatorMatch) {
                if (!options.explicit && runtime.autoSuggest && AUTO_REPLACE_OPERATORS.has(operatorMatch.token)) {
                    const candidates = buildOperatorCandidates(operatorMatch.token);
                    const candidate = candidates[0];
                    if (candidate) {
                        const mutationId = runtime.beginMutationSession();
                        runtime.suppressNextUpdate = true;
                        panelOps.setPanelVisible(false);
                        setSelectionRange(mathfieldApi, operatorMatch.range.start, operatorMatch.range.end);
                        runtime.deps.insertKey(candidate.key);
                        finalizeMutationSession(mutationId);
                        return;
                    }
                }
                // Only show operator suggestions on explicit/manual trigger.
                if (options.explicit) {
                    candidateOps.updateCandidates(operatorMatch, options);
                }
                else {
                    candidateOps.updateCandidates(null, options);
                }
                return;
            }
            const wordMatch = toOffsetMatch(findWordToken(rawValue, cursorIndex));
            if (!options.explicit && wordMatch) {
                const normalized = wordMatch.token.toLowerCase();
                const minLength = wordMatch.kind === "command" ? AUTO_COMMAND_MIN_LENGTH : AUTO_WORD_ALLOWLIST.has(normalized) ? 2 : AUTO_WORD_MIN_LENGTH;
                if (wordMatch.token.length >= minLength && inSuppressedTextContext) {
                    candidateOps.updateCandidates(null, options);
                    return;
                }
            }
            candidateOps.updateCandidates(wordMatch, options);
        }
        catch {
            candidateOps.updateCandidates(null, options);
        }
    };
    const close = () => {
        runtime.beginMutationSession();
        runtime.suppressNextUpdate = false;
        runtime.panelState.explicitSessionPrefixLatex = null;
        clearEditAnchor(runtime);
        candidateOps.updateCandidates(null);
    };
    const openExplicitSuggestions = () => {
        if (!runtime.mathfield || runtime.composing) {
            return false;
        }
        const mathfieldApi = runtime.mathfield;
        const selection = getMathFieldSelectionRange(mathfieldApi);
        const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
        let sessionAnchor = cursorOffset;
        const shouldCarryTypedPrefix = runtime.panelState.active && runtime.panelState.currentCandidates.length > 0;
        if (shouldCarryTypedPrefix) {
            const beforeCursor = readMathfieldLatex(mathfieldApi, 0, cursorOffset, "latex");
            if (typeof beforeCursor === "string" && beforeCursor.length > 0) {
                const trailingPatternList = [
                    /\/\/[A-Za-z*]*$/,
                    /\\[A-Za-z]*$/,
                    /[A-Za-z0-9]{1,32}$/,
                    /[+\-*/=<>:;,!?.]{1,8}$/,
                ];
                for (const pattern of trailingPatternList) {
                    const match = pattern.exec(beforeCursor);
                    if (!match || typeof match[0] !== "string") {
                        continue;
                    }
                    const startIndex = beforeCursor.length - match[0].length;
                    const anchorOffset = indexToOffsetInRange(mathfieldApi, 0, cursorOffset, startIndex, "floor");
                    if (Number.isFinite(anchorOffset) && anchorOffset >= 0) {
                        sessionAnchor = Math.max(0, Math.min(cursorOffset, anchorOffset));
                        break;
                    }
                }
            }
        }
        runtime.editAnchorOffset = sessionAnchor;
        runtime.panelState.explicitSession = true;
        runtime.panelState.explicitSessionPrefixLatex = readMathfieldLatex(mathfieldApi, 0, sessionAnchor, "latex");
        refresh({ explicit: true });
        return runtime.panelState.active;
    };
    const updateConfig = (config) => {
        if (typeof config.autoSuggest === "boolean") {
            runtime.autoSuggest = config.autoSuggest;
        }
        if (Array.isArray(config.enabledPacks)) {
            runtime.enabledPacks = new Set(config.enabledPacks);
        }
        if (!runtime.autoSuggest && runtime.panelState.active && !runtime.panelState.explicitSession) {
            candidateOps.updateCandidates(null);
            return;
        }
        if (runtime.autoSuggest && runtime.mathfield && !runtime.composing) {
            refresh();
        }
    };
    return {
        refresh,
        close,
        openExplicitSuggestions,
        updateConfig,
    };
};

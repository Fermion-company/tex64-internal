const stripMathCaptureWrapper = (value) => {
    const trimmed = value.trim();
    const wrappers = [
        ["$$", "$$"],
        ["$", "$"],
        ["\\(", "\\)"],
        ["\\[", "\\]"],
    ];
    for (const [start, end] of wrappers) {
        if (trimmed.startsWith(start) && trimmed.endsWith(end)) {
            const inner = trimmed.slice(start.length, -end.length).trim();
            if (inner) {
                return inner;
            }
        }
    }
    return trimmed;
};
const TEXT_PLACEHOLDER_PREFIX = "\x00TXTBLK";
const BARE_LATEX_STRUCTURE_COMMAND_PATTERN = /(^|[^\\A-Za-z])(frac|dfrac|tfrac|sqrt|binom|dbinom|tbinom|operatorname)(?=\*?\s*(?:\[[^\]]*\]\s*)?\{)/g;
const BARE_LATEX_OPERATOR_COMMAND_PATTERN = /(^|[^\\A-Za-z])(sum|prod|int|oint|lim)(?=$|[^A-Za-z])/g;
const normalizeBareLatexCommands = (value) => {
    if (!value)
        return value;
    return value
        .replace(BARE_LATEX_STRUCTURE_COMMAND_PATTERN, "$1\\$2")
        .replace(BARE_LATEX_OPERATOR_COMMAND_PATTERN, "$1\\$2");
};
const protectTextBlocks = (value) => {
    const blocks = [];
    const textCmdPattern = /\\(?:text|mbox|textnormal|textrm|textsf|texttt|textbf|textit)\s*\{/g;
    let result = "";
    let lastIndex = 0;
    let match;
    while ((match = textCmdPattern.exec(value)) !== null) {
        result += value.slice(lastIndex, match.index);
        const braceStart = match.index + match[0].length - 1;
        let depth = 0;
        let braceEnd = -1;
        for (let i = braceStart; i < value.length; i += 1) {
            if (value[i] === "{")
                depth += 1;
            if (value[i] === "}") {
                depth -= 1;
                if (depth === 0) {
                    braceEnd = i;
                    break;
                }
            }
        }
        if (braceEnd >= 0) {
            const fullBlock = value.slice(match.index, braceEnd + 1);
            blocks.push(fullBlock);
            result += `${TEXT_PLACEHOLDER_PREFIX}${blocks.length - 1}\x00`;
            lastIndex = braceEnd + 1;
            textCmdPattern.lastIndex = lastIndex;
        }
        else {
            result += value[match.index];
            lastIndex = match.index + 1;
            textCmdPattern.lastIndex = lastIndex;
        }
    }
    result += value.slice(lastIndex);
    return { result, blocks };
};
const restoreTextBlocks = (value, blocks) => {
    return value.replace(new RegExp(`${TEXT_PLACEHOLDER_PREFIX.replace(/\x00/g, "\\x00")}(\\d+)\\x00`, "g"), (_match, idx) => { var _a; return (_a = blocks[parseInt(idx, 10)]) !== null && _a !== void 0 ? _a : ""; });
};
const normalizeMathCaptureText = (value) => {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    const unwrapped = stripMathCaptureWrapper(trimmed);
    // Preserve LaTeX command boundaries when stripping whitespace.
    // A space between `\command` and a following letter is semantically
    // meaningful (e.g. `\pi G` → keep the boundary as `{}`).  Blindly
    // stripping it would produce `\piG`, an invalid command.
    const noWhitespace = unwrapped
        .replace(/(\\[A-Za-z]+)\s+(?=[A-Za-z])/g, "$1{}")
        .replace(/\s+/g, "");
    // Protect interior \text{...} blocks from the character filter
    const { result: withPlaceholders, blocks } = protectTextBlocks(noWhitespace);
    // Apply command repair and character filter to non-text parts.
    let cleaned = normalizeBareLatexCommands(withPlaceholders);
    cleaned = cleaned.replace(/\\newline/g, "").replace(/\\\\/g, "");
    cleaned = cleaned.replace(/[^A-Za-z0-9\\{}_^=+\-*/().,\[\]|<>!:\x00TXTBLK]/g, "");
    // Restore \text{...} blocks
    cleaned = restoreTextBlocks(cleaned, blocks);
    return cleaned;
};
export const createMathCaptureHandler = (params) => {
    let mathCaptureBusy = false;
    const handleMathCaptureImage = async (imageDataUrl, onProgress) => {
        if (mathCaptureBusy) {
            return { ok: false, error: uiText("Processing.", "Processingです。") };
        }
        if (!imageDataUrl) {
            return { ok: false, error: uiText("No capture image available.", "キャプチャNo image available。") };
        }
        mathCaptureBusy = true;
        try {
            const latex = await params.recognizeMath(imageDataUrl, onProgress);
            const normalized = normalizeMathCaptureText(latex);
            if (!normalized) {
                return { ok: false, error: uiText("Could not recognize the formula.", "mathematical formulaを認識できませんでした") };
            }
            params.onInsertMath(normalized);
            return { ok: true };
        }
        catch (error) {
            const msg = error instanceof Error
                ? uiText(`Recognition failed - ${error.message}`, `Recognition failed — ${error.message}`)
                : uiText("Recognition failed", "認識できませんでした");
            return { ok: false, error: msg };
        }
        finally {
            mathCaptureBusy = false;
        }
    };
    return {
        handleMathCaptureImage,
    };
};
import { uiText } from "./app/i18n.js";

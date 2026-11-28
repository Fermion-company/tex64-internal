import { uiText } from "./app/i18n.js";
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
            return trimmed.slice(start.length, -end.length).trim();
        }
    }
    return trimmed;
};
export const createMathCaptureHandler = (params) => {
    const handleMathCaptureImage = async (imageDataUrl, onProgress, signal) => {
        if (!imageDataUrl) {
            return { ok: false, error: uiText("No capture image available.", "キャプチャ画像がありません。") };
        }
        try {
            const latex = await params.recognizeMath(imageDataUrl, onProgress, signal);
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                return { ok: false };
            const normalized = stripMathCaptureWrapper(latex);
            if (!normalized) {
                return { ok: false, error: uiText("Could not recognize the formula.", "数式を認識できませんでした。") };
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
    };
    return {
        handleMathCaptureImage,
    };
};

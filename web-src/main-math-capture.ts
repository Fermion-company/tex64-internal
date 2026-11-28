import { uiText } from "./app/i18n.js";

type MathCaptureHandlerParams = {
  recognizeMath: (
    imageDataUrl: string,
    onProgress?: (current: number, total: number) => void,
    signal?: AbortSignal
  ) => Promise<string>;
  onInsertMath: (latex: string) => void;
};

const stripMathCaptureWrapper = (value: string) => {
  const trimmed = value.trim();
  const wrappers: Array<[string, string]> = [
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

export type MathCaptureResult = {
  ok: boolean;
  error?: string;
};

export const createMathCaptureHandler = (params: MathCaptureHandlerParams) => {
  const handleMathCaptureImage = async (
    imageDataUrl: string,
    onProgress?: (current: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<MathCaptureResult> => {
    if (!imageDataUrl) {
      return { ok: false, error: uiText("No capture image available.", "キャプチャ画像がありません。") };
    }
    try {
      const latex = await params.recognizeMath(imageDataUrl, onProgress, signal);
      if (signal?.aborted) return { ok: false };
      const normalized = stripMathCaptureWrapper(latex);
      if (!normalized) {
        return { ok: false, error: uiText("Could not recognize the formula.", "数式を認識できませんでした。") };
      }
      params.onInsertMath(normalized);
      return { ok: true };
    } catch (error) {
      const msg =
        error instanceof Error
          ? uiText(`Recognition failed - ${error.message}`, `Recognition failed — ${error.message}`)
          : uiText("Recognition failed", "認識できませんでした");
      return { ok: false, error: msg };
    }
  };

  return {
    handleMathCaptureImage,
  };
};

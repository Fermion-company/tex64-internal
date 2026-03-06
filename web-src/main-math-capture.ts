import type { IssueItem, IssuesStatus } from "./app/types.js";

type UpdateIssues = (
  count: number,
  summary: string,
  status: IssuesStatus,
  issues: IssueItem[]
) => void;

type MathCaptureHandlerParams = {
  recognizeMath: (imageDataUrl: string) => Promise<string>;
  updateIssues: UpdateIssues;
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
      const inner = trimmed.slice(start.length, -end.length).trim();
      if (inner) {
        return inner;
      }
    }
  }
  return trimmed;
};

const stripLatexCommandBlocks = (value: string, commands: Set<string>) => {
  let result = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "\\") {
      result += value[i];
      continue;
    }
    let name = "";
    let cursor = i + 1;
    while (cursor < value.length && /[A-Za-z]/.test(value[cursor])) {
      name += value[cursor];
      cursor += 1;
    }
    if (!name || !commands.has(name)) {
      result += value[i];
      continue;
    }
    while (cursor < value.length && /\s/.test(value[cursor])) {
      cursor += 1;
    }
    if (value[cursor] !== "{") {
      result += value[i];
      continue;
    }
    let depth = 0;
    let end = cursor;
    for (; end < value.length; end += 1) {
      if (value[end] === "{") {
        depth += 1;
      } else if (value[end] === "}") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    if (depth === 0) {
      i = end;
      continue;
    }
    result += value[i];
  }
  return result;
};

const normalizeMathCaptureText = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const unwrapped = stripMathCaptureWrapper(trimmed);
  const noWhitespace = unwrapped.replace(/\s+/g, "");
  const textCommands = new Set([
    "text",
    "mbox",
    "textnormal",
    "textrm",
    "textsf",
    "texttt",
    "textbf",
    "textit",
  ]);
  let cleaned = stripLatexCommandBlocks(noWhitespace, textCommands);
  cleaned = cleaned.replace(/\\newline/g, "").replace(/\\\\/g, "");
  cleaned = cleaned.replace(/[^A-Za-z0-9\\{}_^=+\-*/().,\[\]|<>!:]/g, "");
  return cleaned;
};

export type MathCaptureResult = {
  ok: boolean;
  error?: string;
};

export const createMathCaptureHandler = (params: MathCaptureHandlerParams) => {
  let mathCaptureBusy = false;

  const reportError = (message: string) => {
    params.updateIssues(1, message, "error", [{ severity: "error", message }]);
  };

  const handleMathCaptureImage = async (
    imageDataUrl: string
  ): Promise<MathCaptureResult> => {
    if (mathCaptureBusy) {
      return { ok: false, error: "処理中です。" };
    }
    if (!imageDataUrl) {
      const msg = "キャプチャ画像がありません。";
      reportError(msg);
      return { ok: false, error: msg };
    }
    mathCaptureBusy = true;
    try {
      const latex = await params.recognizeMath(imageDataUrl);
      const normalized = normalizeMathCaptureText(latex);
      if (!normalized) {
        const msg = "数式を認識できませんでした";
        reportError(msg);
        return { ok: false, error: msg };
      }
      params.onInsertMath(normalized);
      return { ok: true };
    } catch (error) {
      const msg =
        error instanceof Error
          ? `認識に失敗しました — ${error.message}`
          : "認識に失敗しました";
      reportError(msg);
      return { ok: false, error: msg };
    } finally {
      mathCaptureBusy = false;
    }
  };

  return {
    handleMathCaptureImage,
  };
};

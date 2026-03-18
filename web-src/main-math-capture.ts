type MathCaptureHandlerParams = {
  recognizeMath: (imageDataUrl: string, onProgress?: (current: number, total: number) => void) => Promise<string>;
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

const TEXT_PLACEHOLDER_PREFIX = "\x00TXTBLK";

const protectTextBlocks = (value: string): { result: string; blocks: string[] } => {
  const blocks: string[] = [];
  const textCmdPattern = /\\(?:text|mbox|textnormal|textrm|textsf|texttt|textbf|textit)\s*\{/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = textCmdPattern.exec(value)) !== null) {
    result += value.slice(lastIndex, match.index);
    const braceStart = match.index + match[0].length - 1;
    let depth = 0;
    let braceEnd = -1;
    for (let i = braceStart; i < value.length; i += 1) {
      if (value[i] === "{") depth += 1;
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
    } else {
      result += value[match.index];
      lastIndex = match.index + 1;
      textCmdPattern.lastIndex = lastIndex;
    }
  }
  result += value.slice(lastIndex);
  return { result, blocks };
};

const restoreTextBlocks = (value: string, blocks: string[]): string => {
  return value.replace(
    new RegExp(`${TEXT_PLACEHOLDER_PREFIX.replace(/\x00/g, "\\x00")}(\\d+)\\x00`, "g"),
    (_match, idx) => blocks[parseInt(idx, 10)] ?? ""
  );
};

const normalizeMathCaptureText = (value: string) => {
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

  // Apply character filter to non-text parts
  let cleaned = withPlaceholders;
  cleaned = cleaned.replace(/\\newline/g, "").replace(/\\\\/g, "");
  cleaned = cleaned.replace(/[^A-Za-z0-9\\{}_^=+\-*/().,\[\]|<>!:\x00TXTBLK]/g, "");

  // Restore \text{...} blocks
  cleaned = restoreTextBlocks(cleaned, blocks);

  return cleaned;
};

export type MathCaptureResult = {
  ok: boolean;
  error?: string;
};

export const createMathCaptureHandler = (params: MathCaptureHandlerParams) => {
  let mathCaptureBusy = false;

  const handleMathCaptureImage = async (
    imageDataUrl: string,
    onProgress?: (current: number, total: number) => void
  ): Promise<MathCaptureResult> => {
    if (mathCaptureBusy) {
      return { ok: false, error: "処理中です。" };
    }
    if (!imageDataUrl) {
      return { ok: false, error: "キャプチャ画像がありません。" };
    }
    mathCaptureBusy = true;
    try {
      const latex = await params.recognizeMath(imageDataUrl, onProgress);
      const normalized = normalizeMathCaptureText(latex);
      if (!normalized) {
        return { ok: false, error: "数式を認識できませんでした" };
      }
      params.onInsertMath(normalized);
      return { ok: true };
    } catch (error) {
      const msg =
        error instanceof Error
          ? `認識に失敗しました — ${error.message}`
          : "認識に失敗しました";
      return { ok: false, error: msg };
    } finally {
      mathCaptureBusy = false;
    }
  };

  return {
    handleMathCaptureImage,
  };
};

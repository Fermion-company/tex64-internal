import { stripCommentTail } from "./utils.js";

type MathMatchResult = {
  latex: string;
  startLineNumber: number;
  endLineNumber: number;
  startIndex: number;
  endIndex: number;
};

const findInlineMathAt = (
  line: string,
  cursorIndex: number
): { latex: string; startIndex: number; endIndex: number } | null => {
  if (!line) {
    return null;
  }
  line = stripCommentTail(line);

  const regexPairs: Array<{ regex: RegExp; openLen: number; closeLen: number }> = [
    { regex: /\\\((.+?)\\\)/g, openLen: 2, closeLen: 2 },
  ];
  for (const entry of regexPairs) {
    entry.regex.lastIndex = 0;
    let match = entry.regex.exec(line);
    while (match) {
      const raw = match[0] ?? "";
      const latex = match[1] ?? "";
      const index = match.index ?? -1;
      if (index >= 0 && raw) {
        const startIndex = index + entry.openLen;
        const endIndex = startIndex + latex.length;
        if (cursorIndex >= startIndex && cursorIndex <= endIndex) {
          const trimmed = latex.trim();
          if (trimmed) {
            return { latex: trimmed, startIndex, endIndex };
          }
        }
      }
      match = entry.regex.exec(line);
    }
  }

  const dollarIndices: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "$") {
      continue;
    }
    if (i > 0 && line[i - 1] === "\\") {
      continue;
    }
    if (i + 1 < line.length && line[i + 1] === "$") {
      continue;
    }
    if (i > 0 && line[i - 1] === "$") {
      continue;
    }
    dollarIndices.push(i);
  }
  for (let j = 0; j + 1 < dollarIndices.length; j += 2) {
    const open = dollarIndices[j];
    const close = dollarIndices[j + 1];
    if (cursorIndex < open + 1 || cursorIndex > close) {
      continue;
    }
    const latex = line.slice(open + 1, close);
    const trimmed = latex.trim();
    if (!trimmed) {
      continue;
    }
    return { latex: trimmed, startIndex: open + 1, endIndex: close };
  }

  return null;
};

const isEscapedAt = (text: string, index: number) => {
  let slashCount = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (text[i] !== "\\") {
      break;
    }
    slashCount += 1;
  }
  return slashCount % 2 === 1;
};

const getModelLineCount = (model: { getLineCount?: () => number }, fallback: number) => {
  const count = model.getLineCount?.();
  if (!Number.isFinite(count)) {
    return fallback;
  }
  return Math.max(fallback, Math.floor(count ?? fallback));
};

type MathScanWindow = {
  startLineNumber: number;
  endLineNumber: number;
  lines: string[];
  lineOffsets: number[];
  text: string;
};

const buildMathScanWindow = (
  model: { getLineContent: (lineNumber: number) => string; getLineCount?: () => number },
  centerLineNumber: number,
  options?: { radius?: number }
): MathScanWindow => {
  const lineCount = getModelLineCount(model, centerLineNumber);
  const radius = Number.isFinite(options?.radius) ? Math.max(20, Math.floor(options?.radius ?? 0)) : 320;
  const startLineNumber = Math.max(1, centerLineNumber - radius);
  const endLineNumber = Math.min(lineCount, centerLineNumber + radius);
  const lines: string[] = [];
  const lineOffsets: number[] = [];
  let text = "";
  for (let line = startLineNumber; line <= endLineNumber; line += 1) {
    lineOffsets.push(text.length);
    const content = stripCommentTail(model.getLineContent(line) ?? "");
    lines.push(content);
    text += content;
    if (line < endLineNumber) {
      text += "\n";
    }
  }
  return {
    startLineNumber,
    endLineNumber,
    lines,
    lineOffsets,
    text,
  };
};

const offsetToLineIndex = (window: MathScanWindow, absoluteOffset: number) => {
  const clamped = Math.max(0, Math.min(window.text.length, absoluteOffset));
  let lineIndex = 0;
  while (
    lineIndex + 1 < window.lineOffsets.length &&
    window.lineOffsets[lineIndex + 1] <= clamped
  ) {
    lineIndex += 1;
  }
  const lineStart = window.lineOffsets[lineIndex] ?? 0;
  const lineText = window.lines[lineIndex] ?? "";
  const index = Math.max(0, Math.min(lineText.length, clamped - lineStart));
  return {
    lineNumber: window.startLineNumber + lineIndex,
    index,
  };
};

const pickSmallestMathRange = (ranges: Array<MathMatchResult | null>) => {
  const filtered = ranges.filter((entry): entry is MathMatchResult => Boolean(entry));
  if (filtered.length === 0) {
    return null;
  }
  return filtered.sort((a, b) => {
    const aSpan = (a.endLineNumber - a.startLineNumber) * 10_000 + (a.endIndex - a.startIndex);
    const bSpan = (b.endLineNumber - b.startLineNumber) * 10_000 + (b.endIndex - b.startIndex);
    return aSpan - bSpan;
  })[0];
};

const findDelimitedMathAt = (
  window: MathScanWindow,
  cursorOffset: number,
  openToken: string,
  closeToken: string
): MathMatchResult | null => {
  if (!window.text || !openToken || !closeToken) {
    return null;
  }
  const pairs: Array<{ startOffset: number; endOffset: number }> = [];
  if (openToken === closeToken) {
    const markers: number[] = [];
    let markerPos = window.text.indexOf(openToken);
    while (markerPos >= 0) {
      if (!isEscapedAt(window.text, markerPos)) {
        markers.push(markerPos);
      }
      markerPos = window.text.indexOf(openToken, markerPos + openToken.length);
    }
    for (let i = 0; i + 1 < markers.length; i += 2) {
      const startOffset = markers[i];
      const endOffset = markers[i + 1] + closeToken.length;
      if (endOffset > startOffset) {
        pairs.push({ startOffset, endOffset });
      }
    }
  } else {
    const events: Array<{ offset: number; kind: "open" | "close" }> = [];
    let openPos = window.text.indexOf(openToken);
    while (openPos >= 0) {
      if (!isEscapedAt(window.text, openPos) && (openToken !== "\\[" || window.text[openPos - 1] !== "\\")) {
        events.push({ offset: openPos, kind: "open" });
      }
      openPos = window.text.indexOf(openToken, openPos + openToken.length);
    }
    let closePos = window.text.indexOf(closeToken);
    while (closePos >= 0) {
      if (!isEscapedAt(window.text, closePos) && (closeToken !== "\\]" || window.text[closePos - 1] !== "\\")) {
        events.push({ offset: closePos, kind: "close" });
      }
      closePos = window.text.indexOf(closeToken, closePos + closeToken.length);
    }
    events.sort((a, b) => a.offset - b.offset || (a.kind === "open" ? -1 : 1));
    const stack: number[] = [];
    for (const event of events) {
      if (event.kind === "open") {
        stack.push(event.offset);
        continue;
      }
      const startOffset = stack.pop();
      if (typeof startOffset !== "number") {
        continue;
      }
      const endOffset = event.offset + closeToken.length;
      if (endOffset > startOffset) {
        pairs.push({ startOffset, endOffset });
      }
    }
  }
  if (pairs.length === 0) {
    return null;
  }
  const hit =
    pairs
      .filter((pair) => cursorOffset >= pair.startOffset && cursorOffset <= pair.endOffset)
      .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset))[0] ?? null;
  if (!hit) {
    return null;
  }
  const latex = window.text.slice(hit.startOffset, hit.endOffset).trim();
  if (!latex) {
    return null;
  }
  const start = offsetToLineIndex(window, hit.startOffset);
  const end = offsetToLineIndex(window, hit.endOffset);
  return {
    latex,
    startLineNumber: start.lineNumber,
    endLineNumber: end.lineNumber,
    startIndex: start.index,
    endIndex: end.index,
  };
};

const MATH_ENVIRONMENTS = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "alignat",
  "alignat*",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "flalign",
  "flalign*",
  "eqnarray",
  "eqnarray*",
  "math",
  "displaymath",
  "split",
  "cases",
  "matrix",
  "pmatrix",
  "bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
]);

const findEnvironmentMathAt = (window: MathScanWindow, cursorOffset: number): MathMatchResult | null => {
  if (!window.text) {
    return null;
  }
  const tokenRegex = /\\(begin|end)\{([A-Za-z*@]+)\}/g;
  const stack: Array<{ env: string; startOffset: number }> = [];
  const pairs: Array<{ startOffset: number; endOffset: number }> = [];
  tokenRegex.lastIndex = 0;
  let token = tokenRegex.exec(window.text);
  while (token) {
    const action = token[1] ?? "";
    const env = token[2] ?? "";
    const startOffset = token.index ?? -1;
    if (startOffset >= 0 && MATH_ENVIRONMENTS.has(env)) {
      const tokenEnd = startOffset + (token[0]?.length ?? 0);
      if (action === "begin") {
        stack.push({ env, startOffset });
      } else if (action === "end") {
        let matchIndex = -1;
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i]?.env === env) {
            matchIndex = i;
            break;
          }
        }
        if (matchIndex >= 0) {
          const begin = stack.splice(matchIndex, 1)[0];
          if (tokenEnd > begin.startOffset) {
            pairs.push({ startOffset: begin.startOffset, endOffset: tokenEnd });
          }
        }
      }
    }
    token = tokenRegex.exec(window.text);
  }
  if (pairs.length === 0) {
    return null;
  }
  const hit =
    pairs
      .filter((pair) => cursorOffset >= pair.startOffset && cursorOffset <= pair.endOffset)
      .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset))[0] ?? null;
  if (!hit) {
    return null;
  }
  const latex = window.text.slice(hit.startOffset, hit.endOffset).trim();
  if (!latex) {
    return null;
  }
  const start = offsetToLineIndex(window, hit.startOffset);
  const end = offsetToLineIndex(window, hit.endOffset);
  return {
    latex,
    startLineNumber: start.lineNumber,
    endLineNumber: end.lineNumber,
    startIndex: start.index,
    endIndex: end.index,
  };
};

export const findMathAt = (
  model: { getLineContent: (lineNumber: number) => string; getLineCount?: () => number },
  position: { lineNumber: number; column: number },
  effectiveLine: string,
  cursorIndex: number
): MathMatchResult | null => {
  const inline = findInlineMathAt(effectiveLine, cursorIndex);
  if (inline) {
    return {
      latex: inline.latex,
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startIndex: inline.startIndex,
      endIndex: inline.endIndex,
    };
  }

  const window = buildMathScanWindow(model, position.lineNumber);
  const lineIdx = position.lineNumber - window.startLineNumber;
  if (lineIdx < 0 || lineIdx >= window.lines.length) {
    return null;
  }
  const currentLine = window.lines[lineIdx] ?? "";
  const boundedCursorIndex = Math.max(0, Math.min(cursorIndex, currentLine.length));
  const cursorOffset = (window.lineOffsets[lineIdx] ?? 0) + boundedCursorIndex;

  return pickSmallestMathRange([
    findDelimitedMathAt(window, cursorOffset, "\\[", "\\]"),
    findDelimitedMathAt(window, cursorOffset, "$$", "$$"),
    findEnvironmentMathAt(window, cursorOffset),
  ]);
};


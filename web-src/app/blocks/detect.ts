import { getEnvBaseName, normalizeEnvName } from "../env-registry.js";
import { isEscapedAt } from "./tex-utils.js";
import type { DetectedLatexBlock } from "./types.js";

const RAW_ENV_NAMES = new Set(["verbatim", "Verbatim", "lstlisting", "minted"]);

const MATH_ENV_HINTS = [
  "math",
  "eqn",
  "equation",
  "align",
  "gather",
  "multline",
  "matrix",
  "cases",
  "split",
  "subeq",
  "array",
  "formula",
];

type DetectorDeps = {
  isEnvDisabled: (name: string) => boolean;
  isMathEnvName: (name: string) => boolean;
};

export const createLatexBlockDetector = (deps: DetectorDeps) => {
  const looksLikeMathEnv = (name: string) => {
    const base = getEnvBaseName(normalizeEnvName(name)).toLowerCase();
    return MATH_ENV_HINTS.some((hint) => base.includes(hint));
  };

  const classifyEnv = (name: string): DetectedLatexBlock["type"] | null => {
    const base = getEnvBaseName(normalizeEnvName(name));
    if (deps.isEnvDisabled(base)) {
      return null;
    }
    if (deps.isMathEnvName(base)) {
      return "math";
    }
    if (looksLikeMathEnv(base)) {
      return "math";
    }
    return null;
  };

  type MathDelimiterKind = "dollar" | "double-dollar" | "paren" | "bracket";

  const collectLatexBlocks = (text: string): DetectedLatexBlock[] => {
    const blocks: DetectedLatexBlock[] = [];
    const envStack: { name: string; start: number }[] = [];
    const rawEnvStack: string[] = [];
    let openMath: { kind: MathDelimiterKind; start: number } | null = null;

    const pushMathBlock = (start: number, end: number, kind: MathDelimiterKind) => {
      const inline = kind === "dollar" || kind === "paren";
      const openLength = kind === "double-dollar" ? 2 : kind === "dollar" ? 1 : 2;
      const closeLength = kind === "double-dollar" ? 2 : kind === "dollar" ? 1 : 2;
      const contentStart = start + openLength;
      const contentEnd = Math.max(contentStart, end - closeLength);
      const content = text.slice(contentStart, contentEnd);
      blocks.push({
        type: "math",
        content: content.trim(),
        start,
        end,
        inline,
        fullMatch: text.slice(start, end),
      });
    };

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];

      if (ch === "%" && !isEscapedAt(text, i)) {
        while (i < text.length && text[i] !== "\n") {
          i += 1;
        }
        continue;
      }

      if (rawEnvStack.length > 0) {
        if (ch === "\\" && !isEscapedAt(text, i) && text.startsWith("\\end{", i)) {
          const endBrace = text.indexOf("}", i + 5);
          if (endBrace !== -1) {
            const name = normalizeEnvName(text.slice(i + 5, endBrace));
            const base = getEnvBaseName(name);
            if (base === rawEnvStack[rawEnvStack.length - 1]) {
              rawEnvStack.pop();
            }
            i = endBrace;
          }
        }
        continue;
      }

      if (ch === "\\" && !isEscapedAt(text, i)) {
        if (text.startsWith("\\begin{", i)) {
          const endBrace = text.indexOf("}", i + 7);
          if (endBrace !== -1) {
            const name = normalizeEnvName(text.slice(i + 7, endBrace));
            const base = getEnvBaseName(name);
            if (RAW_ENV_NAMES.has(base)) {
              rawEnvStack.push(base);
            } else {
              envStack.push({ name, start: i });
            }
            i = endBrace;
            continue;
          }
        }
        if (text.startsWith("\\end{", i)) {
          const endBrace = text.indexOf("}", i + 5);
          if (endBrace !== -1) {
            const name = normalizeEnvName(text.slice(i + 5, endBrace));
            let matchIndex = -1;
            for (let j = envStack.length - 1; j >= 0; j -= 1) {
              if (envStack[j].name === name) {
                matchIndex = j;
                break;
              }
            }
            if (matchIndex >= 0) {
              const { start } = envStack[matchIndex];
              envStack.splice(matchIndex);
              const end = endBrace + 1;
              const type = classifyEnv(name);
              if (type) {
                blocks.push({
                  type,
                  content: "",
                  start,
                  end,
                  envName: name,
                  inline: false,
                  fullMatch: text.slice(start, end),
                });
              }
            }
            i = endBrace;
            continue;
          }
        }
        if (text.startsWith("\\(", i)) {
          if (!openMath) {
            openMath = { kind: "paren", start: i };
          }
          i += 1;
          continue;
        }
        if (text.startsWith("\\)", i)) {
          if (openMath?.kind === "paren") {
            const end = i + 2;
            pushMathBlock(openMath.start, end, openMath.kind);
            openMath = null;
          }
          i += 1;
          continue;
        }
        if (text.startsWith("\\[", i)) {
          if (!openMath) {
            openMath = { kind: "bracket", start: i };
          }
          i += 1;
          continue;
        }
        if (text.startsWith("\\]", i)) {
          if (openMath?.kind === "bracket") {
            const end = i + 2;
            pushMathBlock(openMath.start, end, openMath.kind);
            openMath = null;
          }
          i += 1;
          continue;
        }
      }

      if (ch === "$" && !isEscapedAt(text, i)) {
        const isDouble = text[i + 1] === "$";
        if (!openMath) {
          if (isDouble) {
            openMath = { kind: "double-dollar", start: i };
            i += 1;
          } else {
            openMath = { kind: "dollar", start: i };
          }
          continue;
        }
        if (openMath.kind === "double-dollar" && isDouble) {
          const end = i + 2;
          pushMathBlock(openMath.start, end, openMath.kind);
          openMath = null;
          i += 1;
          continue;
        }
        if (openMath.kind === "dollar" && !isDouble) {
          const end = i + 1;
          pushMathBlock(openMath.start, end, openMath.kind);
          openMath = null;
          continue;
        }
      }
    }

    return blocks;
  };

  const detectLatexBlockAtOffset = (
    text: string,
    offset: number
  ): DetectedLatexBlock | null => {
    const candidates = collectLatexBlocks(text).filter(
      (candidate) => offset >= candidate.start && offset < candidate.end
    );
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => {
      const sizeDiff = (b.end - b.start) - (a.end - a.start);
      if (sizeDiff !== 0) {
        return sizeDiff;
      }
      return a.start - b.start;
    });
    return candidates[0];
  };

  const detectLatexBlockInRange = (
    text: string,
    startOffset: number,
    endOffset: number
  ): DetectedLatexBlock | null => {
    const normalizedStart = Math.max(0, Math.min(startOffset, endOffset));
    const normalizedEnd = Math.max(normalizedStart, Math.max(startOffset, endOffset));
    if (normalizedStart === normalizedEnd) {
      return detectLatexBlockAtOffset(text, normalizedStart);
    }
    const candidates = collectLatexBlocks(text).filter(
      (candidate) => candidate.end > normalizedStart && candidate.start < normalizedEnd
    );
    if (candidates.length === 0) {
      return null;
    }
    const containing = candidates.filter(
      (candidate) =>
        candidate.start <= normalizedStart && candidate.end >= normalizedEnd
    );
    if (containing.length > 0) {
      containing.sort((a, b) => {
        const sizeDiff = (b.end - b.start) - (a.end - a.start);
        if (sizeDiff !== 0) {
          return sizeDiff;
        }
        return a.start - b.start;
      });
      return containing[0];
    }
    candidates.sort((a, b) => {
      const overlapA =
        Math.min(a.end, normalizedEnd) - Math.max(a.start, normalizedStart);
      const overlapB =
        Math.min(b.end, normalizedEnd) - Math.max(b.start, normalizedStart);
      if (overlapA !== overlapB) {
        return overlapB - overlapA;
      }
      const sizeDiff = (b.end - b.start) - (a.end - a.start);
      if (sizeDiff !== 0) {
        return sizeDiff;
      }
      return a.start - b.start;
    });
    return candidates[0];
  };

  return { detectLatexBlockAtOffset, detectLatexBlockInRange };
};

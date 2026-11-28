import { isEscapedAt } from "../blocks/tex-utils.js";

// Keep source columns intact around inline verbatim text. Percent signs
// inside the literal are ordinary characters rather than comment markers.
export const getHoverLine = (line: string, cursorIndex?: number): string => {
  const token = /\\verb\*?(?![a-zA-Z])|%/g;
  let result = "";
  let start = 0;
  for (let match = token.exec(line); match; match = token.exec(line)) {
    if (isEscapedAt(line, match.index)) continue;
    if (match[0] === "%") return result + line.slice(start, match.index);
    const delimiter = line[token.lastIndex];
    if (!delimiter || /\s/.test(delimiter)) continue;
    const close = line.indexOf(delimiter, token.lastIndex + 1);
    const end = close < 0 ? line.length : close + 1;
    if (cursorIndex !== undefined && cursorIndex >= match.index && cursorIndex < end) return "";
    result += line.slice(start, match.index) + " ".repeat(end - match.index);
    start = token.lastIndex = end;
  }
  return result + line.slice(start);
};

export const getCursorIndex = (position: { lineNumber: number; column: number }) =>
  Math.max(0, (position.column ?? 1) - 1);

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

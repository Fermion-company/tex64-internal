export const findFirstUnescapedPercent = (line: string) => {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "%") {
      continue;
    }
    if (i > 0 && line[i - 1] === "\\") {
      continue;
    }
    return i;
  }
  return -1;
};

export const stripCommentTail = (line: string) => {
  const commentIndex = findFirstUnescapedPercent(line);
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
};

export const getCursorIndex = (position: { lineNumber: number; column: number }) =>
  Math.max(0, (position.column ?? 1) - 1);

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

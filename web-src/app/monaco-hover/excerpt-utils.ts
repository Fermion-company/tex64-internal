export const renderExcerpt = (payload: {
  startLine: number;
  lines: string[];
  highlightLine?: number;
}) => {
  const start = Math.max(1, payload.startLine);
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (lines.length === 0) {
    return "```tex\n(No excerpt)\n```";
  }
  const endLine = start + lines.length - 1;
  const width = Math.max(String(start).length, String(endLine).length);
  const body = lines
    .map((line, idx) => {
      const lineNo = start + idx;
      const marker = payload.highlightLine === lineNo ? "▶" : " ";
      const padded = String(lineNo).padStart(width, " ");
      return `${marker}${padded} | ${line}`;
    })
    .join("\n");
  return `\`\`\`tex\n${body}\n\`\`\``;
};

export const sliceExcerptAroundLine = (payload: {
  startLine: number;
  lines: string[];
  targetLine: number;
  radius?: number;
  maxLines?: number;
}) => {
  const startLine = Number.isFinite(payload.startLine) ? Math.max(1, payload.startLine) : 1;
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const targetLine = Number.isFinite(payload.targetLine) ? Math.max(1, payload.targetLine) : 1;
  const radius = Number.isFinite(payload.radius)
    ? Math.min(80, Math.max(0, Math.floor(payload.radius ?? 0)))
    : 5;
  const maxLines = Number.isFinite(payload.maxLines)
    ? Math.min(200, Math.max(3, Math.floor(payload.maxLines ?? 0)))
    : 18;
  if (lines.length === 0) {
    return { startLine, lines: [] as string[] };
  }
  const idx = targetLine - startLine;
  if (idx < 0 || idx >= lines.length) {
    return { startLine, lines: lines.slice(0, maxLines) };
  }
  let begin = Math.max(0, idx - radius);
  let end = Math.min(lines.length, idx + radius + 1);
  if (end - begin > maxLines) {
    const half = Math.floor(maxLines / 2);
    begin = Math.max(0, idx - half);
    end = Math.min(lines.length, begin + maxLines);
    begin = Math.max(0, end - maxLines);
  }
  return { startLine: startLine + begin, lines: lines.slice(begin, end) };
};


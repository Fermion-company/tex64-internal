// Where a generated figure should land in a LaTeX document, and what its
// preamble still needs. Pure functions so the rules are unit-testable: the
// canvas UI only turns the result into Monaco edits.

import { isFigureHeaderLine } from "./figure-codec.js";

export type InsertPoint = { lineNumber: number; column: number };
export type PreambleInsert = { lineNumber: number; text: string };
/** カーソル位置に入れられなかった理由。null ならカーソル位置そのまま。 */
export type MoveReason = "preamble" | "environment" | null;
export type InsertPlan = { body: InsertPoint; preamble: PreambleInsert | null; moved: MoveReason };

/** Everything from an unescaped % to the end of the line is a LaTeX comment. */
const stripComment = (line: string): string => {
  const comment = line.indexOf("%");
  return comment >= 0 && (comment === 0 || line[comment - 1] !== "\\") ? line.slice(0, comment) : line;
};

const findLine = (lines: string[], pattern: RegExp): number => {
  for (let index = 0; index < lines.length; index += 1) if (pattern.test(stripComment(lines[index]))) return index + 1;
  return 0;
};

/**
 * 図を入れると壊れる環境。数式・verbatim 系に \begin{tikzpicture} を落とすと
 * コンパイルが通らず、tikzpicture の中に入れると既にある図が壊れる。
 */
const CLOSED_ENVIRONMENTS = new Set([
  "tikzpicture", "equation", "align", "gather", "multline", "eqnarray", "displaymath",
  "verbatim", "lstlisting", "minted", "alignat", "split", "cases", "array", "matrix",
  "pmatrix", "bmatrix", "vmatrix", "Bmatrix", "Vmatrix", "tabular", "tabularx",
]);
const environmentName = (line: string, kind: "begin" | "end"): string | null => {
  const match = new RegExp(`\\\\${kind}\\s*\\{([^}*]+)\\*?\\}`).exec(stripComment(line));
  return match ? match[1].trim() : null;
};

/** 同名のネストを数えながら、`from` 行（1 始まり）で開いた環境が閉じる行を探す。 */
const closingLine = (lines: string[], name: string, from: number): number => {
  let depth = 0;
  for (let index = from - 1; index < lines.length; index += 1) {
    if (environmentName(lines[index], "begin") === name) depth += 1;
    if (environmentName(lines[index], "end") === name) { depth -= 1; if (depth <= 0) return index + 1; }
  }
  return 0;
};

/**
 * カーソルが「図を入れられない環境」の中にいるなら、その環境が閉じる行を返す。
 * ネストしているときは一番外側の環境を抜けたところまで送る。
 * 行頭（column 1）は「その行の手前」なので、環境が始まる行そのものは中に数えない。
 */
const enclosingClosedEnvironment = (lines: string[], cursor: InsertPoint): number => {
  const stack: Array<{ name: string; line: number }> = [];
  for (let index = 0; index < lines.length && index < cursor.lineNumber - 1; index += 1) {
    const begin = environmentName(lines[index], "begin");
    if (begin) { stack.push({ name: begin, line: index + 1 }); continue; }
    const end = environmentName(lines[index], "end");
    if (end && stack.length && stack[stack.length - 1].name === end) stack.pop();
  }
  // 行の途中にいるなら、その行の \begin はもう通り過ぎ、\end はまだ通っていない。
  const own = cursor.column > 1 ? environmentName(lines[cursor.lineNumber - 1] || "", "begin") : null;
  if (own) stack.push({ name: own, line: cursor.lineNumber });
  const outermost = stack.find((entry) => CLOSED_ENVIRONMENTS.has(entry.name));
  return outermost ? closingLine(lines, outermost.name, outermost.line) : 0;
};

/**
 * 図ブロックのメタデータ行（`%% tex64-figure ...`）は次の tikzpicture と 1 組。
 * ここへ割り込むとブロックが壊れるので、図の終わりまで送る。
 */
const figureHeaderBlockEnd = (lines: string[], cursorLine: number): number => {
  const line = lines[cursorLine - 1];
  if (!line || !isFigureHeaderLine(line)) return 0;
  const begin = lines.findIndex((text, index) => index >= cursorLine && environmentName(text, "begin") === "tikzpicture");
  return begin < 0 ? 0 : closingLine(lines, "tikzpicture", begin + 1);
};

/**
 * A figure dropped above \begin{document} breaks the file, and that is exactly
 * where the cursor sits when the canvas is opened without ever clicking the
 * editor (line 1, column 1). Fall back to just before \end{document}.
 * 同じ理由で、既にある図や数式環境の中にも落とさず、その環境の直後へ送る。
 */
export const planBodyInsert = (text: string, cursor: InsertPoint): { point: InsertPoint; moved: MoveReason } => {
  const lines = text.split("\n");
  const beginLine = findLine(lines, /\\begin\s*\{document\}/);
  if (beginLine && cursor.lineNumber <= beginLine) {
    const endLine = findLine(lines, /\\end\s*\{document\}/);
    const target = endLine > beginLine ? endLine : lines.length + 1;
    return { point: { lineNumber: target, column: 1 }, moved: "preamble" };
  }
  const closes = figureHeaderBlockEnd(lines, cursor.lineNumber) || enclosingClosedEnvironment(lines, cursor);
  if (closes) return { point: { lineNumber: closes + 1, column: 1 }, moved: "environment" };
  return { point: cursor, moved: null };
};

/** \usepackage / \usetikzlibrary lines the document is missing for this figure. */
export const missingPreambleLines = (text: string, requires: string[], needsPgfplots: boolean): string[] => {
  const lines = text.split("\n");
  const beginLine = findLine(lines, /\\begin\s*\{document\}/);
  const preamble = (beginLine ? lines.slice(0, beginLine - 1) : lines).map(stripComment).join("\n");
  const has = (pattern: RegExp) => pattern.test(preamble);
  const out: string[] = [];
  if (!has(/\\usepackage(\[[^\]]*\])?\s*\{[^}]*\btikz\b[^}]*\}/) && !has(/\\documentclass(\[[^\]]*\])?\s*\{standalone\}/)) {
    out.push("\\usepackage{tikz}");
  }
  const libraries = requires.filter((name) => !new RegExp(`\\\\usetikzlibrary\\s*\\{[^}]*\\b${name.replace(/\./g, "\\.")}\\b[^}]*\\}`).test(preamble));
  if (libraries.length) out.push(`\\usetikzlibrary{${libraries.join(",")}}`);
  if (needsPgfplots) {
    if (!has(/\\usepackage(\[[^\]]*\])?\s*\{[^}]*\bpgfplots\b[^}]*\}/)) out.push("\\usepackage{pgfplots}");
    if (!has(/\\pgfplotsset\s*\{[^}]*compat/)) out.push("\\pgfplotsset{compat=1.18}");
  }
  return out;
};

export const planFigureInsert = (
  text: string, cursor: InsertPoint, requires: string[], needsPgfplots: boolean
): InsertPlan => {
  const { point, moved } = planBodyInsert(text, cursor);
  const lines = text.split("\n");
  const beginLine = findLine(lines, /\\begin\s*\{document\}/);
  const missing = beginLine ? missingPreambleLines(text, requires, needsPgfplots) : [];
  return {
    body: point,
    preamble: missing.length ? { lineNumber: beginLine, text: `${missing.join("\n")}\n` } : null,
    moved,
  };
};

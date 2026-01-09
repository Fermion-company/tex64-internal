const escapeLatex = (value: string) =>
  value.replace(/[\\{}%$#&_]/g, (char) => `\\${char}`);

export type TextFormat = "plain" | "quote" | "itemize";
export type MathFormat = "inline" | "display" | "align*" | "gather*";
export type TableFormat = "tabular" | "tabularx" | "longtable";
export type FigureFormat = "includegraphics" | "figure";

export const buildTextSnippet = (text: string, format: TextFormat) => {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const escaped = escapeLatex(trimmed);
  if (format === "quote") {
    return ["\\begin{quote}", escaped, "\\end{quote}", ""].join("\n");
  }
  if (format === "itemize") {
    const items = escaped
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `\\item ${line}`);
    if (items.length === 0) return "";
    return ["\\begin{itemize}", ...items, "\\end{itemize}", ""].join("\n");
  }
  return escaped;
};

export const buildMathSnippet = (latex: string, format: MathFormat) => {
  const trimmed = latex.trim();
  if (!trimmed) return "";
  switch (format) {
    case "inline":
      return `$${trimmed}$`;
    case "display":
      return `\\[${trimmed}\\]`;
    case "align*":
      return ["\\begin{align*}", trimmed, "\\end{align*}", ""].join("\n");
    case "gather*":
      return ["\\begin{gather*}", trimmed, "\\end{gather*}", ""].join("\n");
    default:
      return `$${trimmed}$`;
  }
};

const buildTabular = (rows: string[][], format: TableFormat) => {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const columns = columnCount > 0 ? columnCount : 1;
  const columnSpec =
    format === "tabularx"
      ? `|${"X|".repeat(columns)}`
      : `|${"c|".repeat(columns)}`;
  const envName = format === "longtable" ? "longtable" : "tabular";
  const envArgs = format === "tabularx" ? `{\\linewidth}{${columnSpec}}` : `{${columnSpec}}`;
  const lines = [`\\begin{${envName}}${envArgs}`];
  rows.forEach((row) => {
    const cells = row
      .concat(Array.from({ length: Math.max(0, columns - row.length) }, () => ""))
      .map((cell) => escapeLatex(cell.trim()));
    lines.push("\\hline");
    lines.push(`${cells.join(" & ")} \\\\`);
  });
  lines.push("\\hline");
  lines.push(`\\end{${envName}}`);
  lines.push("");
  return lines.join("\n");
};

export const buildTableSnippet = (rows: string[][], format: TableFormat) => {
  if (!rows || rows.length === 0) return "";
  return buildTabular(rows, format);
};

export const buildFigureSnippet = (path: string, format: FigureFormat) => {
  const safePath = path.trim();
  if (!safePath) return "";
  if (format === "figure") {
    return [
      "\\begin{figure}[h]",
      "\\centering",
      `\\includegraphics[width=\\linewidth]{${safePath}}`,
      "\\caption{}",
      "\\label{fig:}",
      "\\end{figure}",
      "",
    ].join("\n");
  }
  return `\\includegraphics[width=\\linewidth]{${safePath}}`;
};

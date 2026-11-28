export type TableCell = { start: number; end: number };

/** Locate cells without rewriting delimiters, rules, commands or whitespace. */
export function tableCells(source: string): TableCell[][] | null {
  const environment = /^\s*\\begin\{(tabular\*?|tabularx)\}/u.exec(source);
  let bodyStart = 0, bodyEnd = source.length;
  if (environment) {
    let offset = environment.index + environment[0].length;
    const argumentsCount = environment[1] === "tabular" ? 1 : 2;
    for (let argument = 0; argument < argumentsCount; argument += 1) {
      while (/\s/u.test(source[offset] ?? "")) offset += 1;
      if (source[offset] === "[") { const end = source.indexOf("]", offset); if (end < 0) return null; offset = end + 1; }
      while (/\s/u.test(source[offset] ?? "")) offset += 1;
      if (source[offset] !== "{") return null;
      let depth = 1;
      for (offset += 1; offset < source.length && depth; offset += 1) {
        if (source[offset] === "\\") offset += 1;
        else if (source[offset] === "{") depth += 1;
        else if (source[offset] === "}") depth -= 1;
      }
    }
    const end = source.lastIndexOf(`\\end{${environment[1]}}`);
    if (end < offset) return null;
    bodyStart = offset;
    bodyEnd = end;
  }
  const rows: TableCell[][] = [];
  let cells: TableCell[] = [];
  let start = bodyStart;
  let braces = 0;
  let environmentDepth = 0;
  let hasColumns = false;
  for (let i = bodyStart; i < bodyEnd; i += 1) {
    if (source[i] === "%") {
      const newline = source.indexOf("\n", i);
      i = newline < 0 ? bodyEnd : newline;
      continue;
    }
    if (source[i] === "\\") {
      const verb = /^\\verb(?![A-Za-z])\*?([^\s])/u.exec(source.slice(i));
      if (verb) {
        const close = source.indexOf(verb[1]!, i + verb[0].length);
        const newline = source.indexOf("\n", i);
        i = close >= 0 && (newline < 0 || close < newline) ? close : newline >= 0 ? newline : bodyEnd;
        continue;
      }
      const env = /^\\(begin|end)\{([^}]+)\}/u.exec(source.slice(i));
      if (env) {
        environmentDepth += env[1] === "begin" ? 1 : -1;
        i += env[0].length - 1;
        continue;
      }
      if (source[i + 1] === "\\" && braces === 0 && environmentDepth === 0) {
        cells.push({ start, end: i });
        rows.push(cells);
        cells = [];
        i += 1;
        if (source[i + 1] === "*") i += 1;
        const spacing = /^\[[^\]]*\]/u.exec(source.slice(i + 1));
        if (spacing) i += spacing[0].length;
        start = i + 1;
      } else if (/[^a-zA-Z]/u.test(source[i + 1] ?? "")) i += 1;
      continue;
    }
    if (source[i] === "{") braces += 1;
    else if (source[i] === "}") braces = Math.max(0, braces - 1);
    else if (source[i] === "&" && braces === 0 && environmentDepth === 0) {
      hasColumns = true;
      cells.push({ start, end: i });
      start = i + 1;
    }
  }
  if (cells.length) { cells.push({ start, end: bodyEnd }); rows.push(cells); }
  return hasColumns ? rows : null;
}

export function replaceTableCells(source: string, replacements: { cell: TableCell; text: string }[]): string {
  let result = source;
  for (const { cell, text } of [...replacements].sort((a, b) => b.cell.start - a.cell.start))
    result = result.slice(0, cell.start) + text + result.slice(cell.end);
  return result;
}

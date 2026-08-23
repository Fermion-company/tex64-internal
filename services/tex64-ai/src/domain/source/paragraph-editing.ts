/**
 * Direct paragraph editing over LaTeX source, without showing the source.
 *
 * The reader clicks the page, SyncTeX names a line, and this module turns the
 * surrounding paragraph into something a person can edit as prose: plain text
 * stays plain text, and every command, math span, comment, and special
 * character becomes an opaque chip. Chips can be deleted or left alone, but
 * their LaTeX is never shown and never altered.
 *
 * Two invariants carry the whole design:
 *
 * 1. Round trip — concatenating the segments' `latex` reproduces the
 *    paragraph byte for byte. Nothing is normalized, reflowed, or prettified.
 * 2. Text segments contain no TeX-special characters — every `\ % $ & # _ ^ ~
 *    { }` lands inside a chip. So escaping *any* text on the way back is the
 *    identity for text the reader did not touch, and exactly the right guard
 *    for text they typed.
 */

export type ParagraphSegment =
  | { kind: "text"; latex: string }
  | { kind: "chip"; latex: string; label: string };

export type ParagraphRange = {
  /** 1-based line of the paragraph's first line in the file. */
  startLine: number;
  /** 1-based line of the paragraph's last line in the file. */
  endLine: number;
  /** The paragraph's source, lines joined with \n. */
  text: string;
};

/**
 * A line a paragraph never crosses — and never starts on. Sectioning, the
 * preamble, environment fences, and display math are structure, not prose;
 * clicking them offers no paragraph to edit.
 */
const STRUCTURAL_LINE = new RegExp(
  String.raw`^\s*(?:\\(?:begin|end)\{|\\(?:sub)*section\*?\s*[{[]|\\chapter\*?\s*[{[]|\\part\*?\s*[{[]|\\paragraph\*?\s*[{[]|\\subparagraph\*?\s*[{[]|\\documentclass|\\usepackage|\\maketitle\b|\\tableofcontents\b|\\bibliography(?:style)?\s*\{|\\appendix\b|\\newcommand|\\renewcommand|\\def\b|\\\[|\\\]|\$\$)`,
);

const isBlankLine = (line: string): boolean => line.trim() === "";
const isStructuralLine = (line: string): boolean => STRUCTURAL_LINE.test(line);

/**
 * Expands from the located line to the paragraph around it: up and down until
 * a blank or structural line. Returns null when the located line itself is
 * blank or structural — there is no prose there to edit.
 *
 * `lines` is an excerpt; `firstLineNumber` says which file line `lines[0]` is.
 */
export function findParagraphRange(
  lines: readonly string[],
  firstLineNumber: number,
  targetLine: number,
): ParagraphRange | null {
  const index = targetLine - firstLineNumber;
  if (index < 0 || index >= lines.length) {
    return null;
  }
  const targetText = lines[index];
  if (targetText === undefined || isBlankLine(targetText) || isStructuralLine(targetText)) {
    return null;
  }
  let start = index;
  while (start > 0) {
    const prev = lines[start - 1];
    if (prev === undefined || isBlankLine(prev) || isStructuralLine(prev)) break;
    start -= 1;
  }
  let end = index;
  while (end < lines.length - 1) {
    const next = lines[end + 1];
    if (next === undefined || isBlankLine(next) || isStructuralLine(next)) break;
    end += 1;
  }
  return {
    startLine: firstLineNumber + start,
    endLine: firstLineNumber + end,
    text: lines.slice(start, end + 1).join("\n"),
  };
}

/** What a chip is called in the card, by command name. */
const CHIP_LABELS: Record<string, string> = {
  emph: "強調",
  textit: "強調",
  textsl: "強調",
  textbf: "太字",
  underline: "下線",
  uline: "下線",
  texttt: "等幅",
  textsc: "スモールキャップ",
  footnote: "脚注",
  label: "ラベル",
  item: "箇条書き",
  includegraphics: "画像",
  url: "リンク",
  href: "リンク",
};

const chipLabelFor = (commandName: string): string => {
  const named = CHIP_LABELS[commandName];
  if (named) return named;
  if (/^[Cc]ite/.test(commandName) || /cite$/i.test(commandName)) return "引用";
  if (/^(?:eq|auto|name|c|C|page|v)?ref$/.test(commandName)) return "参照";
  return `\\${commandName}`;
};

/** Consumes a balanced {...} or [...] group. Returns the index past it. */
const consumeGroup = (source: string, from: number): number => {
  const open = source[from];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let index = from;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
};

/** Consumes an inline/display math span starting at `from`. */
const consumeMath = (source: string, from: number): number => {
  const isDisplay = source.startsWith("$$", from);
  const fence = isDisplay ? "$$" : "$";
  let index = from + fence.length;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source.startsWith(fence, index)) {
      return index + fence.length;
    }
    index += 1;
  }
  return source.length;
};

/** Consumes \( ... \) or \[ ... \]. */
const consumeDelimitedMath = (source: string, from: number): number => {
  const closer = source[from + 1] === "(" ? "\\)" : "\\]";
  const found = source.indexOf(closer, from + 2);
  return found === -1 ? source.length : found + 2;
};

/**
 * Splits a paragraph into editable text and opaque chips. Concatenating the
 * returned segments' `latex` reproduces the input exactly.
 */
export function segmentParagraph(paragraph: string): ParagraphSegment[] {
  const segments: ParagraphSegment[] = [];
  let textStart = 0;
  let index = 0;

  const flushText = (upTo: number) => {
    if (upTo > textStart) {
      segments.push({ kind: "text", latex: paragraph.slice(textStart, upTo) });
    }
  };
  const pushChip = (from: number, to: number, label: string) => {
    flushText(from);
    segments.push({ kind: "chip", latex: paragraph.slice(from, to), label });
    textStart = to;
    index = to;
  };

  while (index < paragraph.length) {
    const char = paragraph[index];
    if (char === "%") {
      const lineEnd = paragraph.indexOf("\n", index);
      pushChip(index, lineEnd === -1 ? paragraph.length : lineEnd, "コメント");
      continue;
    }
    if (char === "$") {
      pushChip(index, consumeMath(paragraph, index), "数式");
      continue;
    }
    if (char === "{" ) {
      pushChip(index, consumeGroup(paragraph, index), "かたまり");
      continue;
    }
    if (char === "~" || char === "&" || char === "#" || char === "_" || char === "^" || char === "}") {
      // Stray specials stay opaque rather than editable. A lone closing brace
      // is malformed input; passing it through unchanged keeps the round trip.
      pushChip(index, index + 1, char === "~" ? "空白" : char);
      continue;
    }
    if (char === "\\") {
      const next = paragraph[index + 1];
      if (next === undefined) {
        pushChip(index, index + 1, "\\");
        continue;
      }
      if (next === "(" || next === "[") {
        pushChip(index, consumeDelimitedMath(paragraph, index), "数式");
        continue;
      }
      if (!/[A-Za-z]/.test(next)) {
        // \\, \%, \&, \, and friends: a two-character command.
        const label =
          next === "\\" ? "改行" : next.trim() === "" ? "空白" : next;
        pushChip(index, index + 2, label);
        continue;
      }
      let nameEnd = index + 1;
      while (nameEnd < paragraph.length && /[A-Za-z]/.test(paragraph[nameEnd] ?? "")) {
        nameEnd += 1;
      }
      const commandName = paragraph.slice(index + 1, nameEnd);
      // A starred variant is part of the same command.
      let cursor = nameEnd;
      if (paragraph[cursor] === "*") cursor += 1;
      if (commandName === "verb") {
        // \verb|...|: the delimiter is whatever follows, verbatim to its twin.
        const delimiter = paragraph[cursor];
        if (delimiter !== undefined) {
          const closing = paragraph.indexOf(delimiter, cursor + 1);
          pushChip(index, closing === -1 ? paragraph.length : closing + 1, "コード");
          continue;
        }
      }
      // Consume every argument group that follows: \cmd[opt]{a}{b}.
      while (cursor < paragraph.length) {
        const argChar = paragraph[cursor];
        if (argChar === "{" || argChar === "[") {
          cursor = consumeGroup(paragraph, cursor);
          continue;
        }
        break;
      }
      pushChip(index, cursor, chipLabelFor(commandName));
      continue;
    }
    index += 1;
  }
  flushText(paragraph.length);
  return segments;
}

/**
 * Escapes prose the reader typed so it typesets as the characters they meant.
 * For text segments that came out of segmentParagraph unedited this is the
 * identity — they contain no specials by construction.
 */
export function escapeParagraphText(text: string): string {
  return text.replace(/[\\%$&#_{}~^]/g, (char) => {
    if (char === "\\") return "\\textbackslash{}";
    if (char === "~") return "\\textasciitilde{}";
    if (char === "^") return "\\textasciicircum{}";
    return `\\${char}`;
  });
}

/** Reassembles a paragraph from segments, escaping only the text parts. */
export function serializeSegments(segments: readonly ParagraphSegment[]): string {
  return segments
    .map((segment) =>
      segment.kind === "chip" ? segment.latex : escapeParagraphText(segment.latex),
    )
    .join("");
}

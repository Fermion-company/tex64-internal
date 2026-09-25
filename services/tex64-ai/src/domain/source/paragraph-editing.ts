/**
 * Direct paragraph editing over LaTeX source, without showing the source.
 *
 * The reader clicks the page, SyncTeX names a line, and this module turns the
 * surrounding source into something a person can edit without seeing code:
 * prose stays prose, formulae become MathLive fields, and LaTeX structure is
 * preserved invisibly around them.
 *
 * Two invariants carry the whole design:
 *
 * 1. Round trip — concatenating the segments' `latex` reproduces the
 *    paragraph byte for byte. Nothing is normalized, reflowed, or prettified.
 * 2. Text segments contain no raw TeX-special syntax. Structure is kept in
 *    invisible segments, while escaped visible characters remain text. Escaping
 *    any text on the way back is therefore the
 *    identity for text the reader did not touch, and exactly the right guard
 *    for text they typed.
 */

export type ParagraphSegment =
  | { kind: "text"; latex: string }
  | { kind: "math"; latex: string; prefix: string; suffix: string }
  | { kind: "syntax"; latex: string };

export type ParagraphRange = {
  /** 1-based line of the paragraph's first line in the file. */
  startLine: number;
  /** 1-based line of the paragraph's last line in the file. */
  endLine: number;
  /** The paragraph's source, lines joined with \n. */
  text: string;
  /** Display math is edited as one formula, never as prose. */
  kind: "text" | "math";
};

/**
 * A line a paragraph never crosses — and never starts on. Sectioning, the
 * preamble, environment fences, and display math are structure, not prose;
 * clicking them offers no paragraph to edit.
 */
const STRUCTURAL_LINE = new RegExp(
  String.raw`^\s*(?:\\(?:begin|end)\{|\\(?:sub)*section\*?\s*[{[]|\\chapter\*?\s*[{[]|\\part\*?\s*[{[]|\\paragraph\*?\s*[{[]|\\subparagraph\*?\s*[{[]|\\documentclass|\\usepackage|\\maketitle\b|\\tableofcontents\b|\\bibliography(?:style)?\s*\{|\\appendix\b|\\newcommand|\\renewcommand|\\def\b|\\\[|\\\]|\$\$)`,
);

const EDITABLE_TEXT_COMMAND_LINE = new RegExp(
  String.raw`^\s*\\(?:title|author|date|(?:sub)*section|chapter|part|paragraph|subparagraph|caption)\*?\s*(?:\[[^\]]*\]\s*)?\{`,
);

const DISPLAY_MATH_ENVIRONMENTS = new Set([
  "math",
  "displaymath",
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
]);

const displayMathBoundary = (
  line: string,
): { edge: "begin" | "end"; environment: string } | null => {
  if (/^\s*\\\[\s*(?:%.*)?$/.test(line)) return { edge: "begin", environment: "\\[" };
  if (/^\s*\\\]\s*(?:%.*)?$/.test(line)) return { edge: "end", environment: "\\[" };
  const match = line.match(/^\s*\\(begin|end)\{([^}]+)\}/);
  if (!match || !DISPLAY_MATH_ENVIRONMENTS.has(match[2] ?? "")) return null;
  return {
    edge: match[1] === "begin" ? "begin" : "end",
    environment: match[2] ?? "",
  };
};

const normalizedPaperText = (value: string): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

const normalizedMathSource = (value: string): string =>
  normalizedPaperText(
    value
      .replace(/\\(?:operatorname|mathrm|mathbf|mathit|mathsf|mathtt|text)\s*\{([^{}]*)\}/gu, "$1")
      .replace(/\\top\b/gu, "t")
      .replace(/\\(?:left|right|big|Big|bigg|Bigg|frac|dfrac|tfrac|sqrt)\b/gu, "")
      .replace(/\\([A-Za-z]+)\b/gu, "$1"),
  );

const bigramSimilarity = (left: string, right: string): number => {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const available = counts.get(pair) ?? 0;
    if (available <= 0) continue;
    overlap += 1;
    counts.set(pair, available - 1);
  }
  return (2 * overlap) / Math.max(1, left.length + right.length - 2);
};

/** Text a reader can recognize on paper, with TeX structure removed. */
export const sourcePaperText = (source: string): string =>
  segmentParagraph(source)
    .map((segment) => {
      if (segment.kind === "text") return segment.latex;
      if (segment.kind === "math") return ` ${normalizedMathSource(segment.latex)} `;
      return " ";
    })
    .join("");

/** Public for the click corpus: the same comparison used by direct editing. */
export const paperTextSimilarity = (source: string, paperText: string): number =>
  bigramSimilarity(
    normalizedPaperText(sourcePaperText(source)),
    normalizedPaperText(paperText),
  );

const collectTextRanges = (
  lines: readonly string[],
  firstLineNumber: number,
): ParagraphRange[] => {
  const ranges: ParagraphRange[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isBlankLine(line)) {
      index += 1;
      continue;
    }
    if (EDITABLE_TEXT_COMMAND_LINE.test(line)) {
      ranges.push({
        startLine: firstLineNumber + index,
        endLine: firstLineNumber + index,
        text: line,
        kind: "text",
      });
      index += 1;
      continue;
    }
    const boundary = displayMathBoundary(line);
    if (boundary?.edge === "begin") {
      index += 1;
      while (index < lines.length) {
        const closing = displayMathBoundary(lines[index] ?? "");
        index += 1;
        if (closing?.edge === "end" && closing.environment === boundary.environment) break;
      }
      continue;
    }
    if (isStructuralLine(line)) {
      index += 1;
      continue;
    }
    const start = index;
    let end = index;
    while (end + 1 < lines.length) {
      const next = lines[end + 1] ?? "";
      if (
        isBlankLine(next) ||
        isStructuralLine(next) ||
        EDITABLE_TEXT_COMMAND_LINE.test(next)
      ) {
        break;
      }
      end += 1;
    }
    const text = lines.slice(start, end + 1).join("\n");
    if (sourcePaperText(text).trim()) {
      ranges.push({
        startLine: firstLineNumber + start,
        endLine: firstLineNumber + end,
        text,
        kind: "text",
      });
    }
    index = end + 1;
  }
  return ranges;
};

const TABLE_ENVIRONMENT = /^\s*\\begin\{(tabular\*?|tabularx)\}/u;

/** A tabular selection edits the table as a whole, including its delimiters. */
const findTableByPaperText = (
  lines: readonly string[],
  firstLineNumber: number,
  selectedText: string,
): ParagraphRange | null => {
  const paper = normalizedPaperText(selectedText);
  if (paper.length < 3) return null;

  let best: { range: ParagraphRange; score: number; contains: boolean } | null = null;
  for (let start = 0; start < lines.length; start += 1) {
    const begin = TABLE_ENVIRONMENT.exec(lines[start] ?? "");
    if (!begin) continue;
    const environment = begin[1]!;
    let end = start + 1;
    while (end < lines.length && !new RegExp(String.raw`^\s*\\end\{${environment}\}`).test(lines[end] ?? "")) end += 1;
    if (end >= lines.length) continue;
    const text = lines.slice(start, end + 1).join("\n");
    const source = normalizedPaperText(sourcePaperText(text));
    const contains = source.includes(paper) || paper.includes(source);
    const score = bigramSimilarity(source, paper);
    if (!contains && score < 0.58) {
      start = end;
      continue;
    }
    const candidate = {
      range: {
        startLine: firstLineNumber + start,
        endLine: firstLineNumber + end,
        text,
        kind: "text" as const,
      },
      score,
      contains,
    };
    if (!best || Number(candidate.contains) > Number(best.contains) || candidate.score > best.score) best = candidate;
    start = end;
  }
  return best?.range ?? null;
};

const findTextByPaperText = (
  lines: readonly string[],
  firstLineNumber: number,
  targetLine: number,
  selectedText: string,
): ParagraphRange | null => {
  const paper = normalizedPaperText(selectedText);
  if (paper.length < 3) return null;
  const ranked = collectTextRanges(lines, firstLineNumber)
    .map((range) => ({
      range,
      score: paperTextSimilarity(range.text, selectedText),
      containsTarget: targetLine >= range.startLine && targetLine <= range.endLine,
      distance:
        targetLine < range.startLine
          ? range.startLine - targetLine
          : targetLine > range.endLine
            ? targetLine - range.endLine
            : 0,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.containsTarget !== right.containsTarget) return left.containsTarget ? -1 : 1;
      if (left.distance !== right.distance) return left.distance - right.distance;
      return left.range.startLine - right.range.startLine;
    });
  const best = ranked[0];
  if (!best) return null;
  const second = ranked[1];
  const shortExact =
    paper.length < 12 &&
    normalizedPaperText(sourcePaperText(best.range.text)) === paper;
  const sufficientlyDistinct =
    !second ||
    best.score - second.score >= 0.04 ||
    (best.containsTarget && !second.containsTarget) ||
    (best.distance + 2 < second.distance);
  if ((best.score >= 0.58 || shortExact) && sufficientlyDistinct) {
    return best.range;
  }
  return null;
};

const findMathByPaperText = (
  lines: readonly string[],
  firstLineNumber: number,
  selectedText: string,
): ParagraphRange | null => {
  const visible = normalizedPaperText(selectedText);
  if (visible.length < 3) return null;
  const candidates: Array<{ range: ParagraphRange; math: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const boundary = displayMathBoundary(lines[index] ?? "");
    if (boundary?.edge === "begin") {
      for (let end = index + 1; end < lines.length; end += 1) {
        const closing = displayMathBoundary(lines[end] ?? "");
        if (closing?.edge !== "end" || closing.environment !== boundary.environment) continue;
        const contentStart = index + 1;
        const contentEnd = end - 1;
        if (contentStart <= contentEnd) {
          const text = lines.slice(contentStart, contentEnd + 1).join("\n");
          candidates.push({
            math: text,
            range: {
              startLine: firstLineNumber + contentStart,
              endLine: firstLineNumber + contentEnd,
              text,
              kind: "math",
            },
          });
        }
        index = end;
        break;
      }
      continue;
    }
    const sourceLine = lines[index] ?? "";
    const inlineMath = segmentParagraph(sourceLine).filter(
      (segment): segment is Extract<ParagraphSegment, { kind: "math" }> =>
        segment.kind === "math",
    );
    if (inlineMath.length > 0) {
      candidates.push({
        math: inlineMath.map((segment) => segment.latex).join(" "),
        range: {
          startLine: firstLineNumber + index,
          endLine: firstLineNumber + index,
          text: sourceLine,
          kind: "text",
        },
      });
    }
  }
  let best: { range: ParagraphRange; score: number } | null = null;
  for (const candidate of candidates) {
    const score = bigramSimilarity(visible, normalizedMathSource(candidate.math));
    if (!best || score > best.score) best = { range: candidate.range, score };
  }
  return best && best.score >= 0.42 ? best.range : null;
};

const findDisplayMathRange = (
  lines: readonly string[],
  firstLineNumber: number,
  targetIndex: number,
): ParagraphRange | null => {
  const targetBoundary = displayMathBoundary(lines[targetIndex] ?? "");
  const scanFrom = targetBoundary?.edge === "end" ? targetIndex - 1 : targetIndex;
  let begin = -1;
  let environment = "";
  for (let index = scanFrom; index >= 0; index -= 1) {
    const boundary = displayMathBoundary(lines[index] ?? "");
    if (!boundary) continue;
    if (boundary.edge === "end") return null;
    begin = index;
    environment = boundary.environment;
    break;
  }
  if (begin < 0) return null;
  let end = -1;
  for (let index = Math.max(scanFrom, begin + 1); index < lines.length; index += 1) {
    const boundary = displayMathBoundary(lines[index] ?? "");
    if (boundary?.edge === "end" && boundary.environment === environment) {
      end = index;
      break;
    }
  }
  if (end < 0 || targetIndex > end) return null;
  const contentStart = begin + 1;
  const contentEnd = end - 1;
  if (contentStart > contentEnd) return null;
  return {
    startLine: firstLineNumber + contentStart,
    endLine: firstLineNumber + contentEnd,
    text: lines.slice(contentStart, contentEnd + 1).join("\n"),
    kind: "math",
  };
};

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
  selectedText = "",
): ParagraphRange | null {
  const index = targetLine - firstLineNumber;
  if (index < 0 || index >= lines.length) {
    return null;
  }
  const targetText = lines[index];
  if (targetText === undefined) return null;
  const displayMath = findDisplayMathRange(lines, firstLineNumber, index);
  if (displayMath) return displayMath;
  const matchedMath = findMathByPaperText(lines, firstLineNumber, selectedText);
  if (matchedMath) return matchedMath;
  const matchedTable = findTableByPaperText(lines, firstLineNumber, selectedText);
  if (matchedTable) return matchedTable;
  if (EDITABLE_TEXT_COMMAND_LINE.test(targetText)) {
    const commandText = normalizedPaperText(
      segmentParagraph(targetText)
        .filter((segment) => segment.kind === "text")
        .map((segment) => segment.latex)
        .join(""),
    );
    const selectionText = normalizedPaperText(selectedText);
    if (
      !selectionText ||
      commandText.includes(selectionText) ||
      selectionText.includes(commandText)
    ) {
      return {
        startLine: targetLine,
        endLine: targetLine,
        text: targetText,
        kind: "text",
      };
    }
  }
  const matchedText = findTextByPaperText(
    lines,
    firstLineNumber,
    targetLine,
    selectedText,
  );
  if (matchedText) return matchedText;
  // PDF text is stronger evidence than a nearby SyncTeX line. If it does not
  // match any editable source, showing a neighboring paragraph would be a
  // confidently wrong editor. Fail closed instead; the paper remains usable.
  if (normalizedPaperText(selectedText).length > 0) return null;
  if (isBlankLine(targetText) || isStructuralLine(targetText)) return null;
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
    kind: "text",
  };
}

/** Commands whose human-facing argument is prose rather than implementation. */
const EDITABLE_TEXT_COMMANDS = new Set([
  "title",
  "author",
  "date",
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
  "caption",
  "emph",
  "textit",
  "textsl",
  "textbf",
  "textrm",
  "textsf",
  "texttt",
  "textsc",
  "textnormal",
  "underline",
  "uline",
  "mbox",
  "footnote",
  "thanks",
]);

/** These expose their last argument; earlier arguments are destinations/style. */
const LAST_TEXT_ARGUMENT_COMMANDS = new Set(["href", "textcolor", "colorbox", "fcolorbox"]);

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

type ArgumentGroup = {
  open: "{" | "[";
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
};

const collectArgumentGroups = (source: string, from: number): ArgumentGroup[] => {
  const groups: ArgumentGroup[] = [];
  let cursor = from;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    const open = source[cursor];
    if (open !== "{" && open !== "[") break;
    const end = consumeGroup(source, cursor);
    const closed = end > cursor && source[end - 1] === (open === "{" ? "}" : "]");
    groups.push({
      open,
      start: cursor,
      contentStart: cursor + 1,
      contentEnd: closed ? end - 1 : end,
      end,
    });
    cursor = end;
  }
  return groups;
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
      const latex = paragraph.slice(textStart, upTo);
      const previous = segments.at(-1);
      if (previous?.kind === "text") previous.latex += latex;
      else segments.push({ kind: "text", latex });
    }
  };
  const pushSyntax = (from: number, to: number) => {
    flushText(from);
    const latex = paragraph.slice(from, to);
    if (latex) {
      const previous = segments.at(-1);
      if (previous?.kind === "syntax") previous.latex += latex;
      else segments.push({ kind: "syntax", latex });
    }
    textStart = to;
    index = to;
  };
  const pushMath = (from: number, contentStart: number, contentEnd: number, to: number) => {
    flushText(from);
    segments.push({
      kind: "math",
      prefix: paragraph.slice(from, contentStart),
      latex: paragraph.slice(contentStart, contentEnd),
      suffix: paragraph.slice(contentEnd, to),
    });
    textStart = to;
    index = to;
  };
  const pushNestedText = (from: number, group: ArgumentGroup, commandEnd: number) => {
    flushText(from);
    const prefix = paragraph.slice(from, group.contentStart);
    if (prefix) segments.push({ kind: "syntax", latex: prefix });
    segments.push(...segmentParagraph(paragraph.slice(group.contentStart, group.contentEnd)));
    const suffix = paragraph.slice(group.contentEnd, commandEnd);
    if (suffix) segments.push({ kind: "syntax", latex: suffix });
    textStart = commandEnd;
    index = commandEnd;
  };

  while (index < paragraph.length) {
    const char = paragraph[index];
    if (char === "%") {
      const lineEnd = paragraph.indexOf("\n", index);
      pushSyntax(index, lineEnd === -1 ? paragraph.length : lineEnd);
      continue;
    }
    if (char === "$") {
      const to = consumeMath(paragraph, index);
      const fenceLength = paragraph.startsWith("$$", index) ? 2 : 1;
      const closed = paragraph.slice(to - fenceLength, to) === "$".repeat(fenceLength);
      pushMath(
        index,
        index + fenceLength,
        closed ? to - fenceLength : to,
        to,
      );
      continue;
    }
    if (char === "{" ) {
      const to = consumeGroup(paragraph, index);
      const closed = paragraph[to - 1] === "}";
      const group: ArgumentGroup = {
        open: "{",
        start: index,
        contentStart: index + 1,
        contentEnd: closed ? to - 1 : to,
        end: to,
      };
      pushNestedText(index, group, to);
      continue;
    }
    if (char === "~" || char === "&" || char === "#" || char === "_" || char === "^" || char === "}") {
      pushSyntax(index, index + 1);
      continue;
    }
    if (char === "\\") {
      const next = paragraph[index + 1];
      if (next === undefined) {
        pushSyntax(index, index + 1);
        continue;
      }
      if (next === "(" || next === "[") {
        const to = consumeDelimitedMath(paragraph, index);
        const closer = next === "(" ? "\\)" : "\\]";
        const closed = paragraph.slice(to - 2, to) === closer;
        pushMath(index, index + 2, closed ? to - 2 : to, to);
        continue;
      }
      if (!/[A-Za-z]/.test(next)) {
        const editableEscapes: Record<string, string> = {
          "%": "%",
          "&": "&",
          "#": "#",
          "_": "_",
          "{": "{",
          "}": "}",
        };
        const editable = editableEscapes[next];
        if (editable !== undefined) {
          flushText(index);
          const previous = segments.at(-1);
          if (previous?.kind === "text") previous.latex += editable;
          else segments.push({ kind: "text", latex: editable });
          index += 2;
          textStart = index;
        } else {
          pushSyntax(index, index + 2);
        }
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
          pushSyntax(index, closing === -1 ? paragraph.length : closing + 1);
          continue;
        }
      }
      const groups = collectArgumentGroups(paragraph, cursor);
      const commandEnd = groups.at(-1)?.end ?? cursor;
      const requiredGroups = groups.filter((group) => group.open === "{");
      const exposesText =
        EDITABLE_TEXT_COMMANDS.has(commandName) ||
        LAST_TEXT_ARGUMENT_COMMANDS.has(commandName);
      const targetGroup = exposesText
        ? LAST_TEXT_ARGUMENT_COMMANDS.has(commandName)
          ? requiredGroups.at(-1)
          : requiredGroups[0]
        : undefined;
      if (targetGroup) {
        pushNestedText(index, targetGroup, commandEnd);
        continue;
      }
      // \item has no human-facing argument of its own; the prose after it is.
      pushSyntax(index, commandEnd);
      continue;
    }
    index += 1;
  }
  flushText(paragraph.length);
  return segments;
}

/** Keep equation metadata out of MathLive while preserving it byte-for-byte. */
export function segmentDisplayMath(source: string): ParagraphSegment[] {
  const segments: ParagraphSegment[] = [];
  const lines = source.split("\n");
  let mathSource = "";
  const flushMath = () => {
    if (!mathSource) return;
    if (mathSource.trim()) {
      segments.push({ kind: "math", latex: mathSource, prefix: "", suffix: "" });
    } else {
      segments.push({ kind: "syntax", latex: mathSource });
    }
    mathSource = "";
  };
  lines.forEach((line, index) => {
    const newline = index < lines.length - 1 ? "\n" : "";
    if (/^\s*(?:%|\\(?:label|tag)\*?\s*\{|\\(?:notag|nonumber)\b)/u.test(line)) {
      flushMath();
      segments.push({ kind: "syntax", latex: `${line}${newline}` });
    } else {
      mathSource += `${line}${newline}`;
    }
  });
  flushMath();
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
    .map((segment) => {
      if (segment.kind === "syntax") return segment.latex;
      if (segment.kind === "math") {
        return `${segment.prefix}${segment.latex}${segment.suffix}`;
      }
      return escapeParagraphText(segment.latex);
    })
    .join("");
}

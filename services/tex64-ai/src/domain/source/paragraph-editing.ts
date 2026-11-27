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

/** Skip escaped control symbols and comments when looking for a closing fence. */
const findFence = (source: string, from: number, fence: string): number => {
  for (let i = from; i < source.length;) {
    if (source.startsWith(fence, i)) return i;
    if (source[i] === "%") {
      const newline = source.indexOf("\n", i);
      if (newline < 0) break;
      i = newline + 1;
    } else {
      i += source[i] === "\\" ? 2 : 1;
    }
  }
  return -1;
};

const displayOpening = (line: string) => {
  const match = /^\s*(?:\\\[|\$\$|\\begin\{([^}]+)\})/u.exec(line);
  if (!match) return null;
  const env = match[1];
  if (env && !DISPLAY_MATH_ENVIRONMENTS.has(env)) return null;
  let length = match[0].length;
  if (env?.startsWith("alignat")) {
    const count = /^\s*\{\s*\d+\s*\}/u.exec(line.slice(length));
    if (count) length += count[0].length;
  }
  return { length, close: env ? `\\end{${env}}` : match[0].trim() === "$$" ? "$$" : "\\]" };
};

type DisplayBlock = { begin: number; end: number; range: ParagraphRange };
const displayBlocks = (lines: readonly string[], firstLineNumber: number): DisplayBlock[] => {
  const blocks: DisplayBlock[] = [];
  for (let begin = 0; begin < lines.length; begin += 1) {
    const first = lines[begin]!;
    const opening = displayOpening(first);
    if (!opening) continue;
    for (let end = begin; end < lines.length; end += 1) {
      const last = lines[end]!;
      const closing = findFence(last, end === begin ? opening.length : 0, opening.close);
      if (closing < 0) {
        if (end > begin && displayOpening(last)) break;
        continue;
      }
      if (!/^\s*(?:%.*)?$/u.test(last.slice(closing + opening.close.length))) break;
      const startLine = begin !== end && /^\s*(?:%.*)?$/u.test(first.slice(opening.length)) ? begin + 1 : begin;
      const endLine = begin !== end && !last.slice(0, closing).trim() ? end - 1 : end;
      if (endLine >= startLine) {
        blocks.push({ begin, end, range: {
          kind: "math", startLine: firstLineNumber + startLine, endLine: firstLineNumber + endLine,
          text: lines.slice(startLine, endLine + 1).join("\n"),
        } });
      }
      begin = end;
      break;
    }
  }
  return blocks;
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
  blocks: readonly DisplayBlock[],
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
    const block = blocks.find((item) => item.begin === index);
    if (block) {
      index = block.end + 1;
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
  blocks: readonly DisplayBlock[],
): ParagraphRange | null => {
  const paper = normalizedPaperText(selectedText);
  if (paper.length < 3) return null;
  const ranked = collectTextRanges(lines, firstLineNumber, blocks)
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
  blocks: readonly DisplayBlock[],
  targetLine: number,
): ParagraphRange | null => {
  const visible = normalizedPaperText(selectedText);
  if (visible.length < 3) return null;
  const candidates: Array<{ range: ParagraphRange; math: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const block = blocks.find((item) => item.begin === index);
    if (block) {
      const parts = segmentDisplayMath(block.range.text);
      // A numbered align row prints its own tag at the far side of the page.
      // The clicked PDF line contains that tag, even when SyncTeX points to
      // the paragraph after the environment.
      const math = parts.filter(s => s.kind === "math").map(s => s.latex).join(" ");
      candidates.push({ range: block.range, math });
      for (let j = 0; j < parts.length; j++) {
        const part = parts[j]!;
        if (part.kind !== "math") continue;
        candidates.push({ range: block.range, math: part.latex });
        const following = parts[j + 1];
        if (following?.kind !== "syntax") continue;
        const tag = /\\tag\*?\s*\{/u.exec(following.latex);
        if (tag) {
          const open = tag.index + tag[0].length - 1;
          const value = following.latex.slice(open + 1, consumeGroup(following.latex, open) - 1);
          candidates.push({ range: block.range, math: part.latex + value });
        }
      }
      index = block.end;
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
    if (!best || score > best.score || (score === best.score &&
        Math.abs(candidate.range.startLine - targetLine) < Math.abs(best.range.startLine - targetLine))) {
      best = { range: candidate.range, score };
    }
  }
  return best && best.score >= 0.42 ? best.range : null;
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
  const blocks = displayBlocks(lines, firstLineNumber);
  const displayMath = blocks.find((block) => block.begin <= index && index <= block.end)?.range;
  if (displayMath) return displayMath;
  // A PDF line can be a short wrapped fragment of a much longer paragraph.
  // An exact fragment on the SyncTeX line is stronger than a document-wide
  // similarity match, including matches against other formulae.
  const fragment = normalizedPaperText(selectedText);
  if (fragment.length >= 4 && normalizedPaperText(sourcePaperText(targetText)).includes(fragment)) {
    const local = collectTextRanges(lines, firstLineNumber, blocks)
      .find(range => range.startLine <= targetLine && range.endLine >= targetLine);
    if (local) return local;
  }
  const matchedMath = findMathByPaperText(lines, firstLineNumber, selectedText, blocks, targetLine);
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
    blocks,
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
    segments.push(...mathSegments(paragraph.slice(contentStart, contentEnd),
      paragraph.slice(from, contentStart), paragraph.slice(contentEnd, to)));
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
      const fence = paragraph.startsWith("$$", index) ? "$$" : "$";
      const start = index + fence.length;
      const close = findFence(paragraph, start, fence);
      pushMath(index, start, close < 0 ? paragraph.length : close,
        close < 0 ? paragraph.length : close + fence.length);
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
        const close = findFence(paragraph, index + 2, next === "(" ? "\\)" : "\\]");
        pushMath(index, index + 2, close < 0 ? paragraph.length : close,
          close < 0 ? paragraph.length : close + 2);
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

function mathMetadataEnd(source: string, start: number): number {
  if (source[start] === "%") {
    const newline = source.indexOf("\n", start);
    return newline < 0 ? source.length : newline + 1;
  }
  if (source[start] !== "\\") return start;
  const match = /^\\(?:(?:label|tag\*?)\s*\{|(?:notag|nonumber)(?![A-Za-z]))/u.exec(source.slice(start));
  if (!match) return start;
  const end = start + match[0].length;
  return match[0].endsWith("{") ? consumeGroup(source, end - 1) : end;
}

/** LaTeX keeps comments and labels even inside fractions and nested matrices. */
export function mathFieldSource(latex: string) {
  const metadata: { offset: number; text: string }[] = [];
  let visible = "";
  let start = 0;
  for (let i = 0; i < latex.length;) {
    const end = mathMetadataEnd(latex, i);
    if (end === i) { i += latex[i] === "\\" ? 2 : 1; continue; }
    visible += latex.slice(start, i);
    metadata.push({ offset: visible.length, text: latex.slice(i, end) });
    // A removed comment must not join a control word to following letters.
    if (/\\[a-zA-Z]+$/u.test(visible) && /[a-zA-Z]/u.test(latex[end] ?? "")) visible += " ";
    start = end;
    i = end;
  }
  return { visible: visible + latex.slice(start), metadata };
}

type MathToken = { value: string; start: number; end: number };

/** Keep source offsets even for a MathLive value that normalized TeX spacing. */
function mathTokens(source: string, hideMetadata: boolean) {
  const tokens: MathToken[] = [];
  const hidden: { start: number; end: number }[] = [];
  const textGroups = [false];
  const token = /\\(?:begin|end)\s*\{[^{}\\%]*\}|\\(?:[A-Za-z@]+|[\s\S])|\s+|[\s\S]/guy;
  let textArgument = false;
  for (let at = 0; at < source.length;) {
    const end = mathMetadataEnd(source, at);
    if (end > at) {
      if (hideMetadata) hidden.push({ start: at, end });
      else tokens.push({ value: source.slice(at, end), start: at, end });
      at = end;
      continue;
    }
    token.lastIndex = at;
    const value = token.exec(source)![0];
    const start = at;
    at += value.length;
    if (/^\s/u.test(value)) {
      if (textGroups.at(-1)) tokens.push({ value: " ", start, end: at });
      continue;
    }
    tokens.push({ value, start, end: at });
    if (value === "{") textGroups.push(Boolean(textGroups.at(-1) || textArgument));
    if (value === "}" && textGroups.length > 1) textGroups.pop();
    textArgument = /^\\(?:text(?:normal|rm|sf|tt|bf|it|sl|sc|up)?|operatorname|begin|end)$/u.test(value);
  }
  return { tokens, hidden };
}

/** Visit each changed span. The usual single insertion/deletion is linear.
 * Two edits in one field may enclose an unchanged fraction or matrix; match
 * its tokens too, keeping the original whitespace and annotations in place. */
function changedMathSpans(old: MathToken[], next: MathToken[],
  change: (from: number, to: number, newFrom: number, newTo: number) => void) {
  let head = 0, end = old.length, newEnd = next.length;
  while (head < end && head < newEnd && old[head]!.value === next[head]!.value) head++;
  while (end > head && newEnd > head && old[end - 1]!.value === next[newEnd - 1]!.value) { end--; newEnd--; }
  if (head === end && head === newEnd) return;
  const rows = end - head, cols = newEnd - head;
  // Bound work on a wholesale paste. Normal keystrokes never allocate a grid.
  if (!rows || !cols || rows * cols > 65536) { change(head, end, head, newEnd); return; }
  const stride = cols + 1, lengths = new Uint16Array((rows + 1) * stride);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const k = i * stride + j;
      lengths[k] = old[head + i]!.value === next[head + j]!.value
        ? lengths[k + stride + 1]! + 1 : Math.max(lengths[k + 1]!, lengths[k + stride]!);
    }
  }
  let i = head, j = head, from = i, newFrom = j;
  while (i < end && j < newEnd) {
    if (old[i]!.value === next[j]!.value) {
      if (i !== from || j !== newFrom) change(from, i, newFrom, j);
      from = ++i;
      newFrom = ++j;
    } else {
      const k = (i - head) * stride + j - head;
      if (lengths[k + stride]! >= lengths[k + 1]!) i++; else j++;
    }
  }
  if (from !== end || newFrom !== newEnd) change(from, end, newFrom, newEnd);
}

export function preserveMathMetadata(original: string, replacement: string): string {
  const { tokens: old, hidden } = mathTokens(original, true);
  const { tokens: next } = mathTokens(replacement, false);
  let result = "", cursor = 0;
  const append = (part: string) => {
    if (/^[A-Za-z@]/u.test(part) && /(?:^|[^\\])(?:\\\\)*\\[A-Za-z@]+$/u.test(result)) result += " ";
    result += part;
  };
  changedMathSpans(old, next, (from, to, newFrom, newTo) => {
    const start = from < to ? old[from]!.start : old[from - 1]?.end ?? old[0]?.start ?? 0;
    const end = from < to ? old[to - 1]!.end : start;
    append(original.slice(cursor, start));
    const inserted = newFrom < newTo ? replacement.slice(next[newFrom]!.start, next[newTo - 1]!.end) : "";
    const notes = hidden.filter(note => note.start >= start && note.end <= end);
    const lastNote = notes.at(-1);
    // A display fence or row separator can follow on its own line outside
    // this field. Finish the replacement with math so a retained comment's
    // newline cannot create an empty paragraph before that separator.
    const notesFirst = inserted && to === old.length && lastNote &&
      original[lastNote.start] === "%" && !original.slice(end).trim();
    if (!notesFirst) append(inserted);
    for (const note of notes) append(original.slice(note.start, note.end));
    if (notesFirst) append(inserted);
    cursor = end;
  });
  append(original.slice(cursor));
  return result;
}

/** Keep structural TeX outside the MathLive value when rewriting a formula. */
function mathSegments(source: string, prefix: string, suffix: string): ParagraphSegment[] {
  const metadata: Array<{ start: number; end: number }> = [];
  const rowBreaks: Array<{ start: number; end: number }> = [];
  let groups = 0;
  let environments = 0;
  for (let i = 0; i < source.length;) {
    const start = i;
    const metadataEnd = mathMetadataEnd(source, i);
    if (metadataEnd > i) {
      i = metadataEnd;
      if (!groups && !environments) metadata.push({ start, end: i });
      continue;
    }
    if (source[i] !== "\\") {
      if (source[i] === "{") groups++;
      if (source[i] === "}") groups = Math.max(0, groups - 1);
      i++;
      continue;
    }
    const token = /^\\(?:[a-zA-Z]+|[\s\S])/u.exec(source.slice(i))?.[0] ?? "\\";
    i += token.length;
    if (token === "\\begin") environments++;
    if (token === "\\end") environments = Math.max(0, environments - 1);
    if (groups || environments) continue;
    if (token === "\\\\") {
      const spacing = /^\*?(?:[ \t]*\[[^\]\n]*\])?/u.exec(source.slice(i))![0];
      i += spacing.length;
      rowBreaks.push({ start, end: i });
    }
  }
  if (!metadata.length) return [{ kind: "math", latex: source, prefix, suffix }];
  const parts: ParagraphSegment[] = [];
  let position = 0;
  const syntax = (latex: string) => {
    if (!latex) return;
    const previous = parts.at(-1);
    if (previous?.kind === "syntax") previous.latex += latex;
    else parts.push({ kind: "syntax", latex });
  };
  const editable = (fragment: string) => {
    const latex = fragment.trim();
    if (!latex) { syntax(fragment); return; }
    const left = fragment.indexOf(latex);
    parts.push({ kind: "math", latex, prefix: fragment.slice(0, left), suffix: fragment.slice(left + latex.length) });
  };
  syntax(prefix);
  // A comment inside a row is part of that field's source. Splitting the
  // field there makes End stop halfway through the printed expression.
  const ordered = [...metadata, ...rowBreaks].sort((a, b) => b.start - a.start);
  let right = source.length, hasFollowingMath = false;
  const boundaries = ordered.filter(span => {
    hasFollowingMath ||= /\S/u.test(source.slice(span.end, right));
    right = span.start;
    if (source[span.start] === "%" && hasFollowingMath) return false;
    hasFollowingMath = false;
    return true;
  }).reverse();
  for (const span of boundaries) {
    editable(source.slice(position, span.start));
    syntax(source.slice(span.start, span.end));
    position = span.end;
  }
  editable(source.slice(position));
  syntax(suffix);
  return parts;
}

export function segmentDisplayMath(source: string): ParagraphSegment[] {
  const opening = displayOpening(source);
  const start = opening?.length ?? 0;
  // A line range can contain either fence independently when the author put
  // formula content on the same line as that fence.
  let end = source.length;
  if (opening) {
    const close = findFence(source, start, opening.close);
    if (close >= 0) end = close;
  }
  if (end === source.length) {
    const closing = /(?:\\end\{([^}]+)\}|\\\]|\$\$)[ \t]*(?:%[^\n]*)?$/u.exec(source);
    if (closing && (!closing[1] || DISPLAY_MATH_ENVIRONMENTS.has(closing[1])) &&
        closing.index >= start && findFence(source, start, closing[0]) === closing.index) end = closing.index;
  }
  return mathSegments(source.slice(start, end), source.slice(0, start), source.slice(end));
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

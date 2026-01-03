import { nanoid } from "nanoid";
import type {
  Document,
  DocumentBlock,
  InlineContent,
  InlineText,
  ListType,
  MathEnvType,
  HeadingLevel,
  HeadingContent,
  TableContent,
  BlockType, // Import BlockType
} from "@/lib/document/types";

/*
export type BlockType =
  | "paragraph"
  | "heading"
  | "list"
  | "mathBlock"
  | "mathEnv"
  | "figure"
  | "table"
  | "code"
  | "raw"
  | "abstract"
  | "toc"
  | "slideFrame"
  | "columnBreak"
  | "pageBreak"
  | "maketitle";
*/

type AnchorKind = "label" | "hash" | "context";

export type BlockAnchor = {
  kind: AnchorKind;
  value: string;
};

export type BlockMeta = {
  envName?: string;
  headingCommand?: string;
  innerStart?: number;
  innerEnd?: number;
  titleStart?: number;
  titleEnd?: number;
  listType?: string;
  indent?: string;
  optionalArg?: string;
  safeStructured?: boolean;
};

export type BlockParsed = {
  title?: string;
  body?: string;
  items?: string[];
  figure?: {
    imagePath: string;
    caption?: string;
    label?: string;
    width?: string;
    placement?: string;
  };
  table?: {
    alignment: string;
    body: string;
    caption?: string;
    label?: string;
  };
};

export type BlockEntry = {
  id: string;
  type: BlockType;
  title: string;
  snippet: string;
  start: number;
  end: number;
  anchor: BlockAnchor;
  fingerprint: string;
  meta: BlockMeta;
  parsed?: BlockParsed;
};

const MATH_ENVS = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "multline",
  "multline*",
]);

const LIST_ENVS = new Set(["itemize", "enumerate", "description"]);

const THEOREM_ENVS = new Set([
  "definition",
  "theorem",
  "lemma",
  "proof",
  "corollary",
  "proposition",
  "example",
  "remark",
  "law",
  "block",
  "alertblock",
  "quote",
]);

const SLIDE_ENVS = new Set(["frame", "columns"]);

const CODE_ENVS = new Set(["lstlisting", "verbatim", "code"]);

const HEADING_COMMANDS = [
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
];

const HEADING_LEVELS: Record<string, HeadingLevel> = {
  chapter: 1,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

const INLINE_FORMATTERS: Record<string, "bold" | "italic" | "texttt" | "underline"> = {
  textbf: "bold",
  textit: "italic",
  texttt: "texttt",
  underline: "underline",
  emph: "italic",
};

const buildHash = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return `b${Math.abs(hash)}`;
};

const buildFingerprint = (snippet: string) =>
  buildHash(snippet.replace(/\s+/g, " ").trim());

const extractAnchor = (snippet: string): BlockAnchor => {
  const labelMatch = snippet.match(/\\label\{([^}]+)\}/);
  if (labelMatch) {
    return { kind: "label", value: labelMatch[1].trim() };
  }
  return { kind: "hash", value: buildFingerprint(snippet) };
};

const buildCommentRanges = (content: string) => {
  const ranges: Array<[number, number]> = [];
  const lines = content.split(/\n/);
  let cursor = 0;
  for (const line of lines) {
    const idx = line.indexOf("%");
    if (idx !== -1) {
      ranges.push([cursor + idx, cursor + line.length]);
    }
    cursor += line.length + 1;
  }
  return ranges;
};

const isInComment = (ranges: Array<[number, number]>, index: number) =>
  ranges.some(([start, end]) => index >= start && index < end);

const findNextMatch = (
  regex: RegExp,
  content: string,
  start: number,
  commentRanges: Array<[number, number]>,
) => {
  regex.lastIndex = start;
  let match = regex.exec(content);
  while (match) {
    if (!isInComment(commentRanges, match.index)) {
      return match;
    }
    regex.lastIndex = match.index + match[0].length;
    match = regex.exec(content);
  }
  return null;
};

const skipWhitespace = (content: string, start: number) => {
  let cursor = start;
  while (cursor < content.length && /\s/.test(content[cursor])) {
    cursor += 1;
  }
  return cursor;
};

const readGroup = (content: string, start: number, open: string, close: string) => {
  if (content[start] !== open) return null;
  let depth = 0;
  for (let i = start; i < content.length; i += 1) {
    const char = content[i];
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return {
          content: content.slice(start + 1, i),
          end: i + 1,
        };
      }
    }
  }
  return null;
};

const findMatchingEnd = (
  content: string,
  envName: string,
  start: number,
  commentRanges: Array<[number, number]>,
) => {
  const beginRegex = new RegExp(`\\\\begin\\{${envName}\\}`, "g");
  const endRegex = new RegExp(`\\\\end\\{${envName}\\}`, "g");
  beginRegex.lastIndex = start;
  endRegex.lastIndex = start;
  let depth = 1;
  let searchPos = start;
  while (searchPos < content.length) {
    const nextBegin = beginRegex.exec(content);
    const nextEnd = endRegex.exec(content);
    if (!nextEnd) return null;
    const nextBeginIndex = nextBegin ? nextBegin.index : Number.POSITIVE_INFINITY;
    if (nextBegin && nextBeginIndex < nextEnd.index) {
      if (!isInComment(commentRanges, nextBegin.index)) {
        depth += 1;
      }
      searchPos = nextBegin.index + nextBegin[0].length;
    } else {
      if (!isInComment(commentRanges, nextEnd.index)) {
        depth -= 1;
      }
      searchPos = nextEnd.index + nextEnd[0].length;
      if (depth === 0) {
        return { index: nextEnd.index, end: searchPos };
      }
    }
  }
  return null;
};

const parseListItems = (content: string, commentRanges: Array<[number, number]>) => {
  const items: string[] = [];
  const itemRegex = /\\item\b/g;
  let match = findNextMatch(itemRegex, content, 0, commentRanges);
  while (match) {
    const start = match.index + match[0].length;
    const next = findNextMatch(itemRegex, content, start, commentRanges);
    const end = next ? next.index : content.length;
    const itemText = content.slice(start, end).trim();
    if (itemText) {
      items.push(itemText);
    }
    if (!next) {
      break;
    }
    match = next;
  }
  return items.length ? items : null;
};

export const parseBlocks = (content: string) => {
  const commentRanges = buildCommentRanges(content);
  const blocksParsed: BlockEntry[] = [];
  let pos = 0;

  const headingRegex = new RegExp(`\\\\(${HEADING_COMMANDS.join("|")})\\*?`, "g");
  const beginRegex = /\\begin\{([^}]+)\}/g;
  const tocRegex = /\\tableofcontents/g;
  const pageBreakRegex = /\\(newpage|clearpage)(?![a-zA-Z])/g;
  const maketitleRegex = /\\maketitle(?![a-zA-Z])/g;
  const columnRegex = /\\columnbreak(?![a-zA-Z])/g;
  const structuralRegex = /\\(listoffigures|listoftables|appendix|bibliography|printbibliography)(?![a-zA-Z])/g;
  const displayMathRegex = /\\\[([\s\S]*?)\\\]/g;
  const doubleDollarRegex = /\$\$([\s\S]*?)\$\$/g;

  while (pos < content.length) {
    const headingMatch = findNextMatch(headingRegex, content, pos, commentRanges);
    const envMatch = findNextMatch(beginRegex, content, pos, commentRanges);
    const tocMatch = findNextMatch(tocRegex, content, pos, commentRanges);
    const pageBreakMatch = findNextMatch(pageBreakRegex, content, pos, commentRanges);
    const maketitleMatch = findNextMatch(maketitleRegex, content, pos, commentRanges);
    const columnMatch = findNextMatch(columnRegex, content, pos, commentRanges);
    const structuralMatch = findNextMatch(structuralRegex, content, pos, commentRanges);
    const displayMathMatch = findNextMatch(displayMathRegex, content, pos, commentRanges);
    const doubleDollarMatch = findNextMatch(doubleDollarRegex, content, pos, commentRanges);

    const candidates = [
      headingMatch,
      envMatch,
      tocMatch,
      pageBreakMatch,
      maketitleMatch,
      columnMatch,
      structuralMatch,
      displayMathMatch,
      doubleDollarMatch
    ].filter(Boolean) as RegExpMatchArray[];
    if (candidates.length === 0) {
      const tail = content.slice(pos);
      const trimmedTail = tail.trim();
      
      if (trimmedTail) {
        const snippet = tail;
        // Strip \\ and check for environments
        const cleanedTail = tail.replace(/\\\\[\s\[\]0-9a-z]*/g, ' ').trim();
        const hasEnvironment = /\\begin\{|\\end\{/.test(cleanedTail);
        blocksParsed.push({
          id: buildHash(`${pos}-${snippet.length}`),
          type: hasEnvironment ? "raw" : "paragraph",
          title: hasEnvironment ? "本文" : cleanedTail.slice(0, 30),
          snippet,
          start: pos,
          end: content.length,
          anchor: extractAnchor(snippet),
          fingerprint: buildFingerprint(snippet),
          meta: {},
        });
      }
      break;
    }

    const nextMatch = candidates.reduce((prev, current) =>
      current.index < prev.index ? current : prev,
    );

    if (nextMatch.index > pos) {
      const between = content.slice(pos, nextMatch.index);
      const trimmedBetween = between.trim();
      if (trimmedBetween) {
        // Only mark as raw if it contains \begin{} or \end{} - inline commands and math are fine in paragraphs
        // Also strip \\ from the content as it's not meaningful in a block editor
        const cleanedBetween = between.replace(/\\\\[\s\[\]0-9a-z]*/g, ' ').trim();
        const hasEnvironment = /\\begin\{|\\end\{/.test(cleanedBetween);
        blocksParsed.push({
          id: buildHash(`${pos}-${between.length}`),
          type: hasEnvironment ? "raw" : "paragraph",
          title: hasEnvironment ? "本文" : cleanedBetween.slice(0, 30),
          snippet: between,
          start: pos,
          end: nextMatch.index,
          anchor: extractAnchor(between),
          fingerprint: buildFingerprint(between),
          meta: {},
        });
      }
      pos = nextMatch.index;
    }

    if (headingMatch && nextMatch === headingMatch) {
      // ... (heading handling same as before)
      const command = headingMatch[1];
      const afterCommand = headingMatch.index + headingMatch[0].length;
      let cursor = skipWhitespace(content, afterCommand);
      if (content[cursor] === "[") {
        const group = readGroup(content, cursor, "[", "]");
        if (group) {
          cursor = group.end;
        }
      }
      cursor = skipWhitespace(content, cursor);
      const titleGroup = readGroup(content, cursor, "{", "}");
      if (!titleGroup) {
        pos = headingMatch.index + headingMatch[0].length;
        continue;
      }
      const snippet = content.slice(headingMatch.index, titleGroup.end);
      const title = titleGroup.content.trim();
      const titleStart = cursor + 1 - headingMatch.index;
      const titleEnd = titleStart + titleGroup.content.length;
      blocksParsed.push({
        id: buildHash(`${headingMatch.index}-${snippet.length}`),
        type: "heading",
        title: title || "見出し",
        snippet,
        start: headingMatch.index,
        end: titleGroup.end,
        anchor: extractAnchor(snippet),
        fingerprint: buildFingerprint(snippet),
        meta: {
          headingCommand: command,
          titleStart,
          titleEnd,
        },
        parsed: { title },
      });
      pos = titleGroup.end;
      continue;
    }

    if (envMatch && nextMatch === envMatch) {
        // ... (env logic mostly same, just checking simple pass-through)
      const envName = envMatch[1];
      const beginIndex = envMatch.index;
      let cursor = skipWhitespace(content, beginIndex + envMatch[0].length);
      let optionalArg: string | undefined;
      // ... (parsing args)
      if (content[cursor] === "[") {
        const group = readGroup(content, cursor, "[", "]");
        if (group) {
          optionalArg = group.content.trim();
          cursor = group.end;
        }
      } else if (content[cursor] === "{") {
        const group = readGroup(content, cursor, "{", "}");
        if (group) {
          optionalArg = group.content.trim();
          cursor = group.end;
        }
      }
      cursor = skipWhitespace(content, cursor);

      const endMatch = findMatchingEnd(content, envName, cursor, commentRanges);
      if (!endMatch) {
        pos = beginIndex + envMatch[0].length;
        continue;
      }
      const snippet = content.slice(beginIndex, endMatch.end);
      const innerStart = cursor - beginIndex;
      const innerEnd = endMatch.index - beginIndex;
      const inner = content.slice(cursor, endMatch.index);
      const indentMatch = content.slice(beginIndex).match(/^[\t ]*/);
      const indent = indentMatch ? indentMatch[0] : "";

      let type: BlockType = "raw";
      const meta: BlockMeta = {
        envName,
        innerStart,
        innerEnd,
        indent,
        optionalArg,
      };
      const parsed: BlockParsed = {};

      if (MATH_ENVS.has(envName)) {
        type = "mathBlock";
        parsed.body = inner.trim();
      } else if (LIST_ENVS.has(envName)) {
        type = "list";
        const items = parseListItems(inner, buildCommentRanges(inner));
        parsed.items = items ?? undefined;
        meta.listType = envName;
        meta.safeStructured = !!items;
      } else if (envName === "figure") {
        type = "figure";
        const includeMatch = inner.match(/\\includegraphics(?:\[([^\]]*)\])?\{([^}]+)\}/);
        if (includeMatch) {
          const widthMatch = includeMatch[1]?.match(/width\s*=\s*([^,\]]+)/);
          parsed.figure = {
            imagePath: includeMatch[2]?.trim() ?? "",
            width: widthMatch?.[1]?.trim(),
            caption: inner.match(/\\caption\{([^}]+)\}/)?.[1]?.trim(),
            label: inner.match(/\\label\{([^}]+)\}/)?.[1]?.trim(),
            placement: content
              .slice(beginIndex, cursor)
              .match(/\\begin\{figure\}\[([^\]]+)\]/)?.[1],
          };
          meta.safeStructured = true;
        } else {
          meta.safeStructured = false;
        }
      } else if (envName === "table") {
        type = "table";
        const tabularMatch = inner.match(/\\begin\{tabular\}\{([^}]*)\}([\s\S]*?)\\end\{tabular\}/);
        if (tabularMatch) {
          parsed.table = {
            alignment: tabularMatch[1] ?? "",
            body: tabularMatch[2]?.trim() ?? "",
            caption: inner.match(/\\caption\{([^}]+)\}/)?.[1]?.trim(),
            label: inner.match(/\\label\{([^}]+)\}/)?.[1]?.trim(),
          };
          meta.safeStructured = true;
        } else {
          meta.safeStructured = false;
        }
      } else if (CODE_ENVS.has(envName)) {
        type = "code";
        parsed.body = inner;
      } else if (envName === "abstract") {
        type = "abstract";
        parsed.body = inner.trim();
      } else if (SLIDE_ENVS.has(envName)) {
        type = "slideFrame";
        parsed.title = optionalArg;
        parsed.body = inner.trim();
        meta.safeStructured = true;
      } else if (THEOREM_ENVS.has(envName)) {
        type = "mathEnv";
        parsed.title = optionalArg;
        parsed.body = inner.trim();
        meta.safeStructured = true;
      } else {
        type = "raw";
      }

      const title =
        parsed.title ||
        (type === "mathBlock" ? envName : null) ||
        (type === "figure" ? parsed.figure?.caption : null) ||
        (type === "table" ? parsed.table?.caption : null) ||
        envName;

      blocksParsed.push({
        id: buildHash(`${beginIndex}-${snippet.length}`),
        type,
        title: (title || envName || "ブロック").trim(),
        snippet,
        start: beginIndex,
        end: endMatch.end,
        anchor: extractAnchor(snippet),
        fingerprint: buildFingerprint(snippet),
        meta,
        parsed,
      });
      pos = endMatch.end;
      continue;
    }

    if (tocMatch && nextMatch === tocMatch) {
      const snippet = tocMatch[0];
      blocksParsed.push({
        id: buildHash(`${tocMatch.index}-${snippet.length}`),
        type: "toc",
        title: "\\tableofcontents",
        snippet,
        start: tocMatch.index,
        end: tocMatch.index + snippet.length,
        anchor: extractAnchor(snippet),
        fingerprint: buildFingerprint(snippet),
        meta: {},
      });
      pos = tocMatch.index + snippet.length;
      continue;
    }

    if (pageBreakMatch && nextMatch === pageBreakMatch) {
      const snippet = pageBreakMatch[0];
      blocksParsed.push({
        id: buildHash(`${pageBreakMatch.index}-${snippet.length}`),
        type: "pageBreak",
        title: "改ページ",
        snippet,
        start: pageBreakMatch.index,
        end: pageBreakMatch.index + snippet.length,
        anchor: extractAnchor(snippet),
        fingerprint: buildFingerprint(snippet),
        meta: { envName: pageBreakMatch[1] },
      });
      pos = pageBreakMatch.index + snippet.length;
      continue;
    }

    if (maketitleMatch && nextMatch === maketitleMatch) {
      const snippet = maketitleMatch[0];
      blocksParsed.push({
        id: buildHash(`${maketitleMatch.index}-${snippet.length}`),
        type: "maketitle",
        title: "タイトルページ",
        snippet,
        start: maketitleMatch.index,
        end: maketitleMatch.index + snippet.length,
        anchor: extractAnchor(snippet),
        fingerprint: buildFingerprint(snippet),
        meta: {},
      });
      pos = maketitleMatch.index + snippet.length;
      continue;
    }

    if (columnMatch && nextMatch === columnMatch) {
      const columnGroup = readGroup(content, columnMatch.index + columnMatch[0].length, "{", "}");
      const end = columnGroup ? columnGroup.end : columnMatch.index + columnMatch[0].length;
      const snippet = content.slice(columnMatch.index, end);
      blocksParsed.push({
        id: buildHash(`${columnMatch.index}-${snippet.length}`),
        type: "columnBreak",
        title: "\\column",
        snippet,
        start: columnMatch.index,
        end,
        anchor: extractAnchor(snippet),
        fingerprint: buildFingerprint(snippet),
        meta: {},
      });
      pos = end;
      continue;
    }

    if (structuralMatch && nextMatch === structuralMatch) {
      // ... (existing structural match logic)
      const typeStr = structuralMatch[1];
      const snippet = structuralMatch[0];
      let type: BlockType = "raw";
      let meta: BlockMeta = {};
      
      if (typeStr === "listoffigures") type = "listoffigures";
      else if (typeStr === "listoftables") type = "listoftables";
      else if (typeStr === "appendix") type = "appendix";
      else if (typeStr === "bibliography" || typeStr === "printbibliography") {
        type = "bibliography";
        // Handle bibliography file arg if present
        let cursor = skipWhitespace(content, structuralMatch.index + snippet.length);
        if (content[cursor] === "{") {
           const group = readGroup(content, cursor, "{", "}");
           if (group) {
             meta.optionalArg = group.content; // Use optionalArg for filename
             pos = group.end; // Advance position past args
             // Rebuild snippet to include args? Yes, otherwise content is lost.
             const fullSnippet = content.slice(structuralMatch.index, group.end);
             blocksParsed.push({
                id: buildHash(`${structuralMatch.index}-${fullSnippet.length}`),
                type,
                title: typeStr,
                snippet: fullSnippet,
                start: structuralMatch.index,
                end: group.end,
                anchor: extractAnchor(fullSnippet),
                fingerprint: buildFingerprint(fullSnippet),
                meta, 
             });
             continue;
           }
        }
      }

      // Default structural handling (no args or unhandled)
      blocksParsed.push({
        id: buildHash(`${structuralMatch.index}-${snippet.length}`),
        type,
        title: typeStr,
        snippet,
        start: structuralMatch.index,
        end: structuralMatch.index + snippet.length,
        anchor: extractAnchor(snippet),
        fingerprint: buildFingerprint(snippet),
        meta,
      });
      pos = structuralMatch.index + snippet.length;
      continue;
    }

    if (displayMathMatch && nextMatch === displayMathMatch) {
      const snippet = displayMathMatch[0];
      const inner = displayMathMatch[1];
      blocksParsed.push({
        id: buildHash(`${displayMathMatch.index}-${snippet.length}`),
        type: "mathBlock",
        title: "数式",
        snippet,
        start: displayMathMatch.index,
        end: displayMathMatch.index + snippet.length,
        anchor: extractAnchor(snippet),
        fingerprint: buildFingerprint(snippet),
        meta: {},
        parsed: { body: inner.trim() }
      });
      pos = displayMathMatch.index + snippet.length;
      continue;
    }

    if (doubleDollarMatch && nextMatch === doubleDollarMatch) {
      const snippet = doubleDollarMatch[0];
      const inner = doubleDollarMatch[1];
      blocksParsed.push({
        id: buildHash(`${doubleDollarMatch.index}-${snippet.length}`),
        type: "mathBlock",
        title: "数式",
        snippet,
        start: doubleDollarMatch.index,
        end: doubleDollarMatch.index + snippet.length,
        anchor: extractAnchor(snippet),
        fingerprint: buildFingerprint(snippet),
        meta: {},
        parsed: { body: inner.trim() }
      });
      pos = doubleDollarMatch.index + snippet.length;
      continue;
    }

    pos += 1;
  }

  return blocksParsed;
};



const findNextSpecial = (text: string, start: number) => {
  const tokens = ["$", "\\(", "\\ce{", "\\text", "\\textbf", "\\textit", "\\texttt", "\\underline", "\\emph"];
  let next = -1;
  for (const token of tokens) {
    const index = text.indexOf(token, start);
    if (index !== -1 && (next === -1 || index < next)) {
      next = index;
    }
  }
  return next;
};

const readTeXGroup = (text: string, start: number) => {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          content: text.substring(start + 1, i),
          nextIndex: i + 1,
        };
      }
    }
  }
  return null;
};

const parseInlines = (text: string, depth = 0): InlineContent[] => {
  if (depth > 5) {
    return [{ type: "text", content: text }];
  }

  const result: InlineContent[] = [];
  let i = 0;
  let iterations = 0;
  const maxIterations = Math.min(text.length * 2, 5000);

  const pushText = (content: string, formatting?: InlineText["formatting"]) => {
    if (!content) return;
    result.push({ id: nanoid(), type: "text", content, formatting });
  };

  while (i < text.length && iterations < maxIterations) {
    iterations += 1;
    const startI = i;

    // Check for \\ line break - parse as special character ⏎ (simple text-based approach)
    // This avoids inline void element complexity and cursor issues
    if (text.startsWith("\\\\", i)) {
      // Also handle \\[1em] style spacing - consume optional spacing arg
      let endPos = i + 2;
      if (text[endPos] === "[") {
        const closeBracket = text.indexOf("]", endPos);
        if (closeBracket > endPos) {
          endPos = closeBracket + 1;
        }
      }
      // Use ⏎ (U+23CE) as LaTeX line break marker - simple text, no cursor issues
      result.push({ id: nanoid(), type: "text", content: "⏎" });
      i = endPos;
      // Skip a single optional newline immediately following \\ to prevent double-spacing
      if (text[i] === "\n") {
        i++;
      } else if (text[i] === "\r" && text[i + 1] === "\n") {
        i += 2;
      }
      continue;
    }

    if (text[i] === "$") {
      const end = text.indexOf("$", i + 1);
      if (end > i) {
        const latex = text.substring(i + 1, end);
        result.push({ id: nanoid(), type: "math", latex });
        i = end + 1;
        continue;
      }
    }

    if (text.startsWith("\\(", i)) {
      const end = text.indexOf("\\)", i + 2);
      if (end > i) {
        const latex = text.substring(i + 2, end);
        result.push({ id: nanoid(), type: "math", latex });
        i = end + 2;
        continue;
      }
    }

    if (text.startsWith("\\ce{", i)) {
      const group = readTeXGroup(text, i + 3);
      if (group) {
        const latex = `\\ce{${group.content}}`;
        result.push({ id: nanoid(), type: "math", latex });
        i = group.nextIndex;
        continue;
      }
    }

    const formatMatch = text.substring(i).match(/^\\([a-zA-Z]+)\{/);
    if (formatMatch && INLINE_FORMATTERS[formatMatch[1]]) {
      const formatter = INLINE_FORMATTERS[formatMatch[1]];
      const group = readTeXGroup(text, i + formatMatch[0].length - 1);
      if (group) {
        const inner = parseInlines(group.content, depth + 1).map((inline) =>
          inline.type === "text"
            ? {
                ...inline,
                formatting: { ...(inline.formatting || {}), [formatter]: true },
              }
            : inline,
        );
        result.push(...inner);
        i = group.nextIndex;
        continue;
      }
    }

    const nextSpecial = findNextSpecial(text, i);
    const chunk = text.substring(i, nextSpecial === -1 ? text.length : nextSpecial);
    pushText(chunk);
    if (nextSpecial === -1) break;
    i = nextSpecial;

    if (i === startI) {
      i += 1;
    }
  }

  return result.length ? result : [{ type: "text", content: "" }];
};

const parseTableRows = (body: string): string[][] => {
  const rows: string[][] = [];
  const cleaned = body.replace(/\\hline/g, "").trim();
  const rawRows = cleaned.split(/\\\\/);
  for (const rawRow of rawRows) {
    const row = rawRow.trim();
    if (!row) continue;
    const cells = row.split("&").map((cell) => cell.trim());
    rows.push(cells);
  }
  return rows.length ? rows : [[""]];
};

const parseMetadata = (content: string) => {
  const beginDocMatch = content.match(/\\begin\{document\}/);
  const endDocMatch = content.match(/\\end\{document\}/);

  if (!beginDocMatch || !endDocMatch) {
    return {
      preamble: "",
      metadata: { documentClass: "article" },
    };
  }

  const preamble = content.substring(0, beginDocMatch.index ?? 0);
  const bodyStart = (beginDocMatch.index ?? 0) + beginDocMatch[0].length;
  const body = content.substring(bodyStart, endDocMatch.index ?? content.length);

  const documentClassMatch = preamble.match(/\\documentclass(?:\[.*?\])?\{(.*?)\}/);
  let titleMatch = preamble.match(/\\title\{(.*?)\}/);
  let authorMatch = preamble.match(/\\author\{(.*?)\}/);
  let dateMatch = preamble.match(/\\date\{(.*?)\}/);

  if (!titleMatch) {
    titleMatch = body.match(/\\title\{(.*?)\}/);
  }
  if (!authorMatch) {
    authorMatch = body.match(/\\author\{(.*?)\}/);
  }
  if (!dateMatch) {
    dateMatch = body.match(/\\date\{(.*?)\}/);
  }

  let dateValue = dateMatch?.[1];
  if (dateValue === "\\today") {
    const now = new Date();
    dateValue = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  }

  return {
    preamble: preamble.trim(),
    metadata: {
      documentClass: documentClassMatch?.[1] ?? "article",
      title: titleMatch?.[1],
      author: authorMatch?.[1],
      date: dateValue,
    },
  };
};

const entryToDocumentBlock = (entry: BlockEntry): DocumentBlock => {
  switch (entry.type) {
    case "heading": {
      const command = entry.meta.headingCommand as HeadingContent['command'] | undefined;
      const level =
        (command && HEADING_LEVELS[command]) || 1;
      return {
        id: entry.id,
        type: "heading",
        content: {
          level,
          title: entry.parsed?.title ?? entry.title ?? "",
          label: entry.anchor.kind === "label" ? entry.anchor.value : undefined,
          command,
        },
      };
    }
    case "paragraph": {
      return {
        id: entry.id,
        type: "paragraph",
        content: {
          inlines: parseInlines(entry.snippet.trim()),
        },
      };
    }
    case "list": {
      const listType = (entry.meta.listType || "itemize") as ListType;
      const items = (entry.parsed?.items ?? [""]).map((item) => ({
        id: nanoid(),
        content: parseInlines(item),
      }));
      return {
        id: entry.id,
        type: "list",
        content: {
          listType,
          items,
        },
      };
    }
    case "mathBlock": {
      const envName = entry.meta.envName ?? "equation";
      return {
        id: entry.id,
        type: "mathBlock",
        content: {
          latex: entry.parsed?.body ?? "",
          environment: envName.replace("*", "") as "equation" | "align" | "gather" | "multline",
          numbered: !envName.endsWith("*"),
          label: entry.anchor.kind === "label" ? entry.anchor.value : undefined,
        },
      };
    }
    case "mathEnv": {
      const envType = (entry.meta.envName || "theorem") as MathEnvType;
      const innerBlocks = entry.parsed?.body
        ? parseBlocks(entry.parsed.body).map(entryToDocumentBlock)
        : [];
      return {
        id: entry.id,
        type: "mathEnv",
        content: {
          envType,
          title: entry.parsed?.title,
          children: innerBlocks,
        },
      };
    }
    case "figure": {
      return {
        id: entry.id,
        type: "figure",
        content: {
          imagePath: entry.parsed?.figure?.imagePath ?? "",
          caption: entry.parsed?.figure?.caption,
          label: entry.parsed?.figure?.label,
          width: entry.parsed?.figure?.width,
          placement: entry.parsed?.figure?.placement,
        },
      };
    }
    case "table": {
      const table = entry.parsed?.table;
      const rows = table ? parseTableRows(table.body) : [[""]];
      const alignment = table?.alignment ?? "";
      const content: TableContent = {
        rows,
        caption: table?.caption,
        label: table?.label,
        alignment,
      };
      return {
        id: entry.id,
        type: "table",
        content,
      };
    }
    case "code": {
      return {
        id: entry.id,
        type: "code",
        content: {
          code: entry.parsed?.body ?? "",
        },
      };
    }
    case "abstract": {
      return {
        id: entry.id,
        type: "abstract",
        content: {
          text: entry.parsed?.body ?? "",
        },
      };
    }
    case "toc": {
      return {
        id: entry.id,
        type: "toc",
        content: {},
      };
    }
    case "slideFrame": {
      return {
        id: entry.id,
        type: "slideFrame",
        content: {
          title: entry.parsed?.title,
          blocks: entry.parsed?.body
            ? parseBlocks(entry.parsed.body).map(entryToDocumentBlock)
            : [],
        },
      };
    }
    case "columnBreak": {
      return {
        id: entry.id,
        type: "columnBreak",
        content: {
          width: entry.parsed?.title,
        },
      };
    }
    case "pageBreak": {
      return {
        id: entry.id,
        type: "pageBreak",
        content: {
          type: (entry.meta.envName === "clearpage" ? "clearpage" : "newpage") as "newpage" | "clearpage",
        },
      };
    }
    case "maketitle": {
      return {
        id: entry.id,
        type: "maketitle",
        content: {},
      };
    }
    case "listoffigures": {
       return { id: entry.id, type: "listoffigures", content: {} };
    }
    case "listoftables": {
       return { id: entry.id, type: "listoftables", content: {} };
    }
    case "appendix": {
       return { id: entry.id, type: "appendix", content: {} };
    }
    case "bibliography": {
       return { id: entry.id, type: "bibliography", content: { file: entry.meta.optionalArg } };
    }
    default: {
      return {
        id: entry.id,
        type: "raw",
        content: {
          latex: entry.snippet,
        },
      };
    }
  }
};

export const buildDocumentFromEntries = (content: string, entries: BlockEntry[]): Document => {
  const { metadata, preamble } = parseMetadata(content);
  const blocks = entries.map(entryToDocumentBlock);
  return {
    metadata: {
      ...metadata,
      preamble,
    },
    blocks,
    layoutMode: metadata.documentClass === "beamer" ? "slides" : "flow",
  };
};

export const parseContentToDocument = (content: string) => {
  const beginDocMatch = content.match(/\\begin\{document\}/);
  const endDocMatch = content.match(/\\end\{document\}/);

  let entries: BlockEntry[] = [];
  if (
    beginDocMatch &&
    endDocMatch &&
    beginDocMatch.index !== undefined &&
    endDocMatch.index !== undefined &&
    endDocMatch.index > beginDocMatch.index
  ) {
    const bodyStart = beginDocMatch.index + beginDocMatch[0].length;
    const body = content.slice(bodyStart, endDocMatch.index);
    entries = parseBlocks(body).map((entry) => ({
      ...entry,
      start: entry.start + bodyStart,
      end: entry.end + bodyStart,
    }));
  } else {
    entries = parseBlocks(content);
  }
  const document = buildDocumentFromEntries(content, entries);
  return { entries, document };
};

import { getEnvBaseName, normalizeEnvName } from "../env-registry.js";
import type { BlockContext } from "./types.js";
import { isEscapedAt } from "./tex-utils.js";

const MATRIX_ENV_NAMES = new Set([
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
]);

const OPTIONAL_BRACKET_ENVS = new Set([
  "aligned",
  "alignedat",
  "gathered",
  "multlined",
  "empheq",
  "mathpar",
  "mathparpagebreakable",
]);

const REQUIRED_ENV_ARGS: Record<string, number> = {
  alignat: 1,
  xalignat: 1,
  xxalignat: 1,
  alignedat: 1,
  empheq: 1,
  numcases: 1,
  subnumcases: 1,
  array: 1,
  subarray: 1,
  IEEEeqnarray: 1,
  IEEEeqnarraybox: 1,
  darray: 1,
};

const skipEnvWhitespace = (text: string, index: number) => {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }
  return cursor;
};

const readDelimitedArg = (
  text: string,
  startIndex: number,
  openChar: string,
  closeChar: string
) => {
  if (text[startIndex] !== openChar) {
    return null;
  }
  let depth = 0;
  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === openChar && !isEscapedAt(text, i)) {
      depth += 1;
    } else if (char === closeChar && !isEscapedAt(text, i)) {
      depth -= 1;
      if (depth === 0) {
        return { end: i + 1 };
      }
    }
  }
  return null;
};

const consumeEnvArguments = (snippet: string, startIndex: number, envName: string) => {
  const base = getEnvBaseName(envName);
  let cursor = skipEnvWhitespace(snippet, startIndex);
  const allowOptional =
    OPTIONAL_BRACKET_ENVS.has(base) || (MATRIX_ENV_NAMES.has(base) && envName.endsWith("*"));
  if (allowOptional && snippet[cursor] === "[") {
    const optionalArg = readDelimitedArg(snippet, cursor, "[", "]");
    if (optionalArg) {
      cursor = skipEnvWhitespace(snippet, optionalArg.end);
    }
  }
  let requiredCount = REQUIRED_ENV_ARGS[base] ?? 0;
  for (let i = 0; i < requiredCount; i += 1) {
    cursor = skipEnvWhitespace(snippet, cursor);
    if (snippet[cursor] !== "{") {
      break;
    }
    const requiredArg = readDelimitedArg(snippet, cursor, "{", "}");
    if (!requiredArg) {
      break;
    }
    cursor = requiredArg.end;
  }
  return skipEnvWhitespace(snippet, cursor);
};

const splitDisplayWrapper = (snippet: string, open: string, close: string) => {
  const start = open.length;
  const end = snippet.length - close.length;
  if (end < start) {
    return { prefix: open, suffix: close };
  }
  const inner = snippet.slice(start, end);
  let prefix = open;
  let suffix = close;
  const leadingMatch = inner.match(/^\s+/);
  const leading = leadingMatch && leadingMatch[0].includes("\n") ? leadingMatch[0] : "";
  if (leading) {
    prefix += leading;
  }
  const trailingMatch = inner.match(/\s+$/);
  const trailing = trailingMatch && trailingMatch[0].includes("\n") ? trailingMatch[0] : "";
  if (trailing && leading.length + trailing.length <= inner.length) {
    suffix = trailing + suffix;
  }
  return { prefix, suffix };
};

export const parseBlockContext = (
  snippet: string
): BlockContext => {
  // 1. Double Dollar (Display)
  const ddMatch = snippet.match(/^(\$\$)([\s\S]*?)(\$\$)$/);
  if (ddMatch) {
    const { prefix, suffix } = splitDisplayWrapper(snippet, ddMatch[1], ddMatch[3]);
    return {
      type: "math",
      originalSnippet: snippet,
      prefix,
      suffix,
    };
  }

  // 2. Bracket Display (\[ ... \])
  const bdMatch = snippet.match(/^(\\\[)([\s\S]*?)(\\\])$/);
  if (bdMatch) {
    const { prefix, suffix } = splitDisplayWrapper(snippet, bdMatch[1], bdMatch[3]);
    return {
      type: "math",
      originalSnippet: snippet,
      prefix,
      suffix,
    };
  }

  // 3. Inline ($ ... $)
  const inlineParenMatch = snippet.match(/^(\\\()([\s\S]*?)(\\\))$/);
  if (inlineParenMatch) {
    return {
      type: "math",
      originalSnippet: snippet,
      prefix: inlineParenMatch[1],
      suffix: inlineParenMatch[3],
    };
  }
  const inlineMatch = snippet.match(/^(\$)([\s\S]*?)(\$)$/);
  if (inlineMatch) {
    return {
      type: "math",
      originalSnippet: snippet,
      prefix: inlineMatch[1],
      suffix: inlineMatch[3],
    };
  }

  // 4. Environments (\begin{name} ... \end{name})
  const envBeginMatch = snippet.match(/^\\begin\{([^}]+)\}/);
  if (envBeginMatch) {
    const envName = normalizeEnvName(envBeginMatch[1]);
    const endToken = `\\end{${envName}}`;
    if (snippet.endsWith(endToken)) {
      const prefixEnd = consumeEnvArguments(snippet, envBeginMatch[0].length, envName);
      const prefix = snippet.slice(0, prefixEnd);
      const suffix = endToken;
      return {
        type: "math",
        originalSnippet: snippet,
        prefix,
        suffix,
        envName,
      };
    }
  }

  // Default: Treat whole thing as content if no wrapper detected
  // This shouldn't happen often if detection works, but safe fallback
  return {
    type: "math",
    originalSnippet: snippet,
    prefix: "",
    suffix: "",
    envName: undefined,
  };
};

export const getInnerContent = (
  context: BlockContext,
  options?: { trim?: boolean }
): string => {
  const start = context.prefix.length;
  const end = context.originalSnippet.length - context.suffix.length;
  const content = context.originalSnippet.slice(start, end);
  return options?.trim === false ? content : content.trim();
};

export const reconstructionBlock = (context: BlockContext, content: string): string => {
  const originalInner = getInnerContent(context);
  const newInner = content.trim();
  if (originalInner === newInner) {
    return context.originalSnippet;
  }
  return context.prefix + content + context.suffix;
};

const ALIGNED_ENV_BEGIN = "\\begin{aligned}";
const ALIGNED_ENV_END = "\\end{aligned}";
const LEGACY_AUX_COMMAND_MAP: Record<string, string> = {
  txlbl: "label",
  txtag: "tag",
  txtgs: "tag*",
  txntg: "notag",
  txnnum: "nonumber",
  txeqr: "eqref",
  txref: "ref",
  txpgrf: "pageref",
  txatrf: "autoref",
  txintr: "intertext",
  txshintr: "shortintertext",
};
const LEGACY_AUX_COMMAND_RE =
  /\\(txlbl|txtag|txtgs|txntg|txnnum|txeqr|txref|txpgrf|txatrf|txintr|txshintr)\b/g;
const AUX_COMMAND_LBRACE_ARG_RE =
  /\\(label|tag\*?|eqref|ref|pageref|autoref|intertext|shortintertext)\{\s*\\lbrace([\s\S]*?)\\rbrace\s*\}/g;
const MATHLIVE_PLACEHOLDER_RE = /\\placeholder(?:\[[^\]]*\])?\{(?:[^{}]|\\.)*\}/g;

/** MathLive placeholders are an editing affordance, not a TeX command.
 * Leaving a new matrix cell empty must save as an ordinary empty cell. */
export const stripMathLivePlaceholders = (value: string) =>
  value.replace(MATHLIVE_PLACEHOLDER_RE, "");

const isEscapedAt = (text: string, index: number) => {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    count += 1;
  }
  return count % 2 === 1;
};

const hasUnescapedAmpersand = (text: string) => {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "&" && !isEscapedAt(text, i)) {
      return true;
    }
  }
  return false;
};

const hasLineBreak = (text: string) => {
  for (let i = 0; i < text.length - 1; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "\\" && !isEscapedAt(text, i)) {
      return true;
    }
  }
  return false;
};

export const shouldWrapAligned = (text: string) => {
  if (!text) {
    return false;
  }
  if (text.includes("\\begin{") || text.includes("\\end{")) {
    return false;
  }
  return hasUnescapedAmpersand(text) || hasLineBreak(text);
};

export const wrapAligned = (text: string) => `${ALIGNED_ENV_BEGIN}\n${text}\n${ALIGNED_ENV_END}`;

export const unwrapAligned = (text: string) => {
  const start = text.indexOf(ALIGNED_ENV_BEGIN);
  const end = text.lastIndexOf(ALIGNED_ENV_END);
  if (start === -1 || end === -1) {
    return { value: text, didUnwrap: false };
  }
  const before = text.slice(0, start).trim();
  const after = text.slice(end + ALIGNED_ENV_END.length).trim();
  if (before || after) {
    return { value: text, didUnwrap: false };
  }
  let inner = text.slice(start + ALIGNED_ENV_BEGIN.length, end);
  if (inner.startsWith("\n")) {
    inner = inner.slice(1);
  }
  if (inner.endsWith("\n")) {
    inner = inner.slice(0, -1);
  }
  return { value: inner, didUnwrap: true };
};

const splitAlignedRows = (text: string) => {
  const rows: string[] = [];
  let current = "";
  let envDepth = 0;
  for (let i = 0; i < text.length; i += 1) {
    // Track \begin{...} / \end{...} nesting so we don't split on \\ inside
    // sub-environments (e.g. matrices nested in aligned rows).
    if (text.startsWith("\\begin{", i) && !isEscapedAt(text, i)) {
      envDepth += 1;
    } else if (text.startsWith("\\end{", i) && !isEscapedAt(text, i)) {
      envDepth = Math.max(0, envDepth - 1);
    }
    if (
      envDepth === 0 &&
      text[i] === "\\" &&
      text[i + 1] === "\\" &&
      !isEscapedAt(text, i)
    ) {
      rows.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += text[i];
  }
  rows.push(current);
  return rows;
};

const isEmptyAlignedRow = (row: string) => {
  const cleaned = stripMathLivePlaceholders(row).replace(/\s+/g, "");
  return cleaned === "" || cleaned === "&";
};

export const stripEmptyAlignedRows = (text: string) => {
  const rows = splitAlignedRows(text);
  if (rows.length <= 1) {
    return text;
  }
  // Only strip trailing empty rows; preserve structure and leading/middle rows
  let lastNonEmpty = rows.length - 1;
  while (lastNonEmpty > 0 && isEmptyAlignedRow(rows[lastNonEmpty])) {
    lastNonEmpty -= 1;
  }
  if (lastNonEmpty === rows.length - 1) {
    return text;
  }
  return rows.slice(0, lastNonEmpty + 1).join("\\\\");
};

const restoreLegacyAlignedProxyEnvs = (value: string) =>
  value.replace(/\\begin\{aligned\}([\s\S]*?)\\end\{aligned\}/g, (match, body: string) => {
    if (body.includes("\\txalnat")) {
      const cleaned = body.replace(/\\txalnat/g, "").trim();
      return `\\begin{alignat*}{2}${cleaned}\\end{alignat*}`;
    }
    if (body.includes("\\txflaln")) {
      const cleaned = body.replace(/\\txflaln/g, "").trim();
      return `\\begin{flalign*}${cleaned}\\end{flalign*}`;
    }
    if (body.includes("\\txarrcf")) {
      const cleaned = body.replace(/\\txarrcf/g, "").trim();
      return `\\begin{array}{@{}rc|l@{}}${cleaned}\\end{array}`;
    }
    return match;
  });

const findBalancedBraceEnd = (text: string, start: number) => {
  if (text[start] !== "{") {
    return -1;
  }
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{" && !isEscapedAt(text, i)) {
      depth += 1;
      continue;
    }
    if (ch === "}" && !isEscapedAt(text, i)) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
};

const replaceCommandWithBraceArgs = (
  value: string,
  command: string,
  argCount: number,
  mapper: (args: string[]) => string
) => {
  const needle = `\\${command}`;
  if (!value.includes(needle)) {
    return value;
  }
  let output = "";
  for (let i = 0; i < value.length; ) {
    if (!value.startsWith(needle, i)) {
      output += value[i];
      i += 1;
      continue;
    }
    let cursor = i + needle.length;
    const args: string[] = [];
    let ok = true;
    for (let argIndex = 0; argIndex < argCount; argIndex += 1) {
      while (cursor < value.length && /\s/.test(value[cursor] ?? "")) {
        cursor += 1;
      }
      if (value[cursor] !== "{") {
        ok = false;
        break;
      }
      const end = findBalancedBraceEnd(value, cursor);
      if (end < 0) {
        ok = false;
        break;
      }
      args.push(value.slice(cursor + 1, end));
      cursor = end + 1;
    }
    if (!ok) {
      output += value[i];
      i += 1;
      continue;
    }
    output += mapper(args);
    i = cursor;
  }
  return output;
};

const restoreLegacyArrayProxyEnvs = (value: string) =>
  replaceCommandWithBraceArgs(value, "txarrayc", 2, (args) => {
    const colspec = args[0] ?? "";
    const body = args[1] ?? "";
    return `\\begin{array}{${colspec}}${body}\\end{array}`;
  });

const normalizeLegacyAuxCommands = (value: string) =>
  value.replace(LEGACY_AUX_COMMAND_RE, (_full, command: string) => {
    const mapped = LEGACY_AUX_COMMAND_MAP[command] ?? command;
    return `\\${mapped}`;
  });

const normalizeAuxCommandLbraceArguments = (value: string) =>
  value.replace(AUX_COMMAND_LBRACE_ARG_RE, (_full, command: string, argument: string) => {
    const normalizedArgument = String(argument ?? "").trim();
    return `\\${command}{${normalizedArgument}}`;
  });

export const normalizeLegacyEnvMarkers = (value: string) => {
  if (!value) {
    return value;
  }
  let normalized = value;
  if (normalized.includes("\\tx")) {
    normalized = normalizeLegacyAuxCommands(
      restoreLegacyAlignedProxyEnvs(restoreLegacyArrayProxyEnvs(normalized))
    );
  }
  if (normalized.includes("\\lbrace") && normalized.includes("\\rbrace")) {
    normalized = normalizeAuxCommandLbraceArguments(normalized);
  }
  return normalized;
};

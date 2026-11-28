const { transformOutsideTextBlocks } = require("./strip-text.cjs");

const postProcessLatex = (value) => {
  if (!value) return "";
  const textReg = /(\\(?:operatorname|mathrm|text|mathbf)\s?\*? {.*?})/g;
  const matches = Array.from(value.matchAll(textReg)).map((match) =>
    match[1].replace(/ /g, "")
  );
  let result = value.replace(textReg, () => matches.shift() ?? "");
  const letter = "[a-zA-Z]";
  const noletter = "[\\W_\\^\\d]";
  for (let pass = 0; pass < 10; pass += 1) {
    const prev = result;
    result = result.replace(
      new RegExp(`(?!\\\\ )(${noletter})\\s+?(${noletter})`, "g"),
      "$1$2"
    );
    result = result.replace(
      new RegExp(`(?!\\\\ )(${noletter})\\s+?(${letter})`, "g"),
      "$1$2"
    );
    result = result.replace(
      new RegExp(`(${letter})\\s+?(${noletter})`, "g"),
      "$1$2"
    );
    if (result === prev) {
      break;
    }
  }
  return result;
};

const BARE_LATEX_STRUCTURE_COMMAND_PATTERN =
  /(^|[^\\A-Za-z])(frac|dfrac|tfrac|sqrt|binom|dbinom|tbinom|operatorname)(?=\*?\s*(?:\[[^\]]*\]\s*)?\{)/g;
const BARE_LATEX_OPERATOR_COMMAND_PATTERN =
  /(^|[^\\A-Za-z])(sum|prod|int|oint|lim)(?=$|[^A-Za-z])/g;

const normalizeBareLatexCommands = (value) => {
  if (!value) return value;
  return value
    .replace(BARE_LATEX_STRUCTURE_COMMAND_PATTERN, "$1\\$2")
    .replace(BARE_LATEX_OPERATOR_COMMAND_PATTERN, "$1\\$2");
};

const fixMatrixSeparators = (value) => {
  if (!value) return value;
  return value.replace(
    /\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}/g,
    (match, body) => {
      if (body.includes("&") || body.includes("\\\\")) {
        return match;
      }
      const cells = [];
      let i = 0;
      let valid = true;
      while (i < body.length) {
        const ch = body[i];
        if (ch === "{") {
          let depth = 0;
          const start = i + 1;
          for (; i < body.length; i += 1) {
            const inner = body[i];
            if (inner === "{") depth += 1;
            if (inner === "}") {
              depth -= 1;
              if (depth === 0) {
                cells.push(body.slice(start, i).trim());
                i += 1;
                break;
              }
            }
          }
          if (depth !== 0) {
            valid = false;
            break;
          }
          continue;
        }
        if (!/\s/.test(ch)) {
          const start = i;
          while (i < body.length && !/\s/.test(body[i])) {
            i += 1;
          }
          cells.push(body.slice(start, i).trim());
          continue;
        }
        i += 1;
      }
      if (!valid) {
        return match;
      }
      const filtered = cells.filter((cell) => cell.length > 0);
      if (filtered.length === 0) {
        return match;
      }
      // Try square matrix first
      const size = Math.sqrt(filtered.length);
      const n = Math.round(size);
      if (Number.isFinite(size) && n * n === filtered.length && n >= 2) {
        const rows = [];
        for (let r = 0; r < n; r += 1) {
          const row = filtered.slice(r * n, (r + 1) * n);
          rows.push(row.join("&"));
        }
        return `\\begin{matrix}${rows.join("\\\\")}\\end{matrix}`;
      }
      // Try common non-square layouts (2×N, 3×N, N×2, N×3)
      for (const cols of [2, 3, 4]) {
        if (filtered.length % cols === 0 && filtered.length / cols >= 2) {
          const numRows = filtered.length / cols;
          const rows = [];
          for (let r = 0; r < numRows; r += 1) {
            const row = filtered.slice(r * cols, (r + 1) * cols);
            rows.push(row.join("&"));
          }
          return `\\begin{matrix}${rows.join("\\\\")}\\end{matrix}`;
        }
      }
      return match;
    }
  );
};

const splitMatrixRows = (text) => {
  const rows = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "\\") {
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

const cleanMatrixBody = (body) => {
  if (!body) return "";
  let cleaned = body;
  cleaned = cleaned.replace(/\{\s*([A-Za-z0-9.+\-*/=]{1,3})\s*\}/g, "$1");
  cleaned = cleaned.replace(/\s+/g, "");
  cleaned = cleaned.replace(/\\\\+$/g, "");
  return cleaned;
};

const normalizeMatrixDelimiters = (value) => {
  if (!value) return value;
  const toMatrix = (env) => (_match, body) => {
    const cleaned = body.trim();
    return `\\begin{${env}}${cleaned}\\end{${env}}`;
  };
  let output = value;
  output = output.replace(
    /\\left\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\\right\)/g,
    toMatrix("pmatrix")
  );
  output = output.replace(
    /\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\)/g,
    toMatrix("pmatrix")
  );
  output = output.replace(
    /\\left\[\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\\right\]/g,
    toMatrix("bmatrix")
  );
  output = output.replace(
    /\[\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\]/g,
    toMatrix("bmatrix")
  );
  return output;
};

const simplifyNestedMatrixWrapper = (value) => {
  if (!value) return value;
  const pattern =
    /^\\begin\{(?:bmatrix|matrix)\}([\s\S]*?)\\\\\s*\{?\s*\\begin\{(pmatrix|bmatrix|matrix)\}([\s\S]*?)\\end\{\2\}\s*\}?\s*\\end\{(?:bmatrix|matrix)\}$/;
  const match = value.trim().match(pattern);
  if (!match) {
    return value;
  }
  const outerFirstRow = cleanMatrixBody(match[1]);
  const innerEnv = match[2];
  const innerBodyRaw = match[3];
  const innerBody = cleanMatrixBody(innerBodyRaw);
  const innerRows = splitMatrixRows(innerBody).map((row) => row.trim()).filter(Boolean);
  if (innerRows.length < 2) {
    return value;
  }
  const innerFirstRow = innerRows[0];
  if (!outerFirstRow || !innerFirstRow || outerFirstRow !== innerFirstRow) {
    return value;
  }
  const targetEnv = innerEnv === "pmatrix" ? "pmatrix" : "pmatrix";
  return `\\begin{${targetEnv}}${innerRows.join("\\\\")}\\end{${targetEnv}}`;
};

const repairBrokenFractionParentheses = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(
    /\\frac\{\(([^{}]+)\}\{([^{}]+)\)\}/g,
    "\\left(\\frac{$1}{$2}\\right)"
  );
  output = output.replace(
    /\\frac\{\(([^{}]+)\}\{([^{}]+)\}\)/g,
    "\\left(\\frac{$1}{$2}\\right)"
  );
  output = output.replace(
    /\\frac\{\[([^{}]+)\}\{([^{}]+)\]\}/g,
    "\\left[\\frac{$1}{$2}\\right]"
  );
  output = output.replace(
    /\\frac\{\[([^{}]+)\}\{([^{}]+)\}\]/g,
    "\\left[\\frac{$1}{$2}\\right]"
  );
  return output;
};

const normalizeOperatorNames = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(
    /\\operatorname\*?\{(sin|cos|tan|cot|sec|csc|log|ln|exp|max|min|det|dim|lim)\}/g,
    (match, name, offset, input) => `\\${name}${/[A-Za-z]/.test(input[offset + match.length] ?? "") ? " " : ""}`
  );
  output = output.replace(/\\(ge|le|ne)q(?![a-zA-Z])/g, "\\$1");
  return output;
};

const stripArrayFormattingCommands = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(/\\arraycolsep=[^\\]+/g, "");
  output = output.replace(/\\def\\arraystretch\{[^}]+\}/g, "");
  return output.trim();
};

const normalizeCompactBinom = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(/\\binom([A-Za-z0-9])([A-Za-z0-9])/g, "\\binom{$1}{$2}");
  return output;
};

const normalizeBinomWrappedInMatrix = (value) => {
  if (!value) return value;
  const trimmed = value.trim();
  const wrapped = trimmed.match(
    /^\\begin\{(?:bmatrix|matrix|pmatrix)\}([\s\S]*)\\end\{(?:bmatrix|matrix|pmatrix)\}$/
  );
  if (!wrapped) {
    return value;
  }
  let body = cleanMatrixBody(wrapped[1]);
  if (body.startsWith("{") && body.endsWith("}")) {
    body = body.slice(1, -1).trim();
  }
  const binom = body.match(/^\\binom\{?([A-Za-z0-9])\}?\{?([A-Za-z0-9])\}?$/);
  if (!binom) {
    return value;
  }
  return `\\binom{${binom[1]}}{${binom[2]}}`;
};

const collapseEmptyFractions = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(/\\frac\{([^{}]+)\}\{\s*\}/g, "$1");
  output = output.replace(/\\frac\{\s*\}\{([^{}]+)\}/g, "$1");
  return output;
};

const trimTrailingBreaksAndWhitespace = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(/\\+$/g, "");
  output = output.replace(/\s+/g, " ");
  return output.trim();
};

const normalizeDecodedLatex = (value) => {
  if (!value) return "";
  return transformOutsideTextBlocks(value, normalizeMathTokens);
};

const normalizeMathTokens = (value) => {
  let output = postProcessLatex(value);
  output = normalizeBareLatexCommands(output);
  output = stripArrayFormattingCommands(output);
  output = repairBrokenFractionParentheses(output);
  output = fixMatrixSeparators(output);
  output = normalizeCompactBinom(output);
  output = normalizeBinomWrappedInMatrix(output);
  output = normalizeMatrixDelimiters(output);
  output = simplifyNestedMatrixWrapper(output);
  output = normalizeOperatorNames(output);
  output = collapseEmptyFractions(output);
  output = trimTrailingBreaksAndWhitespace(output);
  return output.trim();
};

const normalizeFallbackText = (value) => {
  if (!value) return "";
  let cleaned = value.replace(/\s+/g, "");
  cleaned = cleaned.replace(/[^A-Za-z0-9.=+\-*/()^_{}]/g, "");
  if (!cleaned) return "";
  if (!cleaned.includes("^")) {
    cleaned = cleaned.replace(/([A-Za-z\\)])([0-9]+)$/, (_match, prefix, digits) =>
      digits.length === 1 ? `${prefix}^${digits}` : `${prefix}^{${digits}}`
    );
  }
  return normalizeBareLatexCommands(cleaned);
};

module.exports = {
  normalizeDecodedLatex,
  normalizeFallbackText,
};

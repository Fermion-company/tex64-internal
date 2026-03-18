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

const stripOuterBraces = (text) => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return trimmed;
  }
  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0 && i < trimmed.length - 1) {
      return trimmed;
    }
  }
  return trimmed.slice(1, -1).trim();
};

const matrixBodyToBinom = (body) => {
  const rows = splitMatrixRows(body).map((row) => row.trim()).filter(Boolean);
  if (rows.length === 2 && rows.every((row) => !row.includes("&"))) {
    return `\\binom{${stripOuterBraces(rows[0])}}{${stripOuterBraces(rows[1])}}`;
  }
  if (rows.length === 1 && !rows[0].includes("&")) {
    const cells = [];
    let i = 0;
    let valid = true;
    while (i < rows[0].length) {
      const ch = rows[0][i];
      if (ch === "{") {
        let depth = 0;
        const start = i + 1;
        for (; i < rows[0].length; i += 1) {
          const inner = rows[0][i];
          if (inner === "{") depth += 1;
          if (inner === "}") {
            depth -= 1;
            if (depth === 0) {
              cells.push(rows[0].slice(start, i).trim());
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
        while (i < rows[0].length && !/\s/.test(rows[0][i])) {
          i += 1;
        }
        cells.push(rows[0].slice(start, i).trim());
        continue;
      }
      i += 1;
    }
    if (!valid) {
      return null;
    }
    if (cells.length === 2) {
      return `\\binom{${stripOuterBraces(cells[0])}}{${stripOuterBraces(cells[1])}}`;
    }
  }
  return null;
};

const cleanMatrixBody = (body) => {
  if (!body) return "";
  let cleaned = body;
  cleaned = cleaned.replace(/\{\s*([A-Za-z0-9.+\-*/=]{1,3})\s*\}/g, "$1");
  cleaned = cleaned.replace(/\s+/g, "");
  cleaned = cleaned.replace(/\\\\+$/g, "");
  return cleaned;
};

const parseMatrixShape = (body) => {
  const normalizedBody = cleanMatrixBody(body);
  if (!normalizedBody) {
    return null;
  }
  if (/\\begin\{/.test(normalizedBody) || /\\end\{/.test(normalizedBody)) {
    return null;
  }
  const rows = splitMatrixRows(normalizedBody).map((row) => row.trim()).filter(Boolean);
  if (rows.length < 2) {
    return null;
  }
  const colCounts = rows.map((row) => row.split("&").length);
  const expectedCols = colCounts[0];
  if (!Number.isFinite(expectedCols) || expectedCols < 2) {
    return null;
  }
  if (!colCounts.every((count) => count === expectedCols)) {
    return null;
  }
  return { rows: rows.length, cols: expectedCols, body: rows.join("\\\\") };
};

const matrixBodyToFraction = (body) => {
  const rows = splitMatrixRows(body).map((row) => row.trim()).filter(Boolean);
  if (rows.length !== 2) {
    return null;
  }
  if (rows.some((row) => row.includes("&"))) {
    return null;
  }
  const left = stripOuterBraces(rows[0]);
  const right = stripOuterBraces(rows[1]);
  const atomReg = /^\\?[A-Za-z]+(?:_[{]?[A-Za-z0-9]+[}]?)?$/;
  if (atomReg.test(left) && atomReg.test(right)) {
    return null;
  }
  return `\\frac{${left}}{${right}}`;
};

const normalizeFractionMatrices = (value) => {
  if (!value) return value;
  const replaceWithFraction = (match, body) => {
    const result = matrixBodyToFraction(body);
    return result ? result : match;
  };
  let output = value.replace(
    /\\left\[\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\\right\]/g,
    replaceWithFraction
  );
  output = output.replace(
    /\[\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\]/g,
    (match, body) => replaceWithFraction(match, body)
  );
  output = output.replace(
    /\\left\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\\right\)/g,
    (match, body) => replaceWithFraction(match, body)
  );
  output = output.replace(
    /\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\)/g,
    (match, body) => replaceWithFraction(match, body)
  );
  return output;
};

const normalizeMatrixDelimiters = (value) => {
  if (!value) return value;
  const toMatrix = (env) => (_match, body) => {
    const cleaned = cleanMatrixBody(body);
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

const repairMatrixNoise = (value) => {
  if (!value) return value;
  const matches = Array.from(
    value.matchAll(/\\begin\{(matrix|pmatrix|bmatrix)\}([\s\S]*?)\\end\{\1\}/g)
  );
  if (matches.length < 2) {
    return value;
  }
  let best = null;
  for (const match of matches) {
    const shape = parseMatrixShape(match[2]);
    if (!shape) continue;
    const area = shape.rows * shape.cols;
    if (!best || area > best.area) {
      best = {
        area,
        body: shape.body,
      };
    }
  }
  if (!best) {
    return value;
  }
  if (/^\s*\\begin\{(?:matrix|pmatrix|bmatrix)\}[\s\S]*\\end\{(?:matrix|pmatrix|bmatrix)\}\s*$/.test(value)) {
    return `\\begin{pmatrix}${best.body}\\end{pmatrix}`;
  }
  return value;
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

const normalizeBinom = (value) => {
  if (!value) return value;
  const replaceWithBinom = (match, body) => {
    const result = matrixBodyToBinom(body);
    return result ? result : match;
  };
  let output = value.replace(
    /\\left\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\\right\)/g,
    replaceWithBinom
  );
  output = output.replace(
    /\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\)/g,
    (match, body) => replaceWithBinom(match, body)
  );
  return output;
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
    (_match, name) => `\\${name}`
  );
  output = output.replace(/\\operatorname\*?\{det\}/g, "\\det");
  output = output.replace(/\\operatorname\*?\{lim\}/g, "\\lim");
  output = output.replace(/\\geq/g, "\\ge");
  output = output.replace(/\\leq/g, "\\le");
  output = output.replace(/\\neq/g, "\\ne");
  return output;
};

const normalizeLimitCommands = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(/\\varlimsup(_\{[^}]*\\to[^}]*\})/g, "\\lim$1");
  output = output.replace(/\\varliminf(_\{[^}]*\\to[^}]*\})/g, "\\lim$1");
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

const unwrapBoxedExpression = (value) => {
  if (!value) return value;
  let output = value.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = output
      .replace(/^\\boxed\{([\s\S]+)\}$/, "$1")
      .replace(/^\\fbox\{([\s\S]+)\}$/, "$1")
      .trim();
    if (next === output) break;
    output = next;
  }
  return output;
};

const stripEdgeBarDelimiters = (value) => {
  if (!value) return value;
  let output = value.trim();
  output = output.replace(
    /^\\left\[\s*\\\|([\s\S]+?)\\right\]$/,
    "$1"
  );
  output = output.replace(
    /^\\left\[\s*\|([\s\S]+?)\\right\]$/,
    "$1"
  );
  output = output.replace(
    /^\\left\|\s*([\s\S]+?)\\right\|$/,
    "$1"
  );
  return output.trim();
};

const collapseEmptyFractions = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(/\\frac\{([^{}]+)\}\{\s*\}/g, "$1");
  output = output.replace(/\\frac\{\s*\}\{([^{}]+)\}/g, "$1");
  return output;
};

const stripRedundantOuterRoundDelimiters = (value) => {
  if (!value) return value;
  let output = value.trim();
  const patterns = [
    [/^\\left\(\s*([\s\S]+?)\s*\\right\)$/, "$1"],
    [/^\\biggl\(\s*([\s\S]+?)\s*\\biggr\)$/, "$1"],
    [/^\\Biggl\(\s*([\s\S]+?)\s*\\Biggr\)$/, "$1"],
    [/^\\bigg\(\s*([\s\S]+?)\s*\\bigg\)$/, "$1"],
    [/^\\Bigg\(\s*([\s\S]+?)\s*\\Bigg\)$/, "$1"],
    [/^\\bigl\(\s*([\s\S]+?)\s*\\bigr\)$/, "$1"],
    [/^\\Bigl\(\s*([\s\S]+?)\s*\\Bigr\)$/, "$1"],
    // Bare outer parens: only strip if preceded by \left or \big-style command
    // (standalone "(a+b)" is intentional — don't strip it)
  ];
  for (let i = 0; i < 2; i += 1) {
    let changed = false;
    for (const [pattern, replacement] of patterns) {
      const next = output.replace(pattern, replacement).trim();
      if (next === output) {
        continue;
      }
      if (/\\begin\{(?:matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\}/.test(next)) {
        continue;
      }
      output = next;
      changed = true;
    }
    if (!changed) break;
  }
  return output;
};

const removeSpacingCommands = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(/\\(?:,|!|;|:|\s)/g, "");
  output = output.replace(/\\+$/g, "");
  output = output.replace(/\s+/g, " ");
  return output.trim();
};

const stripRedundantOuterSquareDelimiters = (value) => {
  if (!value) return value;
  let output = value.trim();
  const patterns = [
    [/^\\left\[\s*([\s\S]+?)\s*\\right\]$/, "$1"],
    [/^\\biggl\[\s*([\s\S]+?)\s*\\biggr\]$/, "$1"],
    [/^\\Biggl\[\s*([\s\S]+?)\s*\\Biggr\]$/, "$1"],
    [/^\\bigg\[\s*([\s\S]+?)\s*\\bigg\]$/, "$1"],
    [/^\\Bigg\[\s*([\s\S]+?)\s*\\Bigg\]$/, "$1"],
    [/^\\bigl\[\s*([\s\S]+?)\s*\\bigr\]$/, "$1"],
    [/^\\Bigl\[\s*([\s\S]+?)\s*\\Bigr\]$/, "$1"],
    [/^\[\s*([\s\S]+?)\s*\]$/, "$1"],
  ];
  for (let i = 0; i < 3; i += 1) {
    let changed = false;
    for (const [pattern, replacement] of patterns) {
      const next = output.replace(pattern, replacement).trim();
      if (next !== output) {
        output = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return output;
};

const normalizeDecodedLatex = (value) => {
  if (!value) return "";
  let output = postProcessLatex(value);
  output = stripArrayFormattingCommands(output);
  output = unwrapBoxedExpression(output);
  output = repairBrokenFractionParentheses(output);
  output = fixMatrixSeparators(output);
  output = normalizeFractionMatrices(output);
  output = normalizeBinom(output);
  output = normalizeCompactBinom(output);
  output = normalizeBinomWrappedInMatrix(output);
  output = normalizeMatrixDelimiters(output);
  output = repairMatrixNoise(output);
  output = simplifyNestedMatrixWrapper(output);
  output = normalizeOperatorNames(output);
  output = normalizeLimitCommands(output);
  output = stripEdgeBarDelimiters(output);
  output = collapseEmptyFractions(output);
  output = stripRedundantOuterSquareDelimiters(output);
  output = stripRedundantOuterRoundDelimiters(output);
  output = removeSpacingCommands(output);
  return output.trim();
};

const normalizeFallbackText = (value) => {
  if (!value) return "";
  let cleaned = value.replace(/\s+/g, "");
  cleaned = cleaned.replace(/[^A-Za-z0-9=+\-*/()^_{}]/g, "");
  if (!cleaned) return "";
  if (!cleaned.includes("^")) {
    cleaned = cleaned.replace(/([A-Za-z\\)])([0-9]+)$/, (_match, prefix, digits) =>
      digits.length === 1 ? `${prefix}^${digits}` : `${prefix}^{${digits}}`
    );
  }
  return cleaned;
};


module.exports = {
  normalizeDecodedLatex,
  normalizeFallbackText,
};

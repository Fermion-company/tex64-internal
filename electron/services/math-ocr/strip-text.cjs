const MATH_FUNCTION_NAMES = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc",
  "arcsin", "arccos", "arctan",
  "sinh", "cosh", "tanh",
  "log", "ln", "exp", "lg",
  "max", "min", "sup", "inf",
  "lim", "det", "dim", "deg",
  "gcd", "mod", "ker", "arg",
  "hom",
]);

const TEXT_COMMANDS = new Set([
  "text", "mbox", "textnormal", "textrm", "textsf",
  "texttt", "textbf", "textit",
]);

const findMatchingBrace = (value, openIndex) => {
  let depth = 0;
  for (let i = openIndex; i < value.length; i += 1) {
    if (value[i] === "{") {
      depth += 1;
    } else if (value[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
};

const isTextCommand = (value, backslashIndex) => {
  let name = "";
  let cursor = backslashIndex + 1;
  while (cursor < value.length && /[A-Za-z]/.test(value[cursor])) {
    name += value[cursor];
    cursor += 1;
  }
  if (!TEXT_COMMANDS.has(name)) {
    return null;
  }
  while (cursor < value.length && /\s/.test(value[cursor])) {
    cursor += 1;
  }
  if (cursor >= value.length || value[cursor] !== "{") {
    return null;
  }
  const closeIndex = findMatchingBrace(value, cursor);
  if (closeIndex < 0) {
    return null;
  }
  return {
    name,
    start: backslashIndex,
    braceOpen: cursor,
    braceClose: closeIndex,
    content: value.slice(cursor + 1, closeIndex),
  };
};

const stripEdgeTextBlocks = (value) => {
  let result = value;

  // Strip leading \text{...} blocks
  let changed = true;
  while (changed) {
    changed = false;
    const trimmed = result.trimStart();
    if (trimmed.length < result.length) {
      result = trimmed;
    }
    if (result.length === 0) break;
    if (result[0] !== "\\") break;
    const cmd = isTextCommand(result, 0);
    if (!cmd) break;
    result = result.slice(cmd.braceClose + 1);
    changed = true;
  }

  // Strip trailing \text{...} blocks
  changed = true;
  while (changed) {
    changed = false;
    result = result.trimEnd();
    if (result.length === 0) break;
    if (result[result.length - 1] !== "}") break;
    // Find the \text command that ends here
    // Search backwards for the matching \text{
    let searchFrom = result.length - 1;
    let braceClose = searchFrom;
    // Find the opening brace
    let depth = 0;
    let braceOpen = -1;
    for (let i = braceClose; i >= 0; i -= 1) {
      if (result[i] === "}") {
        depth += 1;
      } else if (result[i] === "{") {
        depth -= 1;
        if (depth === 0) {
          braceOpen = i;
          break;
        }
      }
    }
    if (braceOpen < 0) break;
    // Check if preceded by a text command
    let cmdEnd = braceOpen;
    while (cmdEnd > 0 && /\s/.test(result[cmdEnd - 1])) {
      cmdEnd -= 1;
    }
    let nameEnd = cmdEnd;
    let nameStart = nameEnd;
    while (nameStart > 0 && /[A-Za-z]/.test(result[nameStart - 1])) {
      nameStart -= 1;
    }
    if (nameStart <= 0 || result[nameStart - 1] !== "\\") break;
    const name = result.slice(nameStart, nameEnd);
    if (!TEXT_COMMANDS.has(name)) break;
    result = result.slice(0, nameStart - 1);
    changed = true;
  }

  return result.trim();
};

const isMathFunctionName = (word) => {
  return MATH_FUNCTION_NAMES.has(word.toLowerCase());
};

// Common multi-letter LaTeX command names (without backslash) — module-level for performance
const LATEX_COMMAND_NAMES = new Set([
  "frac", "sqrt", "sum", "prod", "int", "oint",
  "partial", "nabla", "cdot", "times", "div",
  "alpha", "beta", "gamma", "delta", "epsilon",
  "zeta", "eta", "theta", "iota", "kappa",
  "lambda", "mu", "nu", "xi", "pi",
  "rho", "sigma", "tau", "upsilon", "phi",
  "chi", "psi", "omega",
  "infty", "forall", "exists", "neg",
  "cap", "cup", "subset", "supset",
  "left", "right", "big", "bigg",
  "begin", "end",
  "binom", "choose",
  "hat", "bar", "dot", "ddot", "tilde", "vec",
  "overline", "underline", "underbrace", "overbrace",
  "matrix", "pmatrix", "bmatrix", "vmatrix",
  "cases", "array",
  "quad", "qquad",
  "mathrm", "mathbf", "mathcal", "mathbb",
  "operatorname",
  "pm", "mp", "le", "ge", "ne", "leq", "geq", "neq",
  "approx", "equiv", "sim", "cong", "propto",
  "to", "gets", "rightarrow", "leftarrow",
  "Rightarrow", "Leftarrow", "Leftrightarrow",
  "langle", "rangle", "lfloor", "rfloor",
  "lceil", "rceil",
  "not", "in", "notin",
  "ldots", "cdots", "vdots", "ddots",
  "boxed", "fbox",
  "varlimsup", "varliminf",
  "displaystyle", "textstyle", "scriptstyle",
]);

const isLatexCommandName = (word) => LATEX_COMMAND_NAMES.has(word);

const stripBareTextFromSegments = (value) => {
  // Split by spaces (decoded output has spaces from tokenizer)
  const segments = value.split(/(\s+)/);
  const result = [];
  for (const segment of segments) {
    if (/^\s+$/.test(segment)) {
      result.push(segment);
      continue;
    }
    // Keep if starts with backslash (LaTeX command)
    if (segment.startsWith("\\")) {
      result.push(segment);
      continue;
    }
    // Keep operators, digits, braces, punctuation
    if (/^[0-9=+\-*/(){}^_.,\[\]|<>!:;]+$/.test(segment)) {
      result.push(segment);
      continue;
    }
    // Keep single or two-letter segments (variables: x, y, dx, dy)
    if (/^[A-Za-z]{1,2}$/.test(segment)) {
      result.push(segment);
      continue;
    }
    // Check if it's a known math function name → convert to \name
    if (isMathFunctionName(segment)) {
      result.push("\\" + segment.toLowerCase());
      continue;
    }
    // Check if it's a known LaTeX command name (without backslash)
    if (isLatexCommandName(segment)) {
      result.push(segment);
      continue;
    }
    // 3+ letter word that's not math → strip (likely text)
    if (/^[A-Za-z]{3,}$/.test(segment)) {
      continue;
    }
    // Mixed alphanumeric — try to extract math parts
    // e.g., "Solvex^{2}" → strip "Solve", keep "x^{2}"
    // Strip 3+ letter prefix, keeping last single letter as potential variable
    const prefixMatch = segment.match(/^([a-zA-Z]{3,})([^A-Za-z].*)/);
    if (prefixMatch) {
      const word = prefixMatch[1];
      const rest = prefixMatch[2];
      if (!isMathFunctionName(word) && !isLatexCommandName(word)) {
        // Keep last char of the word as variable if it's a single letter
        const lastChar = word[word.length - 1];
        result.push(lastChar + rest);
        continue;
      }
    }
    // Keep anything else (symbols, mixed content)
    result.push(segment);
  }
  return result.join("");
};

const stripNonMathText = (raw) => {
  if (!raw || typeof raw !== "string") {
    return raw ?? "";
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  // Step 1: Strip edge \text{...} blocks (explanatory text at start/end)
  let output = stripEdgeTextBlocks(trimmed);

  // Step 2: Strip bare English text words (not in \text{...} commands)
  output = stripBareTextFromSegments(output);

  // Step 3: Clean up artifacts from stripping
  output = output.replace(/\s{2,}/g, " ").trim();
  // Remove leading punctuation left behind after text stripping (e.g., ": x^{2}" → "x^{2}")
  output = output.replace(/^[,:;.\s]+/, "").trimStart();
  // Remove trailing punctuation (e.g., "x^{2} ." → "x^{2}")
  output = output.replace(/[,:;.\s]+$/, "").trimEnd();

  // Safety: if stripping produced empty result, return original
  if (!output) {
    return trimmed;
  }

  return output;
};

module.exports = {
  stripNonMathText,
  stripEdgeTextBlocks,
  stripBareTextFromSegments,
  MATH_FUNCTION_NAMES,
  TEXT_COMMANDS,
};

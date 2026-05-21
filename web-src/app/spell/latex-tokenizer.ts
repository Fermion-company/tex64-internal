// LaTeX-aware prose tokenizer for spell checking. Walks the source once and
// yields only "prose" words with their 1-based editor positions, skipping the
// parts that must NOT be spell-checked:
//   - comments (`%` to end of line)
//   - inline/display math: $...$, $$...$$, \(...\), \[...\]
//   - math environments (equation, align, ...) bodies
//   - command names themselves (\section, \textbf, ...)
//   - non-prose command arguments (\label{}, \ref{}, \cite{}, \begin{}, \usepackage{}, \url{}, ...)
// Prose arguments (e.g. the text inside \textbf{...}, \section{...}, or the
// second arg of \href{url}{text}) ARE yielded.

export type SpellToken = {
  word: string;
  lineNumber: number;
  startColumn: number;
  endColumn: number;
};

// Commands whose brace argument is not prose (skip one optional [..] and one {..}).
const SKIP_ARG_COMMANDS = new Set([
  "label", "ref", "eqref", "pageref", "autoref", "cref", "Cref", "vref", "nameref", "Nameref",
  "cite", "citep", "citet", "citeauthor", "citeyear", "citealp", "citealt", "parencite",
  "textcite", "footcite", "autocite", "supercite", "nocite",
  "input", "include", "includegraphics", "includestandalone", "subfile",
  "usepackage", "RequirePackage", "documentclass", "bibliography", "bibliographystyle",
  "addbibresource", "url", "href", "hyperref", "hypersetup", "geometry", "pagestyle",
  "thispagestyle", "definecolor", "color", "textcolor", "colorbox", "pagecolor",
  "verb", "lstinline", "texttt", "lstinputlisting", "bibitem", "newcommand",
  "renewcommand", "newenvironment", "renewenvironment", "DeclareMathOperator",
  "setlength", "addtolength", "setcounter", "vspace", "hspace", "rule", "graphicspath",
]);

const MATH_ENVIRONMENTS = new Set([
  "equation", "equation*", "align", "align*", "alignat", "alignat*", "gather", "gather*",
  "multline", "multline*", "eqnarray", "eqnarray*", "displaymath", "math", "flalign",
  "flalign*", "array", "cases", "matrix", "pmatrix", "bmatrix", "vmatrix", "Vmatrix",
  "smallmatrix", "split", "IEEEeqnarray", "dmath", "dgroup",
]);

const isLetter = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z]/.test(ch);

export const shouldCheckWord = (word: string): boolean => {
  if (word.length < 2) {
    return false;
  }
  // Skip all-caps tokens (acronyms like PDF, HTML) to reduce false positives.
  if (word === word.toUpperCase()) {
    return false;
  }
  return true;
};

export const tokenizeLatexProse = (text: string): SpellToken[] => {
  const tokens: SpellToken[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = () => {
    if (text[i] === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    i += 1;
  };

  const skipUntilLiteral = (literal: string) => {
    while (i < n) {
      if (text.startsWith(literal, i)) {
        for (let k = 0; k < literal.length; k += 1) {
          advance();
        }
        return;
      }
      advance();
    }
  };

  // Skip a balanced run of {...}; assumes text[i] === "{".
  const skipBraceGroup = () => {
    if (text[i] !== "{") {
      return;
    }
    let depth = 0;
    do {
      if (text[i] === "{") {
        depth += 1;
      } else if (text[i] === "}") {
        depth -= 1;
      } else if (text[i] === "\\") {
        advance(); // skip escaped char inside the group
      }
      advance();
    } while (i < n && depth > 0);
  };

  const skipOptionalBracket = () => {
    if (text[i] !== "[") {
      return;
    }
    let depth = 0;
    do {
      if (text[i] === "[") {
        depth += 1;
      } else if (text[i] === "]") {
        depth -= 1;
      }
      advance();
    } while (i < n && depth > 0);
  };

  const skipSpaces = () => {
    while (i < n && (text[i] === " " || text[i] === "\t")) {
      advance();
    }
  };

  while (i < n) {
    const ch = text[i];

    if (ch === "%") {
      while (i < n && text[i] !== "\n") {
        advance();
      }
      continue;
    }

    if (ch === "$") {
      const display = text[i + 1] === "$";
      advance();
      if (display) {
        advance();
      }
      const close = display ? "$$" : "$";
      while (i < n) {
        if (text[i] === "\\") {
          advance();
          if (i < n) advance();
          continue;
        }
        if (text.startsWith(close, i)) {
          for (let k = 0; k < close.length; k += 1) advance();
          break;
        }
        advance();
      }
      continue;
    }

    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "(") {
        advance();
        advance();
        skipUntilLiteral("\\)");
        continue;
      }
      if (next === "[") {
        advance();
        advance();
        skipUntilLiteral("\\]");
        continue;
      }
      if (!isLetter(next)) {
        // Escaped char (\%, \&, \_, \$, \\, ...) — not prose.
        advance();
        if (i < n) advance();
        continue;
      }
      // Command name.
      advance(); // backslash
      let name = "";
      while (i < n && isLetter(text[i])) {
        name += text[i];
        advance();
      }
      if (text[i] === "*") {
        name += "*";
        advance();
      }

      if (name === "begin" || name === "end") {
        skipSpaces();
        let env = "";
        if (text[i] === "{") {
          advance();
          while (i < n && text[i] !== "}") {
            env += text[i];
            advance();
          }
          if (text[i] === "}") advance();
        }
        if (name === "begin" && MATH_ENVIRONMENTS.has(env)) {
          skipUntilLiteral(`\\end{${env}}`);
        }
        continue;
      }

      if (SKIP_ARG_COMMANDS.has(name)) {
        skipSpaces();
        skipOptionalBracket();
        skipSpaces();
        skipBraceGroup();
      }
      // Other commands: only the name is skipped; a following {...} is scanned as prose.
      continue;
    }

    if (isLetter(ch)) {
      const startColumn = col;
      const startLine = line;
      let word = "";
      while (i < n) {
        const c = text[i];
        if (isLetter(c)) {
          word += c;
          advance();
        } else if ((c === "'" || c === "’" || c === "-") && isLetter(text[i + 1])) {
          // internal apostrophe/hyphen, e.g. don't, well-known
          word += c;
          advance();
        } else {
          break;
        }
      }
      if (word && shouldCheckWord(word)) {
        tokens.push({ word, lineNumber: startLine, startColumn, endColumn: col });
      }
      continue;
    }

    advance();
  }

  return tokens;
};

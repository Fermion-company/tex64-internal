// Builds the arXiv search query from the manuscript: the selection when there
// is one, else the paragraph around the cursor plus the nearest heading above
// it. Pure functions; nothing here touches Monaco or the bridge.

const EN_STOPWORDS = new Set((
  "a an the and or but nor so yet for of in on at to from by with without into onto over under " +
  "about above below between among through during before after against within along across " +
  "is are was were be been being am do does did done have has had having will would shall should " +
  "can could may might must ought not no yes this that these those there here where when why how " +
  "which who whom whose what it its itself they them their theirs we us our ours you your yours he " +
  "she his her hers him i me my mine one ones all any both each few more most other some such than " +
  "too very just also only own same then thus hence therefore however moreover furthermore " +
  "as if while whereas because since until unless although though even still already again " +
  "use used using uses based via et al e.g i.e etc fig figure table section eq equation ref see " +
  "show shows shown given let consider assume define denote note follow following first second " +
  "new well many much large small high low number result results paper work approach method " +
  "methods case cases example examples way ways"
).split(/\s+/));

const MATH_PATTERNS: RegExp[] = [
  /\$\$[\s\S]*?\$\$/g,
  /\\\[[\s\S]*?\\\]/g,
  /\\\([\s\S]*?\\\)/g,
  /\$[^$\n]*\$/g,
  /\\begin\{(equation|align|gather|multline|eqnarray|flalign|alignat|math|displaymath)\*?\}[\s\S]*?\\end\{\1\*?\}/g,
];

// Commands whose argument is not prose.
const DROP_WITH_ARGUMENT =
  /\\(?:cite[a-z]*|[a-zA-Z]*cite|ref|eqref|pageref|autoref|cref|Cref|label|includegraphics|input|include|bibliography|addbibresource|url|href|usepackage|documentclass|begin|end|newcommand|renewcommand|footnote|index|vspace|hspace|caption)\*?\s*(?:\[[^\]]*\]\s*)*(?:\{[^{}]*\}\s*)*/g;

export const stripLatex = (text: string): string => {
  let out = String(text || "");
  // Comments (not escaped percent signs).
  out = out.replace(/(^|[^\\])%.*$/gm, "$1");
  for (const pattern of MATH_PATTERNS) out = out.replace(pattern, " ");
  out = out.replace(DROP_WITH_ARGUMENT, " ");
  // Remaining commands: keep their arguments (\textbf{word} → word).
  out = out.replace(/\\[a-zA-Z@]+\*?\s*(?:\[[^\]]*\])*/g, " ");
  out = out.replace(/\\[^a-zA-Z]/g, " ");
  out = out.replace(/[{}~]/g, " ");
  return out.replace(/\s+/g, " ").trim();
};

const englishTerms = (text: string): string[] => {
  const terms: string[] = [];
  const pattern = /[A-Za-z][A-Za-z0-9'’-]*[A-Za-z0-9]|[A-Za-z]{2,}/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const raw = match[0].replace(/^['’-]+|['’-]+$/g, "");
    const lower = raw.toLowerCase();
    if (lower.length < 3 || EN_STOPWORDS.has(lower) || /^\d+$/.test(lower)) continue;
    terms.push(lower);
  }
  return terms;
};

/**
 * Content terms of a piece of prose, most frequent first, at most `limit`.
 * arXiv indexes English, so only Latin-script words are kept; Japanese prose
 * contributes the English words and identifiers it contains.
 */
export const extractTerms = (text: string, limit = 5): string[] => {
  const plain = stripLatex(text);
  const counts = new Map<string, { count: number; first: number }>();
  const all = englishTerms(plain);
  all.forEach((term, index) => {
    const entry = counts.get(term);
    if (entry) entry.count += 1;
    else counts.set(term, { count: 1, first: index });
  });
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
    .slice(0, limit)
    .map(([term]) => term);
};

/** The paragraph (blank-line delimited) that contains line `index` (0-based). */
export const paragraphAround = (lines: string[], index: number): string => {
  if (!lines.length) return "";
  const line = Math.min(Math.max(index, 0), lines.length - 1);
  const blank = (value: string) => !value || !value.trim();
  if (blank(lines[line])) return "";
  let start = line;
  while (start > 0 && !blank(lines[start - 1])) start -= 1;
  let end = line;
  while (end < lines.length - 1 && !blank(lines[end + 1])) end += 1;
  return lines.slice(start, end + 1).join("\n");
};

const HEADING = /\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/;

/** Title of the nearest \section / \subsection at or above line `index` (0-based). */
export const nearestHeading = (lines: string[], index: number): string => {
  for (let i = Math.min(index, lines.length - 1); i >= 0; i -= 1) {
    const match = lines[i]?.match(HEADING);
    if (match) return match[1];
  }
  return "";
};

export type QueryContext = {
  selection: string;
  lines: string[];
  /** 0-based line of the cursor. */
  cursorLine: number;
};

/** Latin-script words of a heading, stopwords included ("Results" is still a query). */
const headingWords = (heading: string): string[] => {
  const words: string[] = [];
  const pattern = /[A-Za-z][A-Za-z0-9'’-]*/g;
  const plain = stripLatex(heading);
  for (let match = pattern.exec(plain); match; match = pattern.exec(plain)) words.push(match[0].toLowerCase());
  return words.slice(0, 5);
};

/** The paragraph before the one containing line `index`, or "". */
const previousParagraph = (lines: string[], index: number): string => {
  let i = Math.min(index, lines.length - 1);
  while (i >= 0 && lines[i]?.trim()) i -= 1; // leave the current paragraph
  while (i >= 0 && !lines[i]?.trim()) i -= 1; // skip the blank gap
  return i >= 0 ? paragraphAround(lines, i) : "";
};

const unique = (words: string[]) => words.filter((word, i) => words.indexOf(word) === i);

/**
 * The query the dialog starts with: at most 5 content terms, space separated.
 * Selection, else the paragraph with its heading; when those yield no English
 * word (a \ref-only paragraph) the heading's own words, padded from the
 * previous paragraph to at least 3; else "" — the dialog then asks for
 * English words.
 */
export const buildArxivQuery = (context: QueryContext): string => {
  const selection = String(context.selection || "").trim();
  if (selection) {
    const terms = extractTerms(selection);
    if (terms.length) return terms.join(" ");
  }
  const paragraph = paragraphAround(context.lines, context.cursorLine);
  const heading = nearestHeading(context.lines, context.cursorLine);
  const terms = extractTerms(`${heading}\n${paragraph}`);
  if (terms.length) return terms.join(" ");
  const fallback = headingWords(heading);
  if (fallback.length && fallback.length < 3) {
    fallback.push(...extractTerms(previousParagraph(context.lines, context.cursorLine), 5));
  }
  return unique(fallback).slice(0, 5).join(" ");
};

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "θ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", infty: "∞", times: "×", pm: "±", leq: "≤", geq: "≥", neq: "≠", approx: "≈",
  sim: "∼", to: "→", rightarrow: "→", cdot: "·", ell: "ℓ", hbar: "ħ", partial: "∂", nabla: "∇", sum: "Σ", prod: "Π", int: "∫",
};

/** Text of one math segment: commands to symbols or names, scripts flattened. */
const plainMath = (math: string): string =>
  math
    .replace(/\\([a-zA-Z]+)/g, (whole, name: string) => GREEK[name] ?? (/^(log|ln|exp|sin|cos|tan|max|min|lim|det|dim)$/.test(name) ? name : ""))
    .replace(/\\[^a-zA-Z]/g, "")
    .replace(/[{}^_]/g, "");

/** Title / abstract text for display: math and simple commands made readable. */
export const plainLatex = (text: string): string =>
  String(text || "")
    .replace(/\\(?:url|href)\s*\{([^{}]*)\}(?:\s*\{[^{}]*\})?/g, "$1")
    .replace(/\$\$([^$]*)\$\$|\$([^$]*)\$|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g, (_whole, a, b, c, d) => plainMath(a ?? b ?? c ?? d ?? ""))
    .replace(/\\(?:emph|textit|textbf|texttt|textsc|text|mbox)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\([%&$#_])/g, "$1")
    .replace(/\\([a-zA-Z]+)\*?\s*/g, (_whole, name: string) => GREEK[name] ?? "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();

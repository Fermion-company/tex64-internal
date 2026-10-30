// Builds the arXiv search query from the manuscript: the selection when there
// is one, else the paragraph around the cursor plus the nearest heading above
// it. Pure functions; nothing here touches Monaco or the bridge.
const EN_STOPWORDS = new Set(("a an the and or but nor so yet for of in on at to from by with without into onto over under " +
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
    "methods case cases example examples way ways").split(/\s+/));
const MATH_PATTERNS = [
    /\$\$[\s\S]*?\$\$/g,
    /\\\[[\s\S]*?\\\]/g,
    /\\\([\s\S]*?\\\)/g,
    /\$[^$\n]*\$/g,
    /\\begin\{(equation|align|gather|multline|eqnarray|flalign|alignat|math|displaymath)\*?\}[\s\S]*?\\end\{\1\*?\}/g,
];
// Commands whose argument is not prose.
const DROP_WITH_ARGUMENT = /\\(?:cite[a-z]*|[a-zA-Z]*cite|ref|eqref|pageref|autoref|cref|Cref|label|includegraphics|input|include|bibliography|addbibresource|url|href|usepackage|documentclass|begin|end|newcommand|renewcommand|footnote|index|vspace|hspace|caption)\*?\s*(?:\[[^\]]*\]\s*)*(?:\{[^{}]*\}\s*)*/g;
export const stripLatex = (text) => {
    let out = String(text || "");
    // Comments (not escaped percent signs).
    out = out.replace(/(^|[^\\])%.*$/gm, "$1");
    for (const pattern of MATH_PATTERNS)
        out = out.replace(pattern, " ");
    out = out.replace(DROP_WITH_ARGUMENT, " ");
    // Remaining commands: keep their arguments (\textbf{word} → word).
    out = out.replace(/\\[a-zA-Z@]+\*?\s*(?:\[[^\]]*\])*/g, " ");
    out = out.replace(/\\[^a-zA-Z]/g, " ");
    out = out.replace(/[{}~]/g, " ");
    return out.replace(/\s+/g, " ").trim();
};
const englishTerms = (text) => {
    const terms = [];
    const pattern = /[A-Za-z][A-Za-z0-9'’-]*[A-Za-z0-9]|[A-Za-z]{2,}/g;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const raw = match[0].replace(/^['’-]+|['’-]+$/g, "");
        const lower = raw.toLowerCase();
        if (lower.length < 3 || EN_STOPWORDS.has(lower) || /^\d+$/.test(lower))
            continue;
        terms.push(lower);
    }
    return terms;
};
/**
 * Content terms of a piece of prose, most frequent first, at most `limit`.
 * arXiv indexes English, so only Latin-script words are kept; Japanese prose
 * contributes the English words and identifiers it contains.
 */
export const extractTerms = (text, limit = 8) => {
    const plain = stripLatex(text);
    const counts = new Map();
    const all = englishTerms(plain);
    all.forEach((term, index) => {
        const entry = counts.get(term);
        if (entry)
            entry.count += 1;
        else
            counts.set(term, { count: 1, first: index });
    });
    return [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
        .slice(0, limit)
        .map(([term]) => term);
};
/** The paragraph (blank-line delimited) that contains line `index` (0-based). */
export const paragraphAround = (lines, index) => {
    if (!lines.length)
        return "";
    const line = Math.min(Math.max(index, 0), lines.length - 1);
    const blank = (value) => !value || !value.trim();
    if (blank(lines[line]))
        return "";
    let start = line;
    while (start > 0 && !blank(lines[start - 1]))
        start -= 1;
    let end = line;
    while (end < lines.length - 1 && !blank(lines[end + 1]))
        end += 1;
    return lines.slice(start, end + 1).join("\n");
};
const HEADING = /\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/;
/** Title of the nearest \section / \subsection at or above line `index` (0-based). */
export const nearestHeading = (lines, index) => {
    var _a;
    for (let i = Math.min(index, lines.length - 1); i >= 0; i -= 1) {
        const match = (_a = lines[i]) === null || _a === void 0 ? void 0 : _a.match(HEADING);
        if (match)
            return match[1];
    }
    return "";
};
/** Latin-script words of a heading, stopwords included ("Results" is still a query). */
const headingWords = (heading) => {
    const words = [];
    const pattern = /[A-Za-z][A-Za-z0-9'’-]*/g;
    const plain = stripLatex(heading);
    for (let match = pattern.exec(plain); match; match = pattern.exec(plain))
        words.push(match[0].toLowerCase());
    return words.slice(0, 8);
};
/**
 * The query the dialog starts with: at most 8 content terms, space separated.
 * Selection, else the paragraph with its heading; when those yield no English
 * word (a \ref-only paragraph) the heading's own words; else "" — the dialog
 * then asks for English words.
 */
export const buildArxivQuery = (context) => {
    const selection = String(context.selection || "").trim();
    if (selection) {
        const terms = extractTerms(selection);
        if (terms.length)
            return terms.join(" ");
    }
    const paragraph = paragraphAround(context.lines, context.cursorLine);
    const heading = nearestHeading(context.lines, context.cursorLine);
    const terms = extractTerms(`${heading}\n${paragraph}`);
    if (terms.length)
        return terms.join(" ");
    return headingWords(heading).join(" ");
};
/** Title / abstract text for display: math delimiters and simple commands removed. */
export const plainLatex = (text) => String(text || "")
    .replace(/\\(?:url|href)\s*\{([^{}]*)\}(?:\s*\{[^{}]*\})?/g, "$1")
    .replace(/\$\$?([^$]*)\$\$?/g, "$1")
    .replace(/\\(?:emph|textit|textbf|texttt|textsc|mathrm|mathbf|mathcal|text|mbox)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\[a-zA-Z]+\*?\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\^|_/g, "")
    .replace(/\s+/g, " ")
    .trim();

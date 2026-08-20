/**
 * Analyze the excerpt around a \label target so \ref-style hovers can show
 * what is being referenced (rendered equation, section title, or caption)
 * instead of only a raw code excerpt. Pure text functions — no DOM — so the
 * logic is unit-testable under node:test.
 */
const DISPLAY_MATH_ENVIRONMENTS = new Set([
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
    "eqnarray",
    "eqnarray*",
    "math",
    "displaymath",
]);
const stripCommentTail = (line) => {
    for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== "%") {
            continue;
        }
        let slashCount = 0;
        for (let j = i - 1; j >= 0; j -= 1) {
            if (line[j] !== "\\") {
                break;
            }
            slashCount += 1;
        }
        if (slashCount % 2 === 0) {
            return line.slice(0, i);
        }
    }
    return line;
};
const joinExcerpt = (lines) => {
    const lineOffsets = [];
    let text = "";
    lines.forEach((line, index) => {
        lineOffsets.push(text.length);
        text += stripCommentTail(line !== null && line !== void 0 ? line : "");
        if (index < lines.length - 1) {
            text += "\n";
        }
    });
    return { text, lineOffsets };
};
const offsetInLine = (joined, lineIndex) => { var _a; return (_a = joined.lineOffsets[Math.max(0, Math.min(lineIndex, joined.lineOffsets.length - 1))]) !== null && _a !== void 0 ? _a : 0; };
/**
 * Find the display-math construct (environment, \[ \], or $$ $$) that
 * contains the target line and return its LaTeX source. Returns null when
 * the target line is not inside display math within the excerpt.
 */
export const extractMathEnvFromExcerpt = (excerpt) => {
    var _a;
    var _b, _c, _d;
    const { startLine, lines, targetLine } = excerpt;
    if (!Array.isArray(lines) || lines.length === 0) {
        return null;
    }
    const targetIndex = targetLine - startLine;
    if (targetIndex < 0 || targetIndex >= lines.length) {
        return null;
    }
    const joined = joinExcerpt(lines);
    const targetOffset = offsetInLine(joined, targetIndex);
    const targetEnd = targetOffset + (stripCommentTail((_b = lines[targetIndex]) !== null && _b !== void 0 ? _b : "")).length;
    const pairs = [];
    // Environment pairs (\begin{env} ... \end{env}) with proper nesting.
    const tokenRegex = /\\(begin|end)\{([A-Za-z*@]+)\}/g;
    const stack = [];
    let token = tokenRegex.exec(joined.text);
    while (token) {
        const action = (_c = token[1]) !== null && _c !== void 0 ? _c : "";
        const env = (_d = token[2]) !== null && _d !== void 0 ? _d : "";
        if (DISPLAY_MATH_ENVIRONMENTS.has(env)) {
            if (action === "begin") {
                stack.push({ env, startOffset: token.index });
            }
            else {
                for (let i = stack.length - 1; i >= 0; i -= 1) {
                    if (((_a = stack[i]) === null || _a === void 0 ? void 0 : _a.env) === env) {
                        const begin = stack.splice(i, 1)[0];
                        pairs.push({
                            startOffset: begin.startOffset,
                            endOffset: token.index + token[0].length,
                        });
                        break;
                    }
                }
            }
        }
        token = tokenRegex.exec(joined.text);
    }
    // \[ ... \] pairs.
    const bracketRegex = /\\\[|\\\]/g;
    let open = -1;
    let bracket = bracketRegex.exec(joined.text);
    while (bracket) {
        if (bracket[0] === "\\[") {
            if (open < 0) {
                open = bracket.index;
            }
        }
        else if (open >= 0) {
            pairs.push({ startOffset: open, endOffset: bracket.index + 2 });
            open = -1;
        }
        bracket = bracketRegex.exec(joined.text);
    }
    // $$ ... $$ pairs.
    const dollarOffsets = [];
    const doubleDollarRegex = /\$\$/g;
    let dd = doubleDollarRegex.exec(joined.text);
    while (dd) {
        const prev = joined.text[dd.index - 1];
        if (prev !== "\\") {
            dollarOffsets.push(dd.index);
        }
        dd = doubleDollarRegex.exec(joined.text);
    }
    for (let i = 0; i + 1 < dollarOffsets.length; i += 2) {
        pairs.push({ startOffset: dollarOffsets[i], endOffset: dollarOffsets[i + 1] + 2 });
    }
    const hit = pairs
        .filter((pair) => pair.startOffset <= targetEnd && pair.endOffset >= targetOffset)
        .sort((a, b) => a.endOffset - a.startOffset - (b.endOffset - b.startOffset))[0];
    if (!hit) {
        return null;
    }
    const latex = joined.text.slice(hit.startOffset, hit.endOffset).trim();
    return latex || null;
};
const readBalancedBraceArg = (text, openBraceIndex) => {
    if (text[openBraceIndex] !== "{") {
        return null;
    }
    let depth = 0;
    for (let i = openBraceIndex; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "\\") {
            i += 1;
            continue;
        }
        if (ch === "{") {
            depth += 1;
        }
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                return text.slice(openBraceIndex + 1, i);
            }
        }
    }
    return null;
};
/** Remove simple LaTeX markup from headline text for plain display. */
export const cleanHeadingText = (value) => value
    .replace(/\\(?:textbf|textit|texttt|textsc|textrm|textsf|emph|mathrm|text|underline)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\label\s*\{[^{}]*\}/g, "")
    .replace(/\\\\/g, " ")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const SECTION_COMMAND_REGEX = /\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\s*\*?\s*(?:\[[^\]]*\])?\s*\{/;
const SECTION_PREFIX = {
    chapter: "§",
    section: "§",
    subsection: "§",
    subsubsection: "§",
    paragraph: "¶",
    subparagraph: "¶",
};
/**
 * Identify what a non-math \label points at: the enclosing section heading
 * or a figure/table caption. Looks on the target line first, then a few
 * lines above (labels conventionally follow the thing they mark).
 */
export const extractRefTargetSummary = (excerpt) => {
    var _a, _b;
    const { startLine, lines, targetLine } = excerpt;
    if (!Array.isArray(lines) || lines.length === 0) {
        return null;
    }
    const targetIndex = targetLine - startLine;
    if (targetIndex < 0 || targetIndex >= lines.length) {
        return null;
    }
    const LOOKBACK = 3;
    for (let i = targetIndex; i >= Math.max(0, targetIndex - LOOKBACK); i -= 1) {
        const line = stripCommentTail((_a = lines[i]) !== null && _a !== void 0 ? _a : "");
        const sectionMatch = SECTION_COMMAND_REGEX.exec(line);
        if (sectionMatch) {
            const braceIndex = sectionMatch.index + sectionMatch[0].length - 1;
            const title = readBalancedBraceArg(line, braceIndex);
            if (title) {
                const cleaned = cleanHeadingText(title);
                if (cleaned) {
                    const prefix = (_b = SECTION_PREFIX[sectionMatch[1]]) !== null && _b !== void 0 ? _b : "§";
                    return { kind: "section", text: `${prefix} ${cleaned}` };
                }
            }
        }
        const captionMatch = /\\caption\s*(?:\[[^\]]*\])?\s*\{/.exec(line);
        if (captionMatch) {
            const braceIndex = captionMatch.index + captionMatch[0].length - 1;
            const caption = readBalancedBraceArg(line, braceIndex);
            if (caption) {
                const cleaned = cleanHeadingText(caption);
                if (cleaned) {
                    return { kind: "caption", text: cleaned };
                }
            }
        }
    }
    return null;
};

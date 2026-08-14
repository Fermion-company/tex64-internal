// Where a generated figure should land in a LaTeX document, and what its
// preamble still needs. Pure functions so the rules are unit-testable: the
// canvas UI only turns the result into Monaco edits.
/** Everything from an unescaped % to the end of the line is a LaTeX comment. */
const stripComment = (line) => {
    const comment = line.indexOf("%");
    return comment >= 0 && (comment === 0 || line[comment - 1] !== "\\") ? line.slice(0, comment) : line;
};
const findLine = (lines, pattern) => {
    for (let index = 0; index < lines.length; index += 1)
        if (pattern.test(stripComment(lines[index])))
            return index + 1;
    return 0;
};
/**
 * A figure dropped above \begin{document} breaks the file, and that is exactly
 * where the cursor sits when the canvas is opened without ever clicking the
 * editor (line 1, column 1). Fall back to just before \end{document}.
 */
export const planBodyInsert = (text, cursor) => {
    const lines = text.split("\n");
    const beginLine = findLine(lines, /\\begin\s*\{document\}/);
    if (!beginLine || cursor.lineNumber > beginLine)
        return { point: cursor, moved: false };
    const endLine = findLine(lines, /\\end\s*\{document\}/);
    const target = endLine > beginLine ? endLine : lines.length + 1;
    return { point: { lineNumber: target, column: 1 }, moved: true };
};
/** \usepackage / \usetikzlibrary lines the document is missing for this figure. */
export const missingPreambleLines = (text, requires, needsPgfplots) => {
    const lines = text.split("\n");
    const beginLine = findLine(lines, /\\begin\s*\{document\}/);
    const preamble = (beginLine ? lines.slice(0, beginLine - 1) : lines).map(stripComment).join("\n");
    const has = (pattern) => pattern.test(preamble);
    const out = [];
    if (!has(/\\usepackage(\[[^\]]*\])?\s*\{[^}]*\btikz\b[^}]*\}/) && !has(/\\documentclass(\[[^\]]*\])?\s*\{standalone\}/)) {
        out.push("\\usepackage{tikz}");
    }
    const libraries = requires.filter((name) => !new RegExp(`\\\\usetikzlibrary\\s*\\{[^}]*\\b${name.replace(/\./g, "\\.")}\\b[^}]*\\}`).test(preamble));
    if (libraries.length)
        out.push(`\\usetikzlibrary{${libraries.join(",")}}`);
    if (needsPgfplots) {
        if (!has(/\\usepackage(\[[^\]]*\])?\s*\{[^}]*\bpgfplots\b[^}]*\}/))
            out.push("\\usepackage{pgfplots}");
        if (!has(/\\pgfplotsset\s*\{[^}]*compat/))
            out.push("\\pgfplotsset{compat=1.18}");
    }
    return out;
};
export const planFigureInsert = (text, cursor, requires, needsPgfplots) => {
    const { point, moved } = planBodyInsert(text, cursor);
    const lines = text.split("\n");
    const beginLine = findLine(lines, /\\begin\s*\{document\}/);
    const missing = beginLine ? missingPreambleLines(text, requires, needsPgfplots) : [];
    return {
        body: point,
        preamble: missing.length ? { lineNumber: beginLine, text: `${missing.join("\n")}\n` } : null,
        movedIntoBody: moved,
    };
};

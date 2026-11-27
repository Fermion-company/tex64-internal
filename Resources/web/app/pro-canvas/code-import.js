/** Preserve picture options as a local scope when inserting into the canvas picture. */
export const stripTikzWrapper = (tex) => {
    const normalized = tex.replace(/\r\n?/g, "\n").trim();
    const match = normalized.match(/^\\begin\{tikzpicture\}([\s\S]*?)\\end\{tikzpicture\}$/);
    if (!match)
        return normalized;
    const body = match[1].trim();
    if (/^(?:%[^\n]*\n\s*)*\[/.test(body)) {
        return `\\begin{scope}${body}\n\\end{scope}`;
    }
    return body;
};

const escapeLatex = (value) => value.replace(/[\\{}%$#&_]/g, (char) => `\\${char}`);
const normalizeWhitespace = (value) => value.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
const buildTabular = (rows) => {
    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const columns = columnCount > 0 ? columnCount : 1;
    const columnSpec = `|${"c|".repeat(columns)}`;
    const lines = [`\\begin{tabular}{${columnSpec}}`];
    rows.forEach((row) => {
        const cells = row
            .concat(Array.from({ length: Math.max(0, columns - row.length) }, () => ""))
            .map((cell) => escapeLatex(cell.trim()));
        lines.push("\\hline");
        lines.push(`${cells.join(" & ")} \\\\`);
    });
    lines.push("\\hline");
    lines.push("\\end{tabular}");
    lines.push("");
    return lines.join("\n");
};
const serializeNode = (node) => {
    var _a, _b;
    if (node.nodeType === Node.TEXT_NODE) {
        return escapeLatex(normalizeWhitespace((_a = node.textContent) !== null && _a !== void 0 ? _a : ""));
    }
    if (!(node instanceof HTMLElement)) {
        return "";
    }
    const tag = node.tagName.toLowerCase();
    const children = Array.from(node.childNodes).map(serializeNode).filter(Boolean);
    const text = children.join("");
    switch (tag) {
        case "br":
            return "\n";
        case "p":
        case "div":
        case "section":
        case "article":
            return text ? `${text}\n\n` : "";
        case "strong":
        case "b":
            return text ? `\\textbf{${text}}` : "";
        case "em":
        case "i":
            return text ? `\\emph{${text}}` : "";
        case "code":
            return text ? `\\texttt{${text}}` : "";
        case "pre":
            return node.textContent ? `\\begin{verbatim}\n${node.textContent}\n\\end{verbatim}` : "";
        case "a": {
            const href = (_b = node.getAttribute("href")) !== null && _b !== void 0 ? _b : "";
            const label = text || escapeLatex(href);
            return href ? `\\href{${href}}{${label}}` : label;
        }
        case "ul": {
            const items = Array.from(node.querySelectorAll("li"))
                .map((li) => serializeNode(li))
                .filter(Boolean)
                .map((line) => `\\item ${line}`);
            return items.length ? `\\begin{itemize}\n${items.join("\n")}\n\\end{itemize}\n` : "";
        }
        case "ol": {
            const items = Array.from(node.querySelectorAll("li"))
                .map((li) => serializeNode(li))
                .filter(Boolean)
                .map((line) => `\\item ${line}`);
            return items.length ? `\\begin{enumerate}\n${items.join("\n")}\n\\end{enumerate}\n` : "";
        }
        case "li":
            return text;
        case "table": {
            const rows = Array.from(node.querySelectorAll("tr")).map((row) => Array.from(row.querySelectorAll("th, td")).map((cell) => { var _a; return normalizeWhitespace((_a = cell.textContent) !== null && _a !== void 0 ? _a : ""); }));
            return rows.length ? buildTabular(rows) : "";
        }
        default:
            return text;
    }
};
export const convertHtmlToLatex = (html) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const body = doc.body;
    const content = Array.from(body.childNodes).map(serializeNode).join("");
    return content.replace(/\n{3,}/g, "\n\n").trim();
};
export const extractPlainText = (html) => {
    var _a;
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    return normalizeWhitespace((_a = doc.body.textContent) !== null && _a !== void 0 ? _a : "");
};

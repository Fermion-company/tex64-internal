const styleNamePattern = /^[A-Za-z][A-Za-z0-9 _-]*$/;
export const extractPreamble = (source) => {
    const documentClass = /^[ \t]*\\documentclass(?:\s*\[[^\r\n]*\])?\s*\{[^\r\n}]*\}[^\r\n]*(?:\r?\n|$)/m.exec(source);
    if (!documentClass)
        return null;
    const start = documentClass.index + documentClass[0].length;
    const beginDocument = /\\begin\s*\{document\}/.exec(source.slice(start));
    if (!beginDocument)
        return null;
    return source.slice(start, start + beginDocument.index);
};
const collectStyles = (source, names, seen) => {
    const pattern = /(?:^|[,{\n\r])\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*\/\.style\s*=/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        const name = match[1].trim();
        if (styleNamePattern.test(name) && !seen.has(name)) {
            seen.add(name);
            names.push(name);
        }
    }
};
export const scanTikzsetStyles = (source) => {
    const names = [];
    const seen = new Set();
    const outside = source.split("");
    const tikzset = /\\tikzset\s*\{/g;
    let match;
    while ((match = tikzset.exec(source)) !== null) {
        const open = match.index + match[0].lastIndexOf("{");
        let depth = 1;
        let end = open + 1;
        for (; end < source.length && depth > 0; end += 1) {
            if (source[end] === "{" && source[end - 1] !== "\\")
                depth += 1;
            else if (source[end] === "}" && source[end - 1] !== "\\")
                depth -= 1;
        }
        if (depth !== 0)
            continue;
        collectStyles(source.slice(open + 1, end - 1), names, seen);
        outside.fill(" ", match.index, end);
    }
    collectStyles(outside.join(""), names, seen);
    return names;
};

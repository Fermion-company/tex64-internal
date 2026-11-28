export const findCommandMatchAt = (line, cursorIndex, regex, extractKey) => {
    regex.lastIndex = 0;
    let match = regex.exec(line);
    while (match) {
        const extracted = extractKey(match, cursorIndex);
        if (extracted) {
            return extracted;
        }
        match = regex.exec(line);
    }
    return null;
};
// For these commands the required argument is the last part of the match.
// Earlier optional arguments can themselves contain braces.
export const extractSingleKey = (match, cursorIndex) => {
    var _a, _b;
    const command = (_a = match[1]) !== null && _a !== void 0 ? _a : "";
    const content = (_b = match[2]) !== null && _b !== void 0 ? _b : "";
    const start = match.index + match[0].length - content.length - 1;
    const key = content.trim();
    const startIndex = start + content.length - content.trimStart().length;
    const endIndex = startIndex + key.length;
    return key && cursorIndex >= startIndex && cursorIndex < endIndex
        ? { command, key, startIndex, endIndex }
        : null;
};
export const extractListKey = (match, cursorIndex) => {
    var _a, _b;
    const command = (_a = match[1]) !== null && _a !== void 0 ? _a : "";
    const content = (_b = match[2]) !== null && _b !== void 0 ? _b : "";
    let start = match.index + match[0].length - content.length - 1;
    for (const item of content.split(",")) {
        const key = item.trim();
        const startIndex = start + item.length - item.trimStart().length;
        const endIndex = startIndex + key.length;
        if (key && cursorIndex >= startIndex && cursorIndex < endIndex)
            return { command, key, startIndex, endIndex };
        start += item.length + 1;
    }
    return null;
};

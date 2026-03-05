export const findFirstUnescapedPercent = (line) => {
    for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== "%") {
            continue;
        }
        if (i > 0 && line[i - 1] === "\\") {
            continue;
        }
        return i;
    }
    return -1;
};
export const stripCommentTail = (line) => {
    const commentIndex = findFirstUnescapedPercent(line);
    return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
};
export const getCursorIndex = (position) => { var _a; return Math.max(0, ((_a = position.column) !== null && _a !== void 0 ? _a : 1) - 1); };
export const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

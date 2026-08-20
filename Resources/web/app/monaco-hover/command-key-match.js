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
export const extractSingleKey = (match, cursorIndex) => {
    var _a, _b, _c, _d, _e;
    const command = (_a = match[1]) !== null && _a !== void 0 ? _a : "";
    const content = (_b = match[2]) !== null && _b !== void 0 ? _b : "";
    const braceIndex = match[0].indexOf("{");
    if (braceIndex < 0 || typeof match.index !== "number") {
        return null;
    }
    const contentStart = match.index + braceIndex + 1;
    const contentEnd = contentStart + content.length;
    if (cursorIndex < contentStart || cursorIndex > contentEnd) {
        return null;
    }
    const key = content.trim();
    if (!key) {
        return null;
    }
    const leading = (_e = (_d = (_c = content.match(/^\s*/)) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.length) !== null && _e !== void 0 ? _e : 0;
    return {
        command,
        key,
        startIndex: contentStart + leading,
        endIndex: contentStart + leading + key.length,
    };
};
export const extractCiteKey = (match, cursorIndex) => {
    var _a, _b, _c, _d, _e;
    const command = (_a = match[1]) !== null && _a !== void 0 ? _a : "";
    const content = (_b = match[2]) !== null && _b !== void 0 ? _b : "";
    const braceIndex = match[0].indexOf("{");
    if (braceIndex < 0 || typeof match.index !== "number") {
        return null;
    }
    const contentStart = match.index + braceIndex + 1;
    const contentEnd = contentStart + content.length;
    if (cursorIndex < contentStart || cursorIndex > contentEnd) {
        return null;
    }
    const offset = cursorIndex - contentStart;
    const beforeComma = content.lastIndexOf(",", Math.max(0, offset - 1));
    const afterComma = content.indexOf(",", offset);
    const segStart = beforeComma >= 0 ? beforeComma + 1 : 0;
    const segEnd = afterComma >= 0 ? afterComma : content.length;
    const segment = content.slice(segStart, segEnd);
    const leading = (_e = (_d = (_c = segment.match(/^\s*/)) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.length) !== null && _e !== void 0 ? _e : 0;
    const key = segment.trim();
    if (!key) {
        return null;
    }
    return {
        command,
        key,
        startIndex: contentStart + segStart + leading,
        endIndex: contentStart + segStart + leading + key.length,
    };
};
export const extractCommaSeparatedKey = (command, content, contentStart, cursorIndex) => {
    var _a, _b, _c;
    const contentEnd = contentStart + content.length;
    if (cursorIndex < contentStart || cursorIndex > contentEnd) {
        return null;
    }
    const offset = cursorIndex - contentStart;
    const beforeComma = content.lastIndexOf(",", Math.max(0, offset - 1));
    const afterComma = content.indexOf(",", offset);
    const segStart = beforeComma >= 0 ? beforeComma + 1 : 0;
    const segEnd = afterComma >= 0 ? afterComma : content.length;
    const segment = content.slice(segStart, segEnd);
    const leading = (_c = (_b = (_a = segment.match(/^\s*/)) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.length) !== null && _c !== void 0 ? _c : 0;
    const key = segment.trim();
    if (!key) {
        return null;
    }
    return {
        command,
        key,
        startIndex: contentStart + segStart + leading,
        endIndex: contentStart + segStart + leading + key.length,
    };
};
export const extractPackageKey = (match, cursorIndex) => {
    var _a, _b;
    const command = ((_a = match[1]) !== null && _a !== void 0 ? _a : "usepackage").trim();
    const content = (_b = match[2]) !== null && _b !== void 0 ? _b : "";
    const braceIndex = match[0].indexOf("{");
    if (braceIndex < 0 || typeof match.index !== "number") {
        return null;
    }
    const contentStart = match.index + braceIndex + 1;
    return extractCommaSeparatedKey(command, content, contentStart, cursorIndex);
};
export const extractDocumentClassKey = (match, cursorIndex) => {
    var _a, _b, _c, _d;
    const command = "documentclass";
    const content = (_a = match[1]) !== null && _a !== void 0 ? _a : "";
    const braceIndex = match[0].indexOf("{");
    if (braceIndex < 0 || typeof match.index !== "number") {
        return null;
    }
    const contentStart = match.index + braceIndex + 1;
    const key = content.trim();
    if (!key) {
        return null;
    }
    const contentEnd = contentStart + content.length;
    if (cursorIndex < contentStart || cursorIndex > contentEnd) {
        return null;
    }
    const leading = (_d = (_c = (_b = content.match(/^\s*/)) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 0;
    return {
        command,
        key,
        startIndex: contentStart + leading,
        endIndex: contentStart + leading + key.length,
    };
};

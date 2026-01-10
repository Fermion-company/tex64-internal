const PLACEHOLDER_LATEX = "\\placeholder{}";
const MULTI_ARG_COMMANDS = new Set(["frac", "dfrac", "tfrac", "binom", "dbinom", "tbinom"]);
const isAsciiLetter = (value) => /[A-Za-z]/.test(value);
const isDigit = (value) => /[0-9]/.test(value);
const isEscaped = (text, index) => {
    let count = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
        count += 1;
    }
    return count % 2 === 1;
};
const findMatchingBraceLeft = (text, closeIndex) => {
    if (closeIndex < 0 || text[closeIndex] !== "}" || isEscaped(text, closeIndex)) {
        return null;
    }
    let depth = 0;
    for (let i = closeIndex; i >= 0; i -= 1) {
        const char = text[i];
        if (char === "}" && !isEscaped(text, i)) {
            depth += 1;
            continue;
        }
        if (char === "{" && !isEscaped(text, i)) {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return null;
};
const findMatchingBracketLeft = (text, closeIndex) => {
    if (closeIndex < 0 || text[closeIndex] !== "]" || isEscaped(text, closeIndex)) {
        return null;
    }
    let depth = 0;
    for (let i = closeIndex; i >= 0; i -= 1) {
        const char = text[i];
        if (char === "]" && !isEscaped(text, i)) {
            depth += 1;
            continue;
        }
        if (char === "[" && !isEscaped(text, i)) {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return null;
};
const readCommandLeftOf = (text, index) => {
    let i = index - 1;
    if (i < 0 || !isAsciiLetter(text[i])) {
        return null;
    }
    const end = i + 1;
    while (i >= 0 && isAsciiLetter(text[i])) {
        i -= 1;
    }
    if (i >= 0 && text[i] === "\\" && !isEscaped(text, i)) {
        const name = text.slice(i + 1, end);
        return { start: i, end, name };
    }
    return null;
};
const readCommandAt = (text, index) => {
    if (index < 0 || text[index] !== "\\") {
        return null;
    }
    const next = text[index + 1];
    if (!next) {
        return null;
    }
    if (isAsciiLetter(next)) {
        let end = index + 2;
        while (end < text.length && isAsciiLetter(text[end])) {
            end += 1;
        }
        return { start: index, end };
    }
    return { start: index, end: Math.min(text.length, index + 2) };
};
const isLeftRightToken = (text, index, kind) => {
    const token = kind === "left" ? "\\left" : "\\right";
    if (!text.startsWith(token, index)) {
        return false;
    }
    const next = text[index + token.length];
    return !next || !isAsciiLetter(next);
};
const findMatchingLeftToken = (text, rightIndex) => {
    let depth = 0;
    for (let i = rightIndex; i >= 0; i -= 1) {
        if (text[i] !== "\\") {
            continue;
        }
        if (isLeftRightToken(text, i, "right")) {
            depth += 1;
            continue;
        }
        if (isLeftRightToken(text, i, "left")) {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return null;
};
const findLeftRightBaseStart = (text, baseEnd) => {
    for (let i = baseEnd - 1; i >= 0; i -= 1) {
        if (text[i] !== "\\") {
            continue;
        }
        if (!isLeftRightToken(text, i, "right")) {
            continue;
        }
        const delimiterStart = i + "\\right".length;
        if (delimiterStart >= baseEnd) {
            continue;
        }
        let delimiterEnd = delimiterStart + 1;
        if (text[delimiterStart] === "\\") {
            const command = readCommandAt(text, delimiterStart);
            delimiterEnd = command ? command.end : delimiterEnd;
        }
        if (delimiterEnd !== baseEnd) {
            continue;
        }
        return findMatchingLeftToken(text, i);
    }
    return null;
};
const findBaseStart = (text, baseEnd) => {
    if (baseEnd <= 0) {
        return null;
    }
    const lastIndex = baseEnd - 1;
    const lastChar = text[lastIndex];
    if (!lastChar || /\s/.test(lastChar)) {
        return null;
    }
    const leftRightStart = findLeftRightBaseStart(text, baseEnd);
    if (leftRightStart !== null) {
        return leftRightStart;
    }
    if (lastChar === "}" && !isEscaped(text, lastIndex)) {
        const groupStart = findMatchingBraceLeft(text, lastIndex);
        if (groupStart === null) {
            return null;
        }
        let baseStart = groupStart;
        const command = readCommandLeftOf(text, groupStart);
        if (command) {
            baseStart = command.start;
        }
        else {
            let resolved = false;
            if (groupStart > 0 &&
                text[groupStart - 1] === "]" &&
                !isEscaped(text, groupStart - 1)) {
                const bracketEnd = groupStart - 1;
                const bracketStart = findMatchingBracketLeft(text, bracketEnd);
                if (bracketStart !== null) {
                    const optionalCommand = readCommandLeftOf(text, bracketStart);
                    if (optionalCommand && optionalCommand.name === "sqrt") {
                        baseStart = optionalCommand.start;
                        resolved = true;
                    }
                }
            }
            if (!resolved &&
                groupStart > 0 &&
                text[groupStart - 1] === "}" &&
                !isEscaped(text, groupStart - 1)) {
                const prevGroupEnd = groupStart - 1;
                const prevGroupStart = findMatchingBraceLeft(text, prevGroupEnd);
                if (prevGroupStart !== null) {
                    const multiCommand = readCommandLeftOf(text, prevGroupStart);
                    if (multiCommand && MULTI_ARG_COMMANDS.has(multiCommand.name)) {
                        baseStart = multiCommand.start;
                    }
                }
            }
        }
        return baseStart;
    }
    if (isAsciiLetter(lastChar)) {
        const command = readCommandLeftOf(text, baseEnd);
        if (command) {
            return command.start;
        }
        return lastIndex;
    }
    if (isDigit(lastChar)) {
        let start = lastIndex;
        while (start > 0 && isDigit(text[start - 1])) {
            start -= 1;
        }
        return start;
    }
    return lastIndex;
};
const readScriptEndingAt = (text, endIndex) => {
    const closeIndex = endIndex - 1;
    if (closeIndex < 0 || text[closeIndex] !== "}" || isEscaped(text, closeIndex)) {
        const tokenStart = findBaseStart(text, endIndex);
        if (tokenStart === null) {
            return null;
        }
        const scriptIndex = tokenStart - 1;
        if (scriptIndex < 0 || isEscaped(text, scriptIndex)) {
            return null;
        }
        const scriptChar = text[scriptIndex];
        if (scriptChar !== "_" && scriptChar !== "^") {
            return null;
        }
        return {
            kind: scriptChar === "_" ? "sub" : "sup",
            range: {
                start: scriptIndex,
                end: endIndex,
                contentStart: tokenStart,
                contentEnd: endIndex,
            },
        };
    }
    const openIndex = findMatchingBraceLeft(text, closeIndex);
    if (openIndex === null) {
        return null;
    }
    const scriptIndex = openIndex - 1;
    if (scriptIndex < 0 || isEscaped(text, scriptIndex)) {
        return null;
    }
    const scriptChar = text[scriptIndex];
    if (scriptChar !== "_" && scriptChar !== "^") {
        return null;
    }
    return {
        kind: scriptChar === "_" ? "sub" : "sup",
        range: {
            start: scriptIndex,
            end: closeIndex + 1,
            contentStart: openIndex + 1,
            contentEnd: closeIndex,
        },
    };
};
const findAtomLeftOfCursor = (text, cursor) => {
    if (cursor <= 0) {
        return null;
    }
    let baseEnd = cursor;
    let sub;
    let sup;
    for (let i = 0; i < 2; i += 1) {
        const script = readScriptEndingAt(text, baseEnd);
        if (!script) {
            break;
        }
        if (script.kind === "sub" && !sub) {
            sub = script.range;
        }
        else if (script.kind === "sup" && !sup) {
            sup = script.range;
        }
        baseEnd = script.range.start;
    }
    const baseStart = findBaseStart(text, baseEnd);
    if (baseStart === null) {
        return null;
    }
    return { baseStart, baseEnd, sub, sup };
};
const findAtomRangeLeftOfCursor = (text, cursor) => {
    var _a, _b, _c, _d;
    const atom = findAtomLeftOfCursor(text, cursor);
    if (!atom) {
        return null;
    }
    const atomEnd = Math.max(atom.baseEnd, (_b = (_a = atom.sub) === null || _a === void 0 ? void 0 : _a.end) !== null && _b !== void 0 ? _b : atom.baseEnd, (_d = (_c = atom.sup) === null || _c === void 0 ? void 0 : _c.end) !== null && _d !== void 0 ? _d : atom.baseEnd);
    return { start: atom.baseStart, end: atomEnd };
};
const insertAt = (text, index, value) => text.slice(0, index) + value + text.slice(index);
const buildTemplate = (template, placeholder) => {
    var _a, _b;
    const parts = template.split("#?");
    if (parts.length === 1) {
        return { text: template, placeholders: [] };
    }
    const placeholders = [];
    let text = (_a = parts[0]) !== null && _a !== void 0 ? _a : "";
    for (let i = 1; i < parts.length; i += 1) {
        const start = text.length;
        text += placeholder;
        const end = text.length;
        placeholders.push({ start, end });
        text += (_b = parts[i]) !== null && _b !== void 0 ? _b : "";
    }
    return { text, placeholders };
};
const normalizeScriptValue = (value) => value && value.length > 0 ? value : null;
const buildScriptSegment = (kind, placeholder, value) => {
    const marker = kind === "sub" ? "_" : "^";
    if (value) {
        const hasPlaceholder = value.includes("#?");
        if (hasPlaceholder) {
            const template = buildTemplate(value, placeholder);
            const text = `${marker}{${template.text}}`;
            if (template.placeholders.length > 0) {
                const focus = template.placeholders[0];
                const start = marker.length + 1 + focus.start;
                const end = marker.length + 1 + focus.end;
                return { text, selectionStart: start, selectionEnd: end };
            }
            return { text, selectionStart: text.length, selectionEnd: text.length };
        }
        const text = `${marker}{${value}}`;
        return { text, selectionStart: text.length, selectionEnd: text.length };
    }
    const text = `${marker}{${placeholder}}`;
    if (placeholder.length > 0) {
        const start = marker.length + 1;
        return { text, selectionStart: start, selectionEnd: start + placeholder.length };
    }
    const cursor = marker.length + 1;
    return { text, selectionStart: cursor, selectionEnd: cursor };
};
// Apply scripts by editing the LaTeX string so MathLive/textarea stay consistent.
const applyScriptToText = (text, selection, kind, options) => {
    let start = selection.start;
    let end = selection.end;
    if (start > end) {
        [start, end] = [end, start];
    }
    let cursor = end;
    if (start !== end) {
        const selected = text.slice(start, end);
        text = text.slice(0, start) + `{${selected}}` + text.slice(end);
        cursor = start + selected.length + 2;
    }
    const placeholder = options.placeholder;
    const baseInsert = normalizeScriptValue(options.base);
    const subValue = normalizeScriptValue(options.subValue);
    const supValue = normalizeScriptValue(options.supValue);
    let atom = findAtomLeftOfCursor(text, cursor);
    if (!atom && baseInsert) {
        text = insertAt(text, cursor, baseInsert);
        cursor += baseInsert.length;
        atom = findAtomLeftOfCursor(text, cursor);
    }
    if (!atom) {
        const basePlaceholder = placeholder.length > 0 ? placeholder : "{}";
        let scriptText = "";
        if (kind === "sub") {
            scriptText = buildScriptSegment("sub", placeholder, subValue).text;
        }
        else if (kind === "sup") {
            scriptText = buildScriptSegment("sup", placeholder, supValue).text;
        }
        else {
            const subSegment = buildScriptSegment("sub", placeholder, subValue);
            const supSegment = buildScriptSegment("sup", placeholder, supValue);
            scriptText = subSegment.text + supSegment.text;
        }
        const insertion = basePlaceholder + scriptText;
        text = insertAt(text, cursor, insertion);
        if (placeholder.length > 0) {
            return {
                text,
                selectionStart: cursor,
                selectionEnd: cursor + placeholder.length,
            };
        }
        return {
            text,
            selectionStart: cursor + 1,
            selectionEnd: cursor + 1,
        };
    }
    if (kind === "sub") {
        if (atom.sub) {
            return { text, selectionStart: atom.sub.contentEnd, selectionEnd: atom.sub.contentEnd };
        }
        const insertPos = atom.sup ? atom.sup.start : atom.baseEnd;
        const segment = buildScriptSegment("sub", placeholder, subValue);
        text = insertAt(text, insertPos, segment.text);
        return {
            text,
            selectionStart: insertPos + segment.selectionStart,
            selectionEnd: insertPos + segment.selectionEnd,
        };
    }
    if (kind === "sup") {
        if (atom.sup) {
            return { text, selectionStart: atom.sup.contentEnd, selectionEnd: atom.sup.contentEnd };
        }
        const insertPos = atom.sub ? atom.sub.end : atom.baseEnd;
        const segment = buildScriptSegment("sup", placeholder, supValue);
        text = insertAt(text, insertPos, segment.text);
        return {
            text,
            selectionStart: insertPos + segment.selectionStart,
            selectionEnd: insertPos + segment.selectionEnd,
        };
    }
    if (atom.sub && atom.sup) {
        return { text, selectionStart: atom.sub.contentEnd, selectionEnd: atom.sub.contentEnd };
    }
    if (!atom.sub && atom.sup) {
        const insertPos = atom.sup.start;
        const segment = buildScriptSegment("sub", placeholder, subValue);
        text = insertAt(text, insertPos, segment.text);
        return {
            text,
            selectionStart: insertPos + segment.selectionStart,
            selectionEnd: insertPos + segment.selectionEnd,
        };
    }
    if (!atom.sup && atom.sub) {
        const insertPos = atom.sub.end;
        const segment = buildScriptSegment("sup", placeholder, supValue);
        text = insertAt(text, insertPos, segment.text);
        return {
            text,
            selectionStart: insertPos + segment.selectionStart,
            selectionEnd: insertPos + segment.selectionEnd,
        };
    }
    const insertPos = atom.baseEnd;
    const subSegment = buildScriptSegment("sub", placeholder, subValue);
    const supSegment = buildScriptSegment("sup", placeholder, supValue);
    text = insertAt(text, insertPos, subSegment.text + supSegment.text);
    return {
        text,
        selectionStart: insertPos + subSegment.selectionStart,
        selectionEnd: insertPos + subSegment.selectionEnd,
    };
};
const applyTemplateToText = (text, selection, template, options) => {
    var _a, _b, _c, _d, _e;
    let start = selection.start;
    let end = selection.end;
    if (start > end) {
        [start, end] = [end, start];
    }
    const hasSelection = start !== end;
    const cursor = end;
    const baseScope = (_a = options.baseScope) !== null && _a !== void 0 ? _a : "selection";
    const canUseAtom = baseScope !== "selection";
    const baseRange = hasSelection
        ? { start, end }
        : canUseAtom
            ? findAtomRangeLeftOfCursor(text, cursor)
            : null;
    const baseText = baseRange ? text.slice(baseRange.start, baseRange.end) : null;
    let templateText = "";
    let placeholders = [];
    if (options.baseMode === "wrap") {
        const parts = template.split("#?");
        const placeholderCount = Math.max(0, parts.length - 1);
        const targetIndex = placeholderCount === 0
            ? null
            : Math.max(0, Math.min((_b = options.baseIndex) !== null && _b !== void 0 ? _b : 0, placeholderCount - 1));
        templateText = (_c = parts[0]) !== null && _c !== void 0 ? _c : "";
        for (let i = 0; i < placeholderCount; i += 1) {
            const useBase = baseText && targetIndex !== null && i === targetIndex;
            const insertValue = useBase ? baseText : options.placeholder;
            const startIndex = templateText.length;
            templateText += insertValue;
            const endIndex = templateText.length;
            if (!useBase) {
                placeholders.push({ start: startIndex, end: endIndex });
            }
            templateText += (_d = parts[i + 1]) !== null && _d !== void 0 ? _d : "";
        }
    }
    else {
        const built = buildTemplate(template, options.placeholder);
        templateText = built.text;
        placeholders = built.placeholders;
        if (baseText) {
            templateText += ((_e = options.baseSeparator) !== null && _e !== void 0 ? _e : "") + baseText;
        }
    }
    const insertStart = baseRange ? baseRange.start : cursor;
    const insertEnd = baseRange ? baseRange.end : cursor;
    const nextText = text.slice(0, insertStart) + templateText + text.slice(insertEnd);
    if (placeholders.length > 0) {
        const focus = placeholders[0];
        return {
            text: nextText,
            selectionStart: insertStart + focus.start,
            selectionEnd: insertStart + focus.end,
        };
    }
    const cursorPos = insertStart + templateText.length;
    return { text: nextText, selectionStart: cursorPos, selectionEnd: cursorPos };
};
const getMathFieldSelectionRange = (mathField) => {
    const selection = mathField === null || mathField === void 0 ? void 0 : mathField.selection;
    if (selection) {
        if (Array.isArray(selection)) {
            if (selection.length === 2 && typeof selection[0] === "number") {
                return { start: selection[0], end: selection[1] };
            }
            if (Array.isArray(selection[0])) {
                const [start, end] = selection[0];
                return { start, end };
            }
        }
        if (selection.ranges && Array.isArray(selection.ranges) && selection.ranges.length > 0) {
            const [start, end] = selection.ranges[0];
            return { start, end };
        }
    }
    if (typeof (mathField === null || mathField === void 0 ? void 0 : mathField.position) === "number") {
        return { start: mathField.position, end: mathField.position };
    }
    return { start: 0, end: 0 };
};
const offsetToIndex = (mathField, offset) => {
    if (typeof (mathField === null || mathField === void 0 ? void 0 : mathField.getValue) !== "function") {
        return offset;
    }
    const prefix = mathField.getValue(0, offset, "latex");
    return typeof prefix === "string" ? prefix.length : 0;
};
const indexToOffset = (mathField, targetIndex) => {
    if (typeof (mathField === null || mathField === void 0 ? void 0 : mathField.getValue) !== "function") {
        return targetIndex;
    }
    const fullValue = mathField.getValue("latex");
    const fullLength = typeof fullValue === "string" ? fullValue.length : 0;
    const lastOffset = typeof mathField.lastOffset === "number" ? mathField.lastOffset : fullLength;
    if (targetIndex <= 0) {
        return 0;
    }
    if (targetIndex >= fullLength) {
        return lastOffset;
    }
    let low = 0;
    let high = lastOffset;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const length = offsetToIndex(mathField, mid);
        if (length < targetIndex) {
            low = mid + 1;
        }
        else {
            high = mid;
        }
    }
    return low;
};
export { PLACEHOLDER_LATEX, applyScriptToText, applyTemplateToText, getMathFieldSelectionRange, indexToOffset, offsetToIndex, };

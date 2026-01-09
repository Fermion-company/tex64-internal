import { reconstructionBlock } from "./context.js";
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
export const initBlockInputUi = (context, deps) => {
    const { blockToggleButtons, blockForms, blockTableRows, blockTableCols, blockTableGrid, blockTableRaw, blockTableRawInput, blockSettingsButton, blockSettingsModal, blockSettingsClose, blockSettingsBack, blockSettingsPages, blockSettingsMenuItems, blockSettingsInlineOptions, blockSettingsDisplayOptions, blockFormatButton, blockFormatMenu, blockFormatOptions, } = context.dom;
    const MATH_INSERT_MODE_KEY = "tex64.math-insert-mode";
    const MATH_INSERT_INLINE_KEY = "tex64.math-insert-inline-wrap";
    const MATH_INSERT_DISPLAY_KEY = "tex64.math-insert-display-wrap";
    const MATH_INSERT_LEGACY_KEY = "tex64.math-insert-format";
    const MATH_INSERT_MODES = [
        { value: "inline", label: "インライン", shortLabel: "INL" },
        { value: "display", label: "別行", shortLabel: "DSP" },
        { value: "align", label: "align*", shortLabel: "ALN" },
        { value: "gather", label: "gather*", shortLabel: "GTH" },
        { value: "none", label: "囲まない", shortLabel: "RAW" },
    ];
    let activeBlockType = "math";
    let tableEditMode = "grid";
    let mathInput = null;
    let mathInputFallback = null;
    let currentMathValue = "";
    let mathKeyboardVisibilityHandler = () => { };
    let mathInsertMode = "inline";
    let mathInlineWrap = "inline-dollar";
    let mathDisplayWrap = "display-bracket";
    let blockSettingsOpen = false;
    let activeBlockSettingsPage = "menu";
    let formatMenuOpen = false;
    const getFormatLabel = (value) => { var _a, _b; return (_b = (_a = MATH_INSERT_MODES.find((entry) => entry.value === value)) === null || _a === void 0 ? void 0 : _a.label) !== null && _b !== void 0 ? _b : value; };
    const getFormatShortLabel = (value) => { var _a, _b; return (_b = (_a = MATH_INSERT_MODES.find((entry) => entry.value === value)) === null || _a === void 0 ? void 0 : _a.shortLabel) !== null && _b !== void 0 ? _b : value; };
    const setFormatMenuOpen = (open) => {
        formatMenuOpen = open;
        if (blockFormatMenu instanceof HTMLElement) {
            blockFormatMenu.classList.toggle("is-open", open);
            blockFormatMenu.setAttribute("aria-hidden", open ? "false" : "true");
        }
        if (blockFormatButton instanceof HTMLElement) {
            blockFormatButton.setAttribute("aria-expanded", open ? "true" : "false");
        }
    };
    const setMathInsertMode = (value) => {
        mathInsertMode = value;
        if (blockFormatButton instanceof HTMLElement) {
            const fullLabel = getFormatLabel(value);
            blockFormatButton.textContent = getFormatShortLabel(value);
            blockFormatButton.setAttribute("title", fullLabel);
            blockFormatButton.setAttribute("aria-label", `挿入形式: ${fullLabel}`);
        }
        if (Array.isArray(blockFormatOptions)) {
            blockFormatOptions.forEach((option) => {
                const isActive = option.dataset.format === value;
                option.classList.toggle("is-active", isActive);
                option.setAttribute("aria-selected", isActive ? "true" : "false");
            });
        }
        if (typeof localStorage !== "undefined") {
            try {
                localStorage.setItem(MATH_INSERT_MODE_KEY, value);
            }
            catch {
                // ignore storage failures
            }
        }
    };
    const setMathInlineWrap = (value) => {
        mathInlineWrap = value;
        if (Array.isArray(blockSettingsInlineOptions)) {
            blockSettingsInlineOptions.forEach((option) => {
                const isActive = option.dataset.inlineFormat === value;
                option.classList.toggle("is-active", isActive);
                option.setAttribute("aria-pressed", isActive ? "true" : "false");
            });
        }
        if (typeof localStorage !== "undefined") {
            try {
                localStorage.setItem(MATH_INSERT_INLINE_KEY, value);
            }
            catch {
                // ignore storage failures
            }
        }
    };
    const setMathDisplayWrap = (value) => {
        mathDisplayWrap = value;
        if (Array.isArray(blockSettingsDisplayOptions)) {
            blockSettingsDisplayOptions.forEach((option) => {
                const isActive = option.dataset.displayFormat === value;
                option.classList.toggle("is-active", isActive);
                option.setAttribute("aria-pressed", isActive ? "true" : "false");
            });
        }
        if (typeof localStorage !== "undefined") {
            try {
                localStorage.setItem(MATH_INSERT_DISPLAY_KEY, value);
            }
            catch {
                // ignore storage failures
            }
        }
    };
    const loadMathInsertSettings = () => {
        var _a;
        if (typeof localStorage === "undefined") {
            setMathInsertMode(mathInsertMode);
            setMathInlineWrap(mathInlineWrap);
            setMathDisplayWrap(mathDisplayWrap);
            return;
        }
        const storedMode = localStorage.getItem(MATH_INSERT_MODE_KEY);
        const storedInline = localStorage.getItem(MATH_INSERT_INLINE_KEY);
        const storedDisplay = localStorage.getItem(MATH_INSERT_DISPLAY_KEY);
        const legacy = localStorage.getItem(MATH_INSERT_LEGACY_KEY);
        const modeMatch = (_a = MATH_INSERT_MODES.find((entry) => entry.value === storedMode)) === null || _a === void 0 ? void 0 : _a.value;
        const inlineMatch = storedInline === "inline-dollar" || storedInline === "inline-paren"
            ? storedInline
            : null;
        const displayMatch = storedDisplay === "display-dollar" || storedDisplay === "display-bracket"
            ? storedDisplay
            : null;
        let resolvedMode = modeMatch !== null && modeMatch !== void 0 ? modeMatch : mathInsertMode;
        let resolvedInline = inlineMatch !== null && inlineMatch !== void 0 ? inlineMatch : mathInlineWrap;
        let resolvedDisplay = displayMatch !== null && displayMatch !== void 0 ? displayMatch : mathDisplayWrap;
        if (!modeMatch && legacy) {
            if (legacy === "none") {
                resolvedMode = "none";
            }
            else if (legacy === "inline-dollar" || legacy === "inline-paren") {
                resolvedMode = "inline";
                resolvedInline = legacy;
            }
            else if (legacy === "display-dollar" || legacy === "display-bracket") {
                resolvedMode = "display";
                resolvedDisplay = legacy;
            }
        }
        setMathInsertMode(resolvedMode);
        setMathInlineWrap(resolvedInline);
        setMathDisplayWrap(resolvedDisplay);
    };
    const updateMathPreview = () => {
        // preview disabled
    };
    const setMathKeyboardVisibilityHandler = (handler) => {
        mathKeyboardVisibilityHandler = handler;
    };
    const setTableEditMode = (mode) => {
        tableEditMode = mode;
        if (blockTableGrid instanceof HTMLElement) {
            blockTableGrid.classList.toggle("is-hidden", mode === "raw");
        }
        if (blockTableRaw instanceof HTMLElement) {
            blockTableRaw.classList.toggle("is-active", mode === "raw");
        }
    };
    const setActiveBlockType = (type) => {
        const resolvedType = deps.enableTableBlocks ? type : "math";
        activeBlockType = resolvedType;
        blockToggleButtons.forEach((button) => {
            const isActive = button.dataset.block === resolvedType;
            button.classList.toggle("is-active", isActive);
        });
        blockForms.forEach((form) => {
            const isActive = form.dataset.form === resolvedType;
            form.classList.toggle("is-active", isActive);
        });
        mathKeyboardVisibilityHandler();
        if (resolvedType === "math") {
            updateMathPreview();
            setTableEditMode("grid");
        }
        else if (deps.getActiveBlockEditMode() !== "detected") {
            setTableEditMode("grid");
        }
    };
    const isMathInputFocused = () => {
        if (!mathInput) {
            return false;
        }
        if (document.activeElement === mathInput) {
            return true;
        }
        if (mathInput.classList.contains("is-focused")) {
            return true;
        }
        if (typeof mathInput.matches === "function" && mathInput.matches(":focus-within")) {
            return true;
        }
        return false;
    };
    const readMathFieldValue = (mathField) => {
        if (!mathField) {
            return "";
        }
        if (typeof mathField.getValue === "function") {
            const nextValue = mathField.getValue("latex");
            if (typeof nextValue === "string") {
                return nextValue;
            }
        }
        if (typeof mathField.value === "string") {
            return mathField.value;
        }
        return "";
    };
    const writeMathFieldValue = (mathField, value) => {
        if (!mathField) {
            return;
        }
        if (typeof mathField.setValue === "function") {
            mathField.setValue(value);
            return;
        }
        if ("value" in mathField) {
            mathField.value = value;
        }
    };
    const setMathInputElement = (element) => {
        mathInput = element;
        if (!mathInput) {
            return;
        }
        if (!currentMathValue) {
            return;
        }
        if (mathInput instanceof HTMLTextAreaElement) {
            mathInput.value = currentMathValue;
            return;
        }
        writeMathFieldValue(mathInput, currentMathValue);
    };
    const setMathInputFallback = (value) => {
        mathInputFallback = typeof value === "string" ? value : null;
    };
    const getMathInputFallback = () => mathInputFallback;
    const getMathInputValue = () => {
        if (mathInputFallback !== null) {
            return mathInputFallback;
        }
        if (!mathInput) {
            return "";
        }
        if (mathInput instanceof HTMLElement && mathInput.tagName.toLowerCase() === "math-field") {
            currentMathValue = readMathFieldValue(mathInput);
            return currentMathValue;
        }
        if (mathInput instanceof HTMLTextAreaElement) {
            currentMathValue = mathInput.value;
            return currentMathValue;
        }
        const value = mathInput.value;
        return typeof value === "string" ? value : "";
    };
    const setMathInputValue = (value) => {
        currentMathValue = value;
        if (!mathInput) {
            return;
        }
        if (mathInput instanceof HTMLTextAreaElement) {
            mathInput.value = value;
            return;
        }
        writeMathFieldValue(mathInput, value);
    };
    const getTableRawValue = () => {
        if (blockTableRawInput instanceof HTMLTextAreaElement) {
            return blockTableRawInput.value;
        }
        return "";
    };
    const setTableRawValue = (value) => {
        if (blockTableRawInput instanceof HTMLTextAreaElement) {
            blockTableRawInput.value = value;
        }
    };
    const attachMathInputListener = () => {
        if (!mathInput) {
            return;
        }
        mathInput.addEventListener("input", () => {
            if (mathInput instanceof HTMLTextAreaElement) {
                currentMathValue = mathInput.value;
            }
            else {
                currentMathValue = readMathFieldValue(mathInput);
            }
        });
    };
    const attachMathFieldEvents = (mathfield) => {
        const closeMathFieldMenu = () => {
            var _a;
            const internalMenu = (_a = mathfield._mathfield) === null || _a === void 0 ? void 0 : _a.menu;
            if (internalMenu && typeof internalMenu.hide === "function") {
                if (internalMenu.state && internalMenu.state !== "closed") {
                    internalMenu.hide();
                    return;
                }
                const element = internalMenu.element;
                if (element === null || element === void 0 ? void 0 : element.isConnected) {
                    internalMenu.hide();
                    return;
                }
            }
            const executeCommand = mathfield
                .executeCommand;
            if (typeof executeCommand === "function") {
                const menuElement = document.querySelector("menu.ui-menu-container");
                if (menuElement) {
                    executeCommand.call(mathfield, "toggleContextMenu");
                }
            }
        };
        const syncMathFieldValue = () => {
            currentMathValue = readMathFieldValue(mathfield);
        };
        mathfield.addEventListener("input", syncMathFieldValue);
        mathfield.addEventListener("change", syncMathFieldValue);
        mathfield.addEventListener("keydown", (e) => {
            var _a;
            if (e.key === "Escape") {
                mathfield.blur();
                return;
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                (_a = deps.onMathFieldSubmit) === null || _a === void 0 ? void 0 : _a.call(deps);
                return;
            }
            if (e.key === "Tab")
                return;
            e.stopPropagation();
        });
        mathfield.addEventListener("focus", () => {
            mathKeyboardVisibilityHandler();
            mathfield.classList.add("is-focused");
        });
        mathfield.addEventListener("blur", () => {
            mathfield.classList.remove("is-focused");
        });
        mathfield.addEventListener("compositionstart", (e) => e.stopPropagation());
        mathfield.addEventListener("compositionend", (e) => e.stopPropagation());
    };
    const buildTableSnippetFromRaw = (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
            return "";
        }
        const context = deps.getActiveBlockContext();
        if ((context === null || context === void 0 ? void 0 : context.type) === "table") {
            return reconstructionBlock(context, raw);
        }
        if (trimmed.startsWith("\\begin{")) {
            return trimmed;
        }
        return ["\\begin{tabular}{|c|}", trimmed, "\\end{tabular}", ""].join("\n");
    };
    const buildMathSnippet = (formula) => {
        const context = deps.getActiveBlockContext();
        const activeMathEditCell = deps.getActiveMathEditCell();
        if ((context === null || context === void 0 ? void 0 : context.type) === "math") {
            if (activeMathEditCell && activeMathEditCell.context === context) {
                const replacement = activeMathEditCell.range.leading + formula + activeMathEditCell.range.trailing;
                const updatedInner = activeMathEditCell.inner.slice(0, activeMathEditCell.range.start) +
                    replacement +
                    activeMathEditCell.inner.slice(activeMathEditCell.range.end);
                return reconstructionBlock(context, updatedInner);
            }
            return reconstructionBlock(context, formula);
        }
        const trimmed = formula.trim();
        if (!trimmed) {
            return "";
        }
        if (trimmed.startsWith("$") && trimmed.endsWith("$")) {
            return trimmed;
        }
        if (trimmed.startsWith("\\(") && trimmed.endsWith("\\)")) {
            return trimmed;
        }
        if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
            return trimmed;
        }
        if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
            return trimmed;
        }
        if (trimmed.startsWith("\\begin{")) {
            return trimmed;
        }
        switch (mathInsertMode) {
            case "inline":
                if (mathInlineWrap === "inline-paren") {
                    return ["\\(", trimmed, "\\)"].join("");
                }
                return `$${trimmed}$`;
            case "display":
                if (mathDisplayWrap === "display-dollar") {
                    return `$$${trimmed}$$`;
                }
                return `\\[${trimmed}\\]`;
            case "align":
                return ["\\begin{align*}", trimmed, "\\end{align*}"].join("\n");
            case "gather":
                return ["\\begin{gather*}", trimmed, "\\end{gather*}"].join("\n");
            case "none":
                return trimmed;
            default:
                return `$${trimmed}$`;
        }
    };
    const parseTableSize = () => {
        const rows = blockTableRows instanceof HTMLInputElement
            ? Number.parseInt(blockTableRows.value, 10)
            : NaN;
        const cols = blockTableCols instanceof HTMLInputElement
            ? Number.parseInt(blockTableCols.value, 10)
            : NaN;
        if (!Number.isFinite(rows) || rows < 1 || rows > 20) {
            return null;
        }
        if (!Number.isFinite(cols) || cols < 1 || cols > 12) {
            return null;
        }
        return { rows, cols };
    };
    const buildTableSnippet = (rows, cols) => {
        const columnSpec = `|${"c|".repeat(cols)}`;
        const rowCells = Array.from({ length: cols }, () => " ").join(" & ");
        const lines = [];
        lines.push(`\\begin{tabular}{${columnSpec}}`);
        for (let row = 0; row < rows; row += 1) {
            lines.push("\\hline");
            lines.push(`${rowCells} \\\\`);
        }
        lines.push("\\hline");
        lines.push("\\end{tabular}");
        lines.push("");
        return lines.join("\n");
    };
    const getBlockDraft = () => {
        if (activeBlockType === "math") {
            const formula = getMathInputValue();
            const snippet = buildMathSnippet(formula);
            if (!snippet.trim()) {
                return null;
            }
            return { snippet, content: { formula: formula.trim() } };
        }
        if (tableEditMode === "raw") {
            const raw = getTableRawValue();
            const snippet = buildTableSnippetFromRaw(raw);
            if (!snippet.trim()) {
                return null;
            }
            return { snippet, content: { raw } };
        }
        const size = parseTableSize();
        if (!size) {
            return null;
        }
        return {
            snippet: buildTableSnippet(size.rows, size.cols),
            content: { rows: size.rows, cols: size.cols },
        };
    };
    const applyScript = (kind, values = {}) => {
        var _a, _b, _c;
        if (!mathInput) {
            return false;
        }
        if (mathInput instanceof HTMLTextAreaElement) {
            const start = (_a = mathInput.selectionStart) !== null && _a !== void 0 ? _a : mathInput.value.length;
            const end = (_b = mathInput.selectionEnd) !== null && _b !== void 0 ? _b : mathInput.value.length;
            const result = applyScriptToText(mathInput.value, { start, end }, kind, {
                placeholder: "",
                base: values.base,
                subValue: values.subValue,
                supValue: values.supValue,
            });
            mathInput.value = result.text;
            mathInput.setSelectionRange(result.selectionStart, result.selectionEnd);
            mathInput.focus();
            currentMathValue = result.text;
            mathInput.dispatchEvent(new Event("input", { bubbles: true }));
            updateMathPreview();
            return true;
        }
        const mathField = mathInput;
        const text = readMathFieldValue(mathField);
        const offsets = getMathFieldSelectionRange(mathField);
        const selection = {
            start: offsetToIndex(mathField, offsets.start),
            end: offsetToIndex(mathField, offsets.end),
        };
        const result = applyScriptToText(text, selection, kind, {
            placeholder: PLACEHOLDER_LATEX,
            base: values.base,
            subValue: values.subValue,
            supValue: values.supValue,
        });
        writeMathFieldValue(mathField, result.text);
        currentMathValue = result.text;
        const startOffset = indexToOffset(mathField, result.selectionStart);
        const endOffset = indexToOffset(mathField, result.selectionEnd);
        if (startOffset === endOffset) {
            mathField.selection = startOffset;
        }
        else {
            mathField.selection = { ranges: [[startOffset, endOffset]] };
        }
        (_c = mathField.focus) === null || _c === void 0 ? void 0 : _c.call(mathField);
        mathInput.dispatchEvent(new Event("input", { bubbles: true }));
        updateMathPreview();
        return true;
    };
    const applyTemplate = (template, options) => {
        var _a, _b, _c;
        if (!mathInput) {
            return false;
        }
        if (mathInput instanceof HTMLTextAreaElement) {
            const start = (_a = mathInput.selectionStart) !== null && _a !== void 0 ? _a : mathInput.value.length;
            const end = (_b = mathInput.selectionEnd) !== null && _b !== void 0 ? _b : mathInput.value.length;
            const result = applyTemplateToText(mathInput.value, { start, end }, template, {
                placeholder: "",
                baseMode: options.mode,
                baseIndex: options.target,
                baseSeparator: options.separator,
                baseScope: options.scope,
            });
            mathInput.value = result.text;
            mathInput.setSelectionRange(result.selectionStart, result.selectionEnd);
            mathInput.focus();
            currentMathValue = result.text;
            mathInput.dispatchEvent(new Event("input", { bubbles: true }));
            updateMathPreview();
            return true;
        }
        const mathField = mathInput;
        const text = readMathFieldValue(mathField);
        const offsets = getMathFieldSelectionRange(mathField);
        const selection = {
            start: offsetToIndex(mathField, offsets.start),
            end: offsetToIndex(mathField, offsets.end),
        };
        const result = applyTemplateToText(text, selection, template, {
            placeholder: PLACEHOLDER_LATEX,
            baseMode: options.mode,
            baseIndex: options.target,
            baseSeparator: options.separator,
            baseScope: options.scope,
        });
        writeMathFieldValue(mathField, result.text);
        currentMathValue = result.text;
        const startOffset = indexToOffset(mathField, result.selectionStart);
        const endOffset = indexToOffset(mathField, result.selectionEnd);
        if (startOffset === endOffset) {
            mathField.selection = startOffset;
        }
        else {
            mathField.selection = { ranges: [[startOffset, endOffset]] };
        }
        (_c = mathField.focus) === null || _c === void 0 ? void 0 : _c.call(mathField);
        mathInput.dispatchEvent(new Event("input", { bubbles: true }));
        updateMathPreview();
        return true;
    };
    const insertMathKey = (key) => {
        var _a, _b, _c, _d, _e, _f;
        if (!mathInput) {
            return;
        }
        if (key.scriptKind) {
            const values = {
                base: key.scriptBase,
                subValue: key.scriptSubValue,
                supValue: key.scriptSupValue,
            };
            if (key.scriptKind === "sub") {
                values.subValue = (_a = key.scriptSubValue) !== null && _a !== void 0 ? _a : key.scriptValue;
            }
            if (key.scriptKind === "sup") {
                values.supValue = (_b = key.scriptSupValue) !== null && _b !== void 0 ? _b : key.scriptValue;
            }
            if (applyScript(key.scriptKind, values)) {
                return;
            }
        }
        if (key.templateKind) {
            if (applyTemplate(key.latex, {
                mode: key.templateKind,
                target: key.templateTarget,
                separator: key.templateSeparator,
                scope: key.templateScope,
            })) {
                return;
            }
        }
        const mathField = mathInput;
        (_c = mathField.focus) === null || _c === void 0 ? void 0 : _c.call(mathField);
        if (typeof mathField.executeCommand === "function") {
            try {
                mathField.executeCommand("insert", key.latex);
                updateMathPreview();
                return;
            }
            catch (e) {
                console.warn("executeCommand failed:", e);
            }
        }
        if (typeof mathField.insert === "function") {
            mathField.insert(key.latex, { focus: true, feedback: false });
            updateMathPreview();
            return;
        }
        const insertValue = (_d = key.fallback) !== null && _d !== void 0 ? _d : key.latex;
        if (mathInput instanceof HTMLTextAreaElement) {
            const start = (_e = mathInput.selectionStart) !== null && _e !== void 0 ? _e : mathInput.value.length;
            const end = (_f = mathInput.selectionEnd) !== null && _f !== void 0 ? _f : mathInput.value.length;
            mathInput.value =
                mathInput.value.slice(0, start) + insertValue + mathInput.value.slice(end);
            const nextPos = start + insertValue.length;
            mathInput.setSelectionRange(nextPos, nextPos);
            mathInput.focus();
        }
        else if (typeof mathField.value === "string") {
            mathField.value += insertValue;
        }
        mathInput.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const setBlockSettingsPage = (page) => {
        activeBlockSettingsPage = page;
        if (Array.isArray(blockSettingsPages)) {
            blockSettingsPages.forEach((view) => {
                const isActive = view.dataset.blockSettingsPage === page;
                view.classList.toggle("is-active", isActive);
            });
        }
    };
    const setBlockSettingsOpen = (open) => {
        blockSettingsOpen = open;
        if (blockSettingsModal instanceof HTMLElement) {
            blockSettingsModal.classList.toggle("is-open", open);
            blockSettingsModal.setAttribute("aria-hidden", open ? "false" : "true");
        }
        if (blockSettingsButton instanceof HTMLElement) {
            blockSettingsButton.setAttribute("aria-expanded", open ? "true" : "false");
        }
        if (open) {
            setBlockSettingsPage("menu");
        }
    };
    if (blockSettingsButton instanceof HTMLButtonElement) {
        blockSettingsButton.addEventListener("click", () => {
            setBlockSettingsOpen(!blockSettingsOpen);
        });
    }
    if (blockSettingsClose instanceof HTMLButtonElement) {
        blockSettingsClose.addEventListener("click", () => {
            setBlockSettingsOpen(false);
        });
    }
    if (blockSettingsModal instanceof HTMLElement) {
        blockSettingsModal.addEventListener("click", (event) => {
            if (event.target === blockSettingsModal) {
                setBlockSettingsOpen(false);
            }
        });
    }
    if (Array.isArray(blockSettingsMenuItems)) {
        blockSettingsMenuItems.forEach((item) => {
            item.addEventListener("click", () => {
                const target = item.dataset.blockSettingsTarget;
                if (target === "insert-format") {
                    setBlockSettingsPage("insert-format");
                }
            });
        });
    }
    if (blockSettingsBack instanceof HTMLButtonElement) {
        blockSettingsBack.addEventListener("click", () => {
            setBlockSettingsPage("menu");
        });
    }
    if (Array.isArray(blockSettingsInlineOptions)) {
        blockSettingsInlineOptions.forEach((option) => {
            option.addEventListener("click", () => {
                const next = option.dataset.inlineFormat;
                if (!next) {
                    return;
                }
                setMathInlineWrap(next);
            });
        });
    }
    if (Array.isArray(blockSettingsDisplayOptions)) {
        blockSettingsDisplayOptions.forEach((option) => {
            option.addEventListener("click", () => {
                const next = option.dataset.displayFormat;
                if (!next) {
                    return;
                }
                setMathDisplayWrap(next);
            });
        });
    }
    if (blockFormatButton instanceof HTMLButtonElement) {
        blockFormatButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            setFormatMenuOpen(!formatMenuOpen);
        });
    }
    if (blockFormatMenu instanceof HTMLElement) {
        blockFormatMenu.addEventListener("click", (event) => {
            var _a;
            const target = (_a = event.target) === null || _a === void 0 ? void 0 : _a.closest(".block-format-option");
            if (!target) {
                return;
            }
            const nextFormat = target.dataset.format;
            if (!nextFormat) {
                return;
            }
            setMathInsertMode(nextFormat);
            setFormatMenuOpen(false);
        });
    }
    document.addEventListener("click", (event) => {
        if (!formatMenuOpen) {
            return;
        }
        const target = event.target;
        if ((blockFormatButton === null || blockFormatButton === void 0 ? void 0 : blockFormatButton.contains(target)) || (blockFormatMenu === null || blockFormatMenu === void 0 ? void 0 : blockFormatMenu.contains(target))) {
            return;
        }
        setFormatMenuOpen(false);
    });
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
            return;
        }
        if (blockSettingsOpen) {
            setBlockSettingsOpen(false);
            return;
        }
        if (formatMenuOpen) {
            setFormatMenuOpen(false);
        }
    });
    blockToggleButtons.forEach((button) => {
        button.addEventListener("click", () => {
            const type = button.dataset.block === "table" ? "table" : "math";
            setActiveBlockType(type);
        });
    });
    if (blockTableRows instanceof HTMLInputElement) {
        blockTableRows.addEventListener("input", () => { });
    }
    if (blockTableCols instanceof HTMLInputElement) {
        blockTableCols.addEventListener("input", () => { });
    }
    if (blockTableRawInput instanceof HTMLTextAreaElement) {
        blockTableRawInput.addEventListener("input", () => { });
    }
    loadMathInsertSettings();
    return {
        getActiveBlockType: () => activeBlockType,
        setActiveBlockType,
        setMathKeyboardVisibilityHandler,
        setTableEditMode,
        getMathInputValue,
        setMathInputValue,
        getTableRawValue,
        setTableRawValue,
        getBlockDraft,
        insertMathKey,
        setMathInputElement,
        setMathInputFallback,
        getMathInputFallback,
        isMathInputFocused,
        attachMathInputListener,
        attachMathFieldEvents,
        updateMathPreview,
    };
};

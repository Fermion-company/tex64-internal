import { indexToOffset as indexToMathFieldOffset } from "./math-input-utils.js";
import { getMathfieldInternalModel } from "../../math/mathfield-private-adapter.js";
export const readSelectionRange = (mathfieldApi) => {
    const selection = mathfieldApi.selection;
    if (Array.isArray(selection) && selection.length >= 2) {
        return { start: selection[0], end: selection[1] };
    }
    const ranges = selection && !Array.isArray(selection) ? selection.ranges : undefined;
    if (Array.isArray(ranges) && ranges.length > 0 && Array.isArray(ranges[0])) {
        return { start: ranges[0][0], end: ranges[0][1] };
    }
    return null;
};
const setSelectionCollapsed = (mathfieldApi, position) => {
    if (typeof mathfieldApi.setSelection === "function") {
        mathfieldApi.setSelection(position, position);
        return;
    }
    if ("selection" in mathfieldApi) {
        mathfieldApi.selection = [position, position];
        return;
    }
    if (typeof mathfieldApi.position === "number") {
        mathfieldApi.position = position;
        return;
    }
    const internalModel = getMathfieldInternalModel(mathfieldApi);
    if (internalModel && typeof internalModel.setSelection === "function") {
        internalModel.setSelection(position, position);
    }
};
export const setSelectionRange = (mathfieldApi, start, end) => {
    if (typeof mathfieldApi.setSelection === "function") {
        mathfieldApi.setSelection(start, end);
        return;
    }
    if ("selection" in mathfieldApi) {
        mathfieldApi.selection = [start, end];
        return;
    }
    const internalModel = getMathfieldInternalModel(mathfieldApi);
    if (internalModel && typeof internalModel.setSelection === "function") {
        internalModel.setSelection(start, end);
        return;
    }
    if (typeof mathfieldApi.position === "number") {
        mathfieldApi.position = end;
    }
};
const getInternalPlaceholderRanges = (mathfieldApi) => {
    const model = getMathfieldInternalModel(mathfieldApi);
    if (!model || !Array.isArray(model.atoms) || typeof model.offsetOf !== "function") {
        return [];
    }
    const lastOffset = typeof mathfieldApi.lastOffset === "number"
        ? mathfieldApi.lastOffset
        : typeof model.lastOffset === "number"
            ? model.lastOffset
            : null;
    const seenPrompts = new Set();
    const seenPlaceholders = new Set();
    const promptRanges = [];
    const placeholderRanges = [];
    for (const atom of model.atoms) {
        if (!atom || typeof atom !== "object")
            continue;
        const type = atom.type;
        let start = null;
        let end = null;
        if (type === "prompt") {
            if (typeof model.getBranchRange === "function") {
                const offset = model.offsetOf(atom);
                const range = model.getBranchRange(offset, "body");
                if (Array.isArray(range) && range.length >= 2) {
                    start = Number(range[0]);
                    end = Number(range[1]);
                }
            }
        }
        else if (type === "placeholder") {
            const offset = model.offsetOf(atom);
            start = Number(offset) - 1;
            end = Number(offset);
        }
        if (start === null || end === null)
            continue;
        if (!Number.isFinite(start) || !Number.isFinite(end))
            continue;
        if (start < 0 || end < 0)
            continue;
        if (lastOffset !== null && start <= 0 && end >= lastOffset)
            continue;
        const key = `${start}:${end}`;
        if (type === "prompt") {
            if (seenPrompts.has(key))
                continue;
            seenPrompts.add(key);
            promptRanges.push({ start, end });
        }
        else if (type === "placeholder") {
            if (seenPlaceholders.has(key))
                continue;
            seenPlaceholders.add(key);
            placeholderRanges.push({ start, end });
        }
    }
    const ranges = promptRanges.length > 0 ? promptRanges : placeholderRanges;
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    return ranges;
};
const PLACEHOLDER_TOKEN_REGEX = /\\placeholder(?:\[[^\]]*\])?\{(?:[^{}]|\\.)*\}/g;
const getLiteralPlaceholderRanges = (mathfieldApi) => {
    const reader = mathfieldApi;
    if (typeof reader.getValue !== "function") {
        return [];
    }
    const lastOffset = typeof mathfieldApi.lastOffset === "number" && mathfieldApi.lastOffset > 0
        ? mathfieldApi.lastOffset
        : null;
    if (lastOffset === null) {
        return [];
    }
    let latex = "";
    try {
        const value = reader.getValue(0, lastOffset, "latex");
        if (typeof value === "string") {
            latex = value;
        }
    }
    catch {
        return [];
    }
    if (!latex || !latex.includes("\\placeholder")) {
        return [];
    }
    const seen = new Set();
    const ranges = [];
    let match = PLACEHOLDER_TOKEN_REGEX.exec(latex);
    while (match) {
        const startIndex = match.index;
        const endIndex = startIndex + match[0].length;
        const start = indexToMathFieldOffset(mathfieldApi, startIndex);
        const end = indexToMathFieldOffset(mathfieldApi, endIndex);
        if (Number.isFinite(start) &&
            Number.isFinite(end) &&
            start >= 0 &&
            end > start &&
            !(start <= 0 && end >= lastOffset)) {
            const key = `${start}:${end}`;
            if (!seen.has(key)) {
                seen.add(key);
                ranges.push({ start, end });
            }
        }
        match = PLACEHOLDER_TOKEN_REGEX.exec(latex);
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    return ranges;
};
const getPromptRanges = (mathfieldApi) => {
    var _a;
    const internalRanges = getInternalPlaceholderRanges(mathfieldApi);
    if (internalRanges.length > 0) {
        return internalRanges;
    }
    const literalRanges = getLiteralPlaceholderRanges(mathfieldApi);
    if (literalRanges.length > 0) {
        return literalRanges;
    }
    if (typeof mathfieldApi.getPrompts !== "function") {
        return [];
    }
    if (typeof mathfieldApi.getPromptRange !== "function") {
        return [];
    }
    try {
        const ids = (_a = mathfieldApi.getPrompts()) !== null && _a !== void 0 ? _a : [];
        const lastOffset = typeof mathfieldApi.lastOffset === "number" ? mathfieldApi.lastOffset : null;
        const seen = new Set();
        const ranges = [];
        for (const id of ids) {
            const range = mathfieldApi.getPromptRange(id);
            if (!Array.isArray(range) || range.length < 2) {
                continue;
            }
            const start = Number(range[0]);
            const end = Number(range[1]);
            if (!Number.isFinite(start) || !Number.isFinite(end)) {
                continue;
            }
            if (lastOffset !== null && start <= 0 && end >= lastOffset) {
                continue;
            }
            const key = `${start}:${end}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            ranges.push({ start, end });
        }
        ranges.sort((a, b) => a.start - b.start || a.end - b.end);
        if (ranges.length > 0) {
            return ranges;
        }
    }
    catch {
        return [];
    }
    if (typeof mathfieldApi.executeCommand !== "function") {
        return [];
    }
    const snapshot = readSelectionRange(mathfieldApi);
    const snapshotPosition = typeof mathfieldApi.position === "number" ? mathfieldApi.position : null;
    const lastOffset = typeof mathfieldApi.lastOffset === "number" ? mathfieldApi.lastOffset : null;
    const ranges = [];
    const fallbackSeen = new Set();
    try {
        setSelectionCollapsed(mathfieldApi, 0);
        let moved = !!mathfieldApi.executeCommand("moveToNextPlaceholder");
        let guard = 0;
        while (moved && guard < 50) {
            const range = readSelectionRange(mathfieldApi);
            if (!range || range.end <= range.start) {
                break;
            }
            if (!(lastOffset !== null && range.start <= 0 && range.end >= lastOffset)) {
                const key = `${range.start}:${range.end}`;
                if (fallbackSeen.has(key)) {
                    break;
                }
                fallbackSeen.add(key);
                ranges.push(range);
            }
            moved = !!mathfieldApi.executeCommand("moveToNextPlaceholder");
            guard += 1;
        }
    }
    catch {
        // ignore
    }
    finally {
        if (snapshot) {
            setSelectionRange(mathfieldApi, snapshot.start, snapshot.end);
        }
        else if (snapshotPosition !== null) {
            setSelectionCollapsed(mathfieldApi, snapshotPosition);
        }
    }
    if (ranges.length > 0) {
        return ranges;
    }
    return literalRanges;
};
export const createPlaceholderNavigator = () => {
    let lastPlaceholderIndex = null;
    const moveMathFieldPlaceholder = (mathfieldHost, direction) => {
        var _a, _b, _c, _d;
        const mathfieldApi = mathfieldHost;
        const selection = readSelectionRange(mathfieldApi);
        const selectionStart = (_a = selection === null || selection === void 0 ? void 0 : selection.start) !== null && _a !== void 0 ? _a : (typeof mathfieldApi.position === "number" ? mathfieldApi.position : 0);
        const selectionEnd = (_b = selection === null || selection === void 0 ? void 0 : selection.end) !== null && _b !== void 0 ? _b : selectionStart;
        const snapshotRange = readSelectionRange(mathfieldApi);
        const snapshotPosition = typeof mathfieldApi.position === "number" ? mathfieldApi.position : null;
        const restoreSnapshot = () => {
            if (snapshotRange) {
                setSelectionRange(mathfieldApi, snapshotRange.start, snapshotRange.end);
            }
            else if (snapshotPosition !== null) {
                setSelectionCollapsed(mathfieldApi, snapshotPosition);
            }
        };
        const isFullSelection = (range) => {
            if (!range) {
                return false;
            }
            if (typeof mathfieldApi.lastOffset !== "number") {
                return false;
            }
            return range.start <= 0 && range.end >= mathfieldApi.lastOffset;
        };
        const moveByCommandSkippingFull = (commandValue, dir) => {
            if (typeof mathfieldApi.executeCommand !== "function") {
                return false;
            }
            let guard = 0;
            while (guard < 20) {
                let moved = false;
                try {
                    moved = !!mathfieldApi.executeCommand(commandValue);
                }
                catch {
                    moved = false;
                }
                if (!moved) {
                    return false;
                }
                const afterRange = readSelectionRange(mathfieldApi);
                if (!isFullSelection(afterRange)) {
                    return true;
                }
                if (afterRange) {
                    const collapseTarget = dir === "backward" ? afterRange.end : afterRange.start;
                    setSelectionCollapsed(mathfieldApi, collapseTarget);
                }
                guard += 1;
            }
            return false;
        };
        const range = selection;
        const promptRanges = getPromptRanges(mathfieldApi);
        const selectionOverlapsPrompt = promptRanges.length === 0
            ? false
            : promptRanges.some((item) => {
                if (!range) {
                    return selectionStart >= item.start && selectionStart <= item.end;
                }
                return range.end >= item.start && range.start <= item.end;
            });
        const lastOffsetValue = typeof mathfieldApi.lastOffset === "number" ? mathfieldApi.lastOffset : null;
        const atStart = selectionStart <= 0 && selectionEnd <= 0;
        const atEnd = lastOffsetValue !== null &&
            selectionStart >= lastOffsetValue &&
            selectionEnd >= lastOffsetValue;
        const shouldUsePromptNavigation = promptRanges.length > 0 &&
            (isFullSelection(range) ||
                selectionOverlapsPrompt ||
                (direction === "forward" ? atStart : atEnd));
        const moveWithinPrompts = () => {
            var _a, _b;
            if (promptRanges.length === 0) {
                return false;
            }
            if (typeof lastPlaceholderIndex === "number" &&
                (lastPlaceholderIndex < 0 || lastPlaceholderIndex >= promptRanges.length)) {
                lastPlaceholderIndex = null;
            }
            if (!selectionOverlapsPrompt && (atStart || atEnd)) {
                lastPlaceholderIndex = null;
            }
            const findContaining = (pos) => promptRanges.findIndex((range2) => pos >= range2.start && pos <= range2.end);
            let currentIndex = -1;
            if (range && !isFullSelection(range)) {
                currentIndex = promptRanges.findIndex((item) => item.start === range.start && item.end === range.end);
                if (currentIndex < 0) {
                    currentIndex = findContaining(range.start);
                }
            }
            else if (!range || range.start === range.end) {
                currentIndex = findContaining(selectionStart);
            }
            if (currentIndex >= 0) {
                lastPlaceholderIndex = currentIndex;
            }
            else if (typeof lastPlaceholderIndex === "number") {
                currentIndex = lastPlaceholderIndex;
            }
            let targetIndex = -1;
            if (direction === "forward") {
                if (currentIndex >= 0) {
                    targetIndex = (currentIndex + 1) % promptRanges.length;
                }
                else {
                    targetIndex = promptRanges.findIndex((range2) => range2.start >= selectionStart);
                    if (targetIndex < 0) {
                        targetIndex = 0;
                    }
                }
            }
            else {
                if (currentIndex >= 0) {
                    targetIndex = (currentIndex - 1 + promptRanges.length) % promptRanges.length;
                }
                else {
                    for (let i = promptRanges.length - 1; i >= 0; i -= 1) {
                        if (promptRanges[i].end <= selectionEnd) {
                            targetIndex = i;
                            break;
                        }
                    }
                    if (targetIndex < 0) {
                        targetIndex = promptRanges.length - 1;
                    }
                }
            }
            const target = promptRanges[targetIndex];
            if (target) {
                setSelectionRange(mathfieldApi, target.start, target.end);
                const afterRange = readSelectionRange(mathfieldApi);
                if (!isFullSelection(afterRange)) {
                    lastPlaceholderIndex = targetIndex;
                    (_a = mathfieldApi.focus) === null || _a === void 0 ? void 0 : _a.call(mathfieldApi);
                    return true;
                }
                for (let offset = 1; offset < promptRanges.length; offset += 1) {
                    const nextIndex = direction === "forward"
                        ? (targetIndex + offset) % promptRanges.length
                        : (targetIndex - offset + promptRanges.length) % promptRanges.length;
                    const nextTarget = promptRanges[nextIndex];
                    if (!nextTarget)
                        continue;
                    setSelectionRange(mathfieldApi, nextTarget.start, nextTarget.end);
                    const nextRange = readSelectionRange(mathfieldApi);
                    if (!isFullSelection(nextRange)) {
                        lastPlaceholderIndex = nextIndex;
                        (_b = mathfieldApi.focus) === null || _b === void 0 ? void 0 : _b.call(mathfieldApi);
                        return true;
                    }
                }
            }
            return false;
        };
        if (shouldUsePromptNavigation) {
            if (moveWithinPrompts()) {
                return true;
            }
            restoreSnapshot();
        }
        if (range && range.start !== range.end) {
            const target = direction === "backward" ? range.end : range.start;
            setSelectionCollapsed(mathfieldApi, target);
        }
        const charCommand = direction === "backward" ? "moveToPreviousChar" : "moveToNextChar";
        if (moveByCommandSkippingFull(charCommand, direction)) {
            (_c = mathfieldApi.focus) === null || _c === void 0 ? void 0 : _c.call(mathfieldApi);
            return true;
        }
        const command = direction === "backward" ? "moveToPreviousPlaceholder" : "moveToNextPlaceholder";
        if (moveByCommandSkippingFull(command, direction)) {
            (_d = mathfieldApi.focus) === null || _d === void 0 ? void 0 : _d.call(mathfieldApi);
            return true;
        }
        if (direction === "forward") {
            setSelectionCollapsed(mathfieldApi, 0);
        }
        else if (typeof mathfieldApi.lastOffset === "number") {
            setSelectionCollapsed(mathfieldApi, mathfieldApi.lastOffset);
        }
        return false;
    };
    return { moveMathFieldPlaceholder };
};
export const readMathFieldValue = (mathField) => {
    if (!mathField) {
        return "";
    }
    if (typeof mathField.getValue === "function") {
        try {
            const nextValue = mathField.getValue("latex");
            if (typeof nextValue === "string") {
                return nextValue;
            }
        }
        catch {
            // ignore and fallback to .value
        }
    }
    if (typeof mathField.value === "string") {
        return mathField.value;
    }
    return "";
};
export const writeMathFieldValue = (mathField, value) => {
    if (!mathField) {
        return;
    }
    if (typeof mathField.setValue === "function") {
        try {
            mathField.setValue(value);
            return;
        }
        catch {
            // ignore and fallback to .value assignment
        }
    }
    if ("value" in mathField) {
        mathField.value = value;
    }
};

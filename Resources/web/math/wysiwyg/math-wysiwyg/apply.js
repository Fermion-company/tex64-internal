import { getMathFieldSelectionRange } from "../../../app/blocks/math-input-utils.js";
import { getKeyByLatex, normalizeLatexKey } from "../math-wysiwyg-keymap.js";
import { getInternalSelectionRanges, indexToOffsetInRange, offsetToIndexInRange, setSelectionRange, } from "../math-wysiwyg-selection.js";
import { findContainingEnvironmentAtCursor, hasEnvironmentInContext, isCursorInsideEnvironmentBody, readNativeMathfieldEnvironmentContext, } from "../math-wysiwyg-environment-context.js";
import { setMathfieldMode } from "../../mathfield-private-adapter.js";
import { AUX_COMMAND_BARE_RE, AUX_COMMAND_BLOCKED_ENV_NAMES, AUX_COMMAND_TEMPLATE_RE, INTERTEXT_TEMPLATE_RE, PLACEHOLDER_TOKEN_REGEX, } from "./constants.js";
import { clearEditAnchor, nowMs, readMathfieldLatex, resolveCursorOffset, syncMathfieldMode } from "./mathfield.js";
const toLiteralInsertKey = (key) => {
    var _a;
    return ({
        label: (_a = key.label) !== null && _a !== void 0 ? _a : key.latex,
        latex: key.latex,
        fallback: key.fallback,
        displayLatex: key.displayLatex,
        hint: key.hint,
    });
};
const findLiteralPlaceholderRange = (mathfieldApi, anchorOffset) => {
    var _a;
    const lastOffset = typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.lastOffset) === "number" && mathfieldApi.lastOffset > 0 ? mathfieldApi.lastOffset : null;
    if (lastOffset === null) {
        return null;
    }
    const latex = readMathfieldLatex(mathfieldApi, 0, lastOffset, "latex");
    if (!latex || !latex.includes("\\placeholder")) {
        return null;
    }
    const anchorIndex = offsetToIndexInRange(mathfieldApi, 0, anchorOffset);
    const regex = new RegExp(PLACEHOLDER_TOKEN_REGEX.source, "g");
    const matches = [];
    let match = regex.exec(latex);
    while (match) {
        const startIndex = match.index;
        const endIndex = startIndex + match[0].length;
        matches.push({ startIndex, endIndex });
        match = regex.exec(latex);
    }
    if (matches.length === 0) {
        return null;
    }
    const preferred = (_a = matches.find((item) => item.startIndex >= anchorIndex)) !== null && _a !== void 0 ? _a : matches[0];
    const start = indexToOffsetInRange(mathfieldApi, 0, lastOffset, preferred.startIndex, "floor");
    const end = indexToOffsetInRange(mathfieldApi, 0, lastOffset, preferred.endIndex, "ceil");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
    }
    return { start, end };
};
const isCursorInBlockedAuxEnvironment = (mathfieldApi, cursorOffset) => {
    const nativeContext = readNativeMathfieldEnvironmentContext(mathfieldApi, cursorOffset);
    if (hasEnvironmentInContext(nativeContext, AUX_COMMAND_BLOCKED_ENV_NAMES)) {
        return true;
    }
    const latex = readMathfieldLatex(mathfieldApi, "latex");
    if (!latex) {
        return false;
    }
    const cursorIndex = offsetToIndexInRange(mathfieldApi, 0, cursorOffset);
    return isCursorInsideEnvironmentBody(latex, cursorIndex, AUX_COMMAND_BLOCKED_ENV_NAMES);
};
const insertAuxCommandOutsideBlockedContext = (runtime, mathfieldApi, insertedLatex, cursorOffset) => {
    var _a;
    const sourceLatex = readMathfieldLatex(mathfieldApi, "latex");
    if (typeof sourceLatex !== "string") {
        return false;
    }
    const normalized = normalizeLatexKey(insertedLatex).replace(/#\?/g, "");
    if (!normalized.startsWith("\\")) {
        return false;
    }
    let insertionIndex = sourceLatex.length;
    const cursorIndex = typeof cursorOffset === "number" && Number.isFinite(cursorOffset)
        ? offsetToIndexInRange(mathfieldApi, 0, cursorOffset)
        : -1;
    if (cursorIndex >= 0) {
        const blockedEnv = findContainingEnvironmentAtCursor(sourceLatex, cursorIndex, AUX_COMMAND_BLOCKED_ENV_NAMES);
        if (blockedEnv) {
            insertionIndex = blockedEnv.endEnd;
        }
    }
    const before = sourceLatex.slice(0, insertionIndex);
    const after = sourceLatex.slice(insertionIndex);
    const leadingSpacer = before.length === 0 || /\s$/.test(before) ? "" : " ";
    const trailingSpacer = after.length === 0 || /^\s/.test(after) ? "" : " ";
    const insertedChunk = `${leadingSpacer}${normalized}${trailingSpacer}`;
    const insertionStartIndex = before.length + leadingSpacer.length;
    const sourceLastOffset = typeof mathfieldApi.lastOffset === "number" && mathfieldApi.lastOffset > 0 ? mathfieldApi.lastOffset : sourceLatex.length;
    const insertionOffset = indexToOffsetInRange(mathfieldApi, 0, sourceLastOffset, insertionIndex, "floor");
    if (!Number.isFinite(insertionOffset) || insertionOffset < 0) {
        return false;
    }
    setSelectionRange(mathfieldApi, insertionOffset, insertionOffset);
    const insertOptions = {
        selectionMode: "after",
        focus: true,
        feedback: false,
        format: "latex",
    };
    let inserted = false;
    if (typeof mathfieldApi.executeCommand === "function") {
        const beforeValue = readMathfieldLatex(mathfieldApi, "latex");
        try {
            const ok = mathfieldApi.executeCommand("insert", insertedChunk, insertOptions);
            const afterValue = readMathfieldLatex(mathfieldApi, "latex");
            const changed = typeof beforeValue === "string" && typeof afterValue === "string" && afterValue !== beforeValue;
            inserted = ok !== false || changed;
        }
        catch {
            inserted = false;
        }
    }
    if (!inserted && typeof mathfieldApi.insert === "function") {
        const beforeValue = readMathfieldLatex(mathfieldApi, "latex");
        try {
            mathfieldApi.insert(insertedChunk, insertOptions);
            const afterValue = readMathfieldLatex(mathfieldApi, "latex");
            inserted = typeof beforeValue === "string" && typeof afterValue === "string" ? afterValue !== beforeValue : true;
        }
        catch {
            inserted = false;
        }
    }
    if (!inserted) {
        return false;
    }
    const nextLatex = readMathfieldLatex(mathfieldApi, "latex");
    if (typeof nextLatex === "string") {
        const searchStart = Math.max(0, insertionStartIndex - 1);
        let commandIndex = nextLatex.indexOf(normalized, searchStart);
        if (commandIndex < 0) {
            commandIndex = nextLatex.lastIndexOf(normalized);
        }
        if (commandIndex >= 0) {
            let selectionStartIndex = commandIndex + normalized.length;
            let selectionEndIndex = selectionStartIndex;
            const braceStart = normalized.indexOf("{");
            if (braceStart >= 0) {
                const braceEnd = normalized.indexOf("}", braceStart + 1);
                if (braceEnd >= braceStart + 1) {
                    selectionStartIndex = commandIndex + braceStart + 1;
                    selectionEndIndex = commandIndex + braceEnd;
                }
            }
            const lastOffset = typeof mathfieldApi.lastOffset === "number" && mathfieldApi.lastOffset > 0 ? mathfieldApi.lastOffset : nextLatex.length;
            const startOffset = indexToOffsetInRange(mathfieldApi, 0, lastOffset, selectionStartIndex, "floor");
            const endOffset = indexToOffsetInRange(mathfieldApi, 0, lastOffset, selectionEndIndex, "ceil");
            if (Number.isFinite(startOffset) && Number.isFinite(endOffset) && startOffset >= 0 && endOffset >= startOffset) {
                setSelectionRange(mathfieldApi, startOffset, endOffset);
            }
        }
    }
    if (/^\\(?:shortintertext|intertext)\\{/.test(normalized)) {
        try {
            setMathfieldMode(mathfieldApi, "text");
            runtime.forcedTextMode = true;
            runtime.holdTextModeUntil = nowMs() + 200;
        }
        catch {
            // ignore mode switch failures
        }
    }
    try {
        (_a = mathfieldApi.dispatchEvent) === null || _a === void 0 ? void 0 : _a.call(mathfieldApi, new Event("input", { bubbles: true }));
    }
    catch {
        // ignore dispatch failures
    }
    return true;
};
export const createMathWysiwygApplyOps = (runtime, deps) => {
    const { mruOps, panelOps, finalizeMutationSession } = deps;
    const applyCandidate = (index) => {
        var _a, _b, _c;
        if (!runtime.mathfield || index < 0 || index >= runtime.panelState.currentCandidates.length) {
            return;
        }
        // Preserve the edit session anchor before clearing so that
        // clearTriggerRange can use it as an upper bound on deletion.
        const savedEditAnchor = runtime.editAnchorOffset;
        clearEditAnchor(runtime);
        const candidate = runtime.panelState.currentCandidates[index];
        const wasExplicitSession = runtime.panelState.explicitSession;
        const explicitSessionPrefix = runtime.panelState.explicitSessionPrefixLatex;
        const shouldKeepExplicitSession = false;
        runtime.panelState.explicitSession = false;
        mruOps.recordMru(candidate);
        const mathfieldApi = runtime.mathfield;
        if (typeof mathfieldApi.focus === "function") {
            mathfieldApi.focus();
        }
        const selection = getMathFieldSelectionRange(mathfieldApi);
        const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
        const insertionAnchorStart = runtime.currentRange ? runtime.currentRange.start : cursorOffset;
        const startMutation = () => {
            const sessionId = runtime.beginMutationSession();
            runtime.suppressNextUpdate = true;
            panelOps.setPanelVisible(false);
            return sessionId;
        };
        const settleMutation = (sessionId, options) => {
            finalizeMutationSession(sessionId, {
                focusTarget: (options === null || options === void 0 ? void 0 : options.focus) ? mathfieldApi : null,
                reopenExplicitSession: shouldKeepExplicitSession,
                clearCandidates: options === null || options === void 0 ? void 0 : options.clearCandidates,
            });
        };
        const insertedLatex = typeof candidate.key.latex === "string" ? normalizeLatexKey(candidate.key.latex) : "";
        const clearTriggerRange = () => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
            if (typeof mathfieldApi.executeCommand !== "function") {
                return;
            }
            // Maximum number of characters that can safely be deleted without
            // crossing into content that predates the current edit session.
            const maxSafeDelete = savedEditAnchor !== null &&
                Number.isFinite(savedEditAnchor) &&
                cursorOffset > savedEditAnchor
                ? cursorOffset - savedEditAnchor
                : Infinity;
            const deleteBackwardChars = (count) => {
                if (!Number.isFinite(count) || count <= 0) {
                    return false;
                }
                const safeCount = Math.min(count, maxSafeDelete);
                if (safeCount <= 0) {
                    return false;
                }
                for (let i = 0; i < safeCount; i += 1) {
                    try {
                        mathfieldApi.executeCommand("deleteBackward");
                    }
                    catch {
                        return i > 0;
                    }
                }
                return true;
            };
            const tokenSuffixFromMatch = (match) => {
                if (!match) {
                    return "";
                }
                if (match.kind === "command") {
                    return `\\${match.token}`;
                }
                if (match.kind === "slash-command") {
                    return `//${match.token}`;
                }
                return match.token;
            };
            const clearSuffixFromBuffer = (source, suffix) => {
                if (!source || !suffix || !source.endsWith(suffix)) {
                    return false;
                }
                return deleteBackwardChars(suffix.length);
            };
            // Extract the base command name from the candidate LaTeX (e.g. "sin"
            // from "\\sin", "sum" from "\\sum_{#?}^{#?}").  Used to limit the
            // deletion to only the matching suffix of the current word token so
            // that preceding content is never accidentally removed.
            const extractCandidateBaseName = () => {
                if (!insertedLatex)
                    return null;
                const m = /^\\([A-Za-z*]+)/.exec(insertedLatex);
                return m ? m[1] : null;
            };
            const beforeCursor = (_a = readMathfieldLatex(mathfieldApi, 0, cursorOffset, "latex")) !== null && _a !== void 0 ? _a : "";
            // Safety check: when the current token is a plain word (no leading
            // backslash) and the candidate is a LaTeX command, only delete the
            // portion of the word that matches the command's base name instead of
            // the entire word.  This prevents "sumsin" → select \sin from wiping
            // out the preceding "sum" characters, and "sumsin" → select \sum from
            // wiping out the trailing "sin" characters.
            if (((_b = runtime.currentTokenMatch) === null || _b === void 0 ? void 0 : _b.kind) === "word") {
                const baseName = extractCandidateBaseName();
                if (baseName) {
                    const token = runtime.currentTokenMatch.token;
                    if (token.length > baseName.length) {
                        // Suffix match: e.g. "sumsin" → select \sin → delete only "sin"
                        if (token.endsWith(baseName)) {
                            if (clearSuffixFromBuffer(beforeCursor, baseName)) {
                                return;
                            }
                        }
                        // Prefix match: e.g. "sumsin" → select \sum → select "sum" portion
                        // and delete it so that "sin" remains after the inserted command.
                        if (token.startsWith(baseName) && runtime.currentRange) {
                            const prefixEndOffset = runtime.currentRange.start + baseName.length;
                            if (prefixEndOffset > runtime.currentRange.start && prefixEndOffset <= cursorOffset) {
                                setSelectionRange(mathfieldApi, runtime.currentRange.start, prefixEndOffset);
                                try {
                                    mathfieldApi.executeCommand("deleteBackward");
                                }
                                catch {
                                    // ignore
                                }
                                return;
                            }
                        }
                    }
                }
            }
            const expectedSuffix = tokenSuffixFromMatch(runtime.currentTokenMatch);
            if (clearSuffixFromBuffer(beforeCursor, expectedSuffix)) {
                return;
            }
            if (wasExplicitSession) {
                let explicitBuffer = beforeCursor;
                if (explicitSessionPrefix && beforeCursor.startsWith(explicitSessionPrefix)) {
                    explicitBuffer = beforeCursor.slice(explicitSessionPrefix.length);
                }
                else if (explicitSessionPrefix) {
                    const relaxedPrefix = explicitSessionPrefix.replace(/\s+$/, "");
                    if (relaxedPrefix && beforeCursor.startsWith(relaxedPrefix)) {
                        explicitBuffer = beforeCursor.slice(relaxedPrefix.length);
                    }
                }
                const trailingToken = (_h = (_f = (_d = (_c = /(\\?[A-Za-z*]+)$/.exec(explicitBuffer)) === null || _c === void 0 ? void 0 : _c[1]) !== null && _d !== void 0 ? _d : (_e = /(\/\/[A-Za-z*]*)$/.exec(explicitBuffer)) === null || _e === void 0 ? void 0 : _e[1]) !== null && _f !== void 0 ? _f : (_g = /([+\-*/=<>:;,!?.]+)$/.exec(explicitBuffer)) === null || _g === void 0 ? void 0 : _g[1]) !== null && _h !== void 0 ? _h : "";
                if (trailingToken && deleteBackwardChars(trailingToken.length)) {
                    return;
                }
            }
            if (!runtime.currentRange) {
                return;
            }
            const rangeContainsCursor = cursorOffset >= runtime.currentRange.start && cursorOffset <= runtime.currentRange.end + 1;
            const rangeText = (_j = readMathfieldLatex(mathfieldApi, runtime.currentRange.start, runtime.currentRange.end, "latex")) !== null && _j !== void 0 ? _j : "";
            if (rangeContainsCursor && clearSuffixFromBuffer(beforeCursor, rangeText)) {
                return;
            }
            const fallbackToken = (_q = (_o = (_l = (_k = /(\\?[A-Za-z*]+)$/.exec(beforeCursor)) === null || _k === void 0 ? void 0 : _k[1]) !== null && _l !== void 0 ? _l : (_m = /(\/\/[A-Za-z*]*)$/.exec(beforeCursor)) === null || _m === void 0 ? void 0 : _m[1]) !== null && _o !== void 0 ? _o : (_p = /([+\-*/=<>:;,!?.]+)$/.exec(beforeCursor)) === null || _p === void 0 ? void 0 : _p[1]) !== null && _q !== void 0 ? _q : "";
            if (fallbackToken) {
                deleteBackwardChars(fallbackToken.length);
            }
        };
        const isAuxCommandCandidate = AUX_COMMAND_TEMPLATE_RE.test(insertedLatex) || AUX_COMMAND_BARE_RE.test(insertedLatex) || INTERTEXT_TEMPLATE_RE.test(insertedLatex);
        const shouldHoistAuxCommand = isAuxCommandCandidate && isCursorInBlockedAuxEnvironment(mathfieldApi, cursorOffset);
        if (INTERTEXT_TEMPLATE_RE.test(insertedLatex)) {
            const mutationId = startMutation();
            clearTriggerRange();
            const commandLatex = insertedLatex.startsWith("\\shortintertext") ? "\\shortintertext{}" : "\\intertext{}";
            if (shouldHoistAuxCommand) {
                insertAuxCommandOutsideBlockedContext(runtime, mathfieldApi, commandLatex, cursorOffset);
                settleMutation(mutationId, { focus: true });
                return;
            }
            runtime.deps.insertKey(toLiteralInsertKey(getKeyByLatex(commandLatex, commandLatex, commandLatex)));
            const currentSelection = getMathFieldSelectionRange(mathfieldApi);
            const cursorAtInsert = resolveCursorOffset(mathfieldApi, currentSelection);
            const targetOffset = Math.max(0, cursorAtInsert - 1);
            setSelectionRange(mathfieldApi, targetOffset, targetOffset);
            try {
                setMathfieldMode(mathfieldApi, "text");
                runtime.forcedTextMode = true;
                runtime.holdTextModeUntil = nowMs() + 200;
            }
            catch {
                // ignore mode switch failures
            }
            settleMutation(mutationId, { focus: true });
            return;
        }
        if (insertedLatex === "\\text{#?}") {
            const mutationId = startMutation();
            clearTriggerRange();
            try {
                setMathfieldMode(mathfieldApi, "text");
                try {
                    mathfieldApi.mode = "text";
                }
                catch {
                    // ignore
                }
                runtime.forcedTextMode = true;
                runtime.holdTextModeUntil = nowMs() + 200;
            }
            catch {
                // ignore mode switch failures
            }
            settleMutation(mutationId, { focus: true });
            return;
        }
        if (candidate.apply) {
            const mutationId = startMutation();
            if (runtime.currentRange) {
                setSelectionRange(mathfieldApi, runtime.currentRange.start, runtime.currentRange.end);
            }
            candidate.apply(mathfieldApi);
            settleMutation(mutationId);
            return;
        }
        const mutationId = startMutation();
        clearTriggerRange();
        if (shouldHoistAuxCommand && insertAuxCommandOutsideBlockedContext(runtime, mathfieldApi, insertedLatex, cursorOffset)) {
            settleMutation(mutationId, { focus: true });
            return;
        }
        const insertionKey = toLiteralInsertKey(candidate.key);
        runtime.deps.insertKey(insertionKey);
        const hasPlaceholderTemplate = typeof insertionKey.latex === "string" && insertionKey.latex.includes("#?");
        if (hasPlaceholderTemplate) {
            const inserted = normalizeLatexKey(insertionKey.latex);
            const isAuxCommandTemplate = AUX_COMMAND_TEMPLATE_RE.test(inserted);
            try {
                if (isAuxCommandTemplate) {
                    const ranges = getInternalSelectionRanges(mathfieldApi);
                    const literalTarget = (_a = findLiteralPlaceholderRange(mathfieldApi, insertionAnchorStart)) !== null && _a !== void 0 ? _a : findLiteralPlaceholderRange(mathfieldApi, 0);
                    const lastRange = ranges.length > 0 ? ranges[ranges.length - 1] : null;
                    const target = literalTarget !== null && literalTarget !== void 0 ? literalTarget : lastRange;
                    if (target) {
                        setSelectionRange(mathfieldApi, target.start, target.end);
                        const shouldForceText = inserted.startsWith("\\text{") || inserted.startsWith("\\operatorname{");
                        if (shouldForceText) {
                            try {
                                setMathfieldMode(mathfieldApi, "text");
                                runtime.forcedTextMode = true;
                                runtime.holdTextModeUntil = nowMs() + 200;
                            }
                            catch {
                                // ignore mode switch failures
                            }
                        }
                        else {
                            syncMathfieldMode(runtime, mathfieldApi, target.end);
                        }
                    }
                }
                else {
                    const insertedSelection = getMathFieldSelectionRange(mathfieldApi);
                    if (insertedSelection.start !== insertedSelection.end) {
                        syncMathfieldMode(runtime, mathfieldApi, insertedSelection.end);
                    }
                    else {
                        const ranges = getInternalSelectionRanges(mathfieldApi);
                        const target = (_c = (_b = ranges.find((range) => range.start >= insertionAnchorStart)) !== null && _b !== void 0 ? _b : ranges[0]) !== null && _c !== void 0 ? _c : null;
                        if (target) {
                            setSelectionRange(mathfieldApi, target.start, target.end);
                            syncMathfieldMode(runtime, mathfieldApi, target.end);
                        }
                    }
                }
            }
            catch {
                // ignore placeholder positioning failures
            }
            const settledRange = getMathFieldSelectionRange(mathfieldApi);
            if (settledRange.start === settledRange.end && typeof mathfieldApi.executeCommand === "function") {
                try {
                    const moved = Boolean(mathfieldApi.executeCommand("moveToNextPlaceholder"));
                    if (moved) {
                        const movedRange = getMathFieldSelectionRange(mathfieldApi);
                        if (movedRange.start !== movedRange.end) {
                            setSelectionRange(mathfieldApi, movedRange.start, movedRange.end);
                            syncMathfieldMode(runtime, mathfieldApi, movedRange.end);
                        }
                    }
                }
                catch {
                    // ignore placeholder fallback move failures
                }
            }
        }
        else {
            const settled = getMathFieldSelectionRange(mathfieldApi);
            if (settled.start !== settled.end) {
                const collapseTo = Math.max(settled.start, settled.end);
                setSelectionRange(mathfieldApi, collapseTo, collapseTo);
            }
        }
        if (typeof mathfieldApi.focus === "function") {
            mathfieldApi.focus();
        }
        settleMutation(mutationId, { focus: true });
    };
    return { applyCandidate };
};

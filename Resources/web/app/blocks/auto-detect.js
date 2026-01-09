import { createLatexBlockDetector } from "./detect.js";
import { getInnerContent, parseBlockContext } from "./context.js";
export const initBlockAutoDetection = (deps) => {
    let currentDetectedBlock = null;
    let currentSelectionRange = null;
    let currentCandidate = null;
    let blockDetectionDebounceTimer = null;
    let blockHighlightDecorations = [];
    const blockDetector = createLatexBlockDetector({
        isEnvDisabled: deps.envRegistry.isEnvDisabled,
        isTableEnvName: deps.envRegistry.isTableEnvName,
        isMathEnvName: deps.envRegistry.isMathEnvName,
        enableTableBlocks: deps.enableTableBlocks,
    });
    const shouldUpdateDetectedBlock = (detected, selectionRange) => {
        if (!currentDetectedBlock ||
            currentDetectedBlock.start !== detected.start ||
            currentDetectedBlock.end !== detected.end ||
            currentDetectedBlock.fullMatch !== detected.fullMatch) {
            return true;
        }
        if (!currentSelectionRange && !selectionRange) {
            return false;
        }
        if (!currentSelectionRange || !selectionRange) {
            return true;
        }
        return (currentSelectionRange.start !== selectionRange.start ||
            currentSelectionRange.end !== selectionRange.end);
    };
    const highlightDetectedBlock = (start, end, context, type, cursorLineNumber, highlightRange) => {
        var _a, _b;
        const activeGroup = deps.getActiveGroup();
        if (!activeGroup.editor || !activeGroup.editor.deltaDecorations)
            return;
        const model = (_b = (_a = activeGroup.editor).getModel) === null || _b === void 0 ? void 0 : _b.call(_a);
        if (!model)
            return;
        let highlightStart = start;
        let highlightEnd = start;
        let showInline = false;
        if (type === "math" && context) {
            const innerStart = start + context.prefix.length;
            const innerEnd = end - context.suffix.length;
            if (innerEnd > innerStart) {
                const hasHighlightStart = typeof (highlightRange === null || highlightRange === void 0 ? void 0 : highlightRange.start) === "number";
                const hasHighlightEnd = typeof (highlightRange === null || highlightRange === void 0 ? void 0 : highlightRange.end) === "number";
                highlightStart =
                    hasHighlightStart && highlightRange.start >= innerStart
                        ? highlightRange.start
                        : innerStart;
                highlightEnd =
                    hasHighlightEnd && highlightRange.end <= innerEnd ? highlightRange.end : innerEnd;
                showInline = true;
            }
        }
        const startPos = model.getPositionAt(highlightStart);
        const endPos = model.getPositionAt(highlightEnd);
        const glyphLine = cursorLineNumber !== null && cursorLineNumber !== void 0 ? cursorLineNumber : startPos.lineNumber;
        const decorations = [];
        if (showInline) {
            decorations.push({
                range: {
                    startLineNumber: startPos.lineNumber,
                    startColumn: startPos.column,
                    endLineNumber: endPos.lineNumber,
                    endColumn: endPos.column,
                },
                options: {
                    inlineClassName: "detected-block-highlight",
                },
            });
        }
        decorations.push({
            range: {
                startLineNumber: glyphLine,
                startColumn: 1,
                endLineNumber: glyphLine,
                endColumn: 1,
            },
            options: {
                glyphMarginClassName: "detected-block-glyph",
            },
        });
        blockHighlightDecorations = activeGroup.editor.deltaDecorations(blockHighlightDecorations, decorations);
    };
    const clearBlockHighlight = () => {
        const activeGroup = deps.getActiveGroup();
        if (!activeGroup.editor || !activeGroup.editor.deltaDecorations)
            return;
        blockHighlightDecorations = activeGroup.editor.deltaDecorations(blockHighlightDecorations, []);
    };
    const normalizeSelection = (selection) => {
        const startsAfter = selection.startLineNumber > selection.endLineNumber ||
            (selection.startLineNumber === selection.endLineNumber &&
                selection.startColumn > selection.endColumn);
        if (!startsAfter) {
            return selection;
        }
        return {
            startLineNumber: selection.endLineNumber,
            startColumn: selection.endColumn,
            endLineNumber: selection.startLineNumber,
            endColumn: selection.startColumn,
        };
    };
    const resolveSelectionOffsets = (model, selection) => {
        if (!selection) {
            return null;
        }
        const normalized = normalizeSelection(selection);
        const start = model.getOffsetAt({
            lineNumber: normalized.startLineNumber,
            column: normalized.startColumn,
        });
        const end = model.getOffsetAt({
            lineNumber: normalized.endLineNumber,
            column: normalized.endColumn,
        });
        return {
            start: Math.min(start, end),
            end: Math.max(start, end),
            selection: normalized,
        };
    };
    const resolveMathEditCell = (detected, context) => {
        if (detected.type !== "math") {
            return { cell: null, value: "", highlightRange: null };
        }
        const detectedInner = context
            ? getInnerContent(context, { trim: false })
            : detected.content;
        return {
            cell: null,
            value: detectedInner,
            highlightRange: null,
        };
    };
    const applyDetectedBlock = (detected, text, model, selectionOffsets, force = false, allowTabSwitch = true, cursorLineNumber, cursorOffset) => {
        var _a;
        const selectionRange = selectionOffsets
            ? { start: selectionOffsets.start, end: selectionOffsets.end }
            : null;
        if (!force && !shouldUpdateDetectedBlock(detected, selectionRange)) {
            return;
        }
        currentDetectedBlock = detected;
        currentSelectionRange = selectionRange;
        if (allowTabSwitch &&
            !document.querySelector('.panel[data-panel="blocks"].is-active')) {
            const blocksTab = document.querySelector('.tab[data-tab="blocks"]');
            blocksTab === null || blocksTab === void 0 ? void 0 : blocksTab.click();
        }
        const snippet = (_a = detected.fullMatch) !== null && _a !== void 0 ? _a : text.slice(detected.start, detected.end);
        const context = snippet
            ? parseBlockContext(snippet, { isTableEnvName: deps.envRegistry.isTableEnvName })
            : null;
        const mathResult = resolveMathEditCell(detected, context);
        const detectedInner = context
            ? getInnerContent(context, { trim: false })
            : detected.content;
        currentCandidate = {
            detected,
            snapshot: {
                type: detected.type,
                start: detected.start,
                end: detected.end,
                snippet,
                context,
                modelVersion: typeof model.getVersionId === "function" ? model.getVersionId() : 0,
            },
            context,
            mathEditCell: mathResult.cell,
            mathInputValue: mathResult.value,
            tableRawValue: detectedInner,
            highlightRange: mathResult.highlightRange,
            cursorLineNumber,
        };
        deps.setAutoDetectedUi(true, cursorLineNumber !== null && cursorLineNumber !== void 0 ? cursorLineNumber : model.getPositionAt(detected.start).lineNumber);
        if (deps.getActiveBlockEditMode() !== "detected") {
            highlightDetectedBlock(detected.start, detected.end, context, detected.type, cursorLineNumber, mathResult.highlightRange);
        }
    };
    const activateDetectedBlock = () => {
        var _a, _b, _c;
        if (!currentCandidate) {
            return;
        }
        const activeGroup = deps.getActiveGroup();
        const model = (_b = (_a = activeGroup.editor) === null || _a === void 0 ? void 0 : _a.getModel) === null || _b === void 0 ? void 0 : _b.call(_a);
        if (!model) {
            return;
        }
        const { detected, snapshot, context, mathEditCell, mathInputValue, tableRawValue } = currentCandidate;
        const updatedSnapshot = {
            ...snapshot,
            modelVersion: typeof model.getVersionId === "function" ? model.getVersionId() : 0,
        };
        currentCandidate = { ...currentCandidate, snapshot: updatedSnapshot };
        deps.setActiveBlockType(detected.type);
        deps.setActiveBlockEditMode("detected");
        deps.setCurrentBlockDraft(null);
        deps.setActiveBlockOriginalSnippet(updatedSnapshot.snippet);
        deps.setActiveBlockContext(context);
        deps.setDetectedBlockSnapshot(updatedSnapshot);
        const startPos = model.getPositionAt(detected.start);
        deps.setAutoDetectedUi(true, startPos.lineNumber);
        if (detected.type === "math") {
            deps.setActiveMathEditCell(mathEditCell);
            deps.setMathInputValue(mathInputValue);
            deps.setTableEditMode("grid");
        }
        else {
            deps.setActiveMathEditCell(null);
            deps.setTableEditMode("raw");
            deps.setTableRawValue(tableRawValue);
        }
        highlightDetectedBlock(detected.start, detected.end, context, detected.type, (_c = currentCandidate.cursorLineNumber) !== null && _c !== void 0 ? _c : startPos.lineNumber, currentCandidate.highlightRange);
    };
    const clearDetectedBlockState = (options) => {
        if (!currentDetectedBlock && !(options === null || options === void 0 ? void 0 : options.force)) {
            return;
        }
        currentDetectedBlock = null;
        currentSelectionRange = null;
        currentCandidate = null;
        if (options === null || options === void 0 ? void 0 : options.clearActive) {
            deps.setDetectedBlockSnapshot(null);
            if (deps.getActiveBlockEditMode() === "detected") {
                deps.setActiveBlockEditMode("none");
                deps.setActiveBlockContext(null);
                deps.setActiveBlockOriginalSnippet(null);
            }
            deps.setActiveMathEditCell(null);
            deps.setTableEditMode("grid");
        }
        if ((options === null || options === void 0 ? void 0 : options.clearActive) || deps.getActiveBlockEditMode() !== "detected") {
            clearBlockHighlight();
        }
        deps.setAutoDetectedUi(false);
    };
    const syncDetectedBlockAtPosition = (position, options) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const activeGroup = deps.getActiveGroup();
        if (!activeGroup.editor || !position) {
            return null;
        }
        const model = (_b = (_a = activeGroup.editor).getModel) === null || _b === void 0 ? void 0 : _b.call(_a);
        if (!model) {
            return null;
        }
        const text = model.getValue();
        const selectionOffsets = (options === null || options === void 0 ? void 0 : options.ignoreSelection)
            ? null
            : resolveSelectionOffsets(model, (_e = (_d = (_c = activeGroup.editor).getSelection) === null || _d === void 0 ? void 0 : _d.call(_c)) !== null && _e !== void 0 ? _e : null);
        const offset = model.getOffsetAt(position);
        const detected = selectionOffsets
            ? blockDetector.detectLatexBlockInRange(text, selectionOffsets.start, selectionOffsets.end)
            : blockDetector.detectLatexBlockAtOffset(text, offset);
        const force = (_f = options === null || options === void 0 ? void 0 : options.force) !== null && _f !== void 0 ? _f : false;
        const allowTabSwitch = (_g = options === null || options === void 0 ? void 0 : options.allowTabSwitch) !== null && _g !== void 0 ? _g : false;
        if (detected) {
            applyDetectedBlock(detected, text, model, selectionOffsets, force, allowTabSwitch, (_h = selectionOffsets === null || selectionOffsets === void 0 ? void 0 : selectionOffsets.selection.startLineNumber) !== null && _h !== void 0 ? _h : position === null || position === void 0 ? void 0 : position.lineNumber, offset);
            return detected;
        }
        clearDetectedBlockState();
        return null;
    };
    const handleCursorPositionChange = (position) => {
        const activeGroup = deps.getActiveGroup();
        if (!activeGroup.editor)
            return;
        if (blockDetectionDebounceTimer) {
            clearTimeout(blockDetectionDebounceTimer);
        }
        blockDetectionDebounceTimer = setTimeout(() => {
            syncDetectedBlockAtPosition(position, { allowTabSwitch: false });
        }, 150);
    };
    return {
        syncDetectedBlockAtPosition,
        handleCursorPositionChange,
        activateDetectedBlock,
        clearDetectedBlockState,
    };
};

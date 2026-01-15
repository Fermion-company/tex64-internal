import { formatSnippetForInsert } from "./format.js";
export const initBlockInsertFlow = (context, deps) => {
    const { blockInsertButton } = context.dom;
    const countLines = (text) => {
        if (!text)
            return 1;
        return text.split(/\r?\n/).length;
    };
    const countLineBreaks = (text) => { var _a, _b; return (_b = (_a = text.match(/\r?\n/g)) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0; };
    const buildDiffPreviewContext = (model, startOffset, endOffset, replacement, contextLineCount = 3) => {
        const originalText = model.getValue();
        const totalLines = typeof model.getLineCount === "function" ? model.getLineCount() : countLines(originalText);
        const startPos = model.getPositionAt(startOffset);
        const endPos = model.getPositionAt(endOffset);
        let startLine = startPos.lineNumber;
        let endLine = endPos.lineNumber;
        if (endOffset > startOffset && endPos.column === 1) {
            endLine = Math.max(startLine, endLine - 1);
        }
        const contextStartLine = Math.max(1, startLine - contextLineCount);
        const contextEndLine = Math.min(totalLines, endLine + contextLineCount);
        const originalLines = originalText.split(/\r?\n/);
        const originalSlice = originalLines.slice(contextStartLine - 1, contextEndLine).join("\n");
        const originalSegment = originalText.slice(startOffset, endOffset);
        const lineDelta = countLineBreaks(replacement) - countLineBreaks(originalSegment);
        const modifiedText = originalText.slice(0, startOffset) + replacement + originalText.slice(endOffset);
        const modifiedTotalLines = totalLines + lineDelta;
        const modifiedEndLine = Math.min(modifiedTotalLines, contextEndLine + lineDelta);
        const modifiedLines = modifiedText.split(/\r?\n/);
        const modifiedSlice = modifiedLines
            .slice(contextStartLine - 1, Math.max(contextStartLine, modifiedEndLine))
            .join("\n");
        return {
            original: originalSlice,
            modified: modifiedSlice,
            lineOffset: contextStartLine - 1,
        };
    };
    const findChangedRange = (before, after) => {
        if (before === after) {
            return null;
        }
        const maxStart = Math.min(before.length, after.length);
        let start = 0;
        while (start < maxStart && before[start] === after[start]) {
            start += 1;
        }
        let endBefore = before.length;
        let endAfter = after.length;
        while (endBefore > start && endAfter > start) {
            if (before[endBefore - 1] !== after[endAfter - 1]) {
                break;
            }
            endBefore -= 1;
            endAfter -= 1;
        }
        return { start, endBefore, endAfter };
    };
    const toEditorRangeFromOffsets = (model, startOffset, endOffset) => {
        const startPos = model.getPositionAt(startOffset);
        const endPos = model.getPositionAt(endOffset);
        return {
            startLineNumber: startPos.lineNumber,
            startColumn: startPos.column,
            endLineNumber: endPos.lineNumber,
            endColumn: endPos.column,
        };
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
    const resolveEmptyLineInsertRange = (editor) => {
        if (!(editor === null || editor === void 0 ? void 0 : editor.getSelection) || !editor.getModel) {
            return null;
        }
        const selection = editor.getSelection();
        const model = editor.getModel();
        if (!selection || !(model === null || model === void 0 ? void 0 : model.getLineContent)) {
            return null;
        }
        const normalized = normalizeSelection(selection);
        const hasSelection = normalized.startLineNumber !== normalized.endLineNumber ||
            normalized.startColumn !== normalized.endColumn;
        if (!hasSelection) {
            return null;
        }
        const lineContent = model.getLineContent(normalized.startLineNumber);
        if (lineContent.trim().length > 0) {
            return null;
        }
        const isLineSelection = normalized.startColumn === 1 &&
            normalized.endColumn === 1 &&
            normalized.endLineNumber === normalized.startLineNumber + 1;
        if (!isLineSelection) {
            return null;
        }
        return normalized;
    };
    const applyBlockInsert = (payload) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
        const applyPayload = payload !== null && payload !== void 0 ? payload : deps.getPendingBlockApply();
        if (!applyPayload && !deps.getBlockPreviewActive()) {
            return;
        }
        const draft = (_a = applyPayload === null || applyPayload === void 0 ? void 0 : applyPayload.draft) !== null && _a !== void 0 ? _a : deps.getBlockDraft();
        if (!draft) {
            return;
        }
        const activeGroup = deps.getActiveGroup();
        if (!activeGroup.editor || !deps.getMonacoApi()) {
            deps.updateFallback("エディタの準備が完了していません。");
            return;
        }
        if (!activeGroup.currentFilePath || !activeGroup.currentFilePath.endsWith(".tex")) {
            deps.updateIssues(1, "ブロックは .tex ファイルでのみ挿入できます。", "error", [
                { severity: "error", message: "ブロックは .tex ファイルでのみ挿入できます。" },
            ]);
            return;
        }
        const editor = activeGroup.editor;
        const monacoApiAny = deps.getMonacoApi();
        let range;
        const model = (_b = editor.getModel) === null || _b === void 0 ? void 0 : _b.call(editor);
        const blockMode = (_d = (_c = deps.getBlockMode) === null || _c === void 0 ? void 0 : _c.call(deps)) !== null && _d !== void 0 ? _d : "insert";
        const mode = (_e = applyPayload === null || applyPayload === void 0 ? void 0 : applyPayload.mode) !== null && _e !== void 0 ? _e : (blockMode === "edit" ? "detected" : "new");
        let snippet = (_f = applyPayload === null || applyPayload === void 0 ? void 0 : applyPayload.replaceSnippet) !== null && _f !== void 0 ? _f : draft.snippet;
        const preferredRange = (_g = applyPayload === null || applyPayload === void 0 ? void 0 : applyPayload.replaceRange) !== null && _g !== void 0 ? _g : null;
        let insertPosition = null;
        let insertRange = applyPayload
            ? (_h = applyPayload.insertRange) !== null && _h !== void 0 ? _h : null
            : mode === "new"
                ? resolveEmptyLineInsertRange(editor)
                : null;
        if (preferredRange) {
            range = new monacoApiAny.Range(preferredRange.startLineNumber, preferredRange.startColumn, preferredRange.endLineNumber, preferredRange.endColumn);
        }
        else if (mode === "detected") {
            const snapshot = (_j = applyPayload === null || applyPayload === void 0 ? void 0 : applyPayload.detectedSnapshot) !== null && _j !== void 0 ? _j : deps.getDetectedBlockSnapshot();
            if (!snapshot || !(model === null || model === void 0 ? void 0 : model.getPositionAt)) {
                return;
            }
            const content = model.getValue();
            const slice = content.slice(snapshot.start, snapshot.end);
            if (slice !== snapshot.snippet) {
                return;
            }
            const startPos = model.getPositionAt(snapshot.start);
            const endPos = model.getPositionAt(snapshot.end);
            range = new monacoApiAny.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
        }
        else {
            if (insertRange) {
                insertPosition = {
                    lineNumber: insertRange.startLineNumber,
                    column: insertRange.startColumn,
                };
                range = new monacoApiAny.Range(insertRange.startLineNumber, insertRange.startColumn, insertRange.endLineNumber, insertRange.endColumn);
            }
            else {
                insertPosition = (_m = (_k = applyPayload === null || applyPayload === void 0 ? void 0 : applyPayload.insertPosition) !== null && _k !== void 0 ? _k : (_l = editor.getPosition) === null || _l === void 0 ? void 0 : _l.call(editor)) !== null && _m !== void 0 ? _m : null;
                const insertAt = insertPosition !== null && insertPosition !== void 0 ? insertPosition : { lineNumber: 1, column: 1 };
                range = new monacoApiAny.Range(insertAt.lineNumber, insertAt.column, insertAt.lineNumber, insertAt.column);
            }
            if (!applyPayload) {
                snippet = formatSnippetForInsert(snippet, model, insertPosition, {
                    alignEnv: deps.getEditorAlignEnvEnabled(),
                });
            }
        }
        (_o = editor.executeEdits) === null || _o === void 0 ? void 0 : _o.call(editor, "block-insert", [
            {
                range,
                text: snippet,
                forceMoveMarkers: true,
            },
        ]);
        (_p = editor.focus) === null || _p === void 0 ? void 0 : _p.call(editor);
        if (typeof deps.postToNative === "function") {
            deps.postToNative({
                type: "blocks:save",
                entry: {
                    file: (_q = activeGroup.currentFilePath) !== null && _q !== void 0 ? _q : null,
                    snippet,
                    content: (_r = draft.content) !== null && _r !== void 0 ? _r : null,
                    mode,
                    createdAt: new Date().toISOString(),
                },
            }, true);
        }
        deps.setPendingBlockApply(null);
        deps.setCurrentBlockDraft(null);
        deps.resetBlockSession({ applyMode: mode });
    };
    const triggerInsert = async () => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
        const activeGroup = deps.getActiveGroup();
        if (!activeGroup.editor) {
            return;
        }
        const editorForDetect = activeGroup.editor;
        const blockMode = (_b = (_a = deps.getBlockMode) === null || _a === void 0 ? void 0 : _a.call(deps)) !== null && _b !== void 0 ? _b : "insert";
        const detectPosition = (_d = (_c = editorForDetect.getPosition) === null || _c === void 0 ? void 0 : _c.call(editorForDetect)) !== null && _d !== void 0 ? _d : null;
        const model = (_e = editorForDetect.getModel) === null || _e === void 0 ? void 0 : _e.call(editorForDetect);
        let detectedSnapshot = blockMode === "edit" ? deps.getDetectedBlockSnapshot() : null;
        if (blockMode === "edit") {
            const shouldResync = !!detectedSnapshot &&
                !!detectPosition &&
                !!(model === null || model === void 0 ? void 0 : model.getOffsetAt) &&
                (() => {
                    const offset = model.getOffsetAt(detectPosition);
                    if (offset < detectedSnapshot.start || offset >= detectedSnapshot.end) {
                        return true;
                    }
                    if (typeof model.getVersionId === "function" &&
                        detectedSnapshot.modelVersion !== model.getVersionId()) {
                        return true;
                    }
                    return false;
                })();
            if (detectPosition && shouldResync) {
                deps.refreshDetectedBlock(detectPosition, { force: true });
                detectedSnapshot = deps.getDetectedBlockSnapshot();
            }
        }
        const draft = deps.getBlockDraft();
        if (!draft)
            return;
        let mode = "new";
        if (blockMode === "edit") {
            if (!detectedSnapshot) {
                return;
            }
            mode = "detected";
        }
        let insertPosition = mode === "new" ? (_g = (_f = editorForDetect.getPosition) === null || _f === void 0 ? void 0 : _f.call(editorForDetect)) !== null && _g !== void 0 ? _g : null : null;
        const insertRange = mode === "new" ? resolveEmptyLineInsertRange(editorForDetect) : null;
        if (insertRange) {
            insertPosition = {
                lineNumber: insertRange.startLineNumber,
                column: insertRange.startColumn,
            };
        }
        let formattedSnippet = mode === "new"
            ? formatSnippetForInsert(draft.snippet, (_h = editorForDetect.getModel) === null || _h === void 0 ? void 0 : _h.call(editorForDetect), insertPosition, {
                alignEnv: deps.getEditorAlignEnvEnabled(),
            })
            : draft.snippet;
        let resolvedDraft = { ...draft, snippet: formattedSnippet };
        const editorModel = (_j = editorForDetect.getModel) === null || _j === void 0 ? void 0 : _j.call(editorForDetect);
        const hasPositionAt = (model) => typeof model.getValue === "function" && typeof model.getPositionAt === "function";
        if (editorModel && hasPositionAt(editorModel)) {
            const model = editorModel;
            let startOffset = 0;
            let endOffset = 0;
            if (mode === "detected" && detectedSnapshot) {
                startOffset = detectedSnapshot.start;
                endOffset = detectedSnapshot.end;
            }
            else if (insertRange && model.getOffsetAt) {
                startOffset = model.getOffsetAt({
                    lineNumber: insertRange.startLineNumber,
                    column: insertRange.startColumn,
                });
                endOffset = model.getOffsetAt({
                    lineNumber: insertRange.endLineNumber,
                    column: insertRange.endColumn,
                });
            }
            else if (insertPosition && model.getOffsetAt) {
                const offset = model.getOffsetAt(insertPosition);
                startOffset = offset;
                endOffset = offset;
            }
            let replaceRange = null;
            let replaceSnippet = null;
            let diffStartOffset = startOffset;
            let diffEndOffset = endOffset;
            const filePath = activeGroup.currentFilePath;
            const canPreviewFormat = !!deps.requestFormatPreview &&
                typeof filePath === "string" &&
                filePath.toLowerCase().endsWith(".tex");
            if (canPreviewFormat && typeof model.getOffsetAt === "function") {
                const originalContent = model.getValue();
                const rawModified = originalContent.slice(0, startOffset) +
                    formattedSnippet +
                    originalContent.slice(endOffset);
                const previewResult = await ((_k = deps.requestFormatPreview) === null || _k === void 0 ? void 0 : _k.call(deps, {
                    path: filePath,
                    content: rawModified,
                }));
                if ((previewResult === null || previewResult === void 0 ? void 0 : previewResult.ok) && typeof previewResult.content === "string") {
                    const change = findChangedRange(originalContent, previewResult.content);
                    if (change) {
                        formattedSnippet = previewResult.content.slice(change.start, change.endAfter);
                        resolvedDraft = { ...draft, snippet: formattedSnippet };
                        diffStartOffset = change.start;
                        diffEndOffset = change.endBefore;
                        replaceRange = toEditorRangeFromOffsets(model, diffStartOffset, diffEndOffset);
                        replaceSnippet = formattedSnippet;
                    }
                }
            }
            if (deps.getIsE2E()) {
                window.__tex64LastDraft = {
                    formula: deps.getMathInputValue(),
                    snippet: resolvedDraft.snippet,
                    detectedSnippet: (_l = detectedSnapshot === null || detectedSnapshot === void 0 ? void 0 : detectedSnapshot.snippet) !== null && _l !== void 0 ? _l : null,
                };
            }
            const applyPayload = {
                mode,
                draft: resolvedDraft,
                detectedSnapshot: mode === "detected" ? detectedSnapshot : null,
                insertPosition,
                insertRange,
                replaceRange,
                replaceSnippet,
            };
            deps.setPendingBlockApply(applyPayload);
            deps.setCurrentBlockDraft(resolvedDraft);
            const diffContext = buildDiffPreviewContext(model, diffStartOffset, diffEndOffset, resolvedDraft.snippet);
            deps.showDiffModal(diffContext.original, diffContext.modified, diffContext.lineOffset);
            return;
        }
        if (deps.getIsE2E()) {
            window.__tex64LastDraft = {
                formula: deps.getMathInputValue(),
                snippet: resolvedDraft.snippet,
                detectedSnippet: (_m = detectedSnapshot === null || detectedSnapshot === void 0 ? void 0 : detectedSnapshot.snippet) !== null && _m !== void 0 ? _m : null,
            };
        }
        const applyPayload = {
            mode,
            draft: resolvedDraft,
            detectedSnapshot: mode === "detected" ? detectedSnapshot : null,
            insertPosition,
            insertRange,
        };
        deps.setPendingBlockApply(applyPayload);
        deps.setCurrentBlockDraft(resolvedDraft);
        const originalSnippet = mode === "detected" ? (_o = detectedSnapshot === null || detectedSnapshot === void 0 ? void 0 : detectedSnapshot.snippet) !== null && _o !== void 0 ? _o : "" : "";
        const fallbackOffset = insertRange
            ? Math.max(0, insertRange.startLineNumber - 1)
            : insertPosition
                ? Math.max(0, insertPosition.lineNumber - 1)
                : 0;
        deps.showDiffModal(originalSnippet, resolvedDraft.snippet, fallbackOffset);
    };
    const applyPendingFromDiffModal = () => {
        var _a;
        deps.setBlockPreviewActive(true);
        applyBlockInsert((_a = deps.getPendingBlockApply()) !== null && _a !== void 0 ? _a : undefined);
        deps.setBlockPreviewActive(false);
        deps.setPendingBlockApply(null);
        deps.setCurrentBlockDraft(null);
        deps.requestFormatCurrentFile("blockInsert");
    };
    const clearPending = () => {
        deps.setPendingBlockApply(null);
        deps.setCurrentBlockDraft(null);
    };
    const resetPreviewActive = () => {
        deps.setBlockPreviewActive(false);
    };
    if (blockInsertButton instanceof HTMLElement) {
        blockInsertButton.addEventListener("click", () => {
            triggerInsert();
        });
    }
    return {
        triggerInsert,
        applyBlockInsert,
        applyPendingFromDiffModal,
        clearPending,
        resetPreviewActive,
    };
};

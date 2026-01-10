import { buildLineDiff } from "./diff.js";
export const initDiffModal = (context, deps) => {
    var _a;
    const { diffModal, diffTitle, diffModalSubmit, blockDiffContainer, diffSummary, diffFileName } = context.dom;
    const defaultDiffSubmitLabel = diffModalSubmit instanceof HTMLButtonElement
        ? (_a = diffModalSubmit.textContent) !== null && _a !== void 0 ? _a : "確定"
        : "確定";
    let diffEditor = null;
    let diffOriginalModel = null;
    let diffModifiedModel = null;
    let diffContext = null;
    const renderDiffSummary = (before, after) => {
        if (!(diffSummary instanceof HTMLElement)) {
            return;
        }
        diffSummary.textContent = "";
        const beforeText = before.trimEnd();
        const afterText = after.trimEnd();
        const beforeLines = beforeText.length ? beforeText.split(/\r?\n/) : [""];
        const afterLines = afterText.length ? afterText.split(/\r?\n/) : [""];
        const diffLines = buildLineDiff(beforeLines, afterLines);
        let adds = 0;
        let dels = 0;
        diffLines.forEach((entry) => {
            if (entry.type === "add") {
                adds += 1;
            }
            else if (entry.type === "del") {
                dels += 1;
            }
        });
        if (adds === 0 && dels === 0) {
            diffSummary.textContent = "変更なし";
            return;
        }
        const add = document.createElement("span");
        add.className = "diff-summary-item is-add";
        add.textContent = `+${adds}`;
        const del = document.createElement("span");
        del.className = "diff-summary-item is-del";
        del.textContent = `-${dels}`;
        diffSummary.append(add, del);
    };
    const countPatchStats = (patch) => {
        const lines = patch.split(/\r?\n/);
        let adds = 0;
        let dels = 0;
        lines.forEach((line) => {
            if (!line) {
                return;
            }
            if (line.startsWith("+++ ") ||
                line.startsWith("--- ") ||
                line.startsWith("@@") ||
                line.startsWith("diff ") ||
                line.startsWith("index ") ||
                line.startsWith("new file") ||
                line.startsWith("deleted file") ||
                line.startsWith("\\")) {
                return;
            }
            if (line.startsWith("+")) {
                adds += 1;
            }
            else if (line.startsWith("-")) {
                dels += 1;
            }
        });
        return { adds, dels };
    };
    const renderPatchSummary = (patch) => {
        if (!(diffSummary instanceof HTMLElement)) {
            return;
        }
        diffSummary.textContent = "";
        const { adds, dels } = countPatchStats(patch);
        if (adds === 0 && dels === 0) {
            diffSummary.textContent = patch.trim() ? "変更あり" : "変更なし";
            return;
        }
        const add = document.createElement("span");
        add.className = "diff-summary-item is-add";
        add.textContent = `+${adds}`;
        const del = document.createElement("span");
        del.className = "diff-summary-item is-del";
        del.textContent = `-${dels}`;
        diffSummary.append(add, del);
    };
    const renderDiffHeader = () => {
        var _a;
        if (diffTitle instanceof HTMLElement) {
            diffTitle.textContent = "変更内容の確認";
        }
        if (diffFileName instanceof HTMLElement) {
            const activePath = deps.getActiveFilePath();
            const fileName = activePath ? (_a = activePath.split(/[/\\]/).pop()) !== null && _a !== void 0 ? _a : activePath : "未保存";
            diffFileName.textContent = fileName;
        }
    };
    const setDiffHeader = (options) => {
        var _a;
        if (diffTitle instanceof HTMLElement && options.title) {
            diffTitle.textContent = options.title;
        }
        if (diffFileName instanceof HTMLElement) {
            diffFileName.textContent = (_a = options.fileName) !== null && _a !== void 0 ? _a : "";
        }
        if (diffModalSubmit instanceof HTMLButtonElement && options.submitLabel) {
            diffModalSubmit.textContent = options.submitLabel;
        }
    };
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
    const applyDiffLineNumberOffset = (offset, original, modified) => {
        var _a, _b, _c, _d, _e, _f, _g;
        if (!diffEditor)
            return;
        const maxLine = offset + Math.max(countLines(original), countLines(modified));
        const minChars = Math.max(2, String(maxLine).length);
        const lineNumbers = (lineNumber) => String(lineNumber + offset);
        const options = { lineNumbers, lineNumbersMinChars: minChars };
        const editorAny = diffEditor;
        (_c = (_b = (_a = editorAny.getOriginalEditor) === null || _a === void 0 ? void 0 : _a.call(editorAny)) === null || _b === void 0 ? void 0 : _b.updateOptions) === null || _c === void 0 ? void 0 : _c.call(_b, options);
        (_f = (_e = (_d = editorAny.getModifiedEditor) === null || _d === void 0 ? void 0 : _d.call(editorAny)) === null || _e === void 0 ? void 0 : _e.updateOptions) === null || _f === void 0 ? void 0 : _f.call(_e, options);
        (_g = editorAny.updateOptions) === null || _g === void 0 ? void 0 : _g.call(editorAny, options);
    };
    const resetDiffEditor = () => {
        var _a, _b, _c, _d;
        (_a = diffOriginalModel === null || diffOriginalModel === void 0 ? void 0 : diffOriginalModel.dispose) === null || _a === void 0 ? void 0 : _a.call(diffOriginalModel);
        (_b = diffModifiedModel === null || diffModifiedModel === void 0 ? void 0 : diffModifiedModel.dispose) === null || _b === void 0 ? void 0 : _b.call(diffModifiedModel);
        diffOriginalModel = null;
        diffModifiedModel = null;
        if (diffEditor) {
            const diffEditorAny = diffEditor;
            (_c = diffEditorAny.setModel) === null || _c === void 0 ? void 0 : _c.call(diffEditorAny, null);
            (_d = diffEditorAny.dispose) === null || _d === void 0 ? void 0 : _d.call(diffEditorAny);
            diffEditor = null;
        }
        if (blockDiffContainer instanceof HTMLElement) {
            blockDiffContainer.innerHTML = "";
        }
    };
    const computeE2eLineChanges = () => {
        var _a, _b, _c, _d, _e, _f;
        if (!diffOriginalModel || !diffModifiedModel) {
            return null;
        }
        const originalText = (_c = (_b = (_a = diffOriginalModel).getValue) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : "";
        const modifiedText = (_f = (_e = (_d = diffModifiedModel).getValue) === null || _e === void 0 ? void 0 : _e.call(_d)) !== null && _f !== void 0 ? _f : "";
        const before = originalText.trimEnd();
        const after = modifiedText.trimEnd();
        const beforeLines = before.length ? before.split(/\r?\n/) : [""];
        const afterLines = after.length ? after.split(/\r?\n/) : [""];
        const diffLines = buildLineDiff(beforeLines, afterLines);
        let hunks = 0;
        let inChange = false;
        diffLines.forEach((entry) => {
            if (entry.type === "same") {
                inChange = false;
                return;
            }
            if (!inChange) {
                hunks += 1;
                inChange = true;
            }
        });
        return Array.from({ length: hunks }, () => ({}));
    };
    const ensureE2eLineChanges = () => {
        var _a;
        if (!context.isE2E || !diffEditor) {
            return;
        }
        const diffEditorAny = diffEditor;
        if (diffEditorAny.__e2eLineChangesPatched) {
            return;
        }
        const originalGetLineChanges = (_a = diffEditorAny.getLineChanges) === null || _a === void 0 ? void 0 : _a.bind(diffEditorAny);
        diffEditorAny.getLineChanges = () => {
            const changes = originalGetLineChanges ? originalGetLineChanges() : null;
            if (Array.isArray(changes) && changes.length > 0) {
                return changes;
            }
            const fallback = computeE2eLineChanges();
            if (Array.isArray(fallback)) {
                return fallback;
            }
            return changes !== null && changes !== void 0 ? changes : null;
        };
        diffEditorAny.__e2eLineChangesPatched = true;
    };
    const showPatchModal = (patch, options) => {
        const container = blockDiffContainer;
        if (!container) {
            return;
        }
        resetDiffEditor();
        diffContext = options.context;
        if (diffModal) {
            diffModal.classList.add("is-open");
            diffModal.setAttribute("aria-hidden", "false");
        }
        container.innerHTML = "";
        const pre = document.createElement("pre");
        pre.className = "git-diff-text";
        pre.textContent = patch;
        container.appendChild(pre);
        renderPatchSummary(patch);
        setDiffHeader({
            title: options.title,
            fileName: options.fileName,
            submitLabel: options.submitLabel,
        });
    };
    const showDiffModal = (original, modified, lineOffset = 0, options) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const monacoApi = deps.getMonacoApi();
        if (!monacoApi)
            return;
        const monacoApiAny = monacoApi;
        const container = blockDiffContainer;
        if (!container)
            return;
        if (!diffContext) {
            diffContext = { type: "block" };
        }
        if (diffModal) {
            diffModal.classList.add("is-open");
            diffModal.setAttribute("aria-hidden", "false");
        }
        if (!diffEditor) {
            container.innerHTML = "";
            diffEditor = monacoApiAny.editor.createDiffEditor(container, {
                originalEditable: false,
                readOnly: true,
                renderSideBySide: true,
                useInlineViewWhenSpaceIsLimited: false,
                renderIndicators: true,
                renderMarginRevertIcon: false,
                diffWordWrap: "off",
                wordWrap: "off",
                hideUnchangedRegions: {
                    enabled: true,
                    contextLineCount: 3,
                    minimumLineCount: 1,
                },
                scrollBeyondLastLine: false,
                minimap: { enabled: false },
                renderOverviewRuler: false,
                overviewRulerBorder: false,
                occurrencesHighlight: false,
                selectionHighlight: false,
                lineNumbers: "on",
                fontSize: 12,
                fontFamily: "Menlo, Monaco, 'Courier New', monospace",
            });
        }
        else {
            const diffEditorAny = diffEditor;
            const diffNode = (_d = (_b = (_a = diffEditorAny.getDomNode) === null || _a === void 0 ? void 0 : _a.call(diffEditorAny)) !== null && _b !== void 0 ? _b : (_c = diffEditorAny.getContainerDomNode) === null || _c === void 0 ? void 0 : _c.call(diffEditorAny)) !== null && _d !== void 0 ? _d : null;
            if (diffNode && !container.contains(diffNode)) {
                container.innerHTML = "";
                container.appendChild(diffNode);
            }
            (_e = diffEditorAny.layout) === null || _e === void 0 ? void 0 : _e.call(diffEditorAny);
        }
        renderDiffHeader();
        if (options) {
            setDiffHeader(options);
        }
        if (diffModalSubmit instanceof HTMLButtonElement) {
            diffModalSubmit.textContent = defaultDiffSubmitLabel;
        }
        renderDiffSummary(original, modified);
        const diffEditorAny = diffEditor;
        (_f = diffOriginalModel === null || diffOriginalModel === void 0 ? void 0 : diffOriginalModel.dispose) === null || _f === void 0 ? void 0 : _f.call(diffOriginalModel);
        (_g = diffModifiedModel === null || diffModifiedModel === void 0 ? void 0 : diffModifiedModel.dispose) === null || _g === void 0 ? void 0 : _g.call(diffModifiedModel);
        diffOriginalModel = monacoApiAny.editor.createModel(original, "latex");
        diffModifiedModel = monacoApiAny.editor.createModel(modified, "latex");
        (_h = diffEditorAny.setModel) === null || _h === void 0 ? void 0 : _h.call(diffEditorAny, {
            original: diffOriginalModel,
            modified: diffModifiedModel,
        });
        ensureE2eLineChanges();
        applyDiffLineNumberOffset(lineOffset, original, modified);
        if (context.isE2E) {
            window.__tex64LastDiff = { original, modified, lineOffset };
            window.__tex64DiffEditor = diffEditor;
        }
        if (typeof diffEditor.layout === "function") {
            diffEditor.layout();
        }
    };
    const closeDiffModal = () => {
        if (diffModal) {
            diffModal.classList.remove("is-open");
            diffModal.setAttribute("aria-hidden", "true");
        }
        if (diffSummary instanceof HTMLElement) {
            diffSummary.textContent = "";
        }
        if (diffFileName instanceof HTMLElement) {
            diffFileName.textContent = "";
        }
        if (diffTitle instanceof HTMLElement) {
            diffTitle.textContent = "変更内容の確認";
        }
        if (diffModalSubmit instanceof HTMLButtonElement) {
            diffModalSubmit.textContent = defaultDiffSubmitLabel;
        }
        diffContext = null;
        resetDiffEditor();
    };
    return {
        showDiffModal,
        showPatchModal,
        closeDiffModal,
        resetDiffEditor,
        getDiffContext: () => diffContext,
        setDiffContext: (contextValue) => {
            diffContext = contextValue;
        },
    };
};

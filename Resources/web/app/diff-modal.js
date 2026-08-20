import { buildLineDiff } from "./diff.js";
export const initDiffModal = (context, deps) => {
    var _a;
    const { diffModal, diffTitle, diffModalSubmit, blockDiffContainer, diffSummary, diffFileName } = context.dom;
    const defaultDiffSubmitLabel = diffModalSubmit instanceof HTMLButtonElement
        ? (_a = diffModalSubmit.textContent) !== null && _a !== void 0 ? _a : "Confirm"
        : "Confirm";
    let diffEditor = null;
    let diffOriginalModel = null;
    let diffModifiedModel = null;
    let diffContext = null;
    let multiDiffEditors = [];
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
            diffSummary.textContent = "No change";
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
            diffTitle.textContent =
                (diffContext === null || diffContext === void 0 ? void 0 : diffContext.type) === "block" ? "Confirm changes (format after finalization)" : "Confirm changes";
        }
        if (diffFileName instanceof HTMLElement) {
            const activePath = deps.getActiveFilePath();
            const fileName = activePath ? (_a = activePath.split(/[/\\]/).pop()) !== null && _a !== void 0 ? _a : activePath : "Unsaved";
            diffFileName.textContent = fileName;
        }
    };
    const setDiffHeader = (options) => {
        if (diffTitle instanceof HTMLElement && typeof options.title === "string") {
            diffTitle.textContent = options.title;
        }
        if (diffFileName instanceof HTMLElement && typeof options.fileName === "string") {
            diffFileName.textContent = options.fileName;
        }
    };
    const detectLanguage = (fileName) => {
        var _a, _b, _c;
        if (!fileName)
            return "plaintext";
        const ext = (_b = (_a = fileName.split(".").pop()) === null || _a === void 0 ? void 0 : _a.toLowerCase()) !== null && _b !== void 0 ? _b : "";
        const map = {
            tex: "latex", sty: "latex", cls: "latex", bib: "bibtex",
            js: "javascript", ts: "typescript", jsx: "javascript", tsx: "typescript",
            py: "python", rb: "ruby", rs: "rust", go: "go",
            java: "java", kt: "kotlin", swift: "swift",
            css: "css", scss: "scss", less: "less",
            html: "html", xml: "xml", json: "json", yaml: "yaml", yml: "yaml",
            md: "markdown", sh: "shell", bash: "shell",
            c: "c", cpp: "cpp", h: "c", hpp: "cpp",
            sql: "sql", lua: "lua", r: "r",
        };
        return (_c = map[ext]) !== null && _c !== void 0 ? _c : "plaintext";
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
    const disposeMultiDiffEditors = () => {
        var _a, _b, _c, _d, _e, _f;
        for (const entry of multiDiffEditors) {
            try {
                (_b = (_a = entry.editor).setModel) === null || _b === void 0 ? void 0 : _b.call(_a, null);
                (_d = (_c = entry.editor).dispose) === null || _d === void 0 ? void 0 : _d.call(_c);
            }
            catch {
                // ignore disposal errors
            }
            for (const model of entry.models) {
                try {
                    (_f = (_e = model).dispose) === null || _f === void 0 ? void 0 : _f.call(_e);
                }
                catch {
                    // ignore disposal errors
                }
            }
        }
        multiDiffEditors = [];
    };
    const resetDiffEditor = () => {
        var _a, _b, _c, _d;
        disposeMultiDiffEditors();
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
    const showDiffModal = (original, modified, lineOffset = 0, options) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
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
                hideUnchangedRegions: { enabled: false },
                scrollBeyondLastLine: false,
                minimap: { enabled: false },
                renderOverviewRuler: false,
                overviewRulerBorder: false,
                occurrencesHighlight: false,
                selectionHighlight: false,
                lineNumbers: "on",
                fontSize: 12,
                lineHeight: 20,
                fontFamily: '"SF Mono", "Hiragino Kaku Gothic ProN", "Hiragino Sans", Menlo, Monaco, "Courier New", monospace',
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
        if (diffModalSubmit instanceof HTMLButtonElement) {
            const submitLabel = options === null || options === void 0 ? void 0 : options.submitLabel;
            diffModalSubmit.textContent =
                typeof submitLabel === "string" && submitLabel.trim().length > 0
                    ? submitLabel
                    : defaultDiffSubmitLabel;
        }
        if (options) {
            setDiffHeader(options);
        }
        renderDiffSummary(original, modified);
        const diffEditorAny = diffEditor;
        (_f = diffOriginalModel === null || diffOriginalModel === void 0 ? void 0 : diffOriginalModel.dispose) === null || _f === void 0 ? void 0 : _f.call(diffOriginalModel);
        (_g = diffModifiedModel === null || diffModifiedModel === void 0 ? void 0 : diffModifiedModel.dispose) === null || _g === void 0 ? void 0 : _g.call(diffModifiedModel);
        const lang = detectLanguage((_h = options === null || options === void 0 ? void 0 : options.fileName) !== null && _h !== void 0 ? _h : deps.getActiveFilePath());
        diffOriginalModel = monacoApiAny.editor.createModel(original, lang);
        diffModifiedModel = monacoApiAny.editor.createModel(modified, lang);
        (_j = diffEditorAny.setModel) === null || _j === void 0 ? void 0 : _j.call(diffEditorAny, {
            original: diffOriginalModel,
            modified: diffModifiedModel,
        });
        applyDiffLineNumberOffset(lineOffset, original, modified);
        if (typeof diffEditor.layout === "function") {
            diffEditor.layout();
        }
        // Scroll to first change
        requestAnimationFrame(() => {
            var _a;
            const editorAny = diffEditor;
            const modEditor = (_a = editorAny.getModifiedEditor) === null || _a === void 0 ? void 0 : _a.call(editorAny);
            if (!(modEditor === null || modEditor === void 0 ? void 0 : modEditor.revealLine))
                return;
            const beforeLines = original.split(/\r?\n/);
            const afterLines = modified.split(/\r?\n/);
            for (let k = 0; k < afterLines.length; k++) {
                if (beforeLines[k] !== afterLines[k]) {
                    modEditor.revealLine(Math.max(1, k + 1 - 2)); // 2 lines above for context
                    break;
                }
            }
        });
    };
    const computeDiffCounts = (original, modified) => {
        const bLines = original.trimEnd().length ? original.trimEnd().split(/\r?\n/) : [""];
        const aLines = modified.trimEnd().length ? modified.trimEnd().split(/\r?\n/) : [""];
        const lines = buildLineDiff(bLines, aLines);
        let adds = 0;
        let dels = 0;
        lines.forEach((e) => { if (e.type === "add")
            adds++;
        else if (e.type === "del")
            dels++; });
        return { adds, dels, diffLines: lines };
    };
    const showMultiFileDiff = (files, options) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
        const monacoApi = deps.getMonacoApi();
        const container = blockDiffContainer;
        if (!monacoApi || !container)
            return;
        const monacoApiAny = monacoApi;
        if (!diffContext)
            diffContext = { type: "aiApply", proposalIds: [] };
        if (diffModal) {
            diffModal.classList.add("is-open");
            diffModal.setAttribute("aria-hidden", "false");
        }
        // Dispose any existing editors (single + multi) and clear the container.
        resetDiffEditor();
        if (diffTitle instanceof HTMLElement) {
            diffTitle.textContent = (_a = options === null || options === void 0 ? void 0 : options.title) !== null && _a !== void 0 ? _a : "Confirm changes";
        }
        if (diffFileName instanceof HTMLElement) {
            diffFileName.textContent = files.length === 1 ? files[0].fileName : `${files.length} files`;
        }
        if (diffModalSubmit instanceof HTMLButtonElement) {
            diffModalSubmit.textContent = (_b = options === null || options === void 0 ? void 0 : options.submitLabel) !== null && _b !== void 0 ? _b : defaultDiffSubmitLabel;
        }
        let totalAdds = 0;
        let totalDels = 0;
        const fileDiffs = files.map((f) => {
            const { adds, dels } = computeDiffCounts(f.original, f.modified);
            totalAdds += adds;
            totalDels += dels;
            return { ...f, adds, dels };
        });
        if (diffSummary instanceof HTMLElement) {
            diffSummary.textContent = "";
            if (totalAdds > 0 || totalDels > 0) {
                const addEl = document.createElement("span");
                addEl.className = "diff-summary-item is-add";
                addEl.textContent = `+${totalAdds}`;
                const delEl = document.createElement("span");
                delEl.className = "diff-summary-item is-del";
                delEl.textContent = `-${totalDels}`;
                diffSummary.append(addEl, delEl);
            }
        }
        container.innerHTML = "";
        const scrollArea = document.createElement("div");
        scrollArea.className = "multi-diff-scroll";
        container.appendChild(scrollArea);
        // Cap one file so a huge diff can't dominate; outer scroll spans files.
        const MAX_FILE_HEIGHT = Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.7);
        // One Monaco diff editor per file — identical engine to the single-file
        // view, just stacked. Monaco handles vertical scrolling, colours, and
        // folding of unchanged regions natively.
        for (const fd of fileDiffs) {
            const section = document.createElement("div");
            section.className = "multi-diff-section";
            const fileHeader = document.createElement("div");
            fileHeader.className = "multi-diff-file-header";
            const nameSpan = document.createElement("span");
            nameSpan.className = "multi-diff-file-name";
            nameSpan.textContent = fd.fileName;
            const countsSpan = document.createElement("span");
            countsSpan.className = "diff-summary";
            if (fd.adds > 0) {
                const a = document.createElement("span");
                a.className = "diff-summary-item is-add";
                a.textContent = `+${fd.adds}`;
                countsSpan.appendChild(a);
            }
            if (fd.dels > 0) {
                const d = document.createElement("span");
                d.className = "diff-summary-item is-del";
                d.textContent = `-${fd.dels}`;
                countsSpan.appendChild(d);
            }
            fileHeader.append(nameSpan, countsSpan);
            section.appendChild(fileHeader);
            const host = document.createElement("div");
            host.className = "multi-diff-monaco";
            section.appendChild(host);
            scrollArea.appendChild(section);
            const lang = detectLanguage(fd.fileName);
            const original = monacoApiAny.editor.createModel(fd.original, lang);
            const modified = monacoApiAny.editor.createModel(fd.modified, lang);
            const editor = monacoApiAny.editor.createDiffEditor(host, {
                originalEditable: false,
                readOnly: true,
                renderSideBySide: true,
                useInlineViewWhenSpaceIsLimited: false,
                renderIndicators: true,
                renderMarginRevertIcon: false,
                diffWordWrap: "off",
                wordWrap: "off",
                hideUnchangedRegions: { enabled: true },
                scrollBeyondLastLine: false,
                minimap: { enabled: false },
                renderOverviewRuler: false,
                overviewRulerBorder: false,
                occurrencesHighlight: false,
                selectionHighlight: false,
                lineNumbers: "on",
                automaticLayout: true,
                fontSize: 12,
                lineHeight: 20,
                fontFamily: '"SF Mono", "Hiragino Kaku Gothic ProN", "Hiragino Sans", Menlo, Monaco, "Courier New", monospace',
            });
            (_d = (_c = editor).setModel) === null || _d === void 0 ? void 0 : _d.call(_c, {
                original,
                modified,
            });
            multiDiffEditors.push({ editor, models: [original, modified] });
            // Size each editor to its (folded) content so there's no inner scroll —
            // the outer .multi-diff-scroll is the only scroller and every file's last
            // line stays reachable.
            const diffEditor = editor;
            const fitHeight = () => {
                var _a, _b, _c, _d, _e, _f, _g, _h, _j;
                const mh = (_d = (_c = (_b = (_a = diffEditor.getModifiedEditor) === null || _a === void 0 ? void 0 : _a.call(diffEditor)) === null || _b === void 0 ? void 0 : _b.getContentHeight) === null || _c === void 0 ? void 0 : _c.call(_b)) !== null && _d !== void 0 ? _d : 0;
                const oh = (_h = (_g = (_f = (_e = diffEditor.getOriginalEditor) === null || _e === void 0 ? void 0 : _e.call(diffEditor)) === null || _f === void 0 ? void 0 : _f.getContentHeight) === null || _g === void 0 ? void 0 : _g.call(_f)) !== null && _h !== void 0 ? _h : 0;
                const h = Math.max(mh, oh);
                if (h > 0) {
                    host.style.height = `${Math.min(h, MAX_FILE_HEIGHT)}px`;
                    (_j = diffEditor.layout) === null || _j === void 0 ? void 0 : _j.call(diffEditor);
                }
            };
            (_e = diffEditor.onDidUpdate) === null || _e === void 0 ? void 0 : _e.call(diffEditor, fitHeight);
            (_h = (_g = (_f = diffEditor.getModifiedEditor) === null || _f === void 0 ? void 0 : _f.call(diffEditor)) === null || _g === void 0 ? void 0 : _g.onDidContentSizeChange) === null || _h === void 0 ? void 0 : _h.call(_g, fitHeight);
            (_l = (_k = (_j = diffEditor.getOriginalEditor) === null || _j === void 0 ? void 0 : _j.call(diffEditor)) === null || _k === void 0 ? void 0 : _k.onDidContentSizeChange) === null || _l === void 0 ? void 0 : _l.call(_k, fitHeight);
            fitHeight();
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
            diffTitle.textContent = "Confirm changes";
        }
        if (diffModalSubmit instanceof HTMLButtonElement) {
            diffModalSubmit.textContent = defaultDiffSubmitLabel;
        }
        diffContext = null;
        resetDiffEditor();
    };
    // Plain Enter confirms (inserts) while the diff modal is open. Captured at the
    // document level so the keystroke never reaches the editor behind the modal;
    // the diff preview is read-only, so Enter has no competing meaning here.
    document.addEventListener("keydown", (event) => {
        if (!(diffModal instanceof HTMLElement) || !diffModal.classList.contains("is-open")) {
            return;
        }
        if (event.key !== "Enter" ||
            event.shiftKey ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.isComposing) {
            return;
        }
        if (!(diffModalSubmit instanceof HTMLButtonElement) || diffModalSubmit.disabled) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        diffModalSubmit.click();
    }, true);
    return {
        showDiffModal,
        showMultiFileDiff,
        closeDiffModal,
        resetDiffEditor,
        getDiffContext: () => diffContext,
        setDiffContext: (context) => {
            diffContext = context;
        },
    };
};

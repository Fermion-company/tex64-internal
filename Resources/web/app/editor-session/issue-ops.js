export const createEditorSessionIssueOps = (runtime, coreOps) => {
    const clearJumpHighlight = (group) => {
        const decorations = runtime.jumpDecorations[group.key];
        if (!group.editor || decorations.length === 0) {
            runtime.jumpDecorationClassNames[group.key] = null;
            return;
        }
        const editor = group.editor;
        runtime.jumpDecorations[group.key] = editor.deltaDecorations(decorations, []);
        runtime.jumpDecorationClassNames[group.key] = null;
    };
    const clearIssueHighlight = () => {
        const monacoApi = runtime.deps.getMonacoApi();
        if (!monacoApi) {
            return;
        }
        if (runtime.state.issueDecorations.length > 0 && runtime.state.issueDecorationGroup) {
            const issueGroup = coreOps.getEditorGroup(runtime.state.issueDecorationGroup);
            if (issueGroup.editor) {
                const editor = issueGroup.editor;
                runtime.state.issueDecorations = editor.deltaDecorations(runtime.state.issueDecorations, []);
            }
            else {
                runtime.state.issueDecorations = [];
            }
            runtime.state.issueDecorationGroup = null;
        }
        Object.keys(runtime.editorGroups).forEach((key) => {
            const className = runtime.jumpDecorationClassNames[key];
            if (!className || !runtime.issueHighlightClassNames.has(className)) {
                return;
            }
            clearJumpHighlight(runtime.editorGroups[key]);
        });
    };
    const parseIssueDetail = (issue) => {
        var _a, _b, _c, _d, _e, _f, _g;
        const trimmed = issue.message.trim();
        const filePattern = String.raw `((?:[A-Za-z]:)?[^:\s]+?\.[A-Za-z0-9]+)`;
        const match = (_a = trimmed.match(new RegExp(`^${filePattern}:(\\d+):(\\d+):\\s*(.+)$`))) !== null && _a !== void 0 ? _a : trimmed.match(new RegExp(`^${filePattern}:(\\d+):\\s*(.+)$`));
        if (match) {
            const path = (_b = issue.path) !== null && _b !== void 0 ? _b : match[1];
            const line = (_c = issue.line) !== null && _c !== void 0 ? _c : Number.parseInt(match[2], 10);
            const column = (_d = issue.column) !== null && _d !== void 0 ? _d : (match.length > 4 && match[3] && /^\\d+$/.test(match[3])
                ? Number.parseInt(match[3], 10)
                : null);
            let message = match.length > 4 ? match[4].trim() : match[3].trim();
            if (issue.path && issue.line) {
                const prefix = `${issue.path}:${issue.line}`;
                if (message.startsWith(prefix)) {
                    message = message.slice(prefix.length).replace(/^:\\s*/, "");
                }
            }
            return { path, line: Number.isFinite(line) ? line : null, column, message };
        }
        return {
            path: (_e = issue.path) !== null && _e !== void 0 ? _e : null,
            line: (_f = issue.line) !== null && _f !== void 0 ? _f : null,
            column: (_g = issue.column) !== null && _g !== void 0 ? _g : null,
            message: trimmed,
        };
    };
    const syncIssueMarkers = (issues) => {
        var _a;
        const monacoApi = runtime.deps.getMonacoApi();
        if (!monacoApi || runtime.monacoModels.size === 0) {
            return;
        }
        const monacoApiAny = monacoApi;
        if (typeof ((_a = monacoApiAny.editor) === null || _a === void 0 ? void 0 : _a.setModelMarkers) !== "function") {
            return;
        }
        const activePath = coreOps.getActiveFilePath();
        const markersByPath = new Map();
        const pushMarker = (targetPath, marker) => {
            const current = markersByPath.get(targetPath);
            if (current) {
                current.push(marker);
            }
            else {
                markersByPath.set(targetPath, [marker]);
            }
        };
        issues.forEach((issue) => {
            var _a;
            const detail = parseIssueDetail(issue);
            const targetPath = (_a = detail.path) !== null && _a !== void 0 ? _a : activePath;
            if (!targetPath) {
                return;
            }
            const line = Number.isFinite(detail.line) ? detail.line : null;
            if (!line || line < 1) {
                return;
            }
            const column = Number.isFinite(detail.column) ? detail.column : 1;
            const severity = issue.severity === "error" ? 8 : 4;
            pushMarker(targetPath, {
                severity,
                message: detail.message || issue.message,
                startLineNumber: line,
                startColumn: Math.max(1, column),
                endLineNumber: line,
                endColumn: Math.max(1, column) + 1,
            });
        });
        runtime.monacoModels.forEach((entry, path) => {
            var _a, _b, _c;
            const markers = (_a = markersByPath.get(path)) !== null && _a !== void 0 ? _a : [];
            (_c = (_b = monacoApiAny.editor) === null || _b === void 0 ? void 0 : _b.setModelMarkers) === null || _c === void 0 ? void 0 : _c.call(_b, entry.model, "tex64", markers);
        });
    };
    const revealLine = (group, line, options = {}) => {
        var _a, _b, _c, _d;
        const monacoApi = runtime.deps.getMonacoApi();
        if (!group.editor || !monacoApi) {
            return;
        }
        clearJumpHighlight(group);
        const monacoApiAny = monacoApi;
        const editor = group.editor;
        const normalizedLine = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
        const normalizedColumn = Number.isFinite(options.column) && ((_a = options.column) !== null && _a !== void 0 ? _a : 0) > 0
            ? Math.trunc((_b = options.column) !== null && _b !== void 0 ? _b : 1)
            : 1;
        let lineNumber = normalizedLine;
        let columnNumber = normalizedColumn;
        const model = (_c = editor.getModel) === null || _c === void 0 ? void 0 : _c.call(editor);
        if (model) {
            const maxLine = model.getLineCount();
            if (Number.isFinite(maxLine) && maxLine >= 1) {
                lineNumber = Math.min(normalizedLine, maxLine);
            }
            const maxColumn = model.getLineMaxColumn(lineNumber);
            if (Number.isFinite(maxColumn) && maxColumn >= 1) {
                columnNumber = Math.min(normalizedColumn, maxColumn);
            }
        }
        const className = (_d = options.className) !== null && _d !== void 0 ? _d : "jump-line-highlight";
        runtime.jumpDecorations[group.key] = editor.deltaDecorations(runtime.jumpDecorations[group.key], [
            {
                range: new monacoApiAny.Range(lineNumber, 1, lineNumber, 1),
                options: {
                    isWholeLine: true,
                    className,
                },
            },
        ]);
        runtime.jumpDecorationClassNames[group.key] = className;
        editor.revealLineInCenter(lineNumber);
        editor.setPosition({ lineNumber, column: columnNumber });
        if (options.focus !== false) {
            editor.focus();
        }
    };
    return {
        clearIssueHighlight,
        parseIssueDetail,
        syncIssueMarkers,
        clearJumpHighlight,
        revealLine,
    };
};

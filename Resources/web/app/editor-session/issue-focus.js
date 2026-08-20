export const createEditorSessionIssueFocusOps = (runtime, coreOps, issueOps, navigationOps, deps) => {
    const focusIssue = (issue, options = {}) => {
        var _a;
        const activeGroup = coreOps.getActiveGroup();
        const targetKey = (_a = options.groupKey) !== null && _a !== void 0 ? _a : coreOps.getActiveEditorGroupKey();
        const monacoApi = runtime.deps.getMonacoApi();
        if (!activeGroup.editor || !monacoApi) {
            return;
        }
        const detail = issueOps.parseIssueDetail(issue);
        const className = issue.severity === "warning" ? "issue-line-warning" : "issue-line-highlight";
        if (detail.path && detail.line) {
            issueOps.clearIssueHighlight();
            navigationOps.jumpToFileLine(detail.path, detail.line, targetKey, {
                className,
                force: true,
            });
            return;
        }
        if (detail.path && !detail.line) {
            issueOps.clearIssueHighlight();
            deps.requestOpenFile(detail.path, targetKey, true);
            return;
        }
        if (!detail.line) {
            return;
        }
        const monacoApiAny = monacoApi;
        const editor = activeGroup.editor;
        issueOps.clearIssueHighlight();
        issueOps.clearJumpHighlight(activeGroup);
        runtime.state.issueDecorationGroup = activeGroup.key;
        runtime.state.issueDecorations = editor.deltaDecorations(runtime.state.issueDecorations, [
            {
                range: new monacoApiAny.Range(detail.line, 1, detail.line, 1),
                options: {
                    isWholeLine: true,
                    className,
                },
            },
        ]);
        editor.revealLineInCenter(detail.line);
        editor.setPosition({ lineNumber: detail.line, column: 1 });
        editor.focus();
    };
    return { focusIssue };
};

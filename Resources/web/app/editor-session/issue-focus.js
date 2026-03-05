export const createEditorSessionIssueFocusOps = (runtime, coreOps, issueOps, navigationOps, deps) => {
    const focusIssue = (issue) => {
        const activeGroup = coreOps.getActiveGroup();
        const monacoApi = runtime.deps.getMonacoApi();
        if (!activeGroup.editor || !monacoApi) {
            return;
        }
        const detail = issueOps.parseIssueDetail(issue);
        const className = issue.severity === "warning" ? "issue-line-warning" : "issue-line-highlight";
        if (detail.path && detail.line) {
            issueOps.clearIssueHighlight();
            navigationOps.jumpToFileLine(detail.path, detail.line, coreOps.getActiveEditorGroupKey(), {
                className,
                force: true,
            });
            return;
        }
        if (detail.path && !detail.line) {
            issueOps.clearIssueHighlight();
            deps.requestOpenFile(detail.path, coreOps.getActiveEditorGroupKey(), true);
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

export const createIssuesProxy = (onUpdate) => {
    let lastIssueSnapshot = null;
    const recordIssuesSnapshot = (count, summary, status, issues) => {
        lastIssueSnapshot = {
            count,
            summary,
            status,
            issues,
            updatedAt: Date.now(),
        };
    };
    const updateIssuesProxy = (count, summary, status, issues) => {
        const normalizedIssues = issues.length > 0
            ? issues
            : count > 0
                ? [
                    {
                        severity: status === "error" ? "error" : "warning",
                        message: (summary === null || summary === void 0 ? void 0 : summary.trim()) || "エラーが発生しました。",
                    },
                ]
                : [];
        const normalizedCount = count > 0 ? Math.max(count, normalizedIssues.length) : normalizedIssues.length;
        recordIssuesSnapshot(normalizedCount, summary, status, normalizedIssues);
        onUpdate(normalizedCount, summary, status, normalizedIssues);
    };
    return {
        updateIssuesProxy,
        getLastIssueSnapshot: () => lastIssueSnapshot,
    };
};

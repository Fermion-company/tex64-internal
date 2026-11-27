import { uiText } from "./i18n.js";
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
    let base = {
        count: 0, summary: "", status: "info", issues: [],
    };
    const liveErrors = new Map();
    const publish = () => {
        const message = liveErrors.values().next().value;
        const extra = message && !base.issues.some(issue => issue.message === message)
            ? [{ severity: "warning", message }] : [];
        const issues = [...base.issues, ...extra];
        const count = base.count + extra.length;
        const summary = base.summary || message || "";
        const status = extra.length && base.status === "success" ? "info" : base.status;
        recordIssuesSnapshot(count, summary, status, issues);
        onUpdate(count, summary, status, issues);
    };
    const setLiveRuntimeError = (viewer, message) => {
        var _a;
        if (((_a = liveErrors.get(viewer)) !== null && _a !== void 0 ? _a : null) === message)
            return;
        if (message)
            liveErrors.set(viewer, message);
        else
            liveErrors.delete(viewer);
        publish();
    };
    const updateIssuesProxy = (count, summary, status, issues) => {
        const normalizedIssues = issues.length > 0
            ? issues
            : count > 0
                ? [
                    {
                        severity: status === "error" ? "error" : "warning",
                        message: (summary === null || summary === void 0 ? void 0 : summary.trim()) || uiText("An error has occurred.", "エラーが発生しました。"),
                    },
                ]
                : [];
        const normalizedCount = count > 0 ? Math.max(count, normalizedIssues.length) : normalizedIssues.length;
        base = { count: normalizedCount, summary, status, issues: normalizedIssues };
        publish();
    };
    return {
        updateIssuesProxy,
        resetWorkspace: () => {
            liveErrors.clear();
            updateIssuesProxy(0, "", "info", []);
        },
        setLiveRuntimeError,
        getLastIssueSnapshot: () => lastIssueSnapshot,
    };
};

import { getIssueResolution } from "./issue-resolution.js";
import { getUiLocale } from "./i18n.js";
const MAX_ACTIVE_FILE_CONTEXT_CHARS = 10000;
const MAX_SELECTION_CONTEXT_CHARS = 4000;
// Dirty buffers travel to the local host so tools can read the working copy.
// Clean files remain available directly from disk.
export const MAX_DIRTY_FILE_CONTEXT_CHARS = 400000;
const MAX_RECENT_ISSUES = 5;
export const createContextPayloadBuilder = (deps) => {
    const buildActiveFileContext = () => {
        var _a, _b;
        const snapshot = (_b = (_a = deps.getActiveFileSnapshot) === null || _a === void 0 ? void 0 : _a.call(deps)) !== null && _b !== void 0 ? _b : null;
        const fallbackPath = deps.getActiveFilePath();
        if (!snapshot)
            return fallbackPath ? { activeFilePath: fallbackPath } : {};
        const maxChars = snapshot.isDirty ? MAX_DIRTY_FILE_CONTEXT_CHARS : MAX_ACTIVE_FILE_CONTEXT_CHARS;
        let content = snapshot.content;
        let truncated = false;
        if (Number.isFinite(maxChars) && content.length > maxChars) {
            content = content.slice(0, maxChars);
            truncated = true;
        }
        return {
            activeFilePath: snapshot.path,
            activeFileContent: content,
            activeFileIsDirty: snapshot.isDirty,
            activeFileRevision: snapshot.modelRevision,
            activeFileContentTruncated: truncated,
            activeFileContentLength: snapshot.content.length,
        };
    };
    const buildSelectionContext = () => {
        var _a, _b;
        const maxChars = MAX_SELECTION_CONTEXT_CHARS;
        const selection = (_b = (_a = deps.getActiveSelectionSnapshot) === null || _a === void 0 ? void 0 : _a.call(deps)) !== null && _b !== void 0 ? _b : null;
        if (!selection || !selection.text) {
            return {};
        }
        let text = selection.text;
        let truncated = false;
        if (Number.isFinite(maxChars) && text.length > maxChars) {
            text = text.slice(0, maxChars);
            truncated = true;
        }
        return {
            activeSelectionRequested: true,
            activeSelection: {
                path: selection.path,
                text,
                isDirty: selection.isDirty,
                startLine: selection.startLine,
                startColumn: selection.startColumn,
                endLine: selection.endLine,
                endColumn: selection.endColumn,
                truncated,
                textLength: selection.text.length,
            },
        };
    };
    const buildOpenFilesContext = () => {
        var _a;
        const open = (_a = deps.getOpenFileSnapshots) === null || _a === void 0 ? void 0 : _a.call(deps, {
            maxFiles: 0,
            maxChars: MAX_DIRTY_FILE_CONTEXT_CHARS,
            onlyDirty: true,
            excludePath: deps.getActiveFilePath(),
        });
        return open ? { openFiles: open.files, openFileSnapshots: open.snapshots } : {};
    };
    const buildIssuesContext = () => {
        var _a;
        const snapshot = (_a = deps.getRecentIssuesSnapshot) === null || _a === void 0 ? void 0 : _a.call(deps);
        if (!snapshot || !Array.isArray(snapshot.issues) || snapshot.issues.length === 0)
            return {};
        const items = snapshot.issues.slice(0, MAX_RECENT_ISSUES).map((issue) => ({
            severity: issue.severity,
            message: issue.message,
            path: issue.path,
            line: issue.line,
            column: issue.column,
            action: issue.action,
            resolution: getIssueResolution(issue),
        }));
        return {
            recentIssueSummary: snapshot.summary,
            recentIssueStatus: snapshot.status,
            recentIssuesUpdatedAt: new Date(snapshot.updatedAt).toISOString(),
            recentIssues: items,
        };
    };
    return (extras = {}) => {
        const payload = {
            uiLocale: getUiLocale(),
            axiomSurface: "code",
            axiomMode: extras.axiomMode === "ask" || extras.axiomMode === "plan" ? extras.axiomMode : "agent",
            ...(extras.turnOrigin === "step" ? { turnOrigin: "step", stepKind: extras.stepKind === "mechanical" ? "mechanical" : "writing" } : {}),
            ...buildActiveFileContext(),
            ...buildSelectionContext(),
            ...buildOpenFilesContext(),
            ...buildIssuesContext(),
            ...(Array.isArray(extras.explicitContextRefs) && extras.explicitContextRefs.length > 0
                ? { explicitContextRefs: extras.explicitContextRefs }
                : {}),
            contextControls: {
                includeSelection: true,
                includeOpenFiles: true,
                includeIssues: true,
            },
        };
        return payload;
    };
};

import type { ActiveFileSnapshot, EditorSessionApi } from "./editor-session/types.js";
import { getIssueResolution } from "./issue-resolution.js";
import { getUiLocale } from "./i18n.js";
import type { IssueItem, IssuesStatus } from "./types.js";
import type { MentionRef } from "./ai-chat-mention.js";

type ContextDeps = {
  getActiveFilePath: () => string | null;
  getActiveFileSnapshot?: () => ActiveFileSnapshot | null;
  getActiveSelectionSnapshot?: () => {
    path: string;
    text: string;
    isDirty: boolean;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null;
  getOpenFileSnapshots?: EditorSessionApi["getOpenFileSnapshots"];
  getRecentIssuesSnapshot?: () => {
    count: number;
    summary: string;
    status: IssuesStatus;
    issues: IssueItem[];
    updatedAt: number;
  } | null;
};

const MAX_ACTIVE_FILE_CONTEXT_CHARS = 10000;
const MAX_SELECTION_CONTEXT_CHARS = 4000;
// Dirty buffers travel to the local host so tools can read the working copy.
// Clean files remain available directly from disk.
export const MAX_DIRTY_FILE_CONTEXT_CHARS = 400_000;
const MAX_RECENT_ISSUES = 5;

export type ContextExtras = {
  /** "agent" edits and builds; "ask" answers; "plan" records the steps first. */
  axiomMode?: "agent" | "ask" | "plan";
  /** What the reader pointed at with @. */
  explicitContextRefs?: MentionRef[];
  /** "step": the request is one of the offered steps; the agent asks before writing. */
  turnOrigin?: "step";
  /** With "step": a writing step withholds the edit tools on its first turn. */
  stepKind?: "mechanical" | "writing";
};

export const createContextPayloadBuilder = (deps: ContextDeps) => {
  const buildActiveFileContext = () => {
    const snapshot = deps.getActiveFileSnapshot?.() ?? null;
    const fallbackPath = deps.getActiveFilePath();
    if (!snapshot) return fallbackPath ? { activeFilePath: fallbackPath } : {};
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
    const maxChars = MAX_SELECTION_CONTEXT_CHARS;
    const selection = deps.getActiveSelectionSnapshot?.() ?? null;
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
    const open = deps.getOpenFileSnapshots?.({
      maxFiles: 0,
      maxChars: MAX_DIRTY_FILE_CONTEXT_CHARS,
      onlyDirty: true,
      excludePath: deps.getActiveFilePath(),
    });
    return open ? { openFiles: open.files, openFileSnapshots: open.snapshots } : {};
  };

  const buildIssuesContext = () => {
    const snapshot = deps.getRecentIssuesSnapshot?.();
    if (!snapshot || !Array.isArray(snapshot.issues) || snapshot.issues.length === 0) return {};
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

  return (extras: ContextExtras = {}) => {
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
    } as Record<string, unknown>;
    return payload;
  };
};

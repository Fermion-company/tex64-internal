import { getIssueResolution } from "./issue-resolution.js";
import type { AgentSettings, IssueItem, IssuesStatus } from "./types.js";

type ContextDeps = {
  getActiveFilePath: () => string | null;
  getActiveFileSnapshot?: () => { path: string; content: string; isDirty: boolean } | null;
  getActiveSelectionSnapshot?: () => {
    path: string;
    text: string;
    isDirty: boolean;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null;
  getOpenFileSnapshots?: (options?: { maxFiles?: number; maxChars?: number }) => {
    files: Array<{ path: string; isDirty: boolean; isActive: boolean }>;
    snapshots: Array<{ path: string; content: string; isDirty: boolean; truncated: boolean; contentLength: number }>;
  };
  getRecentIssuesSnapshot?: () => {
    count: number;
    summary: string;
    status: IssuesStatus;
    issues: IssueItem[];
    updatedAt: number;
  } | null;
};

const MAX_ACTIVE_FILE_CONTEXT_CHARS = 10000;
const MAX_OPEN_FILE_CONTEXT_CHARS = 8000;
const MAX_SELECTION_CONTEXT_CHARS = 4000;
const MAX_OPEN_FILE_SNAPSHOTS = 4;
const MAX_OPEN_FILES_METADATA = 12;
const MAX_RECENT_ISSUES = 5;

export const createContextPayloadBuilder = (deps: ContextDeps) => {
  const resolveMaxChars = (value: number | undefined, fallback: number) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return value <= 0 ? Number.POSITIVE_INFINITY : value;
  };

  const buildActiveFileContext = (agentSettings: AgentSettings | null) => {
    const maxChars = resolveMaxChars(agentSettings?.openFileMaxChars, MAX_ACTIVE_FILE_CONTEXT_CHARS);
    const snapshot = deps.getActiveFileSnapshot?.() ?? null;
    const fallbackPath = deps.getActiveFilePath();
    if (!snapshot) return fallbackPath ? { activeFilePath: fallbackPath } : {};
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
      activeFileContentTruncated: truncated,
      activeFileContentLength: snapshot.content.length,
    };
  };

  const buildSelectionContext = (agentSettings: AgentSettings | null) => {
    const maxChars = resolveMaxChars(agentSettings?.openFileMaxChars, MAX_SELECTION_CONTEXT_CHARS);
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

  const buildOpenFilesContext = (agentSettings: AgentSettings | null) => {
    const maxChars = resolveMaxChars(agentSettings?.openFileMaxChars, MAX_OPEN_FILE_CONTEXT_CHARS);
    const s = deps.getOpenFileSnapshots?.({ maxFiles: MAX_OPEN_FILE_SNAPSHOTS, maxChars });
    if (!s) {
      return {};
    }
    const files =
      s.files.length > MAX_OPEN_FILES_METADATA
        ? s.files.slice(0, MAX_OPEN_FILES_METADATA)
        : s.files;
    return { openFiles: files, openFileSnapshots: s.snapshots };
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

  return (agentSettings: AgentSettings | null) => {
    const payload = {
      ...buildActiveFileContext(agentSettings),
      ...buildSelectionContext(agentSettings),
      ...buildOpenFilesContext(agentSettings),
      ...buildIssuesContext(),
      contextControls: {
        includeSelection: true,
        includeOpenFiles: true,
        includeIssues: true,
      },
    } as Record<string, unknown>;
    return payload;
  };
};

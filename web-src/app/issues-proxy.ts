import { uiText } from "./i18n.js";
import type { IssueItem, IssuesStatus } from "./types.js";

type UpdateIssuesFn = (
  count: number,
  summary: string,
  status: IssuesStatus,
  issues: IssueItem[]
) => void;

export const createIssuesProxy = (onUpdate: UpdateIssuesFn) => {
  let lastIssueSnapshot: {
    count: number;
    summary: string;
    status: IssuesStatus;
    issues: IssueItem[];
    updatedAt: number;
  } | null = null;

  const recordIssuesSnapshot = (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => {
    lastIssueSnapshot = {
      count,
      summary,
      status,
      issues,
      updatedAt: Date.now(),
    };
  };

  let base: { count: number; summary: string; status: IssuesStatus; issues: IssueItem[] } = {
    count: 0, summary: "", status: "info", issues: [],
  };
  const liveErrors = new Map<string, string>();
  const publish = () => {
    const message = liveErrors.values().next().value as string | undefined;
    const extra: IssueItem[] = message && !base.issues.some(issue => issue.message === message)
      ? [{ severity: "warning", message }] : [];
    const issues = [...base.issues, ...extra];
    const count = base.count + extra.length;
    const summary = base.summary || message || "";
    const status = extra.length && base.status === "success" ? "info" : base.status;
    recordIssuesSnapshot(count, summary, status, issues);
    onUpdate(count, summary, status, issues);
  };

  const setLiveRuntimeError = (viewer: string, message: string | null) => {
    if ((liveErrors.get(viewer) ?? null) === message) return;
    if (message) liveErrors.set(viewer, message);
    else liveErrors.delete(viewer);
    publish();
  };

  const updateIssuesProxy = (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => {
    const normalizedIssues: IssueItem[] =
      issues.length > 0
        ? issues
        : count > 0
        ? [
            {
              severity: status === "error" ? "error" : "warning",
              message: summary?.trim() || uiText("An error has occurred.", "エラーが発生しました。"),
            },
          ]
        : [];
    const normalizedCount =
      count > 0 ? Math.max(count, normalizedIssues.length) : normalizedIssues.length;
    base = { count: normalizedCount, summary, status, issues: normalizedIssues };
    publish();
  };

  return {
    updateIssuesProxy,
    setLiveRuntimeError,
    getLastIssueSnapshot: () => lastIssueSnapshot,
  };
};

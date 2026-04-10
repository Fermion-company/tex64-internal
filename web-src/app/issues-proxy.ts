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
    recordIssuesSnapshot(normalizedCount, summary, status, normalizedIssues);
    onUpdate(normalizedCount, summary, status, normalizedIssues);
  };

  return {
    updateIssuesProxy,
    getLastIssueSnapshot: () => lastIssueSnapshot,
  };
};

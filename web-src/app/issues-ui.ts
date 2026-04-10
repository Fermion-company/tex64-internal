import type { AppContext } from "./context.js";
import { uiText } from "./i18n.js";
import type { IssueItem } from "./types.js";
import { getIssueResolution } from "./issue-resolution.js";

type IssueDetail = {
  path: string | null;
  line: number | null;
  column: number | null;
  message: string;
};

type IssuesUiDeps = {
  parseIssueDetail: (issue: IssueItem) => IssueDetail;
  onFocusIssue: (issue: IssueItem) => void;
  onOpenRuntimeSettings?: () => void;
};

export type IssuesUiApi = {
  render: (issues: IssueItem[]) => void;
};

export const initIssuesUi = (context: AppContext, deps: IssuesUiDeps): IssuesUiApi => {
  const { issuesList, issuesEmpty } = context.dom;

  const render = (issues: IssueItem[]) => {
    if (!(issuesList instanceof HTMLElement) || !(issuesEmpty instanceof HTMLElement)) {
      return;
    }
    issuesList.innerHTML = "";
    if (issues.length === 0) {
      issuesList.style.display = "none";
      issuesEmpty.style.display = "block";
      return;
    }
    issuesEmpty.style.display = "none";
    issuesList.style.display = "flex";
    issues.forEach((issue) => {
      const detail = deps.parseIssueDetail(issue);

      const item = document.createElement("button");
      item.type = "button";
      item.className = "issue-item";
      item.dataset.severity = issue.severity;
      if (issue.action) {
        item.dataset.action = issue.action;
      }

      const header = document.createElement("div");
      header.className = "issue-header";

      const badge = document.createElement("span");
      badge.className = `issue-badge issue-badge-${issue.severity}`;
      badge.textContent =
        issue.severity === "warning"
          ? uiText("Warning", "警告")
          : uiText("Error", "Issues");

      const location = document.createElement("span");
      location.className = "issue-location";
      if (detail.path && detail.line) {
        location.textContent = `${detail.path}:${detail.line}`;
      } else if (detail.path) {
        location.textContent = detail.path;
      } else if (detail.line) {
        location.textContent = uiText(`Line ${detail.line}`, `行 ${detail.line}`);
      } else {
        location.textContent = uiText("Unknown location", "位置不明");
      }

      header.append(badge, location);

      const message = document.createElement("div");
      message.className = "issue-message";
      message.textContent = detail.message || issue.message;

      const detailBlock = document.createElement("div");
      detailBlock.className = "issue-extra";

      const resolution = document.createElement("div");
      resolution.className = "issue-resolution";

      const hint = document.createElement("div");
      hint.className = "issue-hintline";
      const isRuntimeAction =
        issue.action === "open-runtime" && typeof deps.onOpenRuntimeSettings === "function";
      const hasJumpTarget = Boolean(detail.path || detail.line);
      item.disabled = !isRuntimeAction && !hasJumpTarget;
      const resolutionText = getIssueResolution(issue) ?? "";
      const showResolution = Boolean(resolutionText);
      resolution.textContent = resolutionText;
      hint.textContent = isRuntimeAction
        ? uiText("Click to open Runtime", "Click to open Environment")
        : hasJumpTarget
        ? uiText("Click to jump", "Click to move")
        : uiText("Unable to determine destination. Check the build log", "移動先を特定できません。ビルドログを確認");

      if (showResolution) {
        detailBlock.append(resolution);
      }
      detailBlock.append(hint);
      item.append(header, message, detailBlock);
      item.addEventListener("click", () => {
        if (isRuntimeAction) {
          deps.onOpenRuntimeSettings?.();
          return;
        }
        if (!hasJumpTarget) {
          return;
        }
        deps.onFocusIssue(issue);
      });
      issuesList.appendChild(item);
    });
  };

  return { render };
};

import type { AppContext } from "./context.js";
import { uiText } from "./i18n.js";
import type { IssueItem } from "./types.js";
import { diagnoseIssue } from "./issue-diagnosis.js";
import { createExplain } from "./explain.js";
import { markFocus, restoreFocus } from "./focus-key.js";

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

// A filled sign, not a worded pill: a red disc for something that stopped the
// build, an amber triangle for something that did not. The shape carries the
// difference on its own, so the two never rely on colour alone.
const SEVERITY_ICON = {
  error:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9"/>' +
    '<path class="issue-icon-glyph" d="M10 5.2v5.5"/>' +
    '<circle class="issue-icon-dot" cx="10" cy="14.2" r="1.15"/></svg>',
  warning:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.8 19.3 17.9a.9.9 0 0 1-.8 1.3H1.5a.9.9 0 0 1-.8-1.3z"/>' +
    '<path class="issue-icon-glyph" d="M10 7.4v4.3"/>' +
    '<circle class="issue-icon-dot" cx="10" cy="15.1" r="1.1"/></svg>',
} as const;

// The same problem keeps its key across rebuilds of the list, so a fix the
// user opened stays open.
const issueKey = (issue: IssueItem) =>
  JSON.stringify([issue.severity, issue.path ?? "", issue.line ?? 0, issue.column ?? 0, issue.message]);

export const initIssuesUi = (context: AppContext, deps: IssuesUiDeps): IssuesUiApi => {
  const { issuesList, issuesEmpty } = context.dom;
  const fixOpen = new Set<string>();

  const render = (issues: IssueItem[]) => {
    if (!(issuesList instanceof HTMLElement) || !(issuesEmpty instanceof HTMLElement)) {
      return;
    }
    const focusMark = markFocus(issuesList);
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
      const diagnosis = diagnoseIssue(issue);

      const item = document.createElement("article");
      item.className = "issue-item";
      item.dataset.severity = issue.severity;
      if (issue.action) {
        item.dataset.action = issue.action;
      }

      const head = document.createElement("div");
      head.className = "issue-head";

      const icon = document.createElement("span");
      icon.className = `issue-icon issue-icon-${issue.severity}`;
      icon.innerHTML = SEVERITY_ICON[issue.severity === "warning" ? "warning" : "error"];
      icon.setAttribute("role", "img");
      icon.setAttribute(
        "aria-label",
        issue.severity === "warning"
          ? uiText("Warning: the build still finished", "警告: ビルドは完了しています")
          : uiText("Error: the build stopped here", "エラー: ここでビルドが止まりました")
      );
      icon.title = icon.getAttribute("aria-label") ?? "";

      // What family of problem this is — the first thing to read.
      const kind = document.createElement("span");
      kind.className = "issue-kind";
      kind.dataset.noI18n = "";
      kind.textContent = diagnosis.kind;

      head.append(icon, kind);

      // What to do about it waits behind a ▾ beside the kind.
      const fix = diagnosis.fix ? createExplain(diagnosis.fix, { memory: fixOpen, key: issueKey(issue) }) : null;
      if (fix) {
        fix.panel.dataset.noI18n = "";
        head.append(fix.button);
      }

      const isRuntimeAction =
        issue.action === "open-runtime" && typeof deps.onOpenRuntimeSettings === "function";
      const hasJumpTarget = Boolean(detail.path || detail.line);
      const actionable = isRuntimeAction || hasJumpTarget;

      const body = document.createElement(actionable ? "button" : "div");
      body.className = "issue-main";
      if (body instanceof HTMLButtonElement) {
        body.type = "button";
      }

      const summary = document.createElement("span");
      summary.className = "issue-summary";
      summary.dataset.noI18n = "";
      summary.textContent = diagnosis.summary;

      body.append(summary);

      // The whole card is the button, so the location does not need a call to
      // action of its own — it just says where, up in the header. No location
      // for this kind of problem means no location shown at all.
      if (hasJumpTarget) {
        const where = document.createElement("span");
        where.className = "issue-location";
        where.dataset.noI18n = "";
        where.textContent =
          detail.path && detail.line
            ? `${detail.path}:${detail.line}`
            : detail.path
            ? detail.path
            : uiText(`Line ${detail.line}`, `${detail.line} 行目`);
        head.append(where);
      } else if (isRuntimeAction) {
        // No location to show, but there is still somewhere to go.
        const action = document.createElement("span");
        action.className = "issue-jump";
        action.textContent = uiText("Open Settings > Build", "設定 > ビルド を開く");
        body.append(action);
      }

      body.addEventListener("click", () => {
        if (isRuntimeAction) {
          deps.onOpenRuntimeSettings?.();
          return;
        }
        if (!hasJumpTarget) {
          return;
        }
        deps.onFocusIssue(issue);
      });

      item.append(head, body);
      if (fix) item.append(fix.panel);
      issuesList.appendChild(item);
    });
    restoreFocus(issuesList, focusMark);
  };

  return { render };
};

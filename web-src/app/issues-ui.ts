import type { AppContext } from "./context.js";
import { uiText } from "./i18n.js";
import type { IssueItem } from "./types.js";
import { diagnoseIssue } from "./issue-diagnosis.js";

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

const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><polyline points="4,6.5 8,10.5 12,6.5"/></svg>';

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

/** The log line as the build reported it, location included. */
const rawLogText = (issue: IssueItem, detail: IssueDetail) => {
  const where = [detail.path, detail.line, detail.column].filter(Boolean).join(":");
  const message = issue.message?.trim() ?? "";
  return where && !message.startsWith(where) ? `${where}\n${message}` : message;
};

export const initIssuesUi = (context: AppContext, deps: IssuesUiDeps): IssuesUiApi => {
  const { issuesList, issuesEmpty } = context.dom;
  let cardId = 0;

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

      // The log itself is opt-in: everything above it is written for someone
      // who has never read a TeX log.
      cardId += 1;
      const logId = `issue-log-${cardId}`;
      const disclosure = document.createElement("button");
      disclosure.type = "button";
      disclosure.className = "issue-disclosure";
      disclosure.innerHTML = CHEVRON;
      disclosure.setAttribute("aria-expanded", "false");
      disclosure.setAttribute("aria-controls", logId);
      disclosure.title = uiText("Show the build log for this issue", "この問題のビルドログを表示");
      disclosure.setAttribute("aria-label", disclosure.title);

      head.append(icon, kind);

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

      const fix = document.createElement("span");
      fix.className = "issue-fix";
      fix.dataset.noI18n = "";
      fix.textContent = diagnosis.fix;

      body.append(summary, fix);

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
        where.title = uiText("Click the card to open it beside this", "カードをクリックすると横に開きます");
        head.append(where);
      } else if (isRuntimeAction) {
        // No location to show, but there is still somewhere to go.
        const action = document.createElement("span");
        action.className = "issue-jump";
        action.textContent = uiText("Open Settings > Environment", "設定 > 環境 を開く");
        body.append(action);
      }

      head.append(disclosure);

      const log = document.createElement("pre");
      log.className = "issue-log";
      log.id = logId;
      log.dataset.noI18n = "";
      log.hidden = true;
      log.textContent = rawLogText(issue, detail);

      disclosure.addEventListener("click", () => {
        // `hidden` is typed wider than boolean in modern DOM lib, so normalize.
        const open = log.hidden !== false;
        log.hidden = !open;
        disclosure.setAttribute("aria-expanded", String(open));
        item.classList.toggle("is-log-open", open);
        disclosure.title = open
          ? uiText("Hide the build log", "ビルドログを隠す")
          : uiText("Show the build log for this issue", "この問題のビルドログを表示");
        disclosure.setAttribute("aria-label", disclosure.title);
      });

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

      item.append(head, body, log);
      issuesList.appendChild(item);
    });
  };

  return { render };
};

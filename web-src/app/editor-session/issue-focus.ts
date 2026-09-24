import type { IssueItem } from "../types.js";
import type { EditorSessionRuntime } from "./runtime.js";
import type { EditorSessionCoreOps } from "./core-ops.js";
import type { EditorSessionIssueOps } from "./issue-ops.js";
import type { EditorSessionNavigationOps } from "./navigation-ops.js";

export type FocusIssueOptions = {
  /** Where to open the offending file. Defaults to the active group. */
  groupKey?: "primary" | "secondary";
};

export type EditorSessionIssueFocusOps = {
  focusIssue: (issue: IssueItem, options?: FocusIssueOptions) => void;
};

export const createEditorSessionIssueFocusOps = (
  runtime: EditorSessionRuntime,
  coreOps: EditorSessionCoreOps,
  issueOps: EditorSessionIssueOps,
  navigationOps: EditorSessionNavigationOps,
  deps: {
    requestOpenFile: (path: string, groupKey: "primary" | "secondary", force?: boolean) => boolean;
  }
): EditorSessionIssueFocusOps => {
  const focusIssue = (issue: IssueItem, options: FocusIssueOptions = {}) => {
    const activeGroup = coreOps.getActiveGroup();
    const targetKey = options.groupKey ?? coreOps.getActiveEditorGroupKey();
    const monacoApi = runtime.deps.getMonacoApi();
    if (!activeGroup.editor || !monacoApi) {
      return;
    }
    const detail = issueOps.parseIssueDetail(issue);
    const className =
      issue.severity === "warning" ? "issue-line-warning" : "issue-line-highlight";
    if (detail.path && detail.line) {
      issueOps.clearIssueHighlight();
      navigationOps.jumpToFileLine(detail.path, detail.line, targetKey, {
        className,
        force: true,
      });
      return;
    }
    if (detail.path && !detail.line) {
      issueOps.clearIssueHighlight();
      deps.requestOpenFile(detail.path, targetKey, true);
      return;
    }
    if (!detail.line) {
      return;
    }
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = activeGroup.editor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
      revealLineInCenter: (lineNumber: number) => void;
      setPosition: (position: { lineNumber: number; column: number }) => void;
      focus: () => void;
    };
    issueOps.clearIssueHighlight();
    issueOps.clearJumpHighlight(activeGroup);
    runtime.state.issueDecorationGroup = activeGroup.key;
    runtime.state.issueDecorations = editor.deltaDecorations(runtime.state.issueDecorations, [
      {
        range: new monacoApiAny.Range(detail.line, 1, detail.line, 1),
        options: {
          isWholeLine: true,
          className,
          lineNumberClassName: `${className}-number`,
        },
      },
    ]);
    editor.revealLineInCenter(detail.line);
    editor.setPosition({ lineNumber: detail.line, column: 1 });
    editor.focus();
  };

  return { focusIssue };
};


import type { IssueItem } from "../types.js";
import type { EditorGroupState, EditorGroupKey } from "./types.js";
import type { EditorSessionRuntime } from "./runtime.js";
import type { EditorSessionCoreOps } from "./core-ops.js";

export type IssueDetail = {
  path: string | null;
  line: number | null;
  column: number | null;
  message: string;
};

export type EditorSessionIssueOps = {
  clearIssueHighlight: () => void;
  parseIssueDetail: (issue: IssueItem) => IssueDetail;
  syncIssueMarkers: (issues: IssueItem[]) => void;
  clearJumpHighlight: (group: EditorGroupState) => void;
  revealLine: (
    group: EditorGroupState,
    line: number,
    options?: { focus?: boolean; className?: string; column?: number }
  ) => void;
};

export const createEditorSessionIssueOps = (
  runtime: EditorSessionRuntime,
  coreOps: EditorSessionCoreOps
): EditorSessionIssueOps => {
  const clearJumpHighlight = (group: EditorGroupState) => {
    const decorations = runtime.jumpDecorations[group.key];
    if (!group.editor || decorations.length === 0) {
      runtime.jumpDecorationClassNames[group.key] = null;
      return;
    }
    const editor = group.editor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    runtime.jumpDecorations[group.key] = editor.deltaDecorations(decorations, []);
    runtime.jumpDecorationClassNames[group.key] = null;
  };

  const clearIssueHighlight = () => {
    const monacoApi = runtime.deps.getMonacoApi();
    if (!monacoApi) {
      return;
    }
    if (runtime.state.issueDecorations.length > 0 && runtime.state.issueDecorationGroup) {
      const issueGroup = coreOps.getEditorGroup(runtime.state.issueDecorationGroup);
      if (issueGroup.editor) {
        const editor = issueGroup.editor as {
          deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
        };
        runtime.state.issueDecorations = editor.deltaDecorations(runtime.state.issueDecorations, []);
      } else {
        runtime.state.issueDecorations = [];
      }
      runtime.state.issueDecorationGroup = null;
    }
    (Object.keys(runtime.editorGroups) as EditorGroupKey[]).forEach((key) => {
      const className = runtime.jumpDecorationClassNames[key];
      if (!className || !runtime.issueHighlightClassNames.has(className)) {
        return;
      }
      clearJumpHighlight(runtime.editorGroups[key]);
    });
  };

  const parseIssueDetail = (issue: IssueItem): IssueDetail => {
    const trimmed = issue.message.trim();
    const filePattern = String.raw`((?:[A-Za-z]:)?[^:\s]+?\.[A-Za-z0-9]+)`;
    const match =
      trimmed.match(new RegExp(`^${filePattern}:(\\d+):(\\d+):\\s*(.+)$`)) ??
      trimmed.match(new RegExp(`^${filePattern}:(\\d+):\\s*(.+)$`));
    if (match) {
      const path = issue.path ?? match[1];
      const line = issue.line ?? Number.parseInt(match[2], 10);
      const column =
        issue.column ??
        (match.length > 4 && match[3] && /^\\d+$/.test(match[3])
          ? Number.parseInt(match[3], 10)
          : null);
      let message = match.length > 4 ? match[4].trim() : match[3].trim();
      if (issue.path && issue.line) {
        const prefix = `${issue.path}:${issue.line}`;
        if (message.startsWith(prefix)) {
          message = message.slice(prefix.length).replace(/^:\\s*/, "");
        }
      }
      return { path, line: Number.isFinite(line) ? line : null, column, message };
    }
    return {
      path: issue.path ?? null,
      line: issue.line ?? null,
      column: issue.column ?? null,
      message: trimmed,
    };
  };

  const syncIssueMarkers = (issues: IssueItem[]) => {
    const monacoApi = runtime.deps.getMonacoApi();
    if (!monacoApi || runtime.monacoModels.size === 0) {
      return;
    }
    const monacoApiAny = monacoApi as {
      editor?: {
        setModelMarkers?: (
          model: unknown,
          owner: string,
          markers: Array<{
            severity: number;
            message: string;
            startLineNumber: number;
            startColumn: number;
            endLineNumber: number;
            endColumn: number;
          }>
        ) => void;
      };
    };
    if (typeof monacoApiAny.editor?.setModelMarkers !== "function") {
      return;
    }
    const activePath = coreOps.getActiveFilePath();
    const markersByPath = new Map<
      string,
      Array<{
        severity: number;
        message: string;
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      }>
    >();
    const pushMarker = (targetPath: string, marker: any) => {
      const current = markersByPath.get(targetPath);
      if (current) {
        current.push(marker);
      } else {
        markersByPath.set(targetPath, [marker]);
      }
    };
    issues.forEach((issue) => {
      const detail = parseIssueDetail(issue);
      const targetPath = detail.path ?? activePath;
      if (!targetPath) {
        return;
      }
      const line = Number.isFinite(detail.line) ? (detail.line as number) : null;
      if (!line || line < 1) {
        return;
      }
      const column = Number.isFinite(detail.column) ? (detail.column as number) : 1;
      const severity = issue.severity === "error" ? 8 : 4;
      pushMarker(targetPath, {
        severity,
        message: detail.message || issue.message,
        startLineNumber: line,
        startColumn: Math.max(1, column),
        endLineNumber: line,
        endColumn: Math.max(1, column) + 1,
      });
    });

    runtime.monacoModels.forEach((entry, path) => {
      const markers = markersByPath.get(path) ?? [];
      monacoApiAny.editor?.setModelMarkers?.(entry.model as unknown, "tex64", markers);
    });
  };

  const revealLine = (
    group: EditorGroupState,
    line: number,
    options: { focus?: boolean; className?: string; column?: number } = {}
  ) => {
    const monacoApi = runtime.deps.getMonacoApi();
    if (!group.editor || !monacoApi) {
      return;
    }
    clearJumpHighlight(group);
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = group.editor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
      revealLineInCenter: (lineNumber: number) => void;
      setPosition: (position: { lineNumber: number; column: number }) => void;
      focus: () => void;
      getModel?: () => {
        getLineCount: () => number;
        getLineMaxColumn: (lineNumber: number) => number;
      } | null;
    };
    const normalizedLine = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
    const normalizedColumn =
      Number.isFinite(options.column) && (options.column ?? 0) > 0
        ? Math.trunc(options.column ?? 1)
        : 1;
    let lineNumber = normalizedLine;
    let columnNumber = normalizedColumn;
    const model = editor.getModel?.();
    if (model) {
      const maxLine = model.getLineCount();
      if (Number.isFinite(maxLine) && maxLine >= 1) {
        lineNumber = Math.min(normalizedLine, maxLine);
      }
      const maxColumn = model.getLineMaxColumn(lineNumber);
      if (Number.isFinite(maxColumn) && maxColumn >= 1) {
        columnNumber = Math.min(normalizedColumn, maxColumn);
      }
    }
    const className = options.className ?? "jump-line-highlight";
    runtime.jumpDecorations[group.key] = editor.deltaDecorations(runtime.jumpDecorations[group.key], [
      {
        range: new monacoApiAny.Range(lineNumber, 1, lineNumber, 1),
        options: {
          isWholeLine: true,
          className,
        },
      },
    ]);
    runtime.jumpDecorationClassNames[group.key] = className;
    editor.revealLineInCenter(lineNumber);
    editor.setPosition({ lineNumber, column: columnNumber });
    if (options.focus !== false) {
      editor.focus();
    }
  };

  return {
    clearIssueHighlight,
    parseIssueDetail,
    syncIssueMarkers,
    clearJumpHighlight,
    revealLine,
  };
};


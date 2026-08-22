export type ProEditorLike = {
  getPosition?: () => { lineNumber: number; column: number } | null;
  executeEdits?: (source: string, edits: Array<{ range: unknown; text: string; forceMoveMarkers: boolean }>) => boolean;
  pushUndoStop?: () => boolean;
  focus?: () => void;
};

export const ensureTrailingNewline = (text: string) => text.endsWith("\n") ? text : `${text}\n`;

export const insertAtEditorCursor = (editor: ProEditorLike | null, text: string, source = "pro-canvas") => {
  const position = editor?.getPosition?.();
  const Range = (window as any).monaco?.Range;
  if (!editor?.executeEdits || !position || !Range) throw new Error("No active text editor is available.");
  editor.pushUndoStop?.();
  editor.executeEdits(source, [{
    range: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
    text: ensureTrailingNewline(text),
    forceMoveMarkers: true,
  }]);
  editor.pushUndoStop?.();
  editor.focus?.();
};

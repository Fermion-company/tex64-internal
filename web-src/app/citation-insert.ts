// Insert a citation key where the cursor is. Shared by the Zotero and arXiv
// flows: a new `\cite{key}` at the cursor, or `,key` appended when the cursor
// already sits inside the argument of a \cite-family command.

export type CitationEditor = {
  getModel?: () => { getLineContent: (line: number) => string; isDisposed?: () => boolean } | null;
  getPosition?: () => { lineNumber: number; column: number } | null;
  getSelection?: () => { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; isEmpty?: () => boolean } | null;
  executeEdits?: (source: string, edits: Array<{ range: unknown; text: string; forceMoveMarkers: boolean }>) => boolean;
  pushUndoStop?: () => boolean;
  focus?: () => void;
  getRawOptions?: () => { readOnly?: boolean };
};

const CITE_COMMAND =
  /\\(?:[cC]ite(?:p|t|author|year|yearpar|alp|alt|num|title)?|parencite|textcite|autocite|footcite|footfullcite|fullcite|smartcite|supercite|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{$/;

/**
 * When `column` (1-based) lies inside the `{…}` argument of a \cite command on
 * `line`, the argument's bounds (1-based columns of the text between braces).
 */
export const findCiteArgumentAt = (line: string, column: number): { start: number; end: number; keys: string[] } | null => {
  const offset = column - 1;
  const before = line.slice(0, offset);
  const open = before.lastIndexOf("{");
  if (open < 0 || before.indexOf("}", open) >= 0) return null;
  if (!CITE_COMMAND.test(before.slice(0, open + 1))) return null;
  const close = line.indexOf("}", offset);
  if (close < 0) return null;
  const inside = line.slice(open + 1, close);
  return { start: open + 2, end: close + 1, keys: inside.split(",").map((key) => key.trim()).filter(Boolean) };
};

/** Insert `key` as a citation. Returns the text that was inserted, or null. */
export const insertCitation = (editor: CitationEditor | null, key: string, source = "citation-insert"): string | null => {
  const model = editor?.getModel?.();
  const position = editor?.getPosition?.();
  const Range = (window as any).monaco?.Range;
  if (!editor?.executeEdits || !model || model.isDisposed?.() || !position || !Range) return null;
  if (editor.getRawOptions?.()?.readOnly) return null;
  const clean = key.trim();
  if (!clean) return null;

  const selection = editor.getSelection?.();
  const hasSelection = selection && !(selection.isEmpty ? selection.isEmpty() : selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn);
  const line = model.getLineContent(position.lineNumber);
  const argument = hasSelection ? null : findCiteArgumentAt(line, position.column);

  let range: unknown;
  let text: string;
  if (argument) {
    if (argument.keys.includes(clean)) return "";
    const column = argument.end;
    const trimmed = line.slice(argument.start - 1, argument.end - 1).trim();
    text = trimmed ? (trimmed.endsWith(",") ? clean : `,${clean}`) : clean;
    range = new Range(position.lineNumber, column, position.lineNumber, column);
  } else if (hasSelection && selection) {
    text = `\\cite{${clean}}`;
    range = new Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn);
  } else {
    text = `\\cite{${clean}}`;
    range = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
  }
  editor.pushUndoStop?.();
  editor.executeEdits(source, [{ range, text, forceMoveMarkers: true }]);
  editor.pushUndoStop?.();
  editor.focus?.();
  return text;
};

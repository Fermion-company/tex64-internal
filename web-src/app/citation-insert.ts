// Inserts a citation into the editor. Shared by the arXiv search and Zotero
// dialogs: \cite{key} at the cursor, or ",key" appended when the cursor is
// already inside a \cite-like argument.

const CITE_COMMANDS =
  /\\(?:[cC]ite(?:p|t|author|year|yearpar|alp|alt|num|title)?|parencite|textcite|autocite|footcite|footfullcite|fullcite|smartcite|supercite|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]*)\}/g;

export type CiteArgument = {
  /** 1-based column of the first character inside the braces. */
  start: number;
  /** 1-based column of the closing brace. */
  end: number;
  keys: string[];
};

/** The \cite-like argument whose braces contain `column` (1-based), if any. */
export const findCiteArgumentAt = (lineText: string, column: number): CiteArgument | null => {
  CITE_COMMANDS.lastIndex = 0;
  for (let match = CITE_COMMANDS.exec(lineText); match; match = CITE_COMMANDS.exec(lineText)) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = match.index + match[0].length - 1;
    const start = open + 2;
    const end = close + 1;
    // Inside the braces, or immediately after the closing brace (where the
    // caret lands after an earlier insertion).
    if (column >= start && column <= end + 1) {
      CITE_COMMANDS.lastIndex = 0;
      return { start, end, keys: match[1].split(",").map((key) => key.trim()).filter(Boolean) };
    }
  }
  return null;
};

type Position = { lineNumber: number; column: number };
type EditorLike = {
  getModel?: () => { getLineContent: (line: number) => string; isDisposed?: () => boolean } | null;
  getSelection?: () => { isEmpty?: () => boolean; getEndPosition?: () => Position } | null;
  getPosition?: () => Position | null;
  executeEdits?: (source: string, edits: { range: unknown; text: string }[]) => boolean;
  setPosition?: (position: Position) => void;
  focus?: () => void;
};

export type InsertCitationResult = "inserted" | "appended" | "present" | "unavailable";

/**
 * Insert `\cite{key}` at the caret (after the selection when there is one).
 * Inside an existing \cite{…} the key is appended instead.
 */
export const insertCitation = (editor: EditorLike, key: string): InsertCitationResult => {
  const model = editor?.getModel?.();
  if (!model || model.isDisposed?.() || !editor.executeEdits) return "unavailable";
  const selection = editor.getSelection?.();
  const position =
    selection && selection.isEmpty && !selection.isEmpty() && selection.getEndPosition
      ? selection.getEndPosition()
      : editor.getPosition?.();
  if (!position) return "unavailable";
  const lineText = model.getLineContent(position.lineNumber);
  const inside = findCiteArgumentAt(lineText, position.column);
  if (inside) {
    if (inside.keys.includes(key)) return "present";
    const range = {
      startLineNumber: position.lineNumber,
      startColumn: inside.end,
      endLineNumber: position.lineNumber,
      endColumn: inside.end,
    };
    const text = inside.keys.length ? `,${key}` : key;
    editor.executeEdits("tex64.cite", [{ range, text }]);
    editor.setPosition?.({ lineNumber: position.lineNumber, column: inside.end + text.length + 1 });
    return "appended";
  }
  const before = lineText.slice(0, position.column - 1);
  // A tie keeps the citation on the line of the word it follows.
  const prefix = /[A-Za-z0-9)\]]$/.test(before) ? "~" : "";
  const text = `${prefix}\\cite{${key}}`;
  const range = {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
  editor.executeEdits("tex64.cite", [{ range, text }]);
  editor.setPosition?.({ lineNumber: position.lineNumber, column: position.column + text.length });
  return "inserted";
};

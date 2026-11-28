// LaTeX authoring ergonomics layered on a Monaco editor instance:
//   - Enter after a non-empty "\item" starts a new "\item " (an empty "\item"
//     is left untouched — Enter just inserts a normal newline)
//   - Typing "\begin{env}" inserts a matching "\end{env}" body (also on Enter
//     right before its auto-inserted "}", and when the name is accepted from
//     the suggest list: planEnvironmentAccept)
//   - TeX math delimiters "\[" / "\(" receive their TeX-aware closers
//   - Wrap-selection actions (\textbf, \textit, \emph, \texttt)
// Each behavior reads its flag from the editor settings store at call time, so
// toggling a feature on/off takes effect live without re-attaching.

import { editorSettings } from "./editor-settings/editor-settings-store.js";
import { uiText } from "./i18n.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Monaco = any;

const leadingWhitespace = (line: string): string => (line.match(/^[ \t]*/) || [""])[0];

export type TexDelimiterCompletion = {
  text: string;
  replaceLength: number;
  cursorLineDelta?: number;
  cursorColumn?: number;
};

export const planTexDelimiterCompletion = (
  typed: string,
  before: string,
  after: string
): TexDelimiterCompletion | null => {
  let slashCount = 0;
  for (let index = before.length - 2; index >= 0 && before[index] === "\\"; index -= 1) {
    slashCount += 1;
  }
  // "\\[" is a math opener, whereas "\\\\[" is a line break followed by
  // an ordinary bracket. Only an unescaped TeX command slash starts a pair.
  if (slashCount % 2 === 0) {
    return null;
  }
  const pair =
    typed === "[" && before.endsWith("\\[")
      ? { plainClose: "]", text: "\\]" as const }
      : typed === "(" && before.endsWith("\\(")
        ? { plainClose: ")", text: "\\)" as const }
        : null;
  if (!pair) {
    return null;
  }
  if (after.startsWith(pair.text)) {
    return null;
  }
  const displayLine = typed === "[" ? before.match(/^([ \t]*)\\\[$/) : null;
  if (displayLine) {
    const indent = displayLine[1];
    return {
      text: `\n${indent}  \n${indent}\\]`,
      replaceLength: after.startsWith(pair.plainClose) ? 1 : 0,
      cursorLineDelta: 1,
      cursorColumn: indent.length + 3,
    };
  }
  // Monaco has already inserted its ordinary bracket closer in the common
  // path ("\\[]" / "\\()"). Replace it instead of adding a second closer.
  return {
    text: pair.text,
    replaceLength: after.startsWith(pair.plainClose) ? 1 : 0,
  };
};

export type EnvironmentCompletion = {
  text: string;
  cursorColumn: number;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stripTexComment = (line: string): string => {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "%") {
      continue;
    }
    let slashes = 0;
    for (let back = index - 1; back >= 0 && line[back] === "\\"; back -= 1) {
      slashes += 1;
    }
    if (slashes % 2 === 0) {
      return line.slice(0, index);
    }
  }
  return line;
};

// Counts "\begin{env}" and "\end{env}" outside comments. When the document
// already has as many ends as begins, a new "\begin{env}" is closed by an end
// the user wrote (or a completion added earlier), and adding one more would
// leave a stray "\end" that stops the build.
export const countEnvironmentPairs = (
  text: string,
  env: string
): { begins: number; ends: number } => {
  const name = escapeRegExp(env);
  const beginRe = new RegExp(`\\\\begin\\s*\\{${name}\\}`, "g");
  const endRe = new RegExp(`\\\\end\\s*\\{${name}\\}`, "g");
  let begins = 0;
  let ends = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTexComment(raw);
    begins += (line.match(beginRe) || []).length;
    ends += (line.match(endRe) || []).length;
  }
  return { begins, ends };
};

// After the user finishes typing "\end{env}" by hand right above the end a
// completion inserted, the document holds one end too many. Returns the line
// number (1-based) of that following end line to remove, or null.
export const planDuplicateEndRemoval = (
  before: string,
  after: string,
  lines: string[],
  lineNumber: number,
  documentText: string
): number | null => {
  if (after.trim() !== "") {
    return null;
  }
  const endMatch = before.match(/^[ \t]*\\end\{([^{}\r\n]+)\}$/);
  if (!endMatch) {
    return null;
  }
  const env = endMatch[1];
  const { begins, ends } = countEnvironmentPairs(documentText, env);
  if (ends <= begins) {
    return null;
  }
  for (let index = lineNumber; index < lines.length; index += 1) {
    const next = lines[index];
    if (next.trim() === "") {
      continue;
    }
    return next.trim() === `\\end{${env}}` ? index + 1 : null;
  }
  return null;
};

export const planEnvironmentCompletion = (
  before: string,
  after: string,
  documentText?: string
): EnvironmentCompletion | null => {
  if (after.trim() !== "") {
    return null;
  }
  const beginMatch = before.match(/^([ \t]*)\\begin\{([^{}\r\n]+)\}$/);
  if (!beginMatch) {
    return null;
  }
  const indent = beginMatch[1];
  const env = beginMatch[2];
  if (typeof documentText === "string") {
    const { begins, ends } = countEnvironmentPairs(documentText, env);
    if (ends >= begins) {
      return null;
    }
  }
  return {
    text: `\n${indent}  \n${indent}\\end{${env}}`,
    cursorColumn: indent.length + 3,
  };
};

type EnvironmentPairCounts = Map<string, { begins: number; ends: number }>;

// countEnvironmentPairs for every name in one pass, leaving out one line (the
// line a completion is about to rewrite).
export const countAllEnvironmentPairs = (
  lines: string[],
  skipLineIndex = -1
): EnvironmentPairCounts => {
  const counts: EnvironmentPairCounts = new Map();
  lines.forEach((raw, index) => {
    if (index === skipLineIndex || !raw.includes("\\")) {
      return;
    }
    const tokens = /\\(begin|end)\s*\{([^{}\r\n]+)\}/g;
    const line = stripTexComment(raw);
    for (let match = tokens.exec(line); match; match = tokens.exec(line)) {
      const entry = counts.get(match[2]) ?? { begins: 0, ends: 0 };
      if (match[1] === "begin") {
        entry.begins += 1;
      } else {
        entry.ends += 1;
      }
      counts.set(match[2], entry);
    }
  });
  return counts;
};

export type EnvironmentAccept = {
  startColumn: number;
  endColumn: number;
  snippet: string;
};

const escapeSnippetText = (value: string): string => value.replace(/[\\$}]/g, "\\$&");

// Accepting an environment name from the suggest list in "\begin{...}" also
// steps over the closing brace and adds the body line and "\end{name}": the
// same text and caret as typing the "}" (planEnvironmentCompletion), written
// as one snippet so it is one edit and one undo step. Monaco's snippet
// insertion gives the following lines the begin line's indentation. Returns
// null where typing "}" would not close either: the begin is not alone on its
// line, text follows the brace, or an "\end{name}" already pairs with it.
// `counts` covers every line except the caret's.
export const planEnvironmentAccept = (
  line: string,
  caretColumn: number,
  env: string,
  counts: EnvironmentPairCounts
): EnvironmentAccept | null => {
  const head = line.slice(0, caretColumn - 1).match(/^([ \t]*\\begin\{)[^{}\\\s]*$/);
  if (!head || !/^\}?[ \t]*$/.test(line.slice(caretColumn - 1))) {
    return null;
  }
  if (!/^[^{}\\\s%]+$/.test(env)) {
    return null;
  }
  const { begins, ends } = counts.get(env) ?? { begins: 0, ends: 0 };
  if (ends >= begins + 1) {
    return null;
  }
  const name = escapeSnippetText(env);
  return {
    startColumn: head[1].length + 1,
    endColumn: line.length + 1,
    snippet: `${name}\\}\n  $0\n\\\\end{${name}\\}`,
  };
};

// Enter with the caret right before the "}" of "\begin{env}" (the brace an
// auto-close inserted) acts as at the end of the line instead of splitting
// "\begin{env" from its brace.
export const isBeforeBeginBrace = (before: string, after: string): boolean =>
  /^[ \t]*\\begin\{[^{}\r\n]+$/.test(before) && /^\}[ \t]*$/.test(after);

export type CursorEnterPlan = {
  edits: Array<{ lineNumber: number; startColumn: number; endColumn: number; text: string }>;
  cursors: Array<{ lineNumber: number; column: number }>;
};

// Enter with several cursors, when one of them is in a "\begin{env}" line (at
// its end or right before its brace): every such cursor closes its
// environment as a single cursor would, or, where an "\end" already pairs
// with it, breaks the line after the brace; the other cursors get a plain line
// break with their line's indentation. One edit, so one undo step. Null (leave
// it to monaco) when no cursor is in a begin line or two share a line.
export const planEnterAtCursors = (
  lines: string[],
  cursors: Array<{ lineNumber: number; column: number }>,
  autoClose: boolean
): CursorEnterPlan | null => {
  if (new Set(cursors.map((cursor) => cursor.lineNumber)).size !== cursors.length) {
    return null;
  }
  const cases = [...cursors]
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((cursor) => {
      const line = lines[cursor.lineNumber - 1] ?? "";
      const before = line.slice(0, cursor.column - 1);
      const after = line.slice(cursor.column - 1);
      const brace = isBeforeBeginBrace(before, after);
      const atEnd = after.trim() === "" && /^[ \t]*\\begin\{[^{}\r\n]+\}$/.test(before);
      const env = brace || atEnd ? (before.match(/\\begin\{([^{}\r\n]+)\}?$/)?.[1] ?? null) : null;
      return { cursor, line, brace, env, indent: leadingWhitespace(line) };
    });
  if (!cases.some((entry) => entry.env)) {
    return null;
  }
  // Every begin line is already in the counts; each may take one of the
  // missing ends, in document order.
  const counts = autoClose ? countAllEnvironmentPairs(lines) : null;
  const unclosed = new Map<string, number>();
  const plan: CursorEnterPlan = { edits: [], cursors: [] };
  let addedLines = 0;
  for (const { cursor, line, brace, env, indent } of cases) {
    if (env && counts && !unclosed.has(env)) {
      const { begins, ends } = counts.get(env) ?? { begins: 0, ends: 0 };
      unclosed.set(env, begins - ends);
    }
    if (env && counts && (unclosed.get(env) ?? 0) > 0) {
      unclosed.set(env, (unclosed.get(env) ?? 0) - 1);
      plan.edits.push({
        lineNumber: cursor.lineNumber,
        startColumn: cursor.column,
        endColumn: line.length + 1,
        text: `${brace ? "}" : ""}\n${indent}  \n${indent}\\end{${env}}`,
      });
      plan.cursors.push({ lineNumber: cursor.lineNumber + addedLines + 1, column: indent.length + 3 });
      addedLines += 2;
    } else {
      const column = env ? line.length + 1 : cursor.column;
      plan.edits.push({ lineNumber: cursor.lineNumber, startColumn: column, endColumn: column, text: `\n${indent}` });
      plan.cursors.push({ lineNumber: cursor.lineNumber + addedLines + 1, column: indent.length + 1 });
      addedLines += 1;
    }
  }
  return plan;
};

// The label of the focused row of the editor's suggestion list; null while
// no list is shown ("" for a row without one).
const focusedSuggestion = (editor: any): string | null => {
  const widget = editor.getDomNode?.()?.querySelector?.(".suggest-widget.visible");
  if (!widget) {
    return null;
  }
  return widget.querySelector(".monaco-list-row.focused .label-name")?.textContent ?? "";
};

// The suggestion list is open on an environment name it does not show as
// typed (a partial "\begin{eq|}"): Enter does not close the environment with
// that name; it breaks the line (Tab accepts the suggestion). A name the list
// shows exactly, and any name with the list closed (a custom environment),
// is closed as before.
export const isPartialBeginName = (before: string, suggestion: string | null): boolean => {
  if (suggestion === null) {
    return false;
  }
  const name = before.match(/\\begin\{([^{}\r\n]+)\}?$/)?.[1];
  return Boolean(name) && name !== suggestion;
};

export const attachEditorErgonomics = (
  monaco: Monaco,
  editor: any,
  group: { isComposing?: boolean }
): void => {
  const KeyCode = monaco?.KeyCode;
  const KeyMod = monaco?.KeyMod;
  if (!editor || !KeyCode) {
    return;
  }

  // These helpers edit at the primary cursor and then set a single caret, so
  // with several cursors they would drop the others; Monaco's own typing
  // handles every cursor instead. Enter has its own plan for several cursors
  // (planEnterAtCursors).
  const hasSeveralCursors = (): boolean => (editor.getSelections?.()?.length ?? 1) > 1;

  editor.onDidType?.((typed: string) => {
    if (group?.isComposing || hasSeveralCursors()) {
      return;
    }
    const model = editor.getModel?.();
    const pos = editor.getPosition?.();
    if (!model || !pos) {
      return;
    }
    const line = model.getLineContent(pos.lineNumber);
    const before = line.slice(0, pos.column - 1);
    const after = line.slice(pos.column - 1);

    const delimiter = planTexDelimiterCompletion(typed, before, after);
    if (delimiter) {
      editor.executeEdits("ergo-tex-delimiter", [
        {
          range: new monaco.Range(
            pos.lineNumber,
            pos.column,
            pos.lineNumber,
            pos.column + delimiter.replaceLength
          ),
          text: delimiter.text,
        },
      ]);
      // Keep the caret inside the generated pair. A standalone display opener
      // gets the same indented blank body line as an environment completion.
      editor.setPosition(delimiter.cursorLineDelta
        ? {
            lineNumber: pos.lineNumber + delimiter.cursorLineDelta,
            column: delimiter.cursorColumn ?? pos.column,
          }
        : pos);
      return;
    }

    if (typed !== "}" || !editorSettings.isEnabled("ergo.autoCloseEnvironment")) {
      return;
    }
    const documentText = model.getValue();
    const duplicateEnd = planDuplicateEndRemoval(
      before,
      after,
      model.getLinesContent ? model.getLinesContent() : documentText.split(/\r?\n/),
      pos.lineNumber,
      documentText
    );
    if (duplicateEnd) {
      editor.executeEdits("ergo-env-dedupe", [
        {
          range: new monaco.Range(
            pos.lineNumber,
            line.length + 1,
            duplicateEnd,
            model.getLineContent(duplicateEnd).length + 1
          ),
          text: "",
        },
      ]);
      editor.setPosition(pos);
      return;
    }
    const environment = planEnvironmentCompletion(before, after, documentText);
    if (!environment) {
      return;
    }
    editor.executeEdits("ergo-env", [
      {
        // Consume trailing whitespace on the begin line so it does not wind up
        // after the generated end line.
        range: new monaco.Range(
          pos.lineNumber,
          pos.column,
          pos.lineNumber,
          line.length + 1
        ),
        text: environment.text,
      },
    ]);
    editor.setPosition({
      lineNumber: pos.lineNumber + 1,
      column: environment.cursorColumn,
    });
  });

  editor.onKeyDown?.((event: any) => {
    if (event.keyCode !== KeyCode.Enter) {
      return;
    }
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (group?.isComposing) {
      return; // don't fight IME composition
    }
    const model = editor.getModel?.();
    if (hasSeveralCursors()) {
      const selections: any[] = editor.getSelections?.() ?? [];
      if (!model || selections.some((selection) => !selection.isEmpty?.())) {
        return;
      }
      const primary = editor.getPosition?.();
      const partial = Boolean(primary) && isPartialBeginName(
        model.getLineContent(primary.lineNumber).slice(0, primary.column - 1),
        focusedSuggestion(editor)
      );
      const plan = planEnterAtCursors(
        model.getLinesContent(),
        selections.map((selection) => ({
          lineNumber: selection.positionLineNumber,
          column: selection.positionColumn,
        })),
        editorSettings.isEnabled("ergo.autoCloseEnvironment") && !partial
      );
      if (!plan) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      editor.pushUndoStop?.();
      editor.executeEdits(
        "ergo-env",
        plan.edits.map((edit) => ({
          range: new monaco.Range(edit.lineNumber, edit.startColumn, edit.lineNumber, edit.endColumn),
          text: edit.text,
        })),
        plan.cursors.map(
          (cursor) => new monaco.Selection(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column)
        )
      );
      editor.pushUndoStop?.();
      return;
    }
    const pos = editor.getPosition?.();
    if (!model || !pos) {
      return;
    }
    const line = model.getLineContent(pos.lineNumber);
    const before = line.slice(0, pos.column - 1);
    const after = line.slice(pos.column - 1);
    const beforeBrace = isBeforeBeginBrace(before, after);
    if (after.trim() !== "" && !beforeBrace) {
      return; // only act when the caret is at the end of the line's content
    }
    const indent = leadingWhitespace(line);

    // "\item" continuation. Only act on a NON-empty item; an empty "\item" is
    // left as-is and Enter falls through to a normal newline (never delete the
    // user's "\item").
    if (editorSettings.isEnabled("ergo.itemOnEnter")) {
      const itemMatch = before.match(/^[ \t]*\\item\b[ \t]?(.*)$/);
      if (itemMatch && itemMatch[1].trim() !== "") {
        event.preventDefault();
        event.stopPropagation();
        const insert = `\n${indent}\\item `;
        editor.executeEdits("ergo-item", [
          { range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: insert },
        ]);
        editor.setPosition({ lineNumber: pos.lineNumber + 1, column: indent.length + 7 });
        return;
      }
    }

    // "\begin{env}" -> insert body + matching "\end{env}".
    if (editorSettings.isEnabled("ergo.autoCloseEnvironment") && !isPartialBeginName(before, focusedSuggestion(editor))) {
      const environment = beforeBrace
        ? planEnvironmentCompletion(`${before}}`, "", model.getValue())
        : planEnvironmentCompletion(before, after, model.getValue());
      if (environment) {
        event.preventDefault();
        event.stopPropagation();
        // Its own undo step: undo takes back the closing, not the typing.
        editor.pushUndoStop?.();
        editor.executeEdits("ergo-env", [
          {
            range: new monaco.Range(
              pos.lineNumber,
              pos.column,
              pos.lineNumber,
              line.length + 1
            ),
            text: `${beforeBrace ? "}" : ""}${environment.text}`,
          },
        ]);
        editor.setPosition({
          lineNumber: pos.lineNumber + 1,
          column: environment.cursorColumn,
        });
        editor.pushUndoStop?.();
        return;
      }
    }

    // Nothing to close (an "\end" already pairs with it, or the feature is
    // off): still break the line after the brace, not before it.
    if (beforeBrace) {
      event.preventDefault();
      event.stopPropagation();
      editor.pushUndoStop?.();
      editor.executeEdits("ergo-env", [
        {
          range: new monaco.Range(pos.lineNumber, line.length + 1, pos.lineNumber, line.length + 1),
          text: `\n${indent}`,
        },
      ]);
      editor.setPosition({ lineNumber: pos.lineNumber + 1, column: indent.length + 1 });
      editor.pushUndoStop?.();
    }
  });

  editor.onDidChangeCursorPosition?.((event: any) => {
    if (!editorSettings.isEnabled("ergo.typewriterScroll")) {
      return;
    }
    // "Keep the cursor near the center WHILE WRITING": recentering must
    // never fire for mouse-originated cursor moves — with it, every click
    // yanked the clicked line to the vertical center and the whole view
    // visibly jumped (~12 lines for a click near the bottom edge).
    if (event?.source === "mouse") {
      return;
    }
    const position = event?.position ?? editor.getPosition?.();
    if (!position) {
      return;
    }
    const scrollType = monaco?.editor?.ScrollType?.Immediate;
    editor.revealPositionInCenter?.(position, scrollType);
  });

  // Wrap-selection actions. Registered once; the run handler checks the flag so
  // it can be toggled live.
  if (KeyMod && KeyCode && typeof editor.addAction === "function") {
    const wrap = (command: string) => {
      if (!editorSettings.isEnabled("ergo.wrapSelection")) {
        return;
      }
      const selection = editor.getSelection?.();
      const model = editor.getModel?.();
      if (!selection || !model) {
        return;
      }
      const selected = model.getValueInRange(selection);
      editor.executeEdits("ergo-wrap", [
        { range: selection, text: `\\${command}{${selected}}` },
      ]);
      if (!selected) {
        // Place the caret inside the braces: after "\command{".
        editor.setPosition?.({
          lineNumber: selection.startLineNumber,
          column: selection.startColumn + command.length + 2,
        });
      }
      editor.focus?.();
    };

    const addWrap = (id: string, label: string, command: string, keybinding?: number) => {
      editor.addAction({
        id,
        label,
        keybindings: typeof keybinding === "number" ? [keybinding] : [],
        contextMenuGroupId: "9_latex_wrap",
        run: () => wrap(command),
      });
    };

    addWrap("tex64.wrap.textbf", uiText("Bold", "太字"), "textbf", KeyMod.CtrlCmd | KeyCode.KeyB);
    addWrap("tex64.wrap.textit", uiText("Italic", "斜体"), "textit", KeyMod.CtrlCmd | KeyCode.KeyI);
    addWrap("tex64.wrap.emph", uiText("Emphasize", "強調"), "emph");
    addWrap("tex64.wrap.texttt", uiText("Monospace", "等幅"), "texttt");
  }
};

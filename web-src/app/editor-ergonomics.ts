// LaTeX authoring ergonomics layered on a Monaco editor instance:
//   - Enter after a non-empty "\item" starts a new "\item " (an empty "\item"
//     is left untouched — Enter just inserts a normal newline)
//   - Typing "\begin{env}" inserts a matching "\end{env}" body
//   - TeX math delimiters "\[" / "\(" receive their TeX-aware closers
//   - Wrap-selection actions (\textbf, \textit, \emph, \texttt)
// Each behavior reads its flag from the editor settings store at call time, so
// toggling a feature on/off takes effect live without re-attaching.

import { editorSettings } from "./editor-settings/editor-settings-store.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Monaco = any;

const leadingWhitespace = (line: string): string => (line.match(/^[ \t]*/) || [""])[0];

export type TexDelimiterCompletion = {
  text: "\\]" | "\\)";
  replaceLength: number;
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

export const planEnvironmentCompletion = (
  before: string,
  after: string
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
  return {
    text: `\n${indent}  \n${indent}\\end{${env}}`,
    cursorColumn: indent.length + 3,
  };
};

const suggestWidgetOpen = (): boolean => {
  try {
    return typeof document !== "undefined" && !!document.querySelector(".suggest-widget.visible");
  } catch {
    return false;
  }
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

  editor.onDidType?.((typed: string) => {
    if (group?.isComposing) {
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
      // Keep the caret between the opener and closer. executeEdits normally
      // moves it after the inserted text.
      editor.setPosition(pos);
      return;
    }

    if (typed !== "}" || !editorSettings.isEnabled("ergo.autoCloseEnvironment")) {
      return;
    }
    const environment = planEnvironmentCompletion(before, after);
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
    if (suggestWidgetOpen()) {
      return; // let Enter accept the completion
    }
    const model = editor.getModel?.();
    const pos = editor.getPosition?.();
    if (!model || !pos) {
      return;
    }
    const line = model.getLineContent(pos.lineNumber);
    const before = line.slice(0, pos.column - 1);
    const after = line.slice(pos.column - 1);
    if (after.trim() !== "") {
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
    if (editorSettings.isEnabled("ergo.autoCloseEnvironment")) {
      const environment = planEnvironmentCompletion(before, after);
      if (environment) {
        event.preventDefault();
        event.stopPropagation();
        editor.executeEdits("ergo-env", [
          {
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
        return;
      }
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

    addWrap("tex64.wrap.textbf", "LaTeX: Bold (\\textbf)", "textbf", KeyMod.CtrlCmd | KeyCode.KeyB);
    addWrap("tex64.wrap.textit", "LaTeX: Italic (\\textit)", "textit", KeyMod.CtrlCmd | KeyCode.KeyI);
    addWrap("tex64.wrap.emph", "LaTeX: Emphasize (\\emph)", "emph");
    addWrap("tex64.wrap.texttt", "LaTeX: Monospace (\\texttt)", "texttt");
  }
};

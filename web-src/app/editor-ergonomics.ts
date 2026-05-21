// LaTeX authoring ergonomics layered on a Monaco editor instance:
//   - Enter after a non-empty "\item" starts a new "\item " (an empty "\item"
//     is left untouched — Enter just inserts a normal newline)
//   - Enter right after "\begin{env}" inserts a matching "\end{env}" body
//   - Wrap-selection actions (\textbf, \textit, \emph, \texttt)
// Each behavior reads its flag from the editor settings store at call time, so
// toggling a feature on/off takes effect live without re-attaching.

import { editorSettings } from "./editor-settings/editor-settings-store.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Monaco = any;

const leadingWhitespace = (line: string): string => (line.match(/^[ \t]*/) || [""])[0];

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
      const beginMatch = before.match(/\\begin\{([^}]+)\}$/);
      if (beginMatch) {
        event.preventDefault();
        event.stopPropagation();
        const env = beginMatch[1];
        const insert = `\n${indent}  \n${indent}\\end{${env}}`;
        editor.executeEdits("ergo-env", [
          { range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: insert },
        ]);
        editor.setPosition({ lineNumber: pos.lineNumber + 1, column: indent.length + 3 });
        return;
      }
    }
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

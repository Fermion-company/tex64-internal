import { PLACEHOLDER_LATEX, indexToOffset, offsetToIndex, getMathFieldSelectionRange } from "../math-input-utils.js";
import { readMathFieldValue, setSelectionRange, writeMathFieldValue } from "../input-ui-math-field.js";
import type { MathWysiwygApi } from "../../../math/wysiwyg/math-wysiwyg.js";

export type ReadMathFieldLatex = (
  target: { getValue?: (...args: unknown[]) => unknown },
  ...args: unknown[]
) => string | null;

export type MathfieldMatrixOps = {
  tryInsertMatrixRow: () => boolean;
  tryInsertMatrixColumn: () => boolean;
  openMatrixOpsPalette: () => boolean;
};

export const createMathfieldMatrixOps = (params: {
  mathfield: HTMLElement;
  mathWysiwygApi: MathWysiwygApi | null;
  readMathFieldLatex: ReadMathFieldLatex;
}): MathfieldMatrixOps => {
  const { mathfield, mathWysiwygApi, readMathFieldLatex } = params;

  const MATRIX_ENV_NAMES = new Set([
    "matrix",
    "pmatrix",
    "bmatrix",
    "Bmatrix",
    "vmatrix",
    "Vmatrix",
    "smallmatrix",
    "cases",
    "dcases",
    "rcases",
  ]);

  const findMatrixEnvironment = (latex: string, cursorIndex: number) => {
    const tokenRegex = /\\(begin|end)\{([A-Za-z*]+)\}/g;
    const stack: Array<{
      name: string;
      start: number;
      bodyStart: number;
      beginToken: string;
    }> = [];
    let match: RegExpExecArray | null = null;
    let found: {
      name: string;
      start: number;
      end: number;
      bodyStart: number;
      bodyEnd: number;
      beginToken: string;
      endToken: string;
    } | null = null;
    while ((match = tokenRegex.exec(latex))) {
      const kind = match[1];
      const name = match[2];
      const tokenStart = match.index;
      const tokenText = match[0];
      if (kind === "begin") {
        stack.push({
          name,
          start: tokenStart,
          bodyStart: tokenStart + tokenText.length,
          beginToken: tokenText,
        });
        continue;
      }
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name !== name) {
          continue;
        }
        const entry = stack.splice(i, 1)[0];
        // `aligned*` etc should be treated the same as the base environment name.
        const base = name.replace(/\*$/, "");
        const bodyEnd = tokenStart;
        if (cursorIndex >= entry.bodyStart && cursorIndex <= bodyEnd) {
          if (MATRIX_ENV_NAMES.has(base)) {
            if (!found || entry.bodyStart >= found.bodyStart) {
              found = {
                name,
                start: entry.start,
                end: tokenStart + tokenText.length,
                bodyStart: entry.bodyStart,
                bodyEnd,
                beginToken: entry.beginToken,
                endToken: tokenText,
              };
            }
          }
        }
        break;
      }
    }
    return found;
  };

  const splitRows = (body: string) => {
    const isEscapedAt = (text: string, index: number) => {
      let count = 0;
      for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
        count += 1;
      }
      return count % 2 === 1;
    };
    const readEnvironmentTokenAt = (text: string, index: number) => {
      if (text[index] !== "\\") {
        return null;
      }
      const match = /^\\(begin|end)\{([A-Za-z*]+)\}/.exec(text.slice(index));
      if (!match) {
        return null;
      }
      return {
        kind: match[1] as "begin" | "end",
        name: match[2],
        length: match[0].length,
      };
    };
    const state = {
      braceDepth: 0,
      bracketDepth: 0,
      envStack: [] as string[],
    };
    const isTopLevel = () =>
      state.braceDepth === 0 && state.bracketDepth === 0 && state.envStack.length === 0;
    const consumeStructuralToken = (text: string, index: number) => {
      const envToken = readEnvironmentTokenAt(text, index);
      if (envToken) {
        if (envToken.kind === "begin") {
          state.envStack.push(envToken.name);
        } else {
          for (let i = state.envStack.length - 1; i >= 0; i -= 1) {
            if (state.envStack[i] !== envToken.name) {
              continue;
            }
            state.envStack.splice(i, 1);
            break;
          }
        }
        return index + envToken.length - 1;
      }
      const ch = text[index];
      if (ch === "{" && !isEscapedAt(text, index)) {
        state.braceDepth += 1;
      } else if (ch === "}" && !isEscapedAt(text, index)) {
        state.braceDepth = Math.max(0, state.braceDepth - 1);
      } else if (ch === "[" && !isEscapedAt(text, index)) {
        state.bracketDepth += 1;
      } else if (ch === "]" && !isEscapedAt(text, index)) {
        state.bracketDepth = Math.max(0, state.bracketDepth - 1);
      }
      return index;
    };

    const rows: Array<{ text: string; start: number; end: number }> = [];
    let rowStart = 0;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === "\\" && body[i + 1] === "\\" && !isEscapedAt(body, i) && isTopLevel()) {
        rows.push({ text: body.slice(rowStart, i), start: rowStart, end: i });
        i += 1;
        rowStart = i + 1;
        continue;
      }
      i = consumeStructuralToken(body, i);
    }
    rows.push({ text: body.slice(rowStart), start: rowStart, end: body.length });
    return rows;
  };

  const splitCells = (rowText: string) => {
    const isEscapedAt = (text: string, index: number) => {
      let count = 0;
      for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
        count += 1;
      }
      return count % 2 === 1;
    };
    const readEnvironmentTokenAt = (text: string, index: number) => {
      if (text[index] !== "\\") {
        return null;
      }
      const match = /^\\(begin|end)\{([A-Za-z*]+)\}/.exec(text.slice(index));
      if (!match) {
        return null;
      }
      return {
        kind: match[1] as "begin" | "end",
        name: match[2],
        length: match[0].length,
      };
    };
    const state = {
      braceDepth: 0,
      bracketDepth: 0,
      envStack: [] as string[],
    };
    const isTopLevel = () =>
      state.braceDepth === 0 && state.bracketDepth === 0 && state.envStack.length === 0;
    const consumeStructuralToken = (text: string, index: number) => {
      const envToken = readEnvironmentTokenAt(text, index);
      if (envToken) {
        if (envToken.kind === "begin") {
          state.envStack.push(envToken.name);
        } else {
          for (let i = state.envStack.length - 1; i >= 0; i -= 1) {
            if (state.envStack[i] !== envToken.name) {
              continue;
            }
            state.envStack.splice(i, 1);
            break;
          }
        }
        return index + envToken.length - 1;
      }
      const ch = text[index];
      if (ch === "{" && !isEscapedAt(text, index)) {
        state.braceDepth += 1;
      } else if (ch === "}" && !isEscapedAt(text, index)) {
        state.braceDepth = Math.max(0, state.braceDepth - 1);
      } else if (ch === "[" && !isEscapedAt(text, index)) {
        state.bracketDepth += 1;
      } else if (ch === "]" && !isEscapedAt(text, index)) {
        state.bracketDepth = Math.max(0, state.bracketDepth - 1);
      }
      return index;
    };

    const cells: Array<{ text: string; start: number; end: number }> = [];
    let cellStart = 0;
    for (let i = 0; i < rowText.length; i += 1) {
      const ch = rowText[i];
      if (ch === "&" && !isEscapedAt(rowText, i) && isTopLevel()) {
        cells.push({ text: rowText.slice(cellStart, i), start: cellStart, end: i });
        cellStart = i + 1;
        continue;
      }
      i = consumeStructuralToken(rowText, i);
    }
    cells.push({ text: rowText.slice(cellStart), start: cellStart, end: rowText.length });
    return cells;
  };

  const rebuildMatrixBody = (rows: Array<Array<string>>, selectionTarget: { row: number; col: number } | null) => {
    let body = "";
    let selectionIndex = 0;
    rows.forEach((cells, rowIndex) => {
      if (rowIndex > 0) {
        body += "\\\\";
      }
      let rowOffset = body.length;
      cells.forEach((cell, colIndex) => {
        if (colIndex > 0) {
          body += "&";
        }
        if (selectionTarget && rowIndex === selectionTarget.row && colIndex === selectionTarget.col) {
          selectionIndex = rowOffset + body.length - rowOffset;
        }
        body += cell;
      });
    });
    if (selectionTarget) {
      const targetRow = rows[selectionTarget.row];
      if (targetRow) {
        let cursor = 0;
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          if (rowIndex > 0) {
            cursor += 2;
          }
          const cells = rows[rowIndex];
          for (let colIndex = 0; colIndex < cells.length; colIndex += 1) {
            if (colIndex > 0) {
              cursor += 1;
            }
            if (rowIndex === selectionTarget.row && colIndex === selectionTarget.col) {
              selectionIndex = cursor;
              return { body, selectionIndex };
            }
            cursor += cells[colIndex].length;
          }
        }
      }
    }
    return { body, selectionIndex: 0 };
  };

  const tryApplyMatrixEdit = (mode: "row" | "column") => {
    const mathfieldApi = mathfield as {
      getValue?: (format?: string) => unknown;
      executeCommand?: (command: string, ...args: unknown[]) => boolean;
      insert?: (value: string, options?: Record<string, unknown>) => void;
      focus?: () => void;
      setValue?: (value: string) => void;
      value?: string;
    };
    if (typeof mathfieldApi.getValue !== "function") {
      return false;
    }
    const selection = getMathFieldSelectionRange(mathfieldApi);
    // MathLive can represent placeholder focus as a non-collapsed selection range.
    // Allow those (and only those) so Enter can still add a matrix row/column.
    if (selection.start !== selection.end) {
      const selected = readMathFieldLatex(mathfieldApi, selection.start, selection.end, "latex") ?? "";
      if (!selected.includes("\\placeholder")) {
        return false;
      }
    }
    const latex = readMathFieldLatex(mathfieldApi, "latex");
    if (!latex) {
      return false;
    }
    const cursorIndex = offsetToIndex(mathfieldApi, selection.end);
    const env = findMatrixEnvironment(latex, cursorIndex);
    if (!env) {
      return false;
    }
    const body = latex.slice(env.bodyStart, env.bodyEnd);
    const rows = splitRows(body);
    if (rows.length === 0) {
      return false;
    }
    const parsedRows = rows.map((row) => ({
      ...row,
      cells: splitCells(row.text),
    }));
    const cursorInBody = Math.max(0, cursorIndex - env.bodyStart);
    let rowIndex = parsedRows.findIndex((row) => cursorInBody >= row.start && cursorInBody <= row.end);
    if (rowIndex < 0) {
      rowIndex = Math.max(0, parsedRows.length - 1);
    }
    const row = parsedRows[rowIndex];
    const cursorInRow = cursorInBody - row.start;
    let colIndex = row.cells.findIndex((cell) => cursorInRow >= cell.start && cursorInRow <= cell.end);
    if (colIndex < 0) {
      colIndex = Math.max(0, row.cells.length - 1);
    }

    const colCount = Math.max(1, ...parsedRows.map((entry) => Math.max(1, entry.cells.length)));

    let nextRows: Array<Array<string>> = parsedRows.map((entry) => entry.cells.map((cell) => cell.text));

    let selectionTarget: { row: number; col: number } | null = null;
    if (mode === "row") {
      const newRow = Array.from({ length: colCount }, () => PLACEHOLDER_LATEX);
      const insertAt = Math.min(rowIndex + 1, nextRows.length);
      nextRows = [...nextRows.slice(0, insertAt), newRow, ...nextRows.slice(insertAt)];
      selectionTarget = { row: insertAt, col: 0 };
    } else {
      const insertAt = Math.min(colIndex + 1, colCount);
      nextRows = nextRows.map((cells) => {
        const normalized = [...cells];
        while (normalized.length < colCount) {
          normalized.push("");
        }
        normalized.splice(insertAt, 0, PLACEHOLDER_LATEX);
        return normalized;
      });
      selectionTarget = { row: rowIndex, col: insertAt };
    }

    const { body: nextBody, selectionIndex } = rebuildMatrixBody(nextRows, selectionTarget);
    const nextLatex = `${env.beginToken}${nextBody}${env.endToken}`;
    const nextFullLatex = latex.slice(0, env.start) + nextLatex + latex.slice(env.end);
    const startOffset = indexToOffset(mathfieldApi, env.start);
    const endOffset = indexToOffset(mathfieldApi, env.end);
    setSelectionRange(mathfieldApi, startOffset, endOffset);

    mathfieldApi.focus?.();
    let replaced = false;
    if (typeof mathfieldApi.executeCommand === "function") {
      const beforeValue = readMathFieldLatex(mathfieldApi, "latex");
      try {
        mathfieldApi.executeCommand("insert", nextLatex, {
          selectionMode: "after",
          focus: true,
          feedback: false,
          format: "latex",
        });
        const afterValue = readMathFieldLatex(mathfieldApi, "latex");
        const changed =
          typeof beforeValue === "string" && typeof afterValue === "string" && afterValue !== beforeValue;
        // Some MathLive commands can report success while leaving the latex unchanged.
        replaced = changed;
      } catch {
        replaced = false;
      }
    }
    if (!replaced && typeof mathfieldApi.insert === "function") {
      const beforeValue = readMathFieldLatex(mathfieldApi, "latex");
      mathfieldApi.insert(nextLatex, {
        selectionMode: "after",
        focus: true,
        feedback: false,
        format: "latex",
      });
      const afterValue = readMathFieldLatex(mathfieldApi, "latex");
      replaced =
        typeof beforeValue === "string" && typeof afterValue === "string" ? afterValue !== beforeValue : true;
    }
    if (!replaced) {
      // Last resort: overwrite the full latex string (stable + deterministic for e2e and fast typing).
      const beforeValue = readMathFieldValue(mathfieldApi);
      writeMathFieldValue(mathfieldApi, nextFullLatex);
      const afterValue = readMathFieldValue(mathfieldApi);
      replaced = afterValue !== beforeValue;
    }
    if (!replaced) {
      return false;
    }
    if (Number.isFinite(selectionIndex)) {
      const nextSelection = env.start + env.beginToken.length + selectionIndex;
      const nextOffset = indexToOffset(mathfieldApi, nextSelection);
      setSelectionRange(mathfieldApi, nextOffset, nextOffset);
    }
    mathfield.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  };

  const tryInsertMatrixRow = () => tryApplyMatrixEdit("row");
  const tryInsertMatrixColumn = () => tryApplyMatrixEdit("column");

  const openMatrixOpsPalette = () => {
    if (!mathWysiwygApi) {
      return false;
    }
    const mathfieldApi = mathfield as {
      executeCommand?: (command: string, ...args: unknown[]) => boolean;
      getValue?: (format?: string) => unknown;
    };
    if (typeof mathfieldApi.getValue !== "function") {
      return false;
    }
    const selection = getMathFieldSelectionRange(mathfieldApi);
    const latex = readMathFieldLatex(mathfieldApi, "latex");
    if (!latex) {
      return false;
    }
    const cursorIndex = offsetToIndex(mathfieldApi, selection.end);
    const env = findMatrixEnvironment(latex, cursorIndex);
    if (!env) {
      return false;
    }
    const applyCommand = (command: string) => (mf: any) => {
      if (typeof mf.executeCommand !== "function") {
        return;
      }
      try {
        const ok = Boolean(mf.executeCommand(command));
        if (ok) {
          mf.dispatchEvent?.(new Event("input", { bubbles: true }));
        }
      } catch {
        // ignore
      }
    };
    mathWysiwygApi.openCustomCandidates([
      { id: "matrix-op:add-row", label: "+row", hint: "行を追加", apply: applyCommand("addRowAfter") },
      { id: "matrix-op:add-col", label: "+col", hint: "列を追加", apply: applyCommand("addColumnAfter") },
      { id: "matrix-op:remove-row", label: "-row", hint: "行を削除", apply: applyCommand("removeRow") },
      { id: "matrix-op:remove-col", label: "-col", hint: "列を削除", apply: applyCommand("removeColumn") },
    ]);
    return true;
  };

  return {
    tryInsertMatrixRow,
    tryInsertMatrixColumn,
    openMatrixOpsPalette,
  };
};

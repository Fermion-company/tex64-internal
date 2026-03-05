import type { EditorSessionRuntime } from "./runtime.js";

export type EditorSessionCursorOps = {
  getStoredCursorPosition: (path: string) => { line: number; column: number } | null;
  recordCursorPosition: (path: string, position: { lineNumber: number; column: number }) => void;
};

export const createEditorSessionCursorOps = (runtime: EditorSessionRuntime): EditorSessionCursorOps => {
  const getStoredCursorPosition = (path: string) => runtime.lastCursorPositions.get(path) ?? null;

  const recordCursorPosition = (path: string, position: { lineNumber: number; column: number }) => {
    runtime.lastCursorPositions.set(path, {
      line: position.lineNumber,
      column: position.column,
    });
  };

  return { getStoredCursorPosition, recordCursorPosition };
};


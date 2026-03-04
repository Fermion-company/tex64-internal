type ContextBarDeps = {
  aiContextBar: Element | null | undefined;
  getActiveFilePath: () => string | null;
  getActiveSelectionSnapshot?: () => {
    path: string;
    text: string;
    isDirty: boolean;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null;
  getActiveCursorPosition?: () => { lineNumber: number; column: number } | null;
};

export const createContextBarUpdater = (deps: ContextBarDeps) => {
  const { aiContextBar, getActiveFilePath, getActiveSelectionSnapshot, getActiveCursorPosition } = deps;
  return () => {
    if (!(aiContextBar instanceof HTMLElement)) return;
    const filePath = getActiveFilePath();
    aiContextBar.textContent = "";
    const chips: string[] = [];
    if (filePath) {
      chips.push(filePath.split("/").pop() || filePath);
    }
    const selection = getActiveSelectionSnapshot?.() ?? null;
    if (selection) {
      chips.push(
        `selection ${selection.startLine}:${selection.startColumn}-${selection.endLine}:${selection.endColumn}`
      );
    } else {
      const cursor = getActiveCursorPosition?.() ?? null;
      if (cursor) {
        chips.push(`cursor ${cursor.lineNumber}:${cursor.column}`);
      }
    }
    chips.forEach((label) => {
      const chip = document.createElement("span");
      chip.className = "ai-context-chip";
      chip.textContent = label;
      aiContextBar.appendChild(chip);
    });
    aiContextBar.style.display = chips.length > 0 ? "flex" : "none";
  };
};

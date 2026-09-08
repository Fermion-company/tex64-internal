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
  /** A place the reader marked on the typeset page, resolved to a source line. */
  getPdfPlace?: () => { page: number; path: string; line: number; text: string } | null;
  onClearPdfPlace?: () => void;
};

export const createContextBarUpdater = (deps: ContextBarDeps) => {
  const { aiContextBar, getActiveFilePath, getActiveSelectionSnapshot, getActiveCursorPosition, getPdfPlace, onClearPdfPlace } = deps;
  return () => {
    if (!(aiContextBar instanceof HTMLElement)) return;
    const filePath = getActiveFilePath();
    aiContextBar.textContent = "";
    const chips: string[] = [];
    const pdfPlace = getPdfPlace?.() ?? null;
    if (pdfPlace) {
      // The page comes first: it is what the reader pointed at.
      const chip = document.createElement("span");
      chip.className = "ai-context-chip ai-context-chip--pdf";
      chip.title = pdfPlace.text;
      const label = document.createElement("span");
      label.textContent = `p.${pdfPlace.page} · ${pdfPlace.path.split("/").pop() || pdfPlace.path}:${pdfPlace.line}`;
      chip.appendChild(label);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ai-context-chip-remove";
      remove.setAttribute("aria-label", "×");
      remove.textContent = "×";
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClearPdfPlace?.();
      });
      chip.appendChild(remove);
      aiContextBar.appendChild(chip);
    }
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
    aiContextBar.style.display = chips.length > 0 || pdfPlace ? "flex" : "none";
  };
};

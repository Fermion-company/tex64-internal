export const createContextBarUpdater = (deps) => {
    const { aiContextBar, getActiveFilePath, getActiveSelectionSnapshot, getActiveCursorPosition, getPdfPlace, onClearPdfPlace } = deps;
    return () => {
        var _a, _b, _c;
        if (!(aiContextBar instanceof HTMLElement))
            return;
        const filePath = getActiveFilePath();
        aiContextBar.textContent = "";
        const chips = [];
        const pdfPlace = (_a = getPdfPlace === null || getPdfPlace === void 0 ? void 0 : getPdfPlace()) !== null && _a !== void 0 ? _a : null;
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
                onClearPdfPlace === null || onClearPdfPlace === void 0 ? void 0 : onClearPdfPlace();
            });
            chip.appendChild(remove);
            aiContextBar.appendChild(chip);
        }
        if (filePath) {
            chips.push(filePath.split("/").pop() || filePath);
        }
        const selection = (_b = getActiveSelectionSnapshot === null || getActiveSelectionSnapshot === void 0 ? void 0 : getActiveSelectionSnapshot()) !== null && _b !== void 0 ? _b : null;
        if (selection) {
            chips.push(`selection ${selection.startLine}:${selection.startColumn}-${selection.endLine}:${selection.endColumn}`);
        }
        else {
            const cursor = (_c = getActiveCursorPosition === null || getActiveCursorPosition === void 0 ? void 0 : getActiveCursorPosition()) !== null && _c !== void 0 ? _c : null;
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

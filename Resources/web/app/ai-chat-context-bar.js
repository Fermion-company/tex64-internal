export const createContextBarUpdater = (deps) => {
    const { aiContextBar, getActiveFilePath, getActiveSelectionSnapshot, getActiveCursorPosition } = deps;
    return () => {
        var _a, _b;
        if (!(aiContextBar instanceof HTMLElement))
            return;
        const filePath = getActiveFilePath();
        aiContextBar.textContent = "";
        const chips = [];
        if (filePath) {
            chips.push(filePath.split("/").pop() || filePath);
        }
        const selection = (_a = getActiveSelectionSnapshot === null || getActiveSelectionSnapshot === void 0 ? void 0 : getActiveSelectionSnapshot()) !== null && _a !== void 0 ? _a : null;
        if (selection) {
            chips.push(`selection ${selection.startLine}:${selection.startColumn}-${selection.endLine}:${selection.endColumn}`);
        }
        else {
            const cursor = (_b = getActiveCursorPosition === null || getActiveCursorPosition === void 0 ? void 0 : getActiveCursorPosition()) !== null && _b !== void 0 ? _b : null;
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

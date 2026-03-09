const isPlainBackslashInput = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
        return false;
    }
    if (event.key === "\\" || event.key === "¥") {
        return true;
    }
    // Fall back to key code only when event.key is not a recognized printable character.
    // This prevents blocking characters produced via Shift+Backslash (e.g. "|" on JP keyboards).
    if (event.shiftKey) {
        return false;
    }
    if (event.key.length === 1) {
        // event.key is a single printable character that is neither "\\" nor "¥" — not a backslash.
        return false;
    }
    return event.code === "Backslash" || event.code === "IntlYen" || event.code === "IntlRo";
};
export const blockDirectLatexCommandInput = (runtime, event) => {
    var _a, _b;
    if (!isPlainBackslashInput(event)) {
        return false;
    }
    const tagged = event;
    if (tagged.__tex64BackslashHandled) {
        return true;
    }
    tagged.__tex64BackslashHandled = true;
    event.preventDefault();
    event.stopImmediatePropagation();
    const opened = Boolean((_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.openExplicitSuggestions());
    if (!opened) {
        (_b = runtime.state.mathWysiwygApi) === null || _b === void 0 ? void 0 : _b.close();
    }
    return true;
};

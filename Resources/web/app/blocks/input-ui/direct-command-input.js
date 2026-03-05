const isPlainBackslashInput = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
        return false;
    }
    if (event.key === "\\" || event.key === "¥") {
        return true;
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

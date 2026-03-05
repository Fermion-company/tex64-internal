import type { BlockInputRuntime } from "./runtime.js";

type BackslashHandledEvent = KeyboardEvent & { __tex64BackslashHandled?: boolean };

const isPlainBackslashInput = (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  if (event.key === "\\" || event.key === "¥") {
    return true;
  }
  return event.code === "Backslash" || event.code === "IntlYen" || event.code === "IntlRo";
};

export const blockDirectLatexCommandInput = (runtime: BlockInputRuntime, event: KeyboardEvent) => {
  if (!isPlainBackslashInput(event)) {
    return false;
  }
  const tagged = event as BackslashHandledEvent;
  if (tagged.__tex64BackslashHandled) {
    return true;
  }
  tagged.__tex64BackslashHandled = true;
  event.preventDefault();
  event.stopImmediatePropagation();
  const opened = Boolean(runtime.state.mathWysiwygApi?.openExplicitSuggestions());
  if (!opened) {
    runtime.state.mathWysiwygApi?.close();
  }
  return true;
};


import { initTerminalUi } from "./terminal-ui.js";
import { initAppearanceTheme } from "./appearance.js";
import { uiText, initI18n } from "./i18n.js";
import type { AppContext } from "./context.js";
initI18n();
initAppearanceTheme();
const terminal = initTerminalUi({ dom: { terminalHost: document.getElementById("terminal-host") } } as AppContext);
for (const [id, label, action] of [
  ["new", uiText("New tab", "新規タブ"), () => terminal.create()],
  ["split", uiText("Split pane", "分割"), () => terminal.split()],
] as const) {
  const button = document.getElementById(id)!; button.textContent = label; button.addEventListener("click", action);
}
(window as any).tex64Terminal?.onCommand((command: string) => {
  if (command === "restart") terminal.restart(true);
});
window.addEventListener("focus", () => terminal.show());
terminal.show();

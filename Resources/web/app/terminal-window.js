var _a;
import { initTerminalUi } from "./terminal-ui.js";
import { initAppearanceTheme } from "./appearance.js";
import { uiText, initI18n } from "./i18n.js";
initI18n();
initAppearanceTheme();
const terminal = initTerminalUi({ dom: { terminalHost: document.getElementById("terminal-host") } });
for (const [id, label, action] of [
    ["new", uiText("New tab", "新規タブ"), () => terminal.create()],
    ["split", uiText("Split pane", "分割"), () => terminal.split()],
]) {
    const button = document.getElementById(id);
    button.textContent = label;
    button.addEventListener("click", action);
}
(_a = window.tex64Terminal) === null || _a === void 0 ? void 0 : _a.onCommand((command) => {
    if (command === "restart")
        terminal.restart(true);
});
window.addEventListener("focus", () => terminal.show());
terminal.show();

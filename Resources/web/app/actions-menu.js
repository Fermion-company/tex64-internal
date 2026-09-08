import { uiText } from "./i18n.js";
// A disclosure with ordinary buttons keeps native Tab/Enter navigation.
export const createActionsMenu = (items, signal) => {
    const menu = document.createElement("details");
    menu.className = "compact-actions";
    const summary = document.createElement("summary");
    summary.textContent = uiText("Actions", "操作");
    const content = document.createElement("div");
    content.className = "compact-actions-content";
    content.append(...items);
    menu.append(summary, content);
    content.addEventListener("click", (event) => {
        if (event.target.closest("button:not(:disabled)"))
            menu.open = false;
    });
    menu.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && menu.open) {
            event.preventDefault();
            event.stopPropagation();
            menu.open = false;
            summary.focus();
        }
    });
    document.addEventListener("pointerdown", (event) => {
        if (!menu.contains(event.target))
            menu.open = false;
    }, { signal });
    return menu;
};

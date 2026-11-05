// An explanation the user asks for: a small ▾ beside a heading or control
// opens the text below it. The app does not put faint explanatory sentences
// next to its controls; what truly needs saying waits behind this toggle.
import { uiText } from "./i18n.js";
let explainCount = 0;
const CHEVRON = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const createExplain = (content, label = uiText("Explanation", "説明")) => {
    explainCount += 1;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "explain-toggle";
    button.innerHTML = CHEVRON;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", "false");
    const panel = document.createElement("div");
    panel.className = "explain-panel";
    panel.id = `explain-${explainCount}`;
    panel.hidden = true;
    for (const part of Array.isArray(content) ? content : [content]) {
        if (typeof part === "string") {
            const paragraph = document.createElement("p");
            paragraph.textContent = part;
            panel.append(paragraph);
        }
        else {
            panel.append(part);
        }
    }
    button.setAttribute("aria-controls", panel.id);
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        const open = panel.hidden;
        panel.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
    });
    return { button, panel };
};
// A heading row with its ▾ at the end, followed by the hidden explanation.
export const explainedHeading = (heading, content) => {
    const { button, panel } = createExplain(content);
    heading.classList.add("has-explain");
    heading.append(button);
    return [heading, panel];
};

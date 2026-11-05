// An explanation the user asks for: a small ▾ beside a heading or control
// opens the text below it. The app does not put faint explanatory sentences
// next to its controls; what truly needs saying waits behind this toggle.
import { uiText } from "./i18n.js";
let explainCount = 0;
const CHEVRON = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const createExplain = (content, options = {}) => {
    explainCount += 1;
    const { topic, label, memory, key } = options;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "explain-toggle";
    button.innerHTML = CHEVRON;
    button.setAttribute("aria-label", label || (topic ? uiText(`About ${topic}`, `${topic}の説明`) : uiText("Explanation", "説明")));
    const open = Boolean(memory && key && memory.has(key));
    button.setAttribute("aria-expanded", String(open));
    if (key)
        button.dataset.explainKey = key;
    const panel = document.createElement("div");
    panel.className = "explain-panel";
    panel.id = `explain-${explainCount}`;
    panel.hidden = !open;
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
        const opening = panel.hidden;
        panel.hidden = !opening;
        button.setAttribute("aria-expanded", String(opening));
        if (memory && key) {
            if (opening)
                memory.add(key);
            else
                memory.delete(key);
        }
    });
    return { button, panel };
};
// A heading row with its ▾ at the end, followed by the hidden explanation.
export const explainedHeading = (heading, content, options = {}) => {
    var _a;
    const { button, panel } = createExplain(content, { topic: ((_a = heading.textContent) === null || _a === void 0 ? void 0 : _a.trim()) || undefined, ...options });
    heading.classList.add("has-explain");
    heading.append(button);
    return [heading, panel];
};
// The ▾ that had focus before a view rebuilt itself, by key, so the caller can
// give focus back to its replacement.
export const focusedExplainKey = () => { var _a, _b, _c; return (_c = (_b = (_a = document.activeElement) === null || _a === void 0 ? void 0 : _a.closest) === null || _b === void 0 ? void 0 : _b.call(_a, ".explain-toggle")) === null || _c === void 0 ? void 0 : _c.dataset.explainKey; };
export const focusExplain = (root, key) => {
    if (!key)
        return false;
    const button = Array.from(root.querySelectorAll(".explain-toggle")).find((item) => item.dataset.explainKey === key);
    button === null || button === void 0 ? void 0 : button.focus();
    return Boolean(button);
};

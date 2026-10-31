// Git and History act on the host's folder only. On a guest the panel stays
// readable but its controls are off, with one line saying why — instead of
// letting a click through and refusing it afterwards.
import { uiText } from "../i18n.js";
const NOTE_CLASS = "collab-guest-note";
const observers = new WeakMap();
const disableControls = (panel) => {
    for (const control of panel.querySelectorAll("button, input, select")) {
        if (control.disabled || control.closest(`.${NOTE_CLASS}`))
            continue;
        control.dataset.collabLocked = "true";
        control.disabled = true;
    }
};
export const applyCollabGuestLock = (panel, locked) => {
    var _a;
    let note = panel.querySelector(`.${NOTE_CLASS}`);
    if (locked && !note) {
        note = document.createElement("p");
        note.className = `${NOTE_CLASS} history-local`;
        note.textContent = uiText("During a collaboration session the host does this.", "共同編集中はホストが行います。");
        panel.prepend(note);
    }
    else if (!locked && note) {
        note.remove();
    }
    panel.classList.toggle("is-collab-guest", locked);
    if (locked) {
        disableControls(panel);
        // Panels re-render their rows on every refresh; keep those off too.
        if (!observers.has(panel)) {
            const observer = new MutationObserver(() => disableControls(panel));
            observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
            observers.set(panel, observer);
        }
        return;
    }
    (_a = observers.get(panel)) === null || _a === void 0 ? void 0 : _a.disconnect();
    observers.delete(panel);
    for (const control of panel.querySelectorAll("button, input, select")) {
        if (control.dataset.collabLocked) {
            delete control.dataset.collabLocked;
            control.disabled = false;
        }
    }
};

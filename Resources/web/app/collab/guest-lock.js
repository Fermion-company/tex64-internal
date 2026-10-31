// Git and History act on the host's folder only. On a guest the panel stays
// readable but its controls are off, with one line saying why — instead of
// letting a click through and refusing it afterwards.
import { uiText } from "../i18n.js";
const NOTE_CLASS = "collab-guest-note";
export const applyCollabGuestLock = (panel, locked) => {
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
    for (const control of panel.querySelectorAll("button, input, select")) {
        if (locked) {
            if (control.disabled)
                continue;
            control.dataset.collabLocked = "true";
            control.disabled = true;
        }
        else if (control.dataset.collabLocked) {
            delete control.dataset.collabLocked;
            control.disabled = false;
        }
    }
};

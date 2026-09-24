// A short message under the toolbar control the user just used: what the
// click did, or why it could not. The Issues panel is often closed, so a
// result reported only there reads as "nothing happened".
let current = null;
export const hideEditorNotice = (owner) => {
    if (!current)
        return;
    if (owner !== undefined && current.owner !== owner)
        return;
    if (current.timer !== null)
        window.clearTimeout(current.timer);
    current.element.remove();
    current = null;
};
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.isComposing && current)
        hideEditorNotice();
}, true);
// Returns a dismiss that only removes this notice, not a later one.
export const showEditorNotice = (anchor, message, options = {}) => {
    var _a, _b, _c, _d;
    const tone = (_a = options.tone) !== null && _a !== void 0 ? _a : "info";
    // One note at a time: a passing remark does not push aside another
    // control's error (a failed save still waiting to be read).
    if (current && tone === "info" && current.tone === "error" && current.owner !== ((_b = options.owner) !== null && _b !== void 0 ? _b : null)) {
        return () => { };
    }
    hideEditorNotice();
    const element = document.createElement("div");
    element.className = `editor-notice is-${tone}`;
    element.setAttribute("role", tone === "error" ? "alert" : "status");
    const text = document.createElement("span");
    text.className = "editor-notice-text";
    text.textContent = message;
    element.appendChild(text);
    if (options.action) {
        const { label, run } = options.action;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "editor-notice-action";
        button.textContent = label;
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            hideEditorNotice();
            run();
        });
        element.appendChild(button);
    }
    element.addEventListener("click", () => hideEditorNotice());
    document.body.appendChild(element);
    // Right-align under the anchor; the toolbar sits at the window's top right.
    const rect = anchor === null || anchor === void 0 ? void 0 : anchor.getBoundingClientRect();
    if (rect && rect.width > 0) {
        const width = element.offsetWidth;
        const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
        element.style.left = `${left}px`;
        element.style.top = `${rect.bottom + 6}px`;
    }
    else {
        element.style.right = "16px";
        element.style.top = "52px";
    }
    const durationMs = (_c = options.durationMs) !== null && _c !== void 0 ? _c : (tone === "error" || options.action ? 7000 : 4000);
    const entry = { element, timer: null, owner: (_d = options.owner) !== null && _d !== void 0 ? _d : null, tone };
    entry.timer = window.setTimeout(() => {
        if (current === entry)
            hideEditorNotice();
    }, durationMs);
    current = entry;
    return () => {
        if (current === entry)
            hideEditorNotice();
    };
};

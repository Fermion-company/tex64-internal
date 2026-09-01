// Desktop currently ships the Code workspace only. Keep this compatibility
// module so older callers and stored mode values deterministically fall back
// to Code while the separate AI workspace remains disabled.
export const APP_MODE_STORAGE_KEY = "tex64.appMode.v1";
export const parseAppMode = (raw) => {
    if (raw === "code")
        return raw;
    return null;
};
// Old AI and Pro selections both migrate to the only shipped workspace.
export const resolveInitialAppMode = (_storedMode) => "code";
export const initAppModeUi = (deps) => {
    const switcher = document.getElementById("mode-switcher");
    let mode = null;
    const applyMode = (next) => {
        if (mode === next)
            return;
        const previous = mode;
        mode = next;
        document.documentElement.dataset.appMode = next;
        try {
            localStorage.setItem(APP_MODE_STORAGE_KEY, next);
        }
        catch {
            // Persistence is best-effort; mode switching still works in-session.
        }
        switcher === null || switcher === void 0 ? void 0 : switcher.querySelectorAll("[data-app-mode-tab]").forEach((tab) => {
            const active = tab.dataset.appModeTab === next;
            tab.classList.toggle("is-active", active);
            tab.setAttribute("aria-selected", String(active));
            tab.tabIndex = active ? 0 : -1;
        });
        deps.onModeChange(next, previous);
        requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    };
    switcher === null || switcher === void 0 ? void 0 : switcher.querySelectorAll("[data-app-mode-tab]").forEach((tab) => {
        tab.addEventListener("click", () => {
            var _a;
            const next = parseAppMode((_a = tab.dataset.appModeTab) !== null && _a !== void 0 ? _a : null);
            if (next)
                applyMode(next);
        });
    });
    // Roving arrow-key focus within the tablist.
    switcher === null || switcher === void 0 ? void 0 : switcher.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
            return;
        const tabs = Array.from(switcher.querySelectorAll("[data-app-mode-tab]"));
        const current = tabs.findIndex((tab) => tab === document.activeElement);
        if (current < 0)
            return;
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        const next = tabs[(current + delta + tabs.length) % tabs.length];
        next.focus();
        next.click();
    });
    applyMode(deps.initialMode);
    return {
        getMode: () => mode !== null && mode !== void 0 ? mode : "code",
        setMode: (next) => applyMode(next),
    };
};

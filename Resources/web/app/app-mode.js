// The desktop product exposes the Code editor and the paper-first AI workspace.
// Both surfaces share the same project files, build pipeline, and billing state.
export const APP_MODE_STORAGE_KEY = "tex64.appMode.v1";
export const parseAppMode = (raw) => {
    if (raw === "code" || raw === "ai")
        return raw;
    return null;
};
export const resolveInitialAppMode = (storedMode) => { var _a; return (_a = parseAppMode(storedMode)) !== null && _a !== void 0 ? _a : "code"; };
/** Stop every workspace writer before Code persists its final buffers. */
export const prepareCodeWorkspaceHandoff = async (input) => {
    const quiet = await input.quiesce();
    if (!quiet.ok)
        return { ok: false, phase: "quiesce", error: quiet.error };
    if (!(await input.saveCode()))
        return { ok: false, phase: "save" };
    return { ok: true };
};
/**
 * Hands one workspace between the two surfaces. Stop every writer first;
 * only then persist Code's buffers, so the old agent cannot overwrite the
 * state AI mode receives after the save completes.
 */
export const prepareAppModeTransition = async (input) => {
    if (input.previous === null)
        return { ok: true };
    if (input.next === "ai") {
        return prepareCodeWorkspaceHandoff(input);
    }
    const quiet = await input.quiesce();
    if (!quiet.ok)
        return { ok: false, phase: "quiesce", error: quiet.error };
    return { ok: true };
};
export const initAppModeUi = (deps) => {
    const switcher = document.getElementById("mode-switcher");
    let mode = null;
    let transitionVersion = 0;
    let pendingMode = null;
    const commitMode = (next) => {
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
    const applyMode = (next) => {
        var _a, _b;
        // Do not run quiesce/save twice for a double click. These operations own
        // filesystem handoff and must stay serialized even if the visual switch
        // has subsequently been cancelled.
        if (pendingMode === next)
            return;
        transitionVersion += 1;
        const version = transitionVersion;
        // Clicking the still-selected tab cancels an in-flight transition to the
        // other mode. Without advancing the version here, a late approval could
        // switch the UI after the user had explicitly chosen to stay put.
        if (mode === next) {
            switcher === null || switcher === void 0 ? void 0 : switcher.removeAttribute("aria-busy");
            return;
        }
        let approval;
        try {
            approval = (_b = (_a = deps.beforeModeChange) === null || _a === void 0 ? void 0 : _a.call(deps, next, mode)) !== null && _b !== void 0 ? _b : true;
        }
        catch {
            return;
        }
        if (typeof approval === "boolean") {
            if (approval)
                commitMode(next);
            return;
        }
        pendingMode = next;
        switcher === null || switcher === void 0 ? void 0 : switcher.setAttribute("aria-busy", "true");
        void approval
            .then((allowed) => {
            if (allowed && version === transitionVersion)
                commitMode(next);
        })
            .catch(() => { })
            .finally(() => {
            if (pendingMode === next)
                pendingMode = null;
            if (version === transitionVersion)
                switcher === null || switcher === void 0 ? void 0 : switcher.removeAttribute("aria-busy");
        });
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

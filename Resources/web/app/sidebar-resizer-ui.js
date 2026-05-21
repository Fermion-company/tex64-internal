export const initSidebarResizer = (context, deps) => {
    const { editorHost, editorHostSecondary } = context.dom;
    const setup = () => {
        const resizer = document.getElementById("resizer");
        if (!resizer) {
            return;
        }
        let isResizing = false;
        let pendingClientX = 0;
        let rafId = null;
        const startResize = () => {
            var _a;
            if (isResizing) {
                return;
            }
            isResizing = true;
            resizer.classList.add("is-resizing");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            if (editorHost instanceof HTMLElement) {
                editorHost.style.pointerEvents = "none";
            }
            if (editorHostSecondary instanceof HTMLElement) {
                editorHostSecondary.style.pointerEvents = "none";
            }
            // We drive layout manually (throttled) during the drag.
            (_a = deps.setEditorsAutomaticLayout) === null || _a === void 0 ? void 0 : _a.call(deps, false);
        };
        // Applies the latest pointer position once per animation frame.
        const applyResize = () => {
            rafId = null;
            if (!isResizing) {
                return;
            }
            const sidebarWidth = 52;
            const minPanelWidth = 240;
            const minEditorWidth = 320;
            const maxPanelWidth = Math.max(minPanelWidth, window.innerWidth - sidebarWidth - minEditorWidth);
            const newWidth = Math.max(minPanelWidth, Math.min(maxPanelWidth, pendingClientX - sidebarWidth));
            document.documentElement.style.setProperty("--sidebar-panel-width", `${newWidth}px`);
            deps.layoutEditors();
        };
        const doResize = (event) => {
            if (!isResizing) {
                return;
            }
            // Coalesce rapid mousemove events into a single layout per frame —
            // editor.layout() is expensive and was previously run on every event.
            pendingClientX = event.clientX;
            if (rafId === null) {
                rafId = window.requestAnimationFrame(applyResize);
            }
        };
        const stopResize = () => {
            var _a;
            if (!isResizing) {
                return;
            }
            isResizing = false;
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            resizer.classList.remove("is-resizing");
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            if (editorHost instanceof HTMLElement) {
                editorHost.style.pointerEvents = "";
            }
            if (editorHostSecondary instanceof HTMLElement) {
                editorHostSecondary.style.pointerEvents = "";
            }
            (_a = deps.setEditorsAutomaticLayout) === null || _a === void 0 ? void 0 : _a.call(deps, true);
            deps.layoutEditors();
        };
        resizer.addEventListener("mousedown", startResize);
        resizer.addEventListener("mouseup", stopResize);
        resizer.addEventListener("pointerdown", (event) => {
            var _a, _b;
            (_b = (_a = resizer).setPointerCapture) === null || _b === void 0 ? void 0 : _b.call(_a, event.pointerId);
            startResize();
        });
        resizer.addEventListener("pointerup", stopResize);
        resizer.addEventListener("pointercancel", stopResize);
        document.addEventListener("mousemove", doResize);
        document.addEventListener("mouseup", stopResize, true);
        document.addEventListener("pointerup", stopResize, true);
        window.addEventListener("mouseup", stopResize);
        window.addEventListener("mouseleave", stopResize);
        window.addEventListener("pointerup", stopResize);
        window.addEventListener("blur", stopResize);
    };
    return { setup };
};

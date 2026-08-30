/**
 * The panel width is a per-machine preference (a wide Axiom panel while
 * writing a paper, a narrow one while editing), so it survives restarts
 * instead of snapping back to the 25%-of-window default every launch.
 */
const PANEL_WIDTH_STORAGE_KEY = "tex64.sidebar.panelWidth.v1";
const MIN_PANEL_WIDTH = 240;
const MIN_EDITOR_WIDTH = 320;
const SIDEBAR_RAIL_WIDTH = 52;
const COLLAPSE_PANEL_WIDTH = 72;
export const resolveSidebarDragLayout = (clientX, windowWidth) => {
    const rawWidth = clientX - SIDEBAR_RAIL_WIDTH;
    if (rawWidth <= COLLAPSE_PANEL_WIDTH) {
        return { width: 0, collapse: true };
    }
    const maxPanelWidth = Math.max(MIN_PANEL_WIDTH, windowWidth - SIDEBAR_RAIL_WIDTH - MIN_EDITOR_WIDTH);
    return {
        width: Math.max(MIN_PANEL_WIDTH, Math.min(maxPanelWidth, rawWidth)),
        collapse: false,
    };
};
const clampPanelWidth = (width) => {
    const maxPanelWidth = Math.max(MIN_PANEL_WIDTH, window.innerWidth - SIDEBAR_RAIL_WIDTH - MIN_EDITOR_WIDTH);
    return Math.max(MIN_PANEL_WIDTH, Math.min(maxPanelWidth, width));
};
const applyPanelWidth = (width) => {
    document.documentElement.style.setProperty("--sidebar-panel-width", `${width}px`);
};
const readStoredPanelWidth = () => {
    try {
        const raw = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
        if (!raw)
            return null;
        const parsed = Number.parseFloat(raw);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    catch {
        return null;
    }
};
const storePanelWidth = (width) => {
    try {
        window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(Math.round(width)));
    }
    catch {
        /* private mode / quota: the width simply does not persist */
    }
};
export const initSidebarResizer = (context, deps) => {
    const { editorHost, editorHostSecondary } = context.dom;
    const setup = () => {
        const resizer = document.getElementById("resizer");
        if (!resizer) {
            return;
        }
        const storedWidth = readStoredPanelWidth();
        if (storedWidth !== null) {
            applyPanelWidth(clampPanelWidth(storedWidth));
            deps.layoutEditors();
        }
        let isResizing = false;
        let pendingClientX = 0;
        let rafId = null;
        let lastAppliedWidth = null;
        let collapseOnRelease = false;
        let expandedWidthBeforeDrag = null;
        const startResize = () => {
            var _a;
            if (isResizing) {
                return;
            }
            isResizing = true;
            lastAppliedWidth = null;
            collapseOnRelease = false;
            const sidebarPanel = context.dom.sidebarPanel;
            expandedWidthBeforeDrag = sidebarPanel instanceof HTMLElement
                ? sidebarPanel.getBoundingClientRect().width
                : readStoredPanelWidth();
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
            const layout = resolveSidebarDragLayout(pendingClientX, window.innerWidth);
            lastAppliedWidth = layout.width;
            collapseOnRelease = layout.collapse;
            applyPanelWidth(lastAppliedWidth);
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
            var _a, _b;
            if (!isResizing) {
                return;
            }
            isResizing = false;
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
                const layout = resolveSidebarDragLayout(pendingClientX, window.innerWidth);
                lastAppliedWidth = layout.width;
                collapseOnRelease = layout.collapse;
                applyPanelWidth(lastAppliedWidth);
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
            if (collapseOnRelease) {
                const restoredWidth = clampPanelWidth((_b = expandedWidthBeforeDrag !== null && expandedWidthBeforeDrag !== void 0 ? expandedWidthBeforeDrag : readStoredPanelWidth()) !== null && _b !== void 0 ? _b : MIN_PANEL_WIDTH);
                applyPanelWidth(restoredWidth);
                storePanelWidth(restoredWidth);
                deps.collapseSidebar();
            }
            else if (lastAppliedWidth !== null) {
                storePanelWidth(lastAppliedWidth);
            }
            collapseOnRelease = false;
            expandedWidthBeforeDrag = null;
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

import { createViewer } from "./viewer.js";
export const PRO_MODE_STORAGE_KEY = "tex64.proMode.v1";
const DEFAULT_STATE = {
    previewShare: 0.34,
    collapsed: { preview: false, source: false },
};
export const PRO_PANE_MIN_PX = 220;
export const clampPreviewShare = (value, minShare = 0.12) => {
    const minimum = Math.min(Math.max(minShare, 0), 0.5);
    const safe = Number.isFinite(value) ? value : DEFAULT_STATE.previewShare;
    return Math.min(Math.max(safe, minimum), 1 - minimum);
};
export const calculateProSplitterDrag = (pointerRatio, currentPreviewShare, minShare) => {
    const sourceShare = Math.min(Math.max(pointerRatio, 0), 1);
    const minimum = Math.min(Math.max(minShare, 0), 0.5);
    if (sourceShare < minimum) {
        return { previewShare: clampPreviewShare(currentPreviewShare, 0), collapse: "source" };
    }
    if (1 - sourceShare < minimum) {
        return { previewShare: clampPreviewShare(currentPreviewShare, 0), collapse: "preview" };
    }
    return { previewShare: 1 - sourceShare, collapse: null };
};
export const proShortcutPane = (key) => {
    if (key === "1")
        return "preview";
    if (key === "2")
        return "source";
    return null;
};
export const parseProModeState = (raw) => {
    var _a, _b;
    if (!raw)
        return structuredClone(DEFAULT_STATE);
    try {
        const value = JSON.parse(raw);
        let previewShare = Number(value.previewShare);
        if (!Number.isFinite(previewShare) && Array.isArray(value.ratios)) {
            const ratios = value.ratios.map(Number);
            const total = ratios.reduce((sum, ratio) => sum + (Number.isFinite(ratio) && ratio > 0 ? ratio : 0), 0);
            previewShare = total > 0 ? Math.max(ratios[0] || 0, 0) / total : DEFAULT_STATE.previewShare;
        }
        return {
            previewShare: clampPreviewShare(previewShare),
            collapsed: {
                preview: ((_a = value.collapsed) === null || _a === void 0 ? void 0 : _a.preview) === true,
                source: ((_b = value.collapsed) === null || _b === void 0 ? void 0 : _b.source) === true,
            },
        };
    }
    catch {
        return structuredClone(DEFAULT_STATE);
    }
};
export const initProModeUi = (deps) => {
    const root = document.getElementById("editor-groups");
    if (!(root instanceof HTMLElement))
        return null;
    let state = parseProModeState(localStorage.getItem(PRO_MODE_STORAGE_KEY));
    let enabled = false;
    const previewViewer = createViewer({
        editorViewer: document.getElementById("pro-preview-viewer"),
        editorViewerImage: document.getElementById("pro-preview-image"),
        editorViewerPdf: document.getElementById("pro-preview-pdf"),
        editorHost: null,
    });
    const persist = () => localStorage.setItem(PRO_MODE_STORAGE_KEY, JSON.stringify(state));
    const scheduleLayout = () => requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    const apply = () => {
        var _a;
        window.dispatchEvent(new CustomEvent("tex64:code-workspace", { detail: { enabled } }));
        const canvasButton = document.getElementById("pro-canvas-open");
        if (canvasButton instanceof HTMLButtonElement)
            canvasButton.hidden = !enabled;
        (_a = document
            .getElementById("pro-preview-pane")) === null || _a === void 0 ? void 0 : _a.setAttribute("aria-hidden", String(!enabled));
        root.style.setProperty("--pro-preview-share", `${state.previewShare}fr`);
        root.style.setProperty("--pro-source-share", `${1 - state.previewShare}fr`);
        Object.keys(state.collapsed).forEach((pane) => {
            root.classList.toggle(`is-${pane}-collapsed`, state.collapsed[pane]);
            root.querySelectorAll(`[data-pro-collapse="${pane}"]`).forEach((button) => {
                button.setAttribute("aria-expanded", String(!state.collapsed[pane]));
                button.title = state.collapsed[pane] ? `Expand ${pane}` : `Collapse ${pane}`;
            });
        });
        if (enabled)
            deps.setSplitViewEnabled(false);
        scheduleLayout();
    };
    const update = (next) => {
        state = { ...state, ...next };
        persist();
        apply();
    };
    root.querySelectorAll("[data-pro-collapse]").forEach((button) => {
        button.addEventListener("click", () => {
            const pane = button.dataset.proCollapse;
            if (pane !== "preview" && pane !== "source")
                return;
            update({ collapsed: { ...state.collapsed, [pane]: !state.collapsed[pane] } });
        });
    });
    document.addEventListener("keydown", (event) => {
        if (!enabled || !(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey) {
            return;
        }
        const pane = proShortcutPane(event.key);
        if (!pane)
            return;
        event.preventDefault();
        event.stopPropagation();
        update({ collapsed: { ...state.collapsed, [pane]: !state.collapsed[pane] } });
    }, true);
    const previewInput = document.getElementById("pro-preview-file");
    const previewOpen = root.querySelector('[data-pro-open="preview"]');
    if (previewInput instanceof HTMLInputElement && previewOpen) {
        previewOpen.addEventListener("click", () => previewInput.click());
        previewInput.addEventListener("change", () => {
            var _a;
            const file = (_a = previewInput.files) === null || _a === void 0 ? void 0 : _a[0];
            if (!file)
                return;
            const reader = new FileReader();
            reader.addEventListener("load", () => {
                const dataUrl = typeof reader.result === "string" ? reader.result : "";
                const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
                if (file.type === "application/pdf") {
                    previewViewer.showPdfViewer(file.name, data, file.type);
                }
                else {
                    previewViewer.showUnsupportedViewer();
                }
            });
            reader.readAsDataURL(file);
            previewInput.value = "";
        });
    }
    const splitter = document.getElementById("pro-splitter-primary");
    if (splitter instanceof HTMLElement) {
        let dragging = false;
        splitter.addEventListener("pointerdown", (event) => {
            if (!enabled)
                return;
            dragging = true;
            splitter.setPointerCapture(event.pointerId);
            root.classList.add("is-pro-resizing");
        });
        splitter.addEventListener("pointermove", (event) => {
            if (!dragging)
                return;
            const rect = root.getBoundingClientRect();
            const result = calculateProSplitterDrag((event.clientX - rect.left) / Math.max(rect.width, 1), state.previewShare, PRO_PANE_MIN_PX / Math.max(rect.width, 1));
            state = {
                ...state,
                previewShare: result.previewShare,
                collapsed: {
                    preview: result.collapse === "preview",
                    source: result.collapse === "source",
                },
            };
            apply();
        });
        const stop = () => {
            if (!dragging)
                return;
            dragging = false;
            root.classList.remove("is-pro-resizing");
            persist();
        };
        splitter.addEventListener("pointerup", stop);
        splitter.addEventListener("pointercancel", stop);
        splitter.addEventListener("dblclick", (event) => {
            if (!enabled)
                return;
            event.preventDefault();
            update({
                previewShare: DEFAULT_STATE.previewShare,
                collapsed: { preview: false, source: false },
            });
        });
    }
    root
        .querySelectorAll('[data-pro-pane="preview"], [data-editor-group="primary"]')
        .forEach((paneElement) => {
        const pane = paneElement.dataset.proPane === "preview" ? "preview" : "source";
        let startX = 0;
        paneElement.addEventListener("pointerdown", (event) => {
            if (!enabled || !state.collapsed[pane])
                return;
            startX = event.clientX;
            paneElement.setPointerCapture(event.pointerId);
            root.classList.add("is-pro-resizing");
        });
        paneElement.addEventListener("pointermove", (event) => {
            if (!state.collapsed[pane] ||
                !paneElement.hasPointerCapture(event.pointerId) ||
                Math.abs(event.clientX - startX) < 8) {
                return;
            }
            update({ collapsed: { ...state.collapsed, [pane]: false } });
        });
        paneElement.addEventListener("pointerup", (event) => {
            if (!paneElement.hasPointerCapture(event.pointerId))
                return;
            paneElement.releasePointerCapture(event.pointerId);
            root.classList.remove("is-pro-resizing");
            if (Math.abs(event.clientX - startX) < 8) {
                update({ collapsed: { ...state.collapsed, [pane]: false } });
            }
        });
        paneElement.addEventListener("pointercancel", () => root.classList.remove("is-pro-resizing"));
    });
    apply();
    const setEnabled = (nextEnabled) => {
        if (enabled === nextEnabled)
            return;
        enabled = nextEnabled;
        apply();
    };
    const tryShowViewerFile = (path, kind, data, mimeType) => {
        if (!enabled)
            return false;
        if (kind === "pdf")
            previewViewer.showPdfViewer(path, data, mimeType);
        else
            previewViewer.showImageViewer(path, data, mimeType);
        const title = document.getElementById("pro-preview-title");
        if (title)
            title.textContent = path.split("/").pop() || path;
        if (state.collapsed.preview) {
            update({ collapsed: { ...state.collapsed, preview: false } });
        }
        return true;
    };
    return {
        getState: () => state,
        setEnabled,
        tryShowViewerFile,
        getPdfPath: previewViewer.getPdfPath,
        syncPdf: previewViewer.syncPdf,
    };
};

import { createViewer } from "./viewer.js";
export const PRO_MODE_STORAGE_KEY = "tex64.proMode.v1";
const DEFAULT_STATE = {
    enabled: false,
    layout: "preview-source",
    ratios: [0.34, 0.33, 0.33],
    collapsed: { preview: false, source: false, reference: false, code: true },
};
export const clampProRatios = (ratios, minRatio = 0.12) => {
    const safe = [0, 1, 2].map((index) => {
        const value = Number(ratios[index]);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_STATE.ratios[index];
    });
    const total = safe.reduce((sum, value) => sum + value, 0) || 1;
    const normalized = safe.map((value) => value / total);
    const boundedMin = Math.min(Math.max(minRatio, 0), 1 / 3);
    const result = normalized.map((value) => Math.max(value, boundedMin));
    const excess = result.reduce((sum, value) => sum + value, 0) - 1;
    if (excess > 0) {
        const adjustable = result.map((value) => Math.max(value - boundedMin, 0));
        const adjustableTotal = adjustable.reduce((sum, value) => sum + value, 0);
        if (adjustableTotal > 0) {
            result.forEach((value, index) => {
                result[index] = value - excess * (adjustable[index] / adjustableTotal);
            });
        }
    }
    const finalTotal = result.reduce((sum, value) => sum + value, 0) || 1;
    return result.map((value) => value / finalTotal);
};
export const parseProModeState = (raw) => {
    var _a;
    if (!raw)
        return structuredClone(DEFAULT_STATE);
    try {
        const value = JSON.parse(raw);
        const collapsed = (_a = value.collapsed) !== null && _a !== void 0 ? _a : {};
        return {
            enabled: value.enabled === true,
            layout: value.layout === "source-reference-code" ? value.layout : "preview-source",
            ratios: clampProRatios(Array.isArray(value.ratios) ? value.ratios : DEFAULT_STATE.ratios),
            collapsed: {
                preview: collapsed.preview === true,
                source: collapsed.source === true,
                reference: collapsed.reference === true,
                code: collapsed.code !== false,
            },
        };
    }
    catch {
        return structuredClone(DEFAULT_STATE);
    }
};
export const createProSplitViewCoordinator = (deps) => {
    let proModeActive = false;
    let lightSplitViewEnabled = false;
    return (enabled, layout) => {
        if (enabled) {
            if (!proModeActive) {
                lightSplitViewEnabled = deps.getSplitViewEnabled();
            }
            deps.setSplitViewEnabled(layout === "source-reference-code");
        }
        else if (proModeActive) {
            deps.setSplitViewEnabled(lightSplitViewEnabled);
        }
        proModeActive = enabled;
    };
};
export const initProModeUi = (deps) => {
    const root = document.getElementById("editor-groups");
    const toggle = document.getElementById("pro-mode-toggle");
    const switcher = document.getElementById("pro-layout-switcher");
    if (!(root instanceof HTMLElement) || !(toggle instanceof HTMLButtonElement))
        return null;
    let state = parseProModeState(localStorage.getItem(PRO_MODE_STORAGE_KEY));
    const previewViewer = createViewer({
        editorViewer: document.getElementById("pro-preview-viewer"),
        editorViewerImage: document.getElementById("pro-preview-image"),
        editorViewerPdf: document.getElementById("pro-preview-pdf"),
        editorHost: null,
    });
    const referenceViewer = createViewer({
        editorViewer: document.getElementById("pro-reference-viewer"),
        editorViewerImage: document.getElementById("pro-reference-image"),
        editorViewerPdf: document.getElementById("pro-reference-pdf"),
        editorHost: null,
    });
    const syncSplitView = createProSplitViewCoordinator(deps);
    const persist = () => localStorage.setItem(PRO_MODE_STORAGE_KEY, JSON.stringify(state));
    const scheduleLayout = () => requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    const apply = () => {
        document.documentElement.dataset.proMode = state.enabled ? "true" : "false";
        root.dataset.proLayout = state.layout;
        toggle.setAttribute("aria-checked", String(state.enabled));
        toggle.classList.toggle("is-active", state.enabled);
        if (switcher instanceof HTMLElement)
            switcher.hidden = !state.enabled;
        const previewPane = document.getElementById("pro-preview-pane");
        const referencePane = document.getElementById("pro-reference-pane");
        previewPane === null || previewPane === void 0 ? void 0 : previewPane.setAttribute("aria-hidden", String(!state.enabled || state.layout !== "preview-source"));
        referencePane === null || referencePane === void 0 ? void 0 : referencePane.setAttribute("aria-hidden", String(!state.enabled || state.layout !== "source-reference-code"));
        root.style.setProperty("--pro-pane-a", `${state.ratios[0]}fr`);
        root.style.setProperty("--pro-pane-b", `${state.ratios[1]}fr`);
        root.style.setProperty("--pro-pane-c", `${state.ratios[2]}fr`);
        root.style.setProperty("--pro-pane-rest", `${state.ratios[1] + state.ratios[2]}fr`);
        Object.keys(state.collapsed).forEach((pane) => {
            root.classList.toggle(`is-${pane}-collapsed`, state.collapsed[pane]);
            root.querySelectorAll(`[data-pro-collapse="${pane}"]`).forEach((button) => {
                button.setAttribute("aria-expanded", String(!state.collapsed[pane]));
                button.title = state.collapsed[pane] ? `Expand ${pane}` : `Collapse ${pane}`;
            });
        });
        root.querySelectorAll("[data-pro-layout]").forEach((button) => {
            button.setAttribute("aria-pressed", String(button.dataset.proLayout === state.layout));
        });
        syncSplitView(state.enabled, state.layout);
        scheduleLayout();
    };
    const update = (next) => {
        state = { ...state, ...next };
        persist();
        apply();
    };
    toggle.addEventListener("click", () => update({ enabled: !state.enabled }));
    document.querySelectorAll("[data-pro-layout]").forEach((button) => {
        button.addEventListener("click", () => {
            const layout = button.dataset.proLayout;
            if (layout === "preview-source" || layout === "source-reference-code")
                update({ layout });
        });
    });
    root.querySelectorAll("[data-pro-collapse]").forEach((button) => {
        button.addEventListener("click", () => {
            const pane = button.dataset.proCollapse;
            update({ collapsed: { ...state.collapsed, [pane]: !state.collapsed[pane] } });
        });
    });
    const bindFileInput = (kind, viewer) => {
        const input = document.getElementById(`pro-${kind}-file`);
        const open = root.querySelector(`[data-pro-open="${kind}"]`);
        if (!(input instanceof HTMLInputElement) || !open)
            return;
        open.addEventListener("click", () => input.click());
        input.addEventListener("change", () => {
            var _a;
            const file = (_a = input.files) === null || _a === void 0 ? void 0 : _a[0];
            if (!file)
                return;
            const reader = new FileReader();
            reader.addEventListener("load", () => {
                const dataUrl = typeof reader.result === "string" ? reader.result : "";
                const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
                if (file.type === "application/pdf")
                    viewer.showPdfViewer(file.name, data, file.type);
                else if (file.type.startsWith("image/"))
                    viewer.showImageViewer(file.name, data, file.type);
                else
                    viewer.showUnsupportedViewer();
            });
            reader.readAsDataURL(file);
            input.value = "";
        });
    };
    bindFileInput("preview", previewViewer);
    bindFileInput("reference", referenceViewer);
    const setupSplitter = (id, boundary) => {
        const splitter = document.getElementById(id);
        if (!(splitter instanceof HTMLElement))
            return;
        let dragging = false;
        splitter.addEventListener("pointerdown", (event) => {
            if (!state.enabled)
                return;
            dragging = true;
            splitter.setPointerCapture(event.pointerId);
            root.classList.add("is-pro-resizing");
        });
        splitter.addEventListener("pointermove", (event) => {
            if (!dragging)
                return;
            const rect = root.getBoundingClientRect();
            const ratio = (event.clientX - rect.left) / Math.max(rect.width, 1);
            const next = [...state.ratios];
            if (state.layout === "preview-source" || boundary === 0) {
                next[0] = ratio;
                next[1] = Math.max(1 - ratio - next[2], 0.01);
            }
            else {
                next[1] = ratio - next[0];
                next[2] = 1 - ratio;
            }
            state = { ...state, ratios: clampProRatios(next) };
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
    };
    setupSplitter("pro-splitter-primary", 0);
    setupSplitter("pro-splitter-secondary", 1);
    apply();
    return { getState: () => state };
};

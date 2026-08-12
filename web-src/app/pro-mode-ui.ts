import { createViewer } from "./viewer.js";

export type ProLayout = "preview-source" | "source-reference-code";
export type ProPane = "preview" | "source" | "reference" | "code";

export type ProModeState = {
  enabled: boolean;
  layout: ProLayout;
  ratios: [number, number, number];
  collapsed: Record<ProPane, boolean>;
};

export const PRO_MODE_STORAGE_KEY = "tex64.proMode.v1";
const DEFAULT_STATE: ProModeState = {
  enabled: false,
  layout: "preview-source",
  ratios: [0.34, 0.33, 0.33],
  collapsed: { preview: false, source: false, reference: false, code: true },
};

export const clampProRatios = (
  ratios: readonly number[],
  minRatio = 0.12
): [number, number, number] => {
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
  return result.map((value) => value / finalTotal) as [number, number, number];
};

export const parseProModeState = (raw: string | null): ProModeState => {
  if (!raw) return structuredClone(DEFAULT_STATE);
  try {
    const value = JSON.parse(raw) as Partial<ProModeState>;
    const collapsed = value.collapsed ?? {} as Record<ProPane, boolean>;
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
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
};

type ProModeDeps = {
  setSplitViewEnabled: (enabled: boolean) => void;
  getSplitViewEnabled: () => boolean;
};

export const createProSplitViewCoordinator = (deps: ProModeDeps) => {
  let proModeActive = false;
  let lightSplitViewEnabled = false;

  return (enabled: boolean, layout: ProLayout) => {
    if (enabled) {
      if (!proModeActive) {
        lightSplitViewEnabled = deps.getSplitViewEnabled();
      }
      deps.setSplitViewEnabled(layout === "source-reference-code");
    } else if (proModeActive) {
      deps.setSplitViewEnabled(lightSplitViewEnabled);
    }
    proModeActive = enabled;
  };
};

export const initProModeUi = (deps: ProModeDeps) => {
  const root = document.getElementById("editor-groups");
  const toggle = document.getElementById("pro-mode-toggle");
  const switcher = document.getElementById("pro-layout-switcher");
  if (!(root instanceof HTMLElement) || !(toggle instanceof HTMLButtonElement)) return null;

  let state = parseProModeState(localStorage.getItem(PRO_MODE_STORAGE_KEY));
  const previewViewer = createViewer({
    editorViewer: document.getElementById("pro-preview-viewer"),
    editorViewerImage: document.getElementById("pro-preview-image") as HTMLImageElement | null,
    editorViewerPdf: document.getElementById("pro-preview-pdf") as HTMLIFrameElement | null,
    editorHost: null,
  });
  const referenceViewer = createViewer({
    editorViewer: document.getElementById("pro-reference-viewer"),
    editorViewerImage: document.getElementById("pro-reference-image") as HTMLImageElement | null,
    editorViewerPdf: document.getElementById("pro-reference-pdf") as HTMLIFrameElement | null,
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
    if (switcher instanceof HTMLElement) switcher.hidden = !state.enabled;
    const previewPane = document.getElementById("pro-preview-pane");
    const referencePane = document.getElementById("pro-reference-pane");
    previewPane?.setAttribute(
      "aria-hidden",
      String(!state.enabled || state.layout !== "preview-source")
    );
    referencePane?.setAttribute(
      "aria-hidden",
      String(!state.enabled || state.layout !== "source-reference-code")
    );
    root.style.setProperty("--pro-pane-a", `${state.ratios[0]}fr`);
    root.style.setProperty("--pro-pane-b", `${state.ratios[1]}fr`);
    root.style.setProperty("--pro-pane-c", `${state.ratios[2]}fr`);
    root.style.setProperty("--pro-pane-rest", `${state.ratios[1] + state.ratios[2]}fr`);
    (Object.keys(state.collapsed) as ProPane[]).forEach((pane) => {
      root.classList.toggle(`is-${pane}-collapsed`, state.collapsed[pane]);
      root.querySelectorAll<HTMLElement>(`[data-pro-collapse="${pane}"]`).forEach((button) => {
        button.setAttribute("aria-expanded", String(!state.collapsed[pane]));
        button.title = state.collapsed[pane] ? `Expand ${pane}` : `Collapse ${pane}`;
      });
    });
    root.querySelectorAll<HTMLButtonElement>("[data-pro-layout]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.proLayout === state.layout));
    });
    syncSplitView(state.enabled, state.layout);
    scheduleLayout();
  };

  const update = (next: Partial<ProModeState>) => {
    state = { ...state, ...next };
    persist();
    apply();
  };

  toggle.addEventListener("click", () => update({ enabled: !state.enabled }));
  document.querySelectorAll<HTMLButtonElement>("[data-pro-layout]").forEach((button) => {
    button.addEventListener("click", () => {
      const layout = button.dataset.proLayout as ProLayout;
      if (layout === "preview-source" || layout === "source-reference-code") update({ layout });
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-pro-collapse]").forEach((button) => {
    button.addEventListener("click", () => {
      const pane = button.dataset.proCollapse as ProPane;
      update({ collapsed: { ...state.collapsed, [pane]: !state.collapsed[pane] } });
    });
  });

  const bindFileInput = (kind: "preview" | "reference", viewer: ReturnType<typeof createViewer>) => {
    const input = document.getElementById(`pro-${kind}-file`);
    const open = root.querySelector<HTMLButtonElement>(`[data-pro-open="${kind}"]`);
    if (!(input instanceof HTMLInputElement) || !open) return;
    open.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
        if (file.type === "application/pdf") viewer.showPdfViewer(file.name, data, file.type);
        else if (file.type.startsWith("image/")) viewer.showImageViewer(file.name, data, file.type);
        else viewer.showUnsupportedViewer();
      });
      reader.readAsDataURL(file);
      input.value = "";
    });
  };
  bindFileInput("preview", previewViewer);
  bindFileInput("reference", referenceViewer);

  const setupSplitter = (id: string, boundary: 0 | 1) => {
    const splitter = document.getElementById(id);
    if (!(splitter instanceof HTMLElement)) return;
    let dragging = false;
    splitter.addEventListener("pointerdown", (event) => {
      if (!state.enabled) return;
      dragging = true;
      splitter.setPointerCapture(event.pointerId);
      root.classList.add("is-pro-resizing");
    });
    splitter.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const rect = root.getBoundingClientRect();
      const ratio = (event.clientX - rect.left) / Math.max(rect.width, 1);
      const next = [...state.ratios] as [number, number, number];
      if (state.layout === "preview-source" || boundary === 0) {
        next[0] = ratio;
        next[1] = Math.max(1 - ratio - next[2], 0.01);
      } else {
        next[1] = ratio - next[0];
        next[2] = 1 - ratio;
      }
      state = { ...state, ratios: clampProRatios(next) };
      apply();
    });
    const stop = () => {
      if (!dragging) return;
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

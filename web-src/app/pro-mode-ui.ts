import { createViewer } from "./viewer.js";

export type ProModeState = {
  previewShare: number;
};

export const PRO_MODE_STORAGE_KEY = "tex64.proMode.v1";
const DEFAULT_STATE: ProModeState = {
  previewShare: 0.34,
};

export const PRO_PANE_MIN_PX = 220;

export type ProSplitterDragResult = {
  previewShare: number;
};

export const clampPreviewShare = (value: number, minShare = 0.12): number => {
  const minimum = Math.min(Math.max(minShare, 0), 0.5);
  const safe = Number.isFinite(value) ? value : DEFAULT_STATE.previewShare;
  return Math.min(Math.max(safe, minimum), 1 - minimum);
};

export const calculateProSplitterDrag = (
  pointerRatio: number,
  minShare: number
): ProSplitterDragResult => {
  const sourceShare = Math.min(Math.max(pointerRatio, 0), 1);
  return {
    previewShare: clampPreviewShare(1 - sourceShare, minShare),
  };
};

export const isCodePreviewVisible = (
  workspaceEnabled: boolean,
  previewEnabled: boolean
): boolean => workspaceEnabled && previewEnabled;

export const parseProModeState = (raw: string | null): ProModeState => {
  if (!raw) return structuredClone(DEFAULT_STATE);
  try {
    const value = JSON.parse(raw) as {
      previewShare?: unknown;
      ratios?: unknown;
    };
    let previewShare = Number(value.previewShare);
    if (!Number.isFinite(previewShare) && Array.isArray(value.ratios)) {
      const ratios = value.ratios.map(Number);
      const total = ratios.reduce(
        (sum, ratio) => sum + (Number.isFinite(ratio) && ratio > 0 ? ratio : 0),
        0
      );
      previewShare = total > 0 ? Math.max(ratios[0] || 0, 0) / total : DEFAULT_STATE.previewShare;
    }
    return { previewShare: clampPreviewShare(previewShare) };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
};

type ProModeDeps = {
  setSplitViewEnabled: (enabled: boolean) => void;
};

export const initProModeUi = (deps: ProModeDeps) => {
  const root = document.getElementById("editor-groups");
  if (!(root instanceof HTMLElement)) return null;

  let state = parseProModeState(localStorage.getItem(PRO_MODE_STORAGE_KEY));
  let enabled = false;
  let previewEnabled = true;
  const previewViewer = createViewer({
    editorViewer: document.getElementById("pro-preview-viewer"),
    editorViewerImage: document.getElementById("pro-preview-image") as HTMLImageElement | null,
    editorViewerPdf: document.getElementById("pro-preview-pdf") as HTMLIFrameElement | null,
    editorHost: null,
  });
  const persist = () => localStorage.setItem(PRO_MODE_STORAGE_KEY, JSON.stringify(state));
  const scheduleLayout = () =>
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));

  const apply = () => {
    const previewVisible = isCodePreviewVisible(enabled, previewEnabled);
    window.dispatchEvent(
      new CustomEvent("tex64:code-workspace", { detail: { enabled } })
    );
    const canvasButton = document.getElementById("pro-canvas-open");
    if (canvasButton instanceof HTMLButtonElement) canvasButton.hidden = !enabled;
    document
      .getElementById("pro-preview-pane")
      ?.setAttribute("aria-hidden", String(!previewVisible));
    root.dataset.codePreview = previewVisible ? "true" : "false";
    root.style.setProperty("--pro-preview-share", `${state.previewShare}fr`);
    root.style.setProperty("--pro-source-share", `${1 - state.previewShare}fr`);
    if (enabled) deps.setSplitViewEnabled(false);
    scheduleLayout();
  };

  const update = (next: Partial<ProModeState>) => {
    state = { ...state, ...next };
    persist();
    apply();
  };

  const splitter = document.getElementById("pro-splitter-primary");
  if (splitter instanceof HTMLElement) {
    let dragging = false;
    splitter.addEventListener("pointerdown", (event) => {
      if (!enabled) return;
      dragging = true;
      splitter.setPointerCapture(event.pointerId);
      root.classList.add("is-pro-resizing");
    });
    splitter.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const rect = root.getBoundingClientRect();
      const result = calculateProSplitterDrag(
        (event.clientX - rect.left) / Math.max(rect.width, 1),
        PRO_PANE_MIN_PX / Math.max(rect.width, 1)
      );
      state = {
        ...state,
        previewShare: result.previewShare,
      };
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
    splitter.addEventListener("dblclick", (event) => {
      if (!enabled) return;
      event.preventDefault();
      update({ previewShare: DEFAULT_STATE.previewShare });
    });
  }

  apply();

  const setEnabled = (nextEnabled: boolean) => {
    if (enabled === nextEnabled) return;
    enabled = nextEnabled;
    apply();
  };

  const setPreviewEnabled = (nextEnabled: boolean) => {
    if (previewEnabled === nextEnabled) return;
    previewEnabled = nextEnabled;
    apply();
  };

  const tryShowViewerFile = (
    path: string,
    kind: "image" | "pdf",
    data?: string,
    mimeType?: string
  ) => {
    if (!enabled || !previewEnabled) return false;
    if (kind === "pdf") previewViewer.showPdfViewer(path, data, mimeType);
    else previewViewer.showImageViewer(path, data, mimeType);
    return true;
  };

  return {
    getState: () => state,
    setEnabled,
    setPreviewEnabled,
    tryShowViewerFile,
    getPdfPath: previewViewer.getPdfPath,
    syncPdf: previewViewer.syncPdf,
    setLivePreview: previewViewer.setLivePreview,
  };
};

import type { AppContext } from "./context.js";

type SidebarResizerDeps = {
  layoutEditors: () => void;
  collapseSidebar: () => void;
  // Toggle Monaco automaticLayout so it doesn't re-layout in parallel with our
  // throttled manual layout during a drag (best-effort; no-op if unsupported).
  setEditorsAutomaticLayout?: (enabled: boolean) => void;
};

export type SidebarResizerApi = {
  setup: () => void;
};

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

export type SidebarDragLayout = {
  width: number;
  collapse: boolean;
};

export const resolveSidebarDragLayout = (
  clientX: number,
  windowWidth: number
): SidebarDragLayout => {
  const rawWidth = clientX - SIDEBAR_RAIL_WIDTH;
  if (rawWidth <= COLLAPSE_PANEL_WIDTH) {
    return { width: 0, collapse: true };
  }
  const maxPanelWidth = Math.max(
    MIN_PANEL_WIDTH,
    windowWidth - SIDEBAR_RAIL_WIDTH - MIN_EDITOR_WIDTH
  );
  return {
    width: Math.max(MIN_PANEL_WIDTH, Math.min(maxPanelWidth, rawWidth)),
    collapse: false,
  };
};

const clampPanelWidth = (width: number): number => {
  const maxPanelWidth = Math.max(
    MIN_PANEL_WIDTH,
    window.innerWidth - SIDEBAR_RAIL_WIDTH - MIN_EDITOR_WIDTH
  );
  return Math.max(MIN_PANEL_WIDTH, Math.min(maxPanelWidth, width));
};

const applyPanelWidth = (width: number) => {
  document.documentElement.style.setProperty("--sidebar-panel-width", `${width}px`);
};

const readStoredPanelWidth = (): number | null => {
  try {
    const raw = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
};

const storePanelWidth = (width: number) => {
  try {
    window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    /* private mode / quota: the width simply does not persist */
  }
};

export const initSidebarResizer = (
  context: AppContext,
  deps: SidebarResizerDeps
): SidebarResizerApi => {
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
    let rafId: number | null = null;
    let lastAppliedWidth: number | null = null;
    let collapseOnRelease = false;
    let expandedWidthBeforeDrag: number | null = null;

    const startResize = () => {
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
      deps.setEditorsAutomaticLayout?.(false);
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

    const doResize = (event: MouseEvent) => {
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
      deps.setEditorsAutomaticLayout?.(true);
      if (collapseOnRelease) {
        const restoredWidth = clampPanelWidth(
          expandedWidthBeforeDrag ?? readStoredPanelWidth() ?? MIN_PANEL_WIDTH
        );
        applyPanelWidth(restoredWidth);
        storePanelWidth(restoredWidth);
        deps.collapseSidebar();
      } else if (lastAppliedWidth !== null) {
        storePanelWidth(lastAppliedWidth);
      }
      collapseOnRelease = false;
      expandedWidthBeforeDrag = null;
      deps.layoutEditors();
    };

    resizer.addEventListener("mousedown", startResize);
    resizer.addEventListener("mouseup", stopResize);
    resizer.addEventListener("pointerdown", (event) => {
      (resizer as HTMLElement).setPointerCapture?.(event.pointerId);
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

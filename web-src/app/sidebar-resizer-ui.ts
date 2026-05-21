import type { AppContext } from "./context.js";

type SidebarResizerDeps = {
  layoutEditors: () => void;
  // Toggle Monaco automaticLayout so it doesn't re-layout in parallel with our
  // throttled manual layout during a drag (best-effort; no-op if unsupported).
  setEditorsAutomaticLayout?: (enabled: boolean) => void;
};

export type SidebarResizerApi = {
  setup: () => void;
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
    let isResizing = false;
    let pendingClientX = 0;
    let rafId: number | null = null;

    const startResize = () => {
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
      deps.setEditorsAutomaticLayout?.(false);
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
      const maxPanelWidth = Math.max(
        minPanelWidth,
        window.innerWidth - sidebarWidth - minEditorWidth
      );
      const newWidth = Math.max(
        minPanelWidth,
        Math.min(maxPanelWidth, pendingClientX - sidebarWidth)
      );
      document.documentElement.style.setProperty("--sidebar-panel-width", `${newWidth}px`);
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

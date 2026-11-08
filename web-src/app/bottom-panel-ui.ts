import type { AppContext } from "./context.js";

const STORAGE_KEY_SIDEBAR = "tex64.layout.sidebarVisible";
// Retired: the panel's open state was only ever restored onto its Math tab,
// which is gone (the math input stays in the sidebar). The terminal is never
// started by itself at launch, so the stale value is dropped, not read.
const STORAGE_KEY_BOTTOM_RETIRED = "tex64.layout.bottomPanelVisible";
const STORAGE_KEY_BOTTOM_HEIGHT = "tex64.layout.bottomPanelHeight";
const MIN_PANEL_HEIGHT = 120;
const MAX_PANEL_HEIGHT = 600;
const DEFAULT_PANEL_HEIGHT = 220;

export type BottomPanelApi = {
  openBottomPanel: () => void;
  closeBottomPanel: () => void;
  toggleBottomPanel: () => void;
  isBottomPanelOpen: () => boolean;
  /** Open the panel and focus the terminal (used by Ctrl+`). */
  openTerminal: () => void;
  toggleSidebar: () => void;
  isSidebarVisible: () => boolean;
};

export type BottomPanelDeps = {
  onTerminalShow?: () => void;
  onTerminalHide?: () => void;
  onTerminalRestart?: () => void;
  onTerminalCreate?: () => void;
  onTerminalSplit?: () => void;
};

export const initBottomPanelUi = (
  context: AppContext,
  deps: BottomPanelDeps = {}
): BottomPanelApi => {
  const {
    bottomPanel,
    bottomPanelResizer,
    bottomPanelClose,
    bottomPanelTerminalRestart,
    bottomPanelTabs,
    toggleSidebarButton,
    toggleBottomPanelButton,
  } = context.dom;

  const editorSection = document.querySelector<HTMLElement>("section.editor");
  const mainEl = document.querySelector<HTMLElement>(".main");

  let sidebarVisible = true;
  let bottomPanelOpen = false;
  let panelHeight = DEFAULT_PANEL_HEIGHT;

  const tabButtons = bottomPanelTabs ?? [];

  // --- Persistence ---

  const loadState = () => {
    try {
      const sv = localStorage.getItem(STORAGE_KEY_SIDEBAR);
      if (sv !== null) sidebarVisible = sv !== "false";
      localStorage.removeItem(STORAGE_KEY_BOTTOM_RETIRED);
      const bh = localStorage.getItem(STORAGE_KEY_BOTTOM_HEIGHT);
      if (bh !== null) {
        const parsed = parseInt(bh, 10);
        if (Number.isFinite(parsed)) {
          panelHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, parsed));
        }
      }
    } catch { /* ignore */ }
  };

  const saveState = () => {
    try {
      localStorage.setItem(STORAGE_KEY_SIDEBAR, String(sidebarVisible));
      localStorage.setItem(STORAGE_KEY_BOTTOM_HEIGHT, String(panelHeight));
    } catch { /* ignore */ }
  };

  // --- Apply layout ---

  const applyBottomPanel = () => {
    if (!editorSection || !bottomPanel) return;

    if (bottomPanelOpen) {
      editorSection.classList.add("has-bottom-panel");
      editorSection.style.setProperty("--bottom-panel-height", `${panelHeight}px`);
      bottomPanel.setAttribute("aria-hidden", "false");
    } else {
      editorSection.classList.remove("has-bottom-panel");
      editorSection.style.removeProperty("--bottom-panel-height");
      bottomPanel.setAttribute("aria-hidden", "true");
    }

    // Toggle button state
    if (toggleBottomPanelButton) {
      toggleBottomPanelButton.classList.toggle("is-active", bottomPanelOpen);
      toggleBottomPanelButton.setAttribute("aria-pressed", String(bottomPanelOpen));
    }

    if (bottomPanelOpen) {
      deps.onTerminalShow?.();
    } else {
      deps.onTerminalHide?.();
    }
  };

  const applySidebar = () => {
    if (!mainEl) return;
    mainEl.classList.toggle("sidebar-collapsed", !sidebarVisible);

    if (toggleSidebarButton) {
      toggleSidebarButton.classList.toggle("is-active", sidebarVisible);
      toggleSidebarButton.setAttribute("aria-pressed", String(sidebarVisible));
    }
  };

  // --- Public API ---

  const openBottomPanel = () => {
    bottomPanelOpen = true;
    applyBottomPanel();
    saveState();
  };

  const closeBottomPanel = () => {
    bottomPanelOpen = false;
    applyBottomPanel();
    saveState();
  };

  const toggleBottomPanel = () => {
    bottomPanelOpen = !bottomPanelOpen;
    applyBottomPanel();
    saveState();
  };

  const isBottomPanelOpen = () => bottomPanelOpen;

  const openTerminal = () => {
    if (!bottomPanelOpen) {
      openBottomPanel();
    } else {
      deps.onTerminalShow?.();
    }
  };

  const toggleSidebar = () => {
    sidebarVisible = !sidebarVisible;
    applySidebar();
    saveState();
    // Trigger Monaco editor relayout after sidebar collapse/expand
    window.dispatchEvent(new Event("resize"));
  };

  const isSidebarVisible = () => sidebarVisible;

  // --- Resizer drag ---

  const initResizer = () => {
    if (!bottomPanelResizer || !editorSection) return;

    let startY = 0;
    let startHeight = 0;
    let pendingClientY = 0;
    let rafId: number | null = null;

    // Apply the latest pointer position once per animation frame. The CSS var
    // change reflows the grid, which makes the editor and the terminal
    // re-layout — coalescing to one update per frame keeps it smooth.
    const applyResize = () => {
      rafId = null;
      const delta = startY - pendingClientY;
      const newHeight = Math.max(
        MIN_PANEL_HEIGHT,
        Math.min(MAX_PANEL_HEIGHT, startHeight + delta)
      );
      panelHeight = newHeight;
      editorSection.style.setProperty("--bottom-panel-height", `${panelHeight}px`);
    };

    const onMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      pendingClientY = e.clientY;
      if (rafId === null) {
        rafId = window.requestAnimationFrame(applyResize);
      }
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      bottomPanelResizer.classList.remove("is-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      saveState();
      window.dispatchEvent(new Event("resize"));
    };

    bottomPanelResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startY = e.clientY;
      startHeight = panelHeight;
      pendingClientY = e.clientY;
      bottomPanelResizer.classList.add("is-resizing");
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  };

  // --- Event listeners ---

  if (toggleSidebarButton) {
    toggleSidebarButton.addEventListener("click", toggleSidebar);
  }
  if (toggleBottomPanelButton) {
    toggleBottomPanelButton.addEventListener("click", toggleBottomPanel);
  }
  if (bottomPanelClose) {
    bottomPanelClose.addEventListener("click", closeBottomPanel);
  }
  if (bottomPanelTerminalRestart) {
    bottomPanelTerminalRestart.addEventListener("click", () => {
      deps.onTerminalRestart?.();
    });
  }
  document.getElementById("bottom-panel-terminal-window")?.addEventListener("click", async () => {
    const result = await (window as any).tex64Terminal?.openWindow();
    if (result?.error) window.alert(result.error);
  });
  document.getElementById("bottom-panel-terminal-new")?.addEventListener("click", () => deps.onTerminalCreate?.());
  document.getElementById("bottom-panel-terminal-split")?.addEventListener("click", () => deps.onTerminalSplit?.());
  tabButtons.forEach((button) => {
    button.addEventListener("click", openTerminal);
  });

  // Ctrl+` toggles the terminal, VS Code-style: opens the panel (focusing
  // the shell), or closes it when it is already showing. (Build shortcuts remain click-only by policy — this
  // is a panel toggle, not a build binding.)
  document.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return;
    }
    if (event.code !== "Backquote" || event.isComposing) {
      return;
    }
    event.preventDefault();
    if (bottomPanelOpen) {
      closeBottomPanel();
    } else {
      openTerminal();
    }
  });

  // --- Init ---

  loadState();
  applySidebar();
  applyBottomPanel();
  initResizer();

  return {
    openBottomPanel,
    closeBottomPanel,
    toggleBottomPanel,
    isBottomPanelOpen,
    openTerminal,
    toggleSidebar,
    isSidebarVisible,
  };
};

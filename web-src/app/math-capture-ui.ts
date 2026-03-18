import type { AppContext } from "./context.js";

export type MathCaptureWindowSource = {
  id: string;
  title: string;
  app?: string;
  thumbnailUrl?: string;
};

type MathCaptureUiDeps = {
  onWindowSelect?: (id: string) => void;
  onWindowCancel?: () => void;
  onCropApply?: () => void;
  onCropCancel?: () => void;
  onCropRetry?: () => void;
  onPermissionOpenSettings?: () => void;
  onPermissionRetry?: () => void;
};

export type MathCaptureUiApi = {
  openWindowPicker: (sources: MathCaptureWindowSource[], selectedId?: string | null) => void;
  closeWindowPicker: () => void;
  openCropper: (options?: { imageUrl?: string; sizeLabel?: string }) => void;
  closeCropper: () => void;
  setCropSizeLabel: (label: string) => void;
  setCropBusy: (busy: boolean, message?: string) => void;
  setCropError: (message: string) => void;
  showPermissionGuide: () => void;
  hidePermissionGuide: () => void;
  setHandlers: (handlers: MathCaptureUiDeps) => void;
};

export const initMathCaptureUi = (
  context: AppContext,
  deps: MathCaptureUiDeps = {}
): MathCaptureUiApi => {
  const {
    mathCaptureWindowModal,
    mathCaptureWindowCancel,
    mathCaptureWindowSearch,
    mathCaptureWindowGrid,
    mathCaptureWindowItemTemplate,
    mathCaptureCropModal,
    mathCaptureCropRetry,
    mathCaptureCropCancel,
    mathCaptureCropApply,
    mathCaptureCropImage,
    mathCaptureCropSize,
    capturePermissionModal,
    capturePermissionOpen,
    capturePermissionRetry,
    capturePermissionClose,
  } = context.dom;

  let sources: MathCaptureWindowSource[] = [];
  let selectedId: string | null = null;
  let searchText = "";
  let handlers: MathCaptureUiDeps = { ...deps };

  const setModalOpen = (modal: HTMLElement | null, open: boolean) => {
    if (!modal) return;
    modal.classList.toggle("is-open", open);
    modal.setAttribute("aria-hidden", open ? "false" : "true");
  };

  const renderSources = () => {
    if (!(mathCaptureWindowGrid instanceof HTMLElement)) {
      return;
    }
    mathCaptureWindowGrid.textContent = "";
    const template =
      mathCaptureWindowItemTemplate instanceof HTMLTemplateElement
        ? mathCaptureWindowItemTemplate
        : null;
    if (!template) {
      return;
    }
    const filtered = sources.filter((source) => {
      if (!searchText) return true;
      const key = `${source.title} ${source.app ?? ""}`.toLowerCase();
      return key.includes(searchText.toLowerCase());
    });
    filtered.forEach((source) => {
      const fragment = template.content.cloneNode(true) as DocumentFragment;
      const root = fragment.querySelector<HTMLElement>(".capture-window-item");
      if (!root) return;
      root.dataset.id = source.id;
      if (source.id === selectedId) {
        root.classList.add("is-active");
      }
      const titleEl = root.querySelector<HTMLElement>(".capture-window-title");
      if (titleEl) titleEl.textContent = source.title;
      const appEl = root.querySelector<HTMLElement>(".capture-window-app");
      if (appEl) appEl.textContent = source.app ?? "";
      const thumb = root.querySelector<HTMLElement>(".capture-window-thumb");
      if (thumb && source.thumbnailUrl) {
        thumb.style.backgroundImage = `url("${source.thumbnailUrl}")`;
        thumb.style.backgroundSize = "cover";
        thumb.style.backgroundPosition = "center";
      }
      mathCaptureWindowGrid.appendChild(fragment);
    });
  };

  const handleWindowPickerKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeWindowPicker();
      handlers.onWindowCancel?.();
    }
  };

  const openWindowPicker = (
    nextSources: MathCaptureWindowSource[],
    nextSelected?: string | null
  ) => {
    sources = nextSources;
    selectedId = nextSelected ?? null;
    searchText = "";
    if (mathCaptureWindowSearch instanceof HTMLInputElement) {
      mathCaptureWindowSearch.value = "";
    }
    renderSources();
    setModalOpen(mathCaptureWindowModal as HTMLElement | null, true);
    if (mathCaptureWindowSearch instanceof HTMLInputElement) {
      requestAnimationFrame(() => {
        mathCaptureWindowSearch.focus();
      });
    }
    window.addEventListener("keydown", handleWindowPickerKeyDown);
  };

  const closeWindowPicker = () => {
    setModalOpen(mathCaptureWindowModal as HTMLElement | null, false);
    window.removeEventListener("keydown", handleWindowPickerKeyDown);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handlers.onCropApply?.();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      handlers.onCropCancel?.();
    }
  };

  const openCropper = (options?: { imageUrl?: string; sizeLabel?: string }) => {
    if (mathCaptureCropImage instanceof HTMLImageElement) {
      mathCaptureCropImage.src = options?.imageUrl ?? "";
    }
    if (mathCaptureCropSize instanceof HTMLElement && options?.sizeLabel) {
      mathCaptureCropSize.textContent = options.sizeLabel;
    }
    setModalOpen(mathCaptureCropModal as HTMLElement | null, true);
    window.addEventListener("keydown", handleKeyDown);
  };

  const closeCropper = () => {
    setModalOpen(mathCaptureCropModal as HTMLElement | null, false);
    window.removeEventListener("keydown", handleKeyDown);
  };

  const setCropSizeLabel = (label: string) => {
    if (mathCaptureCropSize instanceof HTMLElement) {
      mathCaptureCropSize.textContent = label;
    }
  };

  const setCropBusy = (busy: boolean, message?: string) => {
    if (mathCaptureCropApply instanceof HTMLElement) {
      mathCaptureCropApply.classList.toggle("is-busy", busy);
      mathCaptureCropApply.textContent = busy ? (message ?? "認識中…") : "確定";
      (mathCaptureCropApply as HTMLButtonElement).disabled = busy;
    }
    if (mathCaptureCropRetry instanceof HTMLElement) {
      (mathCaptureCropRetry as HTMLButtonElement).disabled = busy;
    }
    if (mathCaptureCropCancel instanceof HTMLElement) {
      (mathCaptureCropCancel as HTMLButtonElement).disabled = busy;
    }
    // Disable Esc/Enter during processing
    if (busy) {
      window.removeEventListener("keydown", handleKeyDown);
    } else {
      window.addEventListener("keydown", handleKeyDown);
    }
  };

  const setCropError = (message: string) => {
    const hint = context.dom.mathCaptureCropHint;
    if (hint instanceof HTMLElement) {
      hint.textContent = message;
      hint.classList.add("is-error");
      // Auto-clear after 6 seconds
      setTimeout(() => {
        hint.classList.remove("is-error");
        hint.textContent = "";
      }, 6000);
    }
  };

  // Permission guide modal
  const handlePermissionKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hidePermissionGuide();
    }
  };

  const showPermissionGuide = () => {
    setModalOpen(capturePermissionModal as HTMLElement | null, true);
    window.addEventListener("keydown", handlePermissionKeyDown);
  };

  const hidePermissionGuide = () => {
    setModalOpen(capturePermissionModal as HTMLElement | null, false);
    window.removeEventListener("keydown", handlePermissionKeyDown);
  };

  if (capturePermissionOpen instanceof HTMLElement) {
    capturePermissionOpen.addEventListener("click", () => {
      handlers.onPermissionOpenSettings?.();
    });
  }

  if (capturePermissionRetry instanceof HTMLElement) {
    capturePermissionRetry.addEventListener("click", () => {
      hidePermissionGuide();
      handlers.onPermissionRetry?.();
    });
  }

  if (capturePermissionClose instanceof HTMLElement) {
    capturePermissionClose.addEventListener("click", () => {
      hidePermissionGuide();
    });
  }

  if (mathCaptureWindowSearch instanceof HTMLInputElement) {
    mathCaptureWindowSearch.addEventListener("input", () => {
      searchText = mathCaptureWindowSearch.value.trim();
      renderSources();
    });
  }

  if (mathCaptureWindowGrid instanceof HTMLElement) {
    mathCaptureWindowGrid.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const button = target.closest<HTMLElement>(".capture-window-item");
      if (!button) return;
      const id = button.dataset.id;
      if (!id) return;
      selectedId = id;
      renderSources();
      handlers.onWindowSelect?.(id);
    });
  }

  if (mathCaptureWindowCancel instanceof HTMLElement) {
    mathCaptureWindowCancel.addEventListener("click", () => {
      closeWindowPicker();
      handlers.onWindowCancel?.();
    });
  }

  if (mathCaptureCropRetry instanceof HTMLElement) {
    mathCaptureCropRetry.addEventListener("click", () => {
      closeCropper();
      handlers.onCropRetry?.();
    });
  }

  if (mathCaptureCropCancel instanceof HTMLElement) {
    mathCaptureCropCancel.addEventListener("click", () => {
      closeCropper();
      handlers.onCropCancel?.();
    });
  }

  if (mathCaptureCropApply instanceof HTMLElement) {
    mathCaptureCropApply.addEventListener("click", () => {
      handlers.onCropApply?.();
    });
  }

  return {
    openWindowPicker,
    closeWindowPicker,
    openCropper,
    closeCropper,
    setCropSizeLabel,
    setCropBusy,
    setCropError,
    showPermissionGuide,
    hidePermissionGuide,
    setHandlers: (next) => {
      handlers = { ...handlers, ...next };
    },
  };
};

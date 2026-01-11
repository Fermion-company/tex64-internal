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
};

export type MathCaptureUiApi = {
  openWindowPicker: (sources: MathCaptureWindowSource[], selectedId?: string | null) => void;
  closeWindowPicker: () => void;
  openCropper: (options?: { imageUrl?: string; sizeLabel?: string }) => void;
  closeCropper: () => void;
  setCropSizeLabel: (label: string) => void;
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
    if (mathCaptureCropImage instanceof HTMLImageElement && options?.imageUrl) {
      mathCaptureCropImage.src = options.imageUrl;
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
    setHandlers: (next) => {
      handlers = { ...handlers, ...next };
    },
  };
};

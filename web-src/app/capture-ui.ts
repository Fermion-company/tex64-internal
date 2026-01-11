import type { AppContext } from "./context.js";

export type CaptureWindowSource = {
  id: string;
  title: string;
  app?: string;
  thumbnailUrl?: string;
};

type CaptureUiDeps = {
  onWindowSelect?: (id: string) => void;
  onWindowCancel?: () => void;
  onCropApply?: () => void;
  onCropCancel?: () => void;
  onCropRetry?: () => void;
};

export type CaptureUiApi = {
  openWindowPicker: (sources: CaptureWindowSource[], selectedId?: string | null) => void;
  closeWindowPicker: () => void;
  openCropper: (options?: { imageUrl?: string; sizeLabel?: string }) => void;
  closeCropper: () => void;
  setCropSizeLabel: (label: string) => void;
  setHandlers: (handlers: CaptureUiDeps) => void;
};

export const initCaptureUi = (
  context: AppContext,
  deps: CaptureUiDeps = {}
): CaptureUiApi => {
  const {
    captureWindowModal,
    captureWindowCancel,
    captureWindowSearch,
    captureWindowGrid,
    captureWindowItemTemplate,
    captureCropModal,
    captureCropRetry,
    captureCropCancel,
    captureCropApply,
    captureCropImage,
    captureCropSize,
  } = context.dom;

  let sources: CaptureWindowSource[] = [];
  let selectedId: string | null = null;
  let searchText = "";
  let handlers: CaptureUiDeps = { ...deps };

  const setModalOpen = (modal: HTMLElement | null, open: boolean) => {
    if (!modal) return;
    modal.classList.toggle("is-open", open);
    modal.setAttribute("aria-hidden", open ? "false" : "true");
  };

  const renderSources = () => {
    if (!(captureWindowGrid instanceof HTMLElement)) {
      return;
    }
    captureWindowGrid.textContent = "";
    const template =
      captureWindowItemTemplate instanceof HTMLTemplateElement
        ? captureWindowItemTemplate
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
      captureWindowGrid.appendChild(fragment);
    });
  };

  const openWindowPicker = (nextSources: CaptureWindowSource[], nextSelected?: string | null) => {
    sources = nextSources;
    selectedId = nextSelected ?? null;
    searchText = "";
    if (captureWindowSearch instanceof HTMLInputElement) {
      captureWindowSearch.value = "";
    }
    renderSources();
    setModalOpen(captureWindowModal as HTMLElement | null, true);
  };

  const closeWindowPicker = () => {
    setModalOpen(captureWindowModal as HTMLElement | null, false);
  };

  const openCropper = (options?: { imageUrl?: string; sizeLabel?: string }) => {
    if (captureCropImage instanceof HTMLImageElement && options?.imageUrl) {
      captureCropImage.src = options.imageUrl;
    }
    if (captureCropSize instanceof HTMLElement && options?.sizeLabel) {
      captureCropSize.textContent = options.sizeLabel;
    }
    setModalOpen(captureCropModal as HTMLElement | null, true);
  };

  const closeCropper = () => {
    setModalOpen(captureCropModal as HTMLElement | null, false);
  };

  const setCropSizeLabel = (label: string) => {
    if (captureCropSize instanceof HTMLElement) {
      captureCropSize.textContent = label;
    }
  };

  if (captureWindowSearch instanceof HTMLInputElement) {
    captureWindowSearch.addEventListener("input", () => {
      searchText = captureWindowSearch.value.trim();
      renderSources();
    });
  }

  if (captureWindowGrid instanceof HTMLElement) {
    captureWindowGrid.addEventListener("click", (event) => {
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

  if (captureWindowCancel instanceof HTMLElement) {
    captureWindowCancel.addEventListener("click", () => {
      closeWindowPicker();
      handlers.onWindowCancel?.();
    });
  }

  if (captureCropRetry instanceof HTMLElement) {
    captureCropRetry.addEventListener("click", () => {
      closeCropper();
      handlers.onCropRetry?.();
    });
  }

  if (captureCropCancel instanceof HTMLElement) {
    captureCropCancel.addEventListener("click", () => {
      closeCropper();
      handlers.onCropCancel?.();
    });
  }

  if (captureCropApply instanceof HTMLElement) {
    captureCropApply.addEventListener("click", () => {
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

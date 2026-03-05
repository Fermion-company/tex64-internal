import type { BlockInputRuntime } from "./runtime.js";
import type { BlockSettingsPage } from "./types.js";

export type BlockSettingsModalOps = {
  setBlockSettingsOpen: (open: boolean) => void;
  setBlockSettingsPage: (page: BlockSettingsPage) => void;
};

export const createBlockSettingsModalOps = (runtime: BlockInputRuntime): BlockSettingsModalOps => {
  const {
    blockSettingsButton,
    blockCaptureButton,
    blockSettingsModal,
    blockSettingsClose,
    blockSettingsBackButtons,
    blockSettingsPages,
    blockSettingsMenuItems,
  } = runtime.context.dom;

  const setBlockSettingsPage = (page: BlockSettingsPage) => {
    runtime.state.activeBlockSettingsPage = page;
    if (Array.isArray(blockSettingsPages)) {
      blockSettingsPages.forEach((view) => {
        const isActive = view.dataset.blockSettingsPage === page;
        view.classList.toggle("is-active", isActive);
      });
    }
  };

  const setBlockSettingsOpen = (open: boolean) => {
    runtime.state.blockSettingsOpen = open;
    if (blockSettingsModal instanceof HTMLElement) {
      blockSettingsModal.classList.toggle("is-open", open);
      blockSettingsModal.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (blockSettingsButton instanceof HTMLElement) {
      blockSettingsButton.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (open) {
      setBlockSettingsPage("menu");
    }
  };

  if (blockSettingsButton instanceof HTMLButtonElement) {
    blockSettingsButton.addEventListener("click", () => {
      setBlockSettingsOpen(!runtime.state.blockSettingsOpen);
    });
  }

  if (blockCaptureButton instanceof HTMLButtonElement) {
    blockCaptureButton.addEventListener("click", () => {
      runtime.deps.onMathCaptureRequest?.();
    });
  }

  if (blockSettingsClose instanceof HTMLButtonElement) {
    blockSettingsClose.addEventListener("click", () => {
      setBlockSettingsOpen(false);
    });
  }

  if (blockSettingsModal instanceof HTMLElement) {
    blockSettingsModal.addEventListener("click", (event) => {
      if (event.target === blockSettingsModal) {
        setBlockSettingsOpen(false);
      }
    });
  }

  if (Array.isArray(blockSettingsMenuItems)) {
    blockSettingsMenuItems.forEach((item) => {
      item.addEventListener("click", () => {
        const target = item.dataset.blockSettingsTarget;
        if (target === "insert-format") {
          setBlockSettingsPage("insert-format");
        } else if (target === "suggestions") {
          setBlockSettingsPage("suggestions");
        }
      });
    });
  }

  if (Array.isArray(blockSettingsBackButtons)) {
    blockSettingsBackButtons.forEach((button) => {
      button.addEventListener("click", () => {
        setBlockSettingsPage("menu");
      });
    });
  }

  return { setBlockSettingsOpen, setBlockSettingsPage };
};


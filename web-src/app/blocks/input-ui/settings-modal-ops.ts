import type { BlockInputRuntime } from "./runtime.js";

export type BlockSettingsModalOps = {
  setBlockSettingsOpen: (open: boolean) => void;
};

export const createBlockSettingsModalOps = (runtime: BlockInputRuntime): BlockSettingsModalOps => {
  const {
    blockSettingsButton,
    blockCaptureButton,
    blockSettingsModal,
    blockSettingsClose,
  } = runtime.context.dom;

  const setBlockSettingsOpen = (open: boolean) => {
    runtime.state.blockSettingsOpen = open;
    if (blockSettingsModal instanceof HTMLElement) {
      blockSettingsModal.classList.toggle("is-open", open);
      blockSettingsModal.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (blockSettingsButton instanceof HTMLElement) {
      blockSettingsButton.setAttribute("aria-expanded", open ? "true" : "false");
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

  return { setBlockSettingsOpen };
};

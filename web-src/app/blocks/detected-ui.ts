import type { DomRefs } from "../dom.js";
import type { BlockMode } from "../types.js";

export const initDetectedBlockUi = (dom: DomRefs) => {
  const { blocksPanelBody, blockModeToggle } = dom;

  const setAutoDetectedUi = (enabled: boolean, _lineNumber?: number) => {
    if (blocksPanelBody instanceof HTMLElement) {
      blocksPanelBody.classList.toggle("is-auto-detected", enabled);
    }
  };

  const setBlockMode = (mode: BlockMode) => {
    const isEdit = mode === "edit";
    if (blocksPanelBody instanceof HTMLElement) {
      blocksPanelBody.classList.toggle("is-edit-mode", isEdit);
    }
    if (blockModeToggle instanceof HTMLButtonElement) {
      blockModeToggle.classList.toggle("is-edit", isEdit);
      blockModeToggle.dataset.blockMode = mode;
      blockModeToggle.setAttribute("aria-pressed", isEdit ? "true" : "false");
      blockModeToggle.setAttribute("aria-label", isEdit ? "編集モード" : "挿入モード");
    }
  };

  const onBlockModeToggle = (handler: (mode: BlockMode) => void) => {
    if (blockModeToggle instanceof HTMLButtonElement) {
      blockModeToggle.addEventListener("click", () => {
        const current =
          blockModeToggle.dataset.blockMode === "edit" ? "edit" : "insert";
        const next = current === "edit" ? "insert" : "edit";
        handler(next);
      });
    }
  };

  return {
    setAutoDetectedUi,
    setBlockMode,
    onBlockModeToggle,
  };
};

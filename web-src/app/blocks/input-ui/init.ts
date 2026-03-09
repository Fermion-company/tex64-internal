import type { AppContext } from "../../context.js";
import type { BlockType } from "../../types.js";
import { initMathWysiwyg } from "../../../math/wysiwyg/math-wysiwyg.js";
import type { BlockInputApi, BlockInputDeps } from "./types.js";
import { createBlockInputRuntime } from "./runtime.js";
import { createMathValueOps } from "./math-normalize.js";
import { createBlockMathInputElementOps } from "./input-element-ops.js";
import { createBlockInsertSettingsOps } from "./insert-settings-ops.js";
import { createBlockWysiwygSettingsOps, loadInitialMathWysiwygSettings } from "./wysiwyg-settings-ops.js";
import { createBlockInsertKeyOps } from "./insert-key.js";
import { createBlockDraftOps } from "./draft-ops.js";
import { createBlockSettingsModalOps } from "./settings-modal-ops.js";
import { createBlockMathfieldEventsOps } from "./mathfield-events.js";

export const initBlockInputUi = (context: AppContext, deps: BlockInputDeps): BlockInputApi => {
  const runtime = createBlockInputRuntime(context, deps, {
    mathWysiwygSettings: loadInitialMathWysiwygSettings(),
  });

  const mathValueOps = createMathValueOps(runtime);
  const inputOps = createBlockMathInputElementOps(runtime, mathValueOps);

  const insertKeyOps = createBlockInsertKeyOps(runtime);

  const mathfieldEventsOps = createBlockMathfieldEventsOps(runtime, {
    insertMathKey: insertKeyOps.insertMathKey,
  });

  const draftOps = createBlockDraftOps(runtime, {
    getMathInputValue: inputOps.getMathInputValue,
    normalizeMathValueForOutput: mathValueOps.normalizeMathValueForOutput,
  });

  const insertSettingsOps = createBlockInsertSettingsOps(runtime);
  const wysiwygSettingsOps = createBlockWysiwygSettingsOps(runtime);

  const settingsModalOps = createBlockSettingsModalOps(runtime);

  runtime.state.mathWysiwygApi = initMathWysiwyg({
    container: context.dom.blockMathInputContainer instanceof HTMLElement ? context.dom.blockMathInputContainer : null,
    insertKey: (key) => insertKeyOps.insertMathKey(key),
    autoSuggest: runtime.state.mathWysiwygSettings.autoSuggest,
    enabledPacks: runtime.state.mathWysiwygSettings.enabledPacks,
    getMruStorageKey: () => {
      const rootKey = deps.getWorkspaceRootKey?.();
      return rootKey ? `tex64.math-wysiwyg.mru.${rootKey}` : "tex64.math-wysiwyg.mru";
    },
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (runtime.state.blockSettingsOpen) {
      event.preventDefault();
      event.stopPropagation();
      settingsModalOps.setBlockSettingsOpen(false);
      return;
    }
    if (runtime.state.formatMenuOpen) {
      event.preventDefault();
      event.stopPropagation();
      insertSettingsOps.setFormatMenuOpen(false);
    }
  });

  insertSettingsOps.applyMathInsertSettings();
  wysiwygSettingsOps.applyMathWysiwygSettings();

  const setMathKeyboardVisibilityHandler = (handler: () => void) => {
    runtime.state.mathKeyboardVisibilityHandler = handler;
  };

  const setActiveBlockType = (type: BlockType) => {
    runtime.state.mathKeyboardVisibilityHandler();
    runtime.state.activeBlockType = type;
  };

  return {
    getActiveBlockType: () => runtime.state.activeBlockType,
    setActiveBlockType,
    setMathKeyboardVisibilityHandler,
    getMathInputValue: inputOps.getMathInputValue,
    setMathInputValue: inputOps.setMathInputValue,
    getBlockDraft: draftOps.getBlockDraft,
    insertMathKey: insertKeyOps.insertMathKey,
    setMathInputElement: inputOps.setMathInputElement,
    setMathInputFallback: inputOps.setMathInputFallback,
    getMathInputFallback: inputOps.getMathInputFallback,
    isMathInputFocused: inputOps.isMathInputFocused,
    attachMathInputListener: inputOps.attachMathInputListener,
    attachMathFieldEvents: mathfieldEventsOps.attachMathFieldEvents,
  };
};


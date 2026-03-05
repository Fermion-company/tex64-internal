import { initMathWysiwyg } from "../../../math/wysiwyg/math-wysiwyg.js";
import { createBlockInputRuntime } from "./runtime.js";
import { createMathValueOps } from "./math-normalize.js";
import { createBlockMathInputElementOps } from "./input-element-ops.js";
import { createBlockInsertSettingsOps } from "./insert-settings-ops.js";
import { createBlockWysiwygSettingsOps, loadInitialMathWysiwygSettings } from "./wysiwyg-settings-ops.js";
import { createBlockInsertKeyOps } from "./insert-key.js";
import { createBlockDraftOps } from "./draft-ops.js";
import { createBlockSettingsModalOps } from "./settings-modal-ops.js";
import { createBlockMathfieldEventsOps } from "./mathfield-events.js";
export const initBlockInputUi = (context, deps) => {
    const runtime = createBlockInputRuntime(context, deps, {
        mathWysiwygSettings: loadInitialMathWysiwygSettings(),
    });
    const mathValueOps = createMathValueOps(runtime);
    const inputOps = createBlockMathInputElementOps(runtime, mathValueOps);
    const updateMathPreview = () => {
        // preview disabled
    };
    const insertKeyOps = createBlockInsertKeyOps(runtime, { updateMathPreview });
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
            var _a;
            const rootKey = (_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps);
            return rootKey ? `tex64.math-wysiwyg.mru.${rootKey}` : "tex64.math-wysiwyg.mru";
        },
    });
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
            return;
        }
        if (runtime.state.blockSettingsOpen) {
            settingsModalOps.setBlockSettingsOpen(false);
            return;
        }
        if (runtime.state.formatMenuOpen) {
            insertSettingsOps.setFormatMenuOpen(false);
        }
    });
    insertSettingsOps.applyMathInsertSettings();
    wysiwygSettingsOps.applyMathWysiwygSettings();
    const setMathKeyboardVisibilityHandler = (handler) => {
        runtime.state.mathKeyboardVisibilityHandler = handler;
    };
    const setActiveBlockType = (type) => {
        runtime.state.mathKeyboardVisibilityHandler();
        runtime.state.activeBlockType = type;
        updateMathPreview();
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
        updateMathPreview,
    };
};

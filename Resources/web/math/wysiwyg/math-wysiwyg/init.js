import { createMathWysiwygApplyOps } from "./apply.js";
import { createMathWysiwygCandidateOps } from "./candidates.js";
import { createMathWysiwygEventsOps } from "./events.js";
import { createMathWysiwygMruOps } from "./mru.js";
import { createMathWysiwygPanelOps } from "./panel.js";
import { createMathWysiwygRefreshOps } from "./refresh.js";
import { createMathWysiwygRuntime } from "./runtime.js";
export const initMathWysiwyg = (deps) => {
    const runtime = createMathWysiwygRuntime(deps);
    const mruOps = createMathWysiwygMruOps(runtime.mruState);
    const panelOps = createMathWysiwygPanelOps(runtime.panelState);
    const candidateOps = createMathWysiwygCandidateOps(runtime, { mruOps, panelOps });
    // Keep MRU in sync early so explicit suggestions can offer recent items.
    mruOps.loadMru(runtime.mruState.mruStorageKey);
    let refreshFn = () => { };
    const finalizeMutationSession = (sessionId, options) => {
        runtime.enqueueMicrotaskSafe(() => {
            var _a;
            if (sessionId !== runtime.mutationSessionId) {
                return;
            }
            runtime.suppressNextUpdate = false;
            if ((options === null || options === void 0 ? void 0 : options.clearCandidates) !== false) {
                runtime.resetCandidateState();
            }
            if (options === null || options === void 0 ? void 0 : options.reopenExplicitSession) {
                runtime.panelState.explicitSession = true;
                refreshFn({ explicit: true });
            }
            else if (runtime.autoSuggest) {
                refreshFn();
            }
            if (typeof ((_a = options === null || options === void 0 ? void 0 : options.focusTarget) === null || _a === void 0 ? void 0 : _a.focus) === "function") {
                options.focusTarget.focus();
            }
        });
    };
    const refreshOps = createMathWysiwygRefreshOps(runtime, {
        candidateOps,
        panelOps,
        finalizeMutationSession,
    });
    refreshFn = refreshOps.refresh;
    const applyOps = createMathWysiwygApplyOps(runtime, {
        mruOps,
        panelOps,
        finalizeMutationSession,
    });
    panelOps.setApplyCandidateHandler(applyOps.applyCandidate);
    const eventsOps = createMathWysiwygEventsOps(runtime, {
        applyOps,
        candidateOps,
        panelOps,
        refreshOps,
    });
    return {
        attach: eventsOps.attach,
        detach: eventsOps.detach,
        handleKeydown: eventsOps.handleKeydown,
        setComposing: eventsOps.setComposing,
        close: refreshOps.close,
        openExplicitSuggestions: refreshOps.openExplicitSuggestions,
        updateConfig: refreshOps.updateConfig,
        getWordCandidates: candidateOps.getWordCandidates,
        openCustomCandidates: candidateOps.openCustomCandidates,
    };
};

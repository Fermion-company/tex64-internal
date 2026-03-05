import { createMathWysiwygApplyOps } from "./apply.js";
import { createMathWysiwygCandidateOps } from "./candidates.js";
import { createMathWysiwygEventsOps } from "./events.js";
import { createMathWysiwygMruOps } from "./mru.js";
import { createMathWysiwygPanelOps } from "./panel.js";
import { createMathWysiwygRefreshOps } from "./refresh.js";
import { createMathWysiwygRuntime } from "./runtime.js";
import type { MathWysiwygApi, MathWysiwygDeps, SuggestOptions } from "./types.js";

export const initMathWysiwyg = (deps: MathWysiwygDeps): MathWysiwygApi => {
  const runtime = createMathWysiwygRuntime(deps);
  const mruOps = createMathWysiwygMruOps(runtime.mruState);
  const panelOps = createMathWysiwygPanelOps(runtime.panelState);
  const candidateOps = createMathWysiwygCandidateOps(runtime, { mruOps, panelOps });

  // Keep MRU in sync early so explicit suggestions can offer recent items.
  mruOps.loadMru(runtime.mruState.mruStorageKey);

  let refreshFn: (options?: SuggestOptions) => void = () => {};
  const finalizeMutationSession = (
    sessionId: number,
    options?: { focusTarget?: any; reopenExplicitSession?: boolean; clearCandidates?: boolean }
  ) => {
    runtime.enqueueMicrotaskSafe(() => {
      if (sessionId !== runtime.mutationSessionId) {
        return;
      }
      runtime.suppressNextUpdate = false;
      if (options?.clearCandidates !== false) {
        runtime.resetCandidateState();
      }
      if (options?.reopenExplicitSession) {
        runtime.panelState.explicitSession = true;
        refreshFn({ explicit: true });
      } else if (runtime.autoSuggest) {
        refreshFn();
      }
      if (typeof options?.focusTarget?.focus === "function") {
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


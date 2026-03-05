import { DEFAULT_MRU_STORAGE_KEY } from "./constants.js";
import type { Candidate } from "../math-wysiwyg-triggers.js";
import type { MathWysiwygMruState } from "./mru.js";
import type { MathWysiwygPanelState } from "./panel.js";
import type { MathWysiwygDeps, TokenMatch } from "./types.js";

export type MathWysiwygRuntime = {
  deps: MathWysiwygDeps;

  autoSuggest: boolean;
  enabledPacks: Set<string>;

  mathfield: HTMLElement | null;
  eventController: AbortController | null;
  composing: boolean;

  forcedTextMode: boolean;
  holdTextModeUntil: number;
  suppressNextUpdate: boolean;
  lastInputTime: number;

  editAnchorOffset: number | null;
  currentRange: { start: number; end: number } | null;
  currentTokenMatch: TokenMatch | null;

  mutationSessionId: number;

  panelState: MathWysiwygPanelState;
  mruState: MathWysiwygMruState;

  enqueueMicrotaskSafe: (task: () => void) => void;

  // Helpers exposed for convenience. (Avoids recreating function objects in hot paths.)
  resetCandidateState: () => void;
  beginMutationSession: () => number;
};

export const createMathWysiwygRuntime = (deps: MathWysiwygDeps): MathWysiwygRuntime => {
  const enqueueMicrotaskSafe = (task: () => void) => {
    if (typeof queueMicrotask === "function") {
      queueMicrotask(task);
      return;
    }
    Promise.resolve().then(task);
  };

  const resolveMruStorageKey = () =>
    deps.getMruStorageKey?.() ?? deps.mruStorageKey ?? DEFAULT_MRU_STORAGE_KEY;

  const panel = document.createElement("div");
  panel.className = "math-wysiwyg-panel";
  panel.setAttribute("role", "listbox");
  panel.setAttribute("aria-hidden", "true");

  const panelState: MathWysiwygPanelState = {
    deps,
    panel,
    panelHost: null,
    active: false,
    explicitSession: false,
    explicitSessionPrefixLatex: null,
    selectedIndex: 0,
    currentCandidates: [] as Candidate[],
  };

  const runtime: MathWysiwygRuntime = {
    deps,
    autoSuggest: deps.autoSuggest ?? true,
    enabledPacks: new Set(deps.enabledPacks ?? []),
    mathfield: null,
    eventController: null,
    composing: false,
    forcedTextMode: false,
    holdTextModeUntil: 0,
    suppressNextUpdate: false,
    lastInputTime: 0,
    editAnchorOffset: null,
    currentRange: null,
    currentTokenMatch: null,
    mutationSessionId: 0,
    panelState,
    mruState: {
      mruStorageKey: resolveMruStorageKey(),
      mru: new Map(),
      mruSaveTimer: null,
      mruSaveKey: null,
      resolveMruStorageKey,
    },
    enqueueMicrotaskSafe,
    resetCandidateState: () => {
      runtime.panelState.currentCandidates = [];
      runtime.currentRange = null;
      runtime.currentTokenMatch = null;
      runtime.panelState.selectedIndex = 0;
    },
    beginMutationSession: () => {
      runtime.mutationSessionId += 1;
      return runtime.mutationSessionId;
    },
  };

  return runtime;
};

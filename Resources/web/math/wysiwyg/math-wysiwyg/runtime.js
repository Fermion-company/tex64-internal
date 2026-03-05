import { DEFAULT_MRU_STORAGE_KEY } from "./constants.js";
export const createMathWysiwygRuntime = (deps) => {
    var _a, _b;
    const enqueueMicrotaskSafe = (task) => {
        if (typeof queueMicrotask === "function") {
            queueMicrotask(task);
            return;
        }
        Promise.resolve().then(task);
    };
    const resolveMruStorageKey = () => { var _a, _b, _c; return (_c = (_b = (_a = deps.getMruStorageKey) === null || _a === void 0 ? void 0 : _a.call(deps)) !== null && _b !== void 0 ? _b : deps.mruStorageKey) !== null && _c !== void 0 ? _c : DEFAULT_MRU_STORAGE_KEY; };
    const panel = document.createElement("div");
    panel.className = "math-wysiwyg-panel";
    panel.setAttribute("role", "listbox");
    panel.setAttribute("aria-hidden", "true");
    const panelState = {
        deps,
        panel,
        panelHost: null,
        active: false,
        explicitSession: false,
        explicitSessionPrefixLatex: null,
        selectedIndex: 0,
        currentCandidates: [],
    };
    const runtime = {
        deps,
        autoSuggest: (_a = deps.autoSuggest) !== null && _a !== void 0 ? _a : true,
        enabledPacks: new Set((_b = deps.enabledPacks) !== null && _b !== void 0 ? _b : []),
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

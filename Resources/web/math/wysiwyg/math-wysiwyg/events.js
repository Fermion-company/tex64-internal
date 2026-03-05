import { getMathFieldSelectionRange } from "../../../app/blocks/math-input-utils.js";
import { resolveScopeRange } from "../math-wysiwyg-selection.js";
import { getMathfieldInternalModel, getMathfieldModeAtOffset, isMathfieldSelectionPlaceholder, setMathfieldMode, } from "../../mathfield-private-adapter.js";
import { nowMs, resolveCursorOffset, clearEditAnchor } from "./mathfield.js";
const getModeAtOffset = (mathfieldApi, offset) => {
    var _a;
    if (offset < 0) {
        return null;
    }
    if (typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.getElementInfo) === "function") {
        try {
            const info = mathfieldApi.getElementInfo(offset);
            const mode = (_a = info === null || info === void 0 ? void 0 : info.mode) !== null && _a !== void 0 ? _a : null;
            if (mode === "math" || mode === "text" || mode === "latex") {
                return mode;
            }
        }
        catch {
            // ignore
        }
    }
    return getMathfieldModeAtOffset(mathfieldApi, offset);
};
export const createMathWysiwygEventsOps = (runtime, deps) => {
    const { applyOps, candidateOps, panelOps, refreshOps } = deps;
    const handleKeydown = (event) => {
        if (event.key === "Tab") {
            if (event.metaKey || event.ctrlKey || event.altKey) {
                return false;
            }
            event.preventDefault();
            if (runtime.panelState.active && runtime.panelState.currentCandidates.length > 0) {
                if (event.shiftKey) {
                    runtime.panelState.selectedIndex =
                        (runtime.panelState.selectedIndex - 1 + runtime.panelState.currentCandidates.length) %
                            runtime.panelState.currentCandidates.length;
                }
                else {
                    runtime.panelState.selectedIndex =
                        (runtime.panelState.selectedIndex + 1) % runtime.panelState.currentCandidates.length;
                }
                panelOps.renderPanel();
            }
            return true;
        }
        if (!runtime.panelState.active) {
            return false;
        }
        if (event.key === "ArrowDown") {
            event.preventDefault();
            runtime.panelState.selectedIndex =
                (runtime.panelState.selectedIndex + 1) % runtime.panelState.currentCandidates.length;
            panelOps.renderPanel();
            return true;
        }
        if (event.key === "ArrowUp") {
            event.preventDefault();
            runtime.panelState.selectedIndex =
                (runtime.panelState.selectedIndex - 1 + runtime.panelState.currentCandidates.length) %
                    runtime.panelState.currentCandidates.length;
            panelOps.renderPanel();
            return true;
        }
        if (event.key === "Enter") {
            if (event.metaKey || event.ctrlKey || event.altKey) {
                return false;
            }
            event.preventDefault();
            applyOps.applyCandidate(runtime.panelState.selectedIndex);
            return true;
        }
        if (event.key === " " || event.key === "Spacebar") {
            if (event.metaKey || event.ctrlKey || event.altKey) {
                return false;
            }
            event.preventDefault();
            refreshOps.refresh(runtime.panelState.explicitSession ? { explicit: true } : undefined);
            return true;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            candidateOps.updateCandidates(null);
            return true;
        }
        if (!runtime.autoSuggest && !runtime.panelState.explicitSession) {
            if (event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt" && event.key !== "Meta") {
                candidateOps.updateCandidates(null);
            }
        }
        return false;
    };
    const attach = (target) => {
        if (runtime.mathfield === target) {
            return;
        }
        detach();
        runtime.mathfield = target;
        runtime.eventController = new AbortController();
        const { signal } = runtime.eventController;
        const mathfieldApi = runtime.mathfield;
        runtime.mathfield.addEventListener("input", () => {
            runtime.lastInputTime =
                typeof performance !== "undefined" && typeof performance.now === "function"
                    ? performance.now()
                    : Date.now();
            if (runtime.autoSuggest || runtime.panelState.explicitSession) {
                refreshOps.refresh(runtime.panelState.explicitSession ? { explicit: true } : undefined);
            }
        }, { signal });
        const handleEditAnchorKeydown = (event) => {
            if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }
            const selection = getMathFieldSelectionRange(mathfieldApi);
            const selectionStart = Math.min(selection.start, selection.end);
            const selectionEnd = Math.max(selection.start, selection.end);
            const cursorOffset = resolveCursorOffset(mathfieldApi, { start: selectionStart, end: selectionEnd });
            const key = event.key;
            if (key === "Escape" ||
                key === "Enter" ||
                key === "Tab" ||
                key === "Home" ||
                key === "End" ||
                key === "PageUp" ||
                key === "PageDown" ||
                key.startsWith("Arrow")) {
                clearEditAnchor(runtime);
                return;
            }
            if (key === "Backspace") {
                if (selectionStart !== selectionEnd) {
                    runtime.editAnchorOffset = selectionStart;
                    return;
                }
                if (runtime.editAnchorOffset !== null && cursorOffset <= runtime.editAnchorOffset) {
                    clearEditAnchor(runtime);
                }
                return;
            }
            if (key === "Delete") {
                if (selectionStart !== selectionEnd) {
                    runtime.editAnchorOffset = selectionStart;
                }
                return;
            }
            const isSpace = key === " " || key === "Spacebar";
            const isPrintable = (typeof key === "string" && key.length === 1) || isSpace;
            if (!isPrintable) {
                return;
            }
            if (isSpace) {
                clearEditAnchor(runtime);
                return;
            }
            if (selectionStart !== selectionEnd) {
                runtime.editAnchorOffset = selectionStart;
                return;
            }
            if (runtime.editAnchorOffset === null || cursorOffset < runtime.editAnchorOffset || nowMs() - runtime.lastInputTime > 600) {
                runtime.editAnchorOffset = cursorOffset;
            }
        };
        const handleModeKeydown = (event) => {
            var _a;
            if (event.isComposing) {
                return;
            }
            if (event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }
            if (typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.mode) === "string" && mathfieldApi.mode === "latex") {
                return;
            }
            const key = event.key;
            const isPrintable = (typeof key === "string" && key.length === 1) || key === " " || key === "Spacebar";
            if (!isPrintable) {
                return;
            }
            const selection = getMathFieldSelectionRange(mathfieldApi);
            const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
            const cursorMode = (_a = getModeAtOffset(mathfieldApi, cursorOffset)) !== null && _a !== void 0 ? _a : getModeAtOffset(mathfieldApi, cursorOffset - 1);
            const internalModel = getMathfieldInternalModel(mathfieldApi);
            if (!internalModel) {
                return;
            }
            if (cursorMode === "text") {
                try {
                    setMathfieldMode(mathfieldApi, "text");
                    runtime.forcedTextMode = true;
                    if (isMathfieldSelectionPlaceholder(mathfieldApi)) {
                        runtime.holdTextModeUntil = nowMs() + 200;
                    }
                }
                catch {
                    // ignore
                }
            }
            else if (runtime.forcedTextMode && cursorMode === "math") {
                if (nowMs() < runtime.holdTextModeUntil) {
                    try {
                        setMathfieldMode(mathfieldApi, "text");
                    }
                    catch {
                        // ignore
                    }
                    return;
                }
                try {
                    setMathfieldMode(mathfieldApi, "math");
                    runtime.forcedTextMode = false;
                }
                catch {
                    // ignore
                }
            }
        };
        runtime.mathfield.addEventListener("keydown", handleEditAnchorKeydown, { signal, capture: true });
        runtime.mathfield.addEventListener("keydown", handleModeKeydown, { signal, capture: true });
        const shadowRoot = runtime.mathfield.shadowRoot;
        if (shadowRoot) {
            shadowRoot.addEventListener("keydown", handleEditAnchorKeydown, { signal, capture: true });
            shadowRoot.addEventListener("keydown", handleModeKeydown, { signal, capture: true });
        }
        runtime.mathfield.addEventListener("keyup", (event) => {
            if (runtime.panelState.active && event.key.startsWith("Arrow")) {
                return;
            }
            if (event.key.startsWith("Arrow") || event.key === "Backspace" || event.key === "Delete") {
                if (runtime.autoSuggest || runtime.panelState.explicitSession) {
                    refreshOps.refresh(runtime.panelState.explicitSession ? { explicit: true } : undefined);
                }
            }
        }, { signal });
        runtime.mathfield.addEventListener("focus", () => {
            if (runtime.autoSuggest || runtime.panelState.explicitSession) {
                refreshOps.refresh(runtime.panelState.explicitSession ? { explicit: true } : undefined);
            }
        }, { signal });
        runtime.mathfield.addEventListener("selection-change", () => {
            if (runtime.editAnchorOffset !== null && nowMs() - runtime.lastInputTime > 120) {
                const selection = getMathFieldSelectionRange(mathfieldApi);
                const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
                const scopeRange = resolveScopeRange(mathfieldApi, cursorOffset);
                if (selection.start !== selection.end ||
                    cursorOffset < runtime.editAnchorOffset ||
                    runtime.editAnchorOffset < scopeRange.start ||
                    runtime.editAnchorOffset > scopeRange.end) {
                    clearEditAnchor(runtime);
                }
            }
            if (runtime.autoSuggest || runtime.panelState.explicitSession) {
                refreshOps.refresh(runtime.panelState.explicitSession ? { explicit: true } : undefined);
            }
        }, { signal });
        runtime.mathfield.addEventListener("blur", () => {
            clearEditAnchor(runtime);
            candidateOps.updateCandidates(null);
        }, { signal });
        if ((runtime.autoSuggest || runtime.panelState.explicitSession) && typeof mathfieldApi.getValue === "function") {
            refreshOps.refresh(runtime.panelState.explicitSession ? { explicit: true } : undefined);
        }
    };
    const detach = () => {
        var _a;
        (_a = runtime.eventController) === null || _a === void 0 ? void 0 : _a.abort();
        runtime.eventController = null;
        runtime.beginMutationSession();
        runtime.suppressNextUpdate = false;
        runtime.panelState.explicitSessionPrefixLatex = null;
        clearEditAnchor(runtime);
        if (!runtime.mathfield) {
            return;
        }
        runtime.mathfield = null;
        candidateOps.updateCandidates(null);
    };
    const setComposing = (value) => {
        runtime.composing = value;
        if (runtime.composing) {
            runtime.beginMutationSession();
            runtime.suppressNextUpdate = false;
            runtime.panelState.explicitSessionPrefixLatex = null;
            clearEditAnchor(runtime);
            candidateOps.updateCandidates(null);
        }
        else if (runtime.autoSuggest || runtime.panelState.explicitSession) {
            refreshOps.refresh(runtime.panelState.explicitSession ? { explicit: true } : undefined);
        }
    };
    return {
        attach,
        detach,
        handleKeydown,
        setComposing,
    };
};

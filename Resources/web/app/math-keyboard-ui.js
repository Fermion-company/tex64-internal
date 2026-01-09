import { mathKeyboardFixedKeys, mathKeyboardSets } from "./math-keyboard.js";
export const initMathKeyboard = (context, deps) => {
    const { mathKeyboardDock, mathKeyboardGrid, mathKeyboardFixedGrid, mathKeyboardShiftButton, mathKeyboardTabs, } = context.dom;
    let activeTab = "analysis";
    let shiftHeld = false;
    let shiftLocked = false;
    let mathLiveReady = false;
    let mathLiveCheckScheduled = false;
    let mathKeyboardNeedsRerender = false;
    const normalizeMathKeyboardTab = (tab) => {
        if (tab === "analysis" ||
            tab === "algebra" ||
            tab === "sets" ||
            tab === "logic" ||
            tab === "arrows" ||
            tab === "greek") {
            return tab;
        }
        return "analysis";
    };
    const isMathKeyboardShiftActive = () => shiftHeld || shiftLocked;
    const markMathLiveReady = () => {
        if (mathLiveReady) {
            return;
        }
        mathLiveReady = true;
        mathLiveCheckScheduled = false;
        if (mathKeyboardNeedsRerender) {
            renderMathKeyboard(activeTab);
            renderMathKeyboardFixed();
            mathKeyboardNeedsRerender = false;
        }
    };
    const ensureMathLiveReady = () => {
        if (mathLiveReady || mathLiveCheckScheduled) {
            return;
        }
        mathLiveCheckScheduled = true;
        const check = () => {
            if (mathLiveReady) {
                return;
            }
            const MathLiveGlobal = window.MathLive;
            if (MathLiveGlobal === null || MathLiveGlobal === void 0 ? void 0 : MathLiveGlobal.convertLatexToMarkup) {
                markMathLiveReady();
                return;
            }
            setTimeout(check, 120);
        };
        check();
        window.addEventListener("mathlive-ready", markMathLiveReady, { once: true });
    };
    const resolveMathKey = (key, shiftActive) => {
        var _a, _b, _c, _d, _e, _f, _g;
        if (!shiftActive) {
            return key;
        }
        const hasShift = key.shiftLabel ||
            key.shiftLatex ||
            key.shiftFallback ||
            key.shiftDisplayLatex ||
            key.shiftScriptKind ||
            key.shiftScriptValue !== undefined ||
            key.shiftScriptBase ||
            key.shiftScriptSubValue !== undefined ||
            key.shiftScriptSupValue !== undefined ||
            key.shiftTemplateKind ||
            key.shiftTemplateTarget !== undefined ||
            key.shiftTemplateSeparator !== undefined ||
            key.shiftTemplateScope !== undefined;
        if (!hasShift) {
            return key;
        }
        const resolvedScriptKind = (_a = key.shiftScriptKind) !== null && _a !== void 0 ? _a : key.scriptKind;
        const resolvedScriptValue = key.shiftScriptValue !== undefined ? key.shiftScriptValue : key.scriptValue;
        const resolvedScriptBase = (_b = key.shiftScriptBase) !== null && _b !== void 0 ? _b : key.scriptBase;
        const resolvedScriptSubValue = key.shiftScriptSubValue !== undefined ? key.shiftScriptSubValue : key.scriptSubValue;
        const resolvedScriptSupValue = key.shiftScriptSupValue !== undefined ? key.shiftScriptSupValue : key.scriptSupValue;
        const resolvedTemplateKind = (_c = key.shiftTemplateKind) !== null && _c !== void 0 ? _c : key.templateKind;
        const resolvedTemplateTarget = key.shiftTemplateTarget !== undefined ? key.shiftTemplateTarget : key.templateTarget;
        const resolvedTemplateSeparator = key.shiftTemplateSeparator !== undefined
            ? key.shiftTemplateSeparator
            : key.templateSeparator;
        const resolvedTemplateScope = key.shiftTemplateScope !== undefined ? key.shiftTemplateScope : key.templateScope;
        return {
            label: (_d = key.shiftLabel) !== null && _d !== void 0 ? _d : key.label,
            latex: (_e = key.shiftLatex) !== null && _e !== void 0 ? _e : key.latex,
            fallback: (_f = key.shiftFallback) !== null && _f !== void 0 ? _f : key.fallback,
            displayLatex: (_g = key.shiftDisplayLatex) !== null && _g !== void 0 ? _g : key.displayLatex,
            scriptKind: resolvedScriptKind,
            scriptValue: resolvedScriptValue !== null && resolvedScriptValue !== void 0 ? resolvedScriptValue : undefined,
            scriptBase: resolvedScriptBase,
            scriptSubValue: resolvedScriptSubValue !== null && resolvedScriptSubValue !== void 0 ? resolvedScriptSubValue : undefined,
            scriptSupValue: resolvedScriptSupValue !== null && resolvedScriptSupValue !== void 0 ? resolvedScriptSupValue : undefined,
            templateKind: resolvedTemplateKind,
            templateTarget: resolvedTemplateTarget !== null && resolvedTemplateTarget !== void 0 ? resolvedTemplateTarget : undefined,
            templateSeparator: resolvedTemplateSeparator !== null && resolvedTemplateSeparator !== void 0 ? resolvedTemplateSeparator : undefined,
            templateScope: resolvedTemplateScope !== null && resolvedTemplateScope !== void 0 ? resolvedTemplateScope : undefined,
        };
    };
    const buildMathKeyDisplayLatex = (key) => {
        var _a, _b;
        const source = (_b = (_a = key.displayLatex) !== null && _a !== void 0 ? _a : key.latex) !== null && _b !== void 0 ? _b : key.fallback;
        if (!source) {
            return null;
        }
        const placeholders = ["x", "y", "z", "a", "b", "c"];
        let index = 0;
        return source.replace(/#\?/g, () => {
            var _a;
            const value = (_a = placeholders[index]) !== null && _a !== void 0 ? _a : "x";
            index += 1;
            return value;
        });
    };
    const renderMathKeyLabel = (button, key) => {
        const MathLiveGlobal = window.MathLive;
        const displayLatex = buildMathKeyDisplayLatex(key);
        if (displayLatex && (MathLiveGlobal === null || MathLiveGlobal === void 0 ? void 0 : MathLiveGlobal.convertLatexToMarkup)) {
            try {
                const latexToRender = `\\displaystyle ${displayLatex}`;
                const wrapper = document.createElement("span");
                wrapper.className = "math-keyboard-math";
                wrapper.innerHTML = MathLiveGlobal.convertLatexToMarkup(latexToRender);
                button.textContent = "";
                button.appendChild(wrapper);
                button.classList.add("has-math");
                button.setAttribute("aria-label", key.label);
                return;
            }
            catch (error) {
                console.warn("MathLive render failed:", error);
            }
        }
        if (displayLatex) {
            mathKeyboardNeedsRerender = true;
            ensureMathLiveReady();
        }
        button.classList.remove("has-math");
        button.textContent = key.label;
        button.removeAttribute("aria-label");
    };
    const renderMathKeyboardKeys = (target, keys) => {
        if (!(target instanceof HTMLElement)) {
            return;
        }
        const shiftActive = isMathKeyboardShiftActive();
        target.innerHTML = "";
        keys.forEach((key) => {
            const resolved = resolveMathKey(key, shiftActive);
            const button = document.createElement("button");
            button.type = "button";
            button.className = "math-keyboard-key";
            renderMathKeyLabel(button, resolved);
            if (!button.classList.contains("has-math")) {
                const labelLength = Array.from(resolved.label).length;
                if (labelLength > 4) {
                    button.classList.add("is-compact");
                }
                if (labelLength > 7) {
                    button.classList.add("is-tiny");
                }
            }
            button.addEventListener("mousedown", (event) => {
                event.preventDefault();
            });
            button.addEventListener("click", () => {
                deps.onInsertKey(resolved);
            });
            target.appendChild(button);
        });
    };
    const renderMathKeyboardFixed = () => {
        renderMathKeyboardKeys(mathKeyboardFixedGrid, mathKeyboardFixedKeys);
    };
    const updateMathKeyboardShiftState = () => {
        const isActive = isMathKeyboardShiftActive();
        if (mathKeyboardShiftButton instanceof HTMLButtonElement) {
            mathKeyboardShiftButton.classList.toggle("is-active", isActive);
            mathKeyboardShiftButton.setAttribute("aria-pressed", isActive ? "true" : "false");
        }
        if (mathKeyboardDock instanceof HTMLElement && mathKeyboardDock.classList.contains("is-open")) {
            renderMathKeyboard(activeTab);
            renderMathKeyboardFixed();
        }
    };
    const updateMathKeyboardVisibility = () => {
        if (!(mathKeyboardDock instanceof HTMLElement)) {
            return;
        }
        const shouldShow = deps.getActiveTab() === "blocks" && deps.getActiveBlockType() === "math";
        mathKeyboardDock.classList.toggle("is-open", shouldShow);
        mathKeyboardDock.setAttribute("aria-hidden", shouldShow ? "false" : "true");
        if (!shouldShow) {
            return;
        }
        if (mathKeyboardGrid instanceof HTMLElement && mathKeyboardGrid.childElementCount === 0) {
            renderMathKeyboard(activeTab);
        }
        if (mathKeyboardFixedGrid instanceof HTMLElement &&
            mathKeyboardFixedGrid.childElementCount === 0) {
            renderMathKeyboardFixed();
        }
        updateMathKeyboardShiftState();
    };
    const renderMathKeyboard = (tab) => {
        var _a;
        const keys = (_a = mathKeyboardSets[tab]) !== null && _a !== void 0 ? _a : [];
        renderMathKeyboardKeys(mathKeyboardGrid, keys);
    };
    const setMathKeyboardTab = (tab) => {
        activeTab = tab;
        mathKeyboardTabs.forEach((button) => {
            const isActive = button.dataset.mathTab === tab;
            button.classList.toggle("is-active", isActive);
            button.setAttribute("aria-selected", isActive ? "true" : "false");
        });
        renderMathKeyboard(tab);
    };
    mathKeyboardTabs.forEach((button) => {
        button.addEventListener("click", () => {
            setMathKeyboardTab(normalizeMathKeyboardTab(button.dataset.mathTab));
        });
    });
    if (mathKeyboardShiftButton instanceof HTMLButtonElement) {
        mathKeyboardShiftButton.addEventListener("click", () => {
            shiftLocked = !shiftLocked;
            updateMathKeyboardShiftState();
        });
    }
    window.addEventListener("blur", () => {
        if (shiftHeld) {
            shiftHeld = false;
            updateMathKeyboardShiftState();
        }
    });
    window.addEventListener("keydown", (event) => {
        if (event.key === "Shift" && !shiftHeld) {
            shiftHeld = true;
            updateMathKeyboardShiftState();
        }
    }, true);
    window.addEventListener("keyup", (event) => {
        if (event.key === "Shift" && shiftHeld) {
            shiftHeld = false;
            updateMathKeyboardShiftState();
        }
    }, true);
    return {
        setTab: setMathKeyboardTab,
        updateVisibility: updateMathKeyboardVisibility,
        markMathLiveReady,
        ensureMathLiveReady,
    };
};

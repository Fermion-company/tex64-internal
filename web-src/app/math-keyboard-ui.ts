import { mathKeyboardFixedKeys, mathKeyboardSets } from "./math-keyboard.js";
import type { AppContext } from "./context.js";
import type { BlockType, MathKey, MathKeyboardTab } from "./types.js";
import type { TabKey } from "./config.js";

export type MathKeyboardApi = {
  setTab: (tab: MathKeyboardTab) => void;
  updateVisibility: () => void;
  markMathLiveReady: () => void;
  ensureMathLiveReady: () => void;
};

type MathKeyboardDeps = {
  getActiveTab: () => TabKey;
  getActiveBlockType: () => BlockType;
  onInsertKey: (key: MathKey) => void;
};

export const initMathKeyboard = (
  context: AppContext,
  deps: MathKeyboardDeps
): MathKeyboardApi => {
  const {
    mathKeyboardDock,
    mathKeyboardGrid,
    mathKeyboardFixedGrid,
    mathKeyboardShiftButton,
    mathKeyboardTabs,
  } = context.dom;

  let activeTab: MathKeyboardTab = "analysis";
  let shiftHeld = false;
  let shiftLocked = false;
  let mathLiveReady = false;
  let mathLiveCheckScheduled = false;
  let mathKeyboardNeedsRerender = false;

  const normalizeMathKeyboardTab = (tab?: string | null): MathKeyboardTab => {
    if (
      tab === "analysis" ||
      tab === "algebra" ||
      tab === "sets" ||
      tab === "logic" ||
      tab === "arrows" ||
      tab === "greek"
    ) {
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
      const MathLiveGlobal = (window as any).MathLive;
      if (MathLiveGlobal?.convertLatexToMarkup) {
        markMathLiveReady();
        return;
      }
      setTimeout(check, 120);
    };
    check();
    window.addEventListener("mathlive-ready", markMathLiveReady, { once: true });
  };

  const resolveMathKey = (key: MathKey, shiftActive: boolean): MathKey => {
    if (!shiftActive) {
      return key;
    }
    const hasShift =
      key.shiftLabel ||
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
    const resolvedScriptKind = key.shiftScriptKind ?? key.scriptKind;
    const resolvedScriptValue =
      key.shiftScriptValue !== undefined ? key.shiftScriptValue : key.scriptValue;
    const resolvedScriptBase = key.shiftScriptBase ?? key.scriptBase;
    const resolvedScriptSubValue =
      key.shiftScriptSubValue !== undefined ? key.shiftScriptSubValue : key.scriptSubValue;
    const resolvedScriptSupValue =
      key.shiftScriptSupValue !== undefined ? key.shiftScriptSupValue : key.scriptSupValue;
    const resolvedTemplateKind = key.shiftTemplateKind ?? key.templateKind;
    const resolvedTemplateTarget =
      key.shiftTemplateTarget !== undefined ? key.shiftTemplateTarget : key.templateTarget;
    const resolvedTemplateSeparator =
      key.shiftTemplateSeparator !== undefined
        ? key.shiftTemplateSeparator
        : key.templateSeparator;
    const resolvedTemplateScope =
      key.shiftTemplateScope !== undefined ? key.shiftTemplateScope : key.templateScope;
    return {
      label: key.shiftLabel ?? key.label,
      latex: key.shiftLatex ?? key.latex,
      fallback: key.shiftFallback ?? key.fallback,
      displayLatex: key.shiftDisplayLatex ?? key.displayLatex,
      scriptKind: resolvedScriptKind,
      scriptValue: resolvedScriptValue ?? undefined,
      scriptBase: resolvedScriptBase,
      scriptSubValue: resolvedScriptSubValue ?? undefined,
      scriptSupValue: resolvedScriptSupValue ?? undefined,
      templateKind: resolvedTemplateKind,
      templateTarget: resolvedTemplateTarget ?? undefined,
      templateSeparator: resolvedTemplateSeparator ?? undefined,
      templateScope: resolvedTemplateScope ?? undefined,
    };
  };

  const buildMathKeyDisplayLatex = (key: MathKey) => {
    const source = key.displayLatex ?? key.latex ?? key.fallback;
    if (!source) {
      return null;
    }
    const placeholders = ["x", "y", "z", "a", "b", "c"];
    let index = 0;
    return source.replace(/#\?/g, () => {
      const value = placeholders[index] ?? "x";
      index += 1;
      return value;
    });
  };

  const renderMathKeyLabel = (button: HTMLButtonElement, key: MathKey) => {
    const MathLiveGlobal = (window as any).MathLive;
    const displayLatex = buildMathKeyDisplayLatex(key);
    if (displayLatex && MathLiveGlobal?.convertLatexToMarkup) {
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
      } catch (error) {
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

  const renderMathKeyboardKeys = (target: HTMLElement | null, keys: MathKey[]) => {
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
    const shouldShow =
      deps.getActiveTab() === "blocks" && deps.getActiveBlockType() === "math";
    mathKeyboardDock.classList.toggle("is-open", shouldShow);
    mathKeyboardDock.setAttribute("aria-hidden", shouldShow ? "false" : "true");
    if (!shouldShow) {
      return;
    }
    if (mathKeyboardGrid instanceof HTMLElement && mathKeyboardGrid.childElementCount === 0) {
      renderMathKeyboard(activeTab);
    }
    if (
      mathKeyboardFixedGrid instanceof HTMLElement &&
      mathKeyboardFixedGrid.childElementCount === 0
    ) {
      renderMathKeyboardFixed();
    }
    updateMathKeyboardShiftState();
  };

  const renderMathKeyboard = (tab: MathKeyboardTab) => {
    const keys = mathKeyboardSets[tab] ?? [];
    renderMathKeyboardKeys(mathKeyboardGrid, keys);
  };

  const setMathKeyboardTab = (tab: MathKeyboardTab) => {
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

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Shift" && !shiftHeld) {
        shiftHeld = true;
        updateMathKeyboardShiftState();
      }
    },
    true
  );

  window.addEventListener(
    "keyup",
    (event) => {
      if (event.key === "Shift" && shiftHeld) {
        shiftHeld = false;
        updateMathKeyboardShiftState();
      }
    },
    true
  );

  return {
    setTab: setMathKeyboardTab,
    updateVisibility: updateMathKeyboardVisibility,
    markMathLiveReady,
    ensureMathLiveReady,
  };
};

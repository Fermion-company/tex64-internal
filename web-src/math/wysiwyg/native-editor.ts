import { initMathWysiwyg } from "./math-wysiwyg.js";
import { createMathfieldMatrixOps } from "../../app/blocks/input-ui/mathfield-matrix-ops.js";
import { getMathFieldSelectionRange } from "../../app/blocks/math-input-utils.js";

/** The same IME and matrix operations used by Code, mounted in the AI paper. */
const attach = (field: HTMLElement & Record<string, any>, container: HTMLElement) => {
  field.smartMode = false;
  field.smartFence = false;
  field.defaultMode = "math";
  field.inlineShortcuts = {};
  field.onInlineShortcut = () => "";
  field.mathVirtualKeyboardPolicy = "manual";
  field.menuItems = [];
  field.setAttribute("lang", "en");
  const changed = () => field.dispatchEvent(new Event("input", { bubbles: true }));
  const insert = (latex: string) => {
    field.insert(latex, { selectionMode: "placeholder", format: "latex", focus: true, feedback: false });
    changed();
  };
  const api = initMathWysiwyg({
    container,
    floating: true,
    autoSuggest: true,
    insertKey: (key) => { if (key.latex) insert(key.latex); },
    mruStorageKey: "tex64.math-wysiwyg.mru",
  });

  const matrix = createMathfieldMatrixOps({
    mathfield: field,
    mathWysiwygApi: api,
    readMathFieldLatex: (target, ...args) => {
      try { const value = target.getValue?.(...args); return typeof value === "string" ? value : null; }
      catch { return null; }
    },
  });
  const controller = new AbortController();
  field.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.isComposing || event.defaultPrevented) return;
    if (api.handleKeydown(event)) {
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const selection = getMathFieldSelectionRange(field);
      const numerator = selection.start !== selection.end
        ? field.getValue(selection.start, selection.end, "latex") : "#?";
      event.preventDefault();
      event.stopImmediatePropagation();
      api.close();
      insert(`\\frac{${numerator}}{#?}`);
    } else if (event.key === "Enter" && !event.metaKey && !event.shiftKey && !event.altKey) {
      const handled = event.ctrlKey ? matrix.tryInsertMatrixColumn() : matrix.tryInsertMatrixRow();
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
        api.close();
        changed();
      }
    }
  }, { capture: true, signal: controller.signal });
  api.attach(field);
  field.addEventListener("compositionstart", () => api.setComposing(true), { signal: controller.signal });
  field.addEventListener("compositionend", () => api.setComposing(false), { signal: controller.signal });
  return () => { controller.abort(); api.detach(); };
};

(window as any).tex64PaperMath = { attach };

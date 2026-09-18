import { initMathWysiwyg } from "./math-wysiwyg.js";
import { attachMathfieldController } from "./field-controller.js";
/** Mount the application's shared IME and structural editing in the AI paper. */
const attach = (field, container) => {
    field.menuItems = [];
    field.setAttribute("lang", "en");
    const insertKey = (key, options) => {
        if (!key.latex)
            return;
        field.insert(key.latex, { selectionMode: "placeholder", format: "latex", focus: true, feedback: false, ...options });
        field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const api = initMathWysiwyg({ container, floating: true, autoSuggest: true, insertKey, mruStorageKey: "tex64.math-wysiwyg.mru" });
    return attachMathfieldController(field, api, insertKey);
};
window.tex64PaperMath = { attach };

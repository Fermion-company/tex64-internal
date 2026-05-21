// Central, extensible editor settings + feature-flag store. Each toggleable
// editor feature is registered here once (id + label + category + default); the
// rest of the app reads flags via `editorSettings.isEnabled(id)` and value
// settings (font) via getters. A future settings UI can enumerate `features()`
// to render toggles without touching individual call sites.
//
// Persistence is localStorage (renderer), namespaced under `tex64.editor.*`,
// matching the existing settings convention. Guarded so the module is safe to
// import in non-DOM contexts (e.g. unit tests), where it falls back to defaults.
// The single source of truth for toggleable editor features. Add a row here to
// expose a new toggle; defaults apply until the user overrides them.
export const EDITOR_FEATURES = [
    { id: "lsp.completion", label: "Completion", description: "Commands, environments, \\ref/\\cite, file paths (texlab).", category: "Language server", default: true },
    { id: "lsp.definition", label: "Go to definition", description: "Jump to a label/command definition.", category: "Language server", default: true },
    { id: "lsp.references", label: "Find references", description: "Find all uses of a label or citation.", category: "Language server", default: true },
    { id: "lsp.documentSymbol", label: "Document symbols", description: "Outline/breadcrumbs and Go to Symbol.", category: "Language server", default: true },
    { id: "lsp.rename", label: "Rename", description: "Rename a label across the project.", category: "Language server", default: true },
    { id: "lsp.formatting", label: "Format document", description: "Format with latexindent via texlab.", category: "Language server", default: true },
    { id: "lsp.diagnostics", label: "Diagnostics", description: "Live syntax/reference diagnostics from texlab.", category: "Language server", default: true },
    { id: "lsp.folding", label: "Code folding", description: "Fold sections and environments.", category: "Language server", default: true },
    { id: "lsp.documentLink", label: "Clickable includes", description: "Ctrl/Cmd-click \\input/\\include/\\href targets.", category: "Language server", default: true },
    { id: "lsp.documentHighlight", label: "Highlight occurrences", description: "Highlight other uses of the symbol at the cursor.", category: "Language server", default: true },
    { id: "lsp.inlayHint", label: "Inlay hints", description: "Inline hints (e.g. label names) from texlab.", category: "Language server", default: true },
    { id: "lint.chktex", label: "ChkTeX lint", description: "Style warnings via ChkTeX (requires chktex).", category: "Linting", default: true },
    { id: "spell.check", label: "Spell check", description: "LaTeX-aware English spell checking (prose only).", category: "Linting", default: true },
    { id: "ergo.itemOnEnter", label: "Auto \\item", description: "Insert \\item on Enter inside list environments.", category: "Editing", default: true },
    { id: "ergo.autoCloseEnvironment", label: "Auto-close environment", description: "Insert matching \\end when you type \\begin{...}.", category: "Editing", default: true },
    { id: "ergo.wrapSelection", label: "Wrap selection", description: "Wrap the selection in an environment or command.", category: "Editing", default: true },
];
const DEFAULTS = new Map(EDITOR_FEATURES.map((f) => [f.id, f.default]));
// The previous hardcoded editor font; "" font family means "use this default".
export const DEFAULT_FONT_FAMILY = '"SF Mono", "Hiragino Kaku Gothic ProN", "Hiragino Sans", Menlo, Monaco, "Courier New", monospace';
export const DEFAULT_FONT_SIZE = 12;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 40;
// Line height scales with font size. Ratio chosen so the default (12px) keeps
// the previous fixed line height of 20px (20 / 12).
export const LINE_HEIGHT_RATIO = 20 / 12;
const FLAG_KEY = (id) => `tex64.editor.feature.${id}`;
const FONT_FAMILY_KEY = "tex64.editor.fontFamily";
const FONT_SIZE_KEY = "tex64.editor.fontSize";
const hasStorage = () => {
    try {
        return typeof localStorage !== "undefined" && localStorage !== null;
    }
    catch {
        return false;
    }
};
class EditorSettingsStore {
    constructor() {
        this.listeners = new Set();
    }
    isEnabled(id) {
        var _a;
        const fallback = (_a = DEFAULTS.get(id)) !== null && _a !== void 0 ? _a : false;
        if (!hasStorage()) {
            return fallback;
        }
        const stored = localStorage.getItem(FLAG_KEY(id));
        if (stored === null) {
            return fallback;
        }
        return stored !== "false";
    }
    setFlag(id, value) {
        if (hasStorage()) {
            localStorage.setItem(FLAG_KEY(id), value ? "true" : "false");
        }
        this.emit({ kind: "flag", id, value });
    }
    getFontFamily() {
        if (hasStorage()) {
            const stored = localStorage.getItem(FONT_FAMILY_KEY);
            if (stored && stored.trim()) {
                return stored;
            }
        }
        return DEFAULT_FONT_FAMILY;
    }
    // The raw stored value ("" when following the system default) — for the UI control.
    getFontFamilyRaw() {
        var _a;
        if (hasStorage()) {
            return (_a = localStorage.getItem(FONT_FAMILY_KEY)) !== null && _a !== void 0 ? _a : "";
        }
        return "";
    }
    setFontFamily(value) {
        if (hasStorage()) {
            localStorage.setItem(FONT_FAMILY_KEY, value !== null && value !== void 0 ? value : "");
        }
        this.emit({ kind: "font" });
    }
    getFontSize() {
        if (hasStorage()) {
            const stored = Number(localStorage.getItem(FONT_SIZE_KEY));
            if (Number.isFinite(stored) && stored > 0) {
                return this.clampSize(stored);
            }
        }
        return DEFAULT_FONT_SIZE;
    }
    setFontSize(value) {
        const size = this.clampSize(value);
        if (hasStorage()) {
            localStorage.setItem(FONT_SIZE_KEY, String(size));
        }
        this.emit({ kind: "font" });
    }
    clampSize(value) {
        if (!Number.isFinite(value)) {
            return DEFAULT_FONT_SIZE;
        }
        return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));
    }
    // Derived line height so rows grow/shrink with the font size.
    getLineHeight() {
        return Math.round(this.getFontSize() * LINE_HEIGHT_RATIO);
    }
    features() {
        return EDITOR_FEATURES.slice();
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    emit(change) {
        this.listeners.forEach((listener) => {
            try {
                listener(change);
            }
            catch (error) {
                console.error("[editor-settings] listener failed", error);
            }
        });
    }
}
export const editorSettings = new EditorSettingsStore();

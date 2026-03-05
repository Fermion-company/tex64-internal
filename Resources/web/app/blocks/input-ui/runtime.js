export const createBlockInputRuntime = (context, deps, initial) => {
    return {
        context,
        deps,
        state: {
            activeBlockType: "math",
            mathInput: null,
            mathInputFallback: null,
            currentMathValue: "",
            mathFieldWrapped: false,
            mathKeyboardVisibilityHandler: () => { },
            mathWysiwygApi: null,
            globalWysiwygKeydownBound: false,
            mathInsertMode: "inline",
            mathInlineWrap: "inline-dollar",
            mathDisplayWrap: "display-bracket",
            blockSettingsOpen: false,
            activeBlockSettingsPage: "menu",
            formatMenuOpen: false,
            mathWysiwygSettings: initial.mathWysiwygSettings,
        },
        attachedMathInputListeners: new WeakSet(),
        TEXTAREA_MATHFIELD_SHIM: Symbol("tex64.textarea-mathfield-shim"),
        STYLE_WRAPPER_TEMPLATE_RE: /^\\(?:mathbb|mathcal|mathfrak|mathsf|mathrm|mathbf|mathit|mathtt|operatorname)\\{#\\?\\}$/,
    };
};

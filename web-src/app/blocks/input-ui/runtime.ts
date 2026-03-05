import type { AppContext } from "../../context.js";
import type { BlockType } from "../../types.js";
import type { MathWysiwygApi } from "../../../math/wysiwyg/math-wysiwyg.js";
import type { MathDisplayWrap, MathInlineWrap, MathInsertMode } from "../input-ui-settings.js";
import type { BlockInputDeps, BlockSettingsPage } from "./types.js";

export type MathWysiwygSettingsState = {
  autoSuggest: boolean;
  enabledPacks: string[];
};

export type BlockInputRuntime = {
  context: AppContext;
  deps: BlockInputDeps;
  state: {
    activeBlockType: BlockType;
    mathInput: HTMLElement | null;
    mathInputFallback: string | null;
    currentMathValue: string;
    mathFieldWrapped: boolean;
    mathKeyboardVisibilityHandler: () => void;
    mathWysiwygApi: MathWysiwygApi | null;
    globalWysiwygKeydownBound: boolean;
    mathInsertMode: MathInsertMode;
    mathInlineWrap: MathInlineWrap;
    mathDisplayWrap: MathDisplayWrap;
    blockSettingsOpen: boolean;
    activeBlockSettingsPage: BlockSettingsPage;
    formatMenuOpen: boolean;
    mathWysiwygSettings: MathWysiwygSettingsState;
  };
  attachedMathInputListeners: WeakSet<HTMLElement>;
  TEXTAREA_MATHFIELD_SHIM: symbol;
  STYLE_WRAPPER_TEMPLATE_RE: RegExp;
};

export const createBlockInputRuntime = (
  context: AppContext,
  deps: BlockInputDeps,
  initial: { mathWysiwygSettings: MathWysiwygSettingsState }
): BlockInputRuntime => {
  return {
    context,
    deps,
    state: {
      activeBlockType: "math",
      mathInput: null,
      mathInputFallback: null,
      currentMathValue: "",
      mathFieldWrapped: false,
      mathKeyboardVisibilityHandler: () => {},
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
    STYLE_WRAPPER_TEMPLATE_RE:
      /^\\(?:mathbb|mathcal|mathfrak|mathsf|mathrm|mathbf|mathit|mathtt|operatorname)\\{#\\?\\}$/,
  };
};


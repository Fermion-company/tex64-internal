import type { BlockContent, BlockType, MathKey } from "../../types.js";
import type { BlockContext } from "../types.js";

export type BlockInputApi = {
  getActiveBlockType: () => BlockType;
  setActiveBlockType: (type: BlockType) => void;
  setMathKeyboardVisibilityHandler: (handler: () => void) => void;
  getMathInputValue: () => string;
  setMathInputValue: (value: string) => void;
  getBlockDraft: () => { snippet: string; content: BlockContent } | null;
  insertMathKey: (key: MathKey) => void;
  setMathInputElement: (element: HTMLElement | null) => void;
  setMathInputFallback: (value: string | null) => void;
  getMathInputFallback: () => string | null;
  isMathInputFocused: () => boolean;
  attachMathInputListener: () => void;
  attachMathFieldEvents: (mathfield: HTMLElement) => void;
  updateMathPreview: () => void;
};

export type BlockInputDeps = {
  getActiveBlockContext: () => BlockContext | null;
  getWorkspaceRootKey?: () => string | null;
  onMathFieldSubmit?: () => void;
  onMathCaptureRequest?: () => void;
};

export type BlockSettingsPage = "menu" | "insert-format" | "suggestions";


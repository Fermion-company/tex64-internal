import type { MathKey } from "../../../app/types.js";

export type MathWysiwygApi = {
  attach: (mathfield: HTMLElement) => void;
  detach: () => void;
  handleKeydown: (event: KeyboardEvent) => boolean;
  setComposing: (value: boolean) => void;
  close: () => void;
  openExplicitSuggestions: () => boolean;
  updateConfig: (config: Partial<MathWysiwygConfig>) => void;
  getWordCandidates: (token: string) => MathWysiwygWordCandidate[];
  openCustomCandidates: (candidates: CustomCandidate[], options?: { selectedIndex?: number }) => void;
};

export type MathWysiwygWordCandidate = {
  id: string;
  key: MathKey;
  label: string;
  hint: string;
  displayLatex?: string;
};

/** Style captured from the text that a WYSIWYG candidate replaces. */
export type MathWysiwygInsertOptions = {
  style?: Record<string, unknown>;
};

export type MathWysiwygDeps = {
  container: HTMLElement | null;
  floating?: boolean;
  insertKey: (key: MathKey, options?: MathWysiwygInsertOptions) => void;
  autoSuggest?: boolean;
  mruStorageKey?: string;
  getMruStorageKey?: () => string;
};

export type MathWysiwygConfig = {
  autoSuggest: boolean;
};

export type TokenMatch = {
  token: string;
  range: { start: number; end: number };
  kind: "word" | "operator" | "command" | "slash-command";
};

export type SuggestOptions = {
  explicit?: boolean;
};

export type CustomCandidate = {
  id: string;
  label: string;
  hint: string;
  displayLatex?: string;
  apply: (mathfield: any) => void;
};

export type MruEntry = {
  count: number;
  lastUsedAt: number;
  latex?: string;
  label?: string;
  hint?: string;
  displayLatex?: string;
};

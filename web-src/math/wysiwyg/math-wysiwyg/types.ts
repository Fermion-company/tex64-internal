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

export type MathWysiwygDeps = {
  container: HTMLElement | null;
  insertKey: (key: MathKey) => void;
  autoSuggest?: boolean;
  enabledPacks?: string[];
  mruStorageKey?: string;
  getMruStorageKey?: () => string;
};

export type MathWysiwygConfig = {
  autoSuggest: boolean;
  enabledPacks: string[];
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


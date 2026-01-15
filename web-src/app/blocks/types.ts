import type { BlockApplyMode, BlockContent } from "../types.js";

export type BlockContext = {
  type: "math";
  originalSnippet: string;
  prefix: string;
  suffix: string;
  envName?: string;
};

export type DetectedBlockSnapshot = {
  type: "math";
  start: number;
  end: number;
  snippet: string;
  context: BlockContext | null;
  modelVersion: number;
};

export type PendingBlockApply = {
  mode: BlockApplyMode;
  draft: { snippet: string; content: BlockContent };
  detectedSnapshot?: DetectedBlockSnapshot | null;
  insertPosition?: { lineNumber: number; column: number } | null;
  insertRange?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null;
  replaceRange?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null;
  replaceSnippet?: string | null;
};

export type DetectedLatexBlock = {
  type: "math";
  content: string;
  start: number;
  end: number;
  envName?: string | null;
  inline?: boolean;
  fullMatch?: string;
};

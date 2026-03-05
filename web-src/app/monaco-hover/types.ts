export type HoverState = { registered: boolean };

export type StableHoverAnchor = {
  filePath: string;
  startLineNumber: number;
  endLineNumber: number;
  startColumn: number;
  endColumn: number;
  tokenKey: string;
  updatedAt: number;
};

export type CommandKeyMatch = {
  command: string;
  key: string;
  startIndex: number;
  endIndex: number;
};

export type FileExcerptResult =
  | { ok: true; path: string; startLine: number; lines: string[]; truncated?: boolean }
  | { ok: false; error?: string };

export type FilePreviewResult = { ok: boolean; dataUrl?: string | null; error?: string };


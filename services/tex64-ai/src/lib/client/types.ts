export const RUN_STAGES = [
  "understanding",
  "planning",
  "writing",
  "checking",
  "formatting",
  "ready",
  "needs_input",
  "failed",
] as const;

export type RunStage = (typeof RUN_STAGES)[number];

export const RUN_PROGRESS_STAGES = [
  "understanding",
  "planning",
  "writing",
  "checking",
  "formatting",
  "ready",
] as const satisfies readonly RunStage[];

export const RUN_STAGE_LABELS: Record<RunStage, string> = {
  understanding: "依頼を確認しています",
  planning: "構成を考えています",
  writing: "本文を書いています",
  checking: "文書を確認しています",
  formatting: "紙面を整えています",
  ready: "仕上がりました",
  needs_input: "確認したいことがあります",
  failed: "続けられませんでした",
};

export type DocumentKind = "proposal" | "report" | "paper" | "memo";

export type DocumentStatus = "draft" | "working" | "ready";

export interface HeadingBlock {
  id: string;
  type: "heading";
  level: 1 | 2;
  text: string;
}

export interface ParagraphBlock {
  id: string;
  type: "paragraph";
  text: string;
}

export interface QuoteBlock {
  id: string;
  type: "quote";
  text: string;
  attribution?: string;
}

export interface ListBlock {
  id: string;
  type: "list";
  items: string[];
}

export interface EquationBlock {
  id: string;
  type: "equation";
  expression: string;
  caption?: string;
}

export type DocumentBlock =
  | HeadingBlock
  | ParagraphBlock
  | QuoteBlock
  | ListBlock
  | EquationBlock;

export interface DocumentVersion {
  id: string;
  /** Revision number this version snapshots; restore targets this. */
  revision: number;
  label: string;
  createdAt: string;
  source: "agent" | "manual";
}

export interface AgentRun {
  id: string;
  documentId: string;
  prompt: string;
  stage: RunStage;
  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "cancelled";
  createdAt: string;
  updatedAt: string;
  resultNote?: string;
  inputKind?: "approval" | "clarification" | null;
}

/**
 * One semantic progress step of a run, in occurrence order. Labels are the
 * fixed user-facing copy; repair rounds repeat a stage with attempt >= 1.
 */
export interface RunProgressEvent {
  stage: RunStage;
  label: string;
  sequence: number;
  occurredAt: string;
  attempt?: number;
}

export interface DocumentSummary {
  id: string;
  title: string;
  kind: DocumentKind;
  status: DocumentStatus;
  updatedAt: string;
  preview: string;
}

/**
 * One selectable element of the typeset document, in reading order. Covers
 * rich nodes (figures, tables, theorems…) that the block editor cannot
 * represent; labels use the same numbering as the canvas.
 */
export interface DocumentElement {
  id: string;
  kind:
    | "section"
    | "heading"
    | "paragraph"
    | "list"
    | "equation"
    | "quote"
    | "figure"
    | "table"
    | "theorem"
    | "proof"
    | "algorithm"
    | "code"
    | "appendix"
    | "bibliography";
  label: string;
  /** True when the block canvas can edit this element directly. */
  editable: boolean;
}

export interface DocumentDetail extends DocumentSummary {
  revision: number;
  artifactUrl?: string;
  /** Inline PDF for the current revision (released or the owner's draft). */
  previewUrl?: string;
  /** Element-region map for previewUrl; absent when no map was produced. */
  regionsUrl?: string;
  eyebrow?: string;
  author?: string;
  blocks: DocumentBlock[];
  elements: DocumentElement[];
  versions: DocumentVersion[];
  runs: AgentRun[];
}

export interface DocumentPatch {
  baseRevision: number;
  title?: string;
  eyebrow?: string;
  author?: string;
  blocks?: DocumentBlock[];
  status?: DocumentStatus;
}

export type DocumentChanges = Omit<DocumentPatch, "baseRevision">;

export interface CreateDocumentInput {
  prompt: string;
  kind: DocumentKind;
}

export interface StartRunInput {
  prompt?: string;
  replyToRunId?: string;
  decision?: "approve" | "reject";
  /** Document element (block id) this request is scoped to. */
  targetNodeId?: string;
}

export type ClientError = "conflict" | "unavailable" | "invalid_response";

export type ClientResult<T> =
  | { data: T; source: "remote"; ok: true; error?: never }
  | { data: null; source: "remote"; ok: false; error: ClientError };

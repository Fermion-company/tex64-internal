/**
 * What the agent is doing right now, keyed by the tool it just called. The
 * label is the only thing the reader sees; tool names never surface.
 */
export const TOOL_ACTIVITY_LABELS: Record<string, string> = {
  read_document: "文書を読んでいます",
  search_sources: "資料を探しています",
  resolve_source: "資料を確認しています",
  apply_document_patch: "本文を書いています",
  format_document: "体裁を整えています",
  check_document: "文書を確認しています",
  compile_document: "紙面を組み立てています",
};

export const DEFAULT_TOOL_ACTIVITY_LABEL = "作業しています";

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

/** One visible turn of the conversation. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

/**
 * What the server sends while a turn runs. Text arrives as it is written;
 * tool frames say what the agent is doing right now; revision/compiled frames
 * tell the client the document and its page moved.
 */
export type TurnFrame =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; state: "start" | "ok" | "error" }
  | { type: "revision"; revision: number }
  | { type: "compiled"; revision: number; pageCount: number }
  | { type: "error"; message: string }
  | { type: "done"; status: "completed" | "aborted" | "failed" };

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
  messages: ChatMessage[];
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
  /** Omitted by the app: the server infers the kind from the prompt. */
  kind?: DocumentKind;
}

export interface StartRunInput {
  prompt?: string;
  replyToRunId?: string;
  /** Document element (block id) this request is scoped to. */
  targetNodeId?: string;
}

export type ClientError = "conflict" | "unavailable" | "invalid_response";

export type ClientResult<T> =
  | { data: T; source: "remote"; ok: true; error?: never }
  | { data: null; source: "remote"; ok: false; error: ClientError };

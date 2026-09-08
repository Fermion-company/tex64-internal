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
  // The desktop agent reports its tools by name; the words are ours.
  read_file: "文書を読んでいます",
  list_files: "構成を確かめています",
  list_sections: "構成を読んでいます",
  read_section: "文書を読んでいます",
  replace_section: "本文を書いています",
  append_to_section: "本文を書いています",
  find_math_region: "数式を探しています",
  replace_lines: "本文を書いています",
  insert_lines: "本文を書いています",
  delete_lines: "本文を整えています",
  create_file: "本文を書いています",
  write_file: "本文を書いています",
  apply_patch: "本文を書いています",
  get_compile_log: "組版の結果を見ています",
  run_build: "紙面を組み立てています",
  propose_next_steps: "次の一手を考えています",
  ask_user: "質問を用意しています",
  arxiv_search: "資料を探しています",
  arxiv_bibtex: "資料を確認しています",
  check_environment: "環境を確かめています",
  check_references: "参照と図表を確かめています",
  check_bibliography: "参考文献を確かめています",
  git_diff: "変更を読んでいます",
  record_plan: "計画をまとめています",
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

/**
 * One concrete next step the agent proposes for the document. `request` is
 * phrased so it can be sent back as-is; `scope` says how much it touches.
 */
/** One question the agent puts to the user, rendered as an input card. */
export interface AgentQuestion {
  question: string;
  /** Short facts to collect together (subject, audience, goal...). */
  fields?: { key: string; label: string; placeholder?: string }[];
  /** Real alternatives to pick from. */
  options?: string[];
}

export interface AgentProposal {
  id: string;
  title: string;
  request: string;
  scope?: string;
  /** What the user must answer before this step can be written. */
  asks?: AgentQuestion;
  /** "writing" starts with the brief when taken; "mechanical" is done at once. */
  kind?: "mechanical" | "writing";
  /** 1-based line in the main file where the step applies; marks the page. */
  line?: number;
}

/** One visible turn of the conversation. */
/** One piece of a user turn as the desktop agent accepts it. */
export type MessagePart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export type AttachmentKind = "image" | "pdf" | "sheet" | "text" | "file";

/** A file the user sent with a message, as the chat shows it afterwards. */
export interface ChatAttachment {
  name: string;
  kind: AttachmentKind;
  /** Where it was saved in the workspace, when it was. */
  path?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /** Files sent with this message. */
  attachments?: ChatAttachment[];
  /** Next steps the agent attached to this reply, in its suggested order. */
  proposals?: AgentProposal[];
  /** The agent stopped to ask this; the user's next message answers it. */
  question?: AgentQuestion;
  /** A turn the app started on the user's behalf (the opening read); never shown. */
  hidden?: boolean;
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

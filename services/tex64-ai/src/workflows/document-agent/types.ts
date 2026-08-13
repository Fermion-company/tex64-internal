import type {
  AgentRunStage,
  ArtifactReleaseBinding,
  RunDecision,
} from "@/server/persistence";
import type { DocumentBrief } from "@/domain/brief";

/** Public API and durable workflow input share one non-silent prompt limit. */
export const MAX_DOCUMENT_AGENT_PROMPT_CHARS = 20_000;

export type DocumentAgentWorkflowInput = {
  userId: string;
  documentId: string;
  runId: string;
  prompt: string;
  baseRevision: number;
  replyToRunId: string | null;
  decision: RunDecision | null;
  targetNodeId?: string | null;
};

export type ClarificationContinuation = {
  sourceRunId: string;
  originalPrompt: string;
  question: string;
  answer: string;
};

export type ClarificationHistoryTurn = {
  question: string;
  answer: string;
};

export type ClarificationHistory = {
  originalRequest: string;
  turns: ClarificationHistoryTurn[];
  truncated: boolean;
};

export type DocumentRunPromptContext = {
  effectivePrompt: string;
  clarification: ClarificationContinuation | null;
  history?: ClarificationHistory | null;
};

export type DocumentBriefAssessment =
  | {
      status: "needs_input";
      question: string;
      briefSummary: string;
    }
  | {
      status: "ready";
      brief: DocumentBrief | null;
      briefVersion: number | null;
      legacyDocument: boolean;
    };

export type DocumentAgentProvider =
  | "ai_gateway"
  | "deterministic_fallback";

export type DocumentAgentArtifactSummary = {
  revision: number;
  sha256: string;
  byteSize: number;
};

export type DocumentAgentWorkflowResult =
  | {
      status: "completed";
      runId: string;
      documentId: string;
      revision: number;
      artifact: DocumentAgentArtifactSummary;
    }
  | {
      status: "needs_input";
      runId: string;
      documentId: string;
      stage: Extract<AgentRunStage, "needs_input">;
      question: string;
    }
  | {
      status: "cancelled";
      runId: string;
      documentId: string;
    }
  | {
      status: "failed";
      runId: string;
      documentId: string;
      message: string;
    };

export type AgentRuntimeSelection =
  | { provider: "ai_gateway"; model: string }
  | { provider: "deterministic_fallback"; model: null };

export type WorkflowLoadResult =
  | {
      state: "active";
      currentRevision: number;
      resultRevision: number | null;
    }
  | {
      state: "completed";
      revision: number;
      artifact: DocumentAgentArtifactSummary;
    }
  | {
      state: "cancelled";
    }
  | {
      state: "failed";
      message: string;
    };

export type RunDocumentRevisionResult = {
  revision: number;
  changed: boolean;
  hasContent: boolean;
  needsInput: boolean;
  question?: string;
};

export type DocumentDecisionRunResult =
  | { status: "not_requested" }
  | { status: "applied"; revision: number }
  | { status: "rejected" }
  | { status: "stale"; message: string };

export type CompileAndStoreResult =
  | {
      ok: true;
      revision: number;
      artifact: DocumentAgentArtifactSummary;
      /** Internal publication identity; never returned by the client API. */
      release: ArtifactReleaseBinding;
      pageCount: number;
      warningCount: number;
      reused: boolean;
    }
  | {
      ok: false;
      revision: number;
      code:
        | "document_validation_failed"
        | "typesetting_failed"
        | "visual_quality_failed"
        | "page_target_mismatch"
        | "page_target_unsupported";
      issueCount: number;
      /** Path-sanitized typesetting diagnostics for the repair prompt. */
      diagnostics?: Array<{ code: string; message: string; line?: number }>;
      visualFindings?: Array<{
        category:
          | "clipping"
          | "overlap"
          | "spacing_and_margins"
          | "typography"
          | "figures_and_tables"
          | "equations";
        page: number;
        detail: string;
      }>;
      pageTarget?: {
        observed: number;
        minimum: number;
        maximum?: number;
      };
    };

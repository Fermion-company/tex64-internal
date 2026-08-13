import { createHash } from "node:crypto";
import { FatalError } from "workflow";
import { z } from "zod";

import {
  DocumentAgentSessionSchema,
  DocumentBriefSchema,
  StoredDocumentAgentSessionSchema,
  advanceElicitation,
  applyBriefExtraction,
  autopilotDocumentBrief,
  createDocumentAgentSession,
  resolveSafeCustomTemplatePreset,
  type DocumentBrief,
  type DocumentAgentSession,
  type ElicitationQuestion,
} from "@/domain/brief";
import {
  DocumentCitationStyleSchema,
  DocumentLayoutSchema,
  DocumentPatchSchema,
  DocumentValidationError,
  DocumentWritingStyleSchema,
  applyDocumentPatch,
  normalizeDocumentLanguage,
  safeValidateDocument,
  validateDocument,
  type DocumentModel,
  type DocumentCitationStyle,
  type DocumentLayout,
  type DocumentWritingStyle,
  type DocumentPatch,
  type DocumentRevision,
} from "@/domain/document";
import {
  DocumentPlanSchema,
  createDocumentBriefDigest,
  type DocumentPlan,
} from "@/domain/plan";
import {
  createReviewPlanProjection,
  evaluateDeterministicAcceptance,
} from "@/domain/review";
import { runReleasesArtifact } from "@/server/artifacts";
import {
  DocumentToolContextSchema,
  SEMANTIC_PROGRESS_LABELS,
  buildClarifiedDocumentPrompt,
  deterministicUuid,
  documentMutationReadiness,
  isContentEditRun,
  parseStronglyScopedLegacyEdit,
  patchMatchesScopedLegacyEdit,
  extractBriefRequirements,
  createDocumentPlan,
  reviewDocumentIndependently,
  type IndependentDocumentReview,
  planDocumentDeterministically,
  workflowNeedsApproval,
  type DeterministicFallbackPlan,
  type DocumentCheckResult,
  type DocumentMutationResult,
  type ResolveSourceResult,
  type DocumentToolContext,
  type DocumentToolExecution,
  type DocumentToolHandlers,
} from "@/server/agent";
import { parsePageTarget } from "@/server/compiler";
import { compileDocumentRevision } from "@/server/compiler/compile-document-revision";
import {
  AgentRunNotFoundError,
  DocumentNotFoundError,
  IdempotencyConflictError,
  RevisionConflictError,
  getDocumentRepository,
  type AgentRunStage,
  type ArtifactReleaseBinding,
  type DocumentRepository,
  type StoredAgentRun,
  type StoredDocument,
} from "@/server/persistence";
import {
  documentPatchDigest,
  needsInputQuestion,
} from "@/server/persistence/pending-actions";
import {
  SourceAuthorizationError,
  SourceProvenanceError,
  SourceResolutionError,
  authorizedSourceLocator,
  canonicalizeSourceLocator,
  citationSourceIdsForPatch,
  normalizeCitationPatchWithSources,
  resolveSource,
  type CanonicalizedSourceLocator,
} from "@/server/sources";
import {
  ResearchEvidenceDraftSchema,
  buildResearchLedger,
  createResearchLedgerId,
  createResearchReviewRunId,
  freezeResearchSources,
  reviewResearchEvidenceIndependently,
  validateResearchLedgerAgainstContext,
  type ResearchLedgerContext,
} from "@/server/research";
import {
  normalizeUserFacingQuestion,
  normalizeUserFacingResultNote,
} from "@/lib/user-facing-copy";

import { usesDirectOpenAiTransport } from "@/server/agent/language-model";
import { normalizeModelDocumentPatch } from "@/server/agent/normalize-model-patch";

import {
  hasSemanticEvent,
  selectAgentRuntime,
  semanticEventKey,
} from "./helpers";
import { resolvedSourceToolResult } from "./source-tool-result";
import { trustedSourcePromptForRun } from "./trusted-source-prompt";
import { MAX_DOCUMENT_AGENT_PROMPT_CHARS } from "./types";
import type {
  AgentRuntimeSelection,
  CompileAndStoreResult,
  DocumentBriefAssessment,
  DocumentRunPromptContext,
  DocumentAgentArtifactSummary,
  DocumentAgentWorkflowInput,
  DocumentDecisionRunResult,
  RunDocumentRevisionResult,
  WorkflowLoadResult,
} from "./types";

type ReadDocumentInput = Parameters<
  DocumentToolHandlers["readDocument"]
>[0];
type ApplyDocumentPatchInput = Parameters<
  DocumentToolHandlers["applyDocumentPatch"]
>[0];
type CheckDocumentInput = Parameters<
  DocumentToolHandlers["checkDocument"]
>[0];
type FormatDocumentInput = Parameters<
  DocumentToolHandlers["formatDocument"]
>[0];
type RequestInputInput = Parameters<
  DocumentToolHandlers["requestInput"]
>[0];
type ResolveSourceInput = Parameters<
  DocumentToolHandlers["resolveSource"]
>[0];
type DeleteDocumentInput = Parameters<
  DocumentToolHandlers["deleteDocument"]
>[0];
type PublishDocumentInput = Parameters<
  DocumentToolHandlers["publishDocument"]
>[0];
type RunExpensiveTaskInput = Parameters<
  DocumentToolHandlers["runExpensiveTask"]
>[0];

const WorkflowInputSchema = z
  .object({
    userId: z.string().min(1).max(200),
    documentId: z.string().uuid(),
    runId: z.string().min(1).max(200),
    prompt: z.string().trim().min(1).max(MAX_DOCUMENT_AGENT_PROMPT_CHARS),
    baseRevision: z.number().int().nonnegative(),
    replyToRunId: z.string().uuid().nullable().default(null),
    decision: z.enum(["approve", "reject"]).nullable().default(null),
    targetNodeId: z.string().uuid().nullable().default(null),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.decision !== null && input.replyToRunId === null) {
      context.addIssue({
        code: "custom",
        path: ["replyToRunId"],
        message: "A decision must target a pending run.",
      });
    }
  });

const SemanticStageSchema = z.enum([
  "understanding",
  "planning",
  "writing",
  "checking",
  "formatting",
  "ready",
  "needs_input",
  "failed",
]);

const SafeEventDetailSchema = z
  .object({
    code: z.string().min(1).max(100).optional(),
    attempt: z.number().int().nonnegative().optional(),
    issueCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const DocumentRunPromptContextSchema = z
  .object({
    effectivePrompt: z.string().trim().min(1).max(50_000),
    clarification: z
      .object({
        sourceRunId: z.string().min(1).max(200),
        originalPrompt: z
          .string()
          .trim()
          .min(1)
          .max(MAX_DOCUMENT_AGENT_PROMPT_CHARS),
        question: z.string().trim().min(1).max(500),
        answer: z
          .string()
          .trim()
          .min(1)
          .max(MAX_DOCUMENT_AGENT_PROMPT_CHARS),
      })
      .strict()
      .nullable(),
    history: z
      .object({
        originalRequest: z
          .string()
          .trim()
          .min(1)
          .max(MAX_DOCUMENT_AGENT_PROMPT_CHARS),
        turns: z
          .array(
            z
              .object({
                question: z.string().trim().min(1).max(300),
                answer: z.string().trim().min(1).max(800),
              })
              .strict(),
          )
          .max(8),
        truncated: z.boolean(),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();

const MAX_CLARIFICATION_CONTEXT_TURNS = 8;

function boundedPrompt(value: string, maximum: number): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function trimmedPrompt(value: string): string {
  return value.trim();
}

function standalonePromptContext(prompt: string): DocumentRunPromptContext {
  return DocumentRunPromptContextSchema.parse({
    effectivePrompt: trimmedPrompt(prompt),
    clarification: null,
    history: null,
  });
}

function parseWorkflowInput(
  input: DocumentAgentWorkflowInput,
): DocumentAgentWorkflowInput {
  return WorkflowInputSchema.parse(input);
}

async function requireRun(
  repository: DocumentRepository,
  userId: string,
  runId: string,
): Promise<StoredAgentRun> {
  const run = await repository.getRun(userId, runId);
  if (!run) throw new AgentRunNotFoundError();
  return run;
}

async function requireDocument(
  repository: DocumentRepository,
  userId: string,
  documentId: string,
): Promise<StoredDocument> {
  const document = await repository.getDocument(userId, documentId);
  if (!document) throw new DocumentNotFoundError();
  return document;
}

function assertRunScope(
  run: StoredAgentRun,
  documentId: string,
): void {
  if (run.documentId !== documentId) {
    throw new FatalError("この文書操作を実行できません。");
  }
  if (run.status === "cancelled" || run.status === "failed") {
    throw new FatalError("この文書作成は終了しています。");
  }
  if (run.status === "waiting_approval" || run.stage === "needs_input") {
    throw new FatalError(
      "この実行は入力待ちです。回答は新しい依頼として送ってください。",
    );
  }
}

async function loadToolScope(contextInput: DocumentToolContext) {
  const context = DocumentToolContextSchema.parse(contextInput);
  const repository = getDocumentRepository();
  const run = await requireRun(repository, context.actorId, context.runId);
  assertRunScope(run, context.documentId);
  const document = await requireDocument(
    repository,
    context.actorId,
    context.documentId,
  );
  return { context, repository, run, document };
}

type ToolMutationAction =
  | "apply_document_patch"
  | "format_document"
  | "request_input"
  | "delete_document"
  | "publish_document"
  | "run_expensive_task";

/**
 * AI SDK executes tool calls from one model response concurrently. Claim one
 * durable mutation slot for that response before any document or run state is
 * changed. appendRunEvent serializes on the run in both repository backends;
 * its idempotency key also makes a replay of the winning tool harmless.
 */
async function claimToolMutation(
  repository: DocumentRepository,
  run: StoredAgentRun,
  action: ToolMutationAction,
  execution: DocumentToolExecution | undefined,
): Promise<void> {
  if (!execution) return;
  const toolCallId = z.string().min(1).max(500).parse(execution.toolCallId);
  const batchDigest = createHash("sha256")
    .update(JSON.stringify(execution.messages))
    .digest("hex");
  const eventKey = `${run.id}:tool-mutation:${batchDigest}`;

  try {
    await repository.appendRunEvent({
      userId: run.userId,
      runId: run.id,
      idempotencyKey: eventKey,
      stage: "writing",
      message: SEMANTIC_PROGRESS_LABELS.writing,
      detail: {
        eventKey,
        code: "tool_mutation_claim",
        action,
        toolCallId,
      },
    });
  } catch (error) {
    if (!(error instanceof IdempotencyConflictError)) throw error;
    throw new FatalError(
      "同じ応答では文書を変更する操作を一つだけ実行します。現在の文書を読み直してください。",
    );
  }
}

function storedDocumentRevision(document: StoredDocument): DocumentRevision {
  return {
    revisionId: deterministicUuid(
      `${document.id}:stored-revision:${document.currentRevision}`,
    ),
    revision: document.currentRevision,
    parentRevisionId:
      document.currentRevision > 0
        ? deterministicUuid(
            `${document.id}:stored-revision:${document.currentRevision - 1}`,
          )
        : null,
    committedAt: document.updatedAt,
    document: document.document,
  };
}

function safeValidationMessage(code: string): string {
  switch (code) {
    case "missing_reference":
    case "invalid_reference":
      return "参照先を確認してください。";
    case "unlisted_citation":
      return "引用と参考文献の対応を確認してください。";
    case "invalid_table":
      return "表の構成を確認してください。";
    case "orphan_node":
    case "duplicate_parent":
    case "cycle":
    case "depth_limit":
      return "文書の章立てを確認してください。";
    default:
      return "文書の内容を確認してください。";
  }
}

async function persistNeedsInput(
  repository: DocumentRepository,
  run: StoredAgentRun,
  code: "clarification_required" | "approval_required",
  question: string,
  pendingAction?: { patch: DocumentPatch; summary: string },
): Promise<void> {
  const safeQuestion = normalizeUserFacingQuestion(question, code);
  await repository.setRunNeedsInput({
    userId: run.userId,
    documentId: run.documentId,
    runId: run.id,
    expectedStateVersion: run.stateVersion,
    code,
    question: safeQuestion,
    ...(pendingAction
      ? {
          pendingAction: {
            id: deterministicUuid(
              `${run.id}:pending-document-action:${pendingAction.patch.id}`,
            ),
            patch: pendingAction.patch,
            patchDigest: documentPatchDigest(pendingAction.patch),
            summary: pendingAction.summary,
          },
        }
      : {}),
  });
}

function clarificationPromptContext(input: {
  source: StoredAgentRun;
  question: string;
  answer: string;
  history: DocumentRunPromptContext["history"];
}): DocumentRunPromptContext {
  const originalPrompt = trimmedPrompt(input.source.prompt);
  const question = trimmedPrompt(input.question);
  const answer = trimmedPrompt(input.answer);
  const priorHistoryTurns = input.history?.turns.slice(0, -1) ?? [];
  const priorPrompt = priorHistoryTurns.reduce(
    (request, turn) =>
      buildClarifiedDocumentPrompt({
        originalPrompt: request,
        question: turn.question,
        answer: turn.answer,
      }),
    input.history?.originalRequest ?? originalPrompt,
  );
  // The current API answer is deliberately applied from its full validated
  // value. Only older history may be summarized, and that is disclosed by the
  // history.truncated bit that is also passed to the model.
  const effectivePrompt = buildClarifiedDocumentPrompt({
    originalPrompt: priorPrompt,
    question,
    answer,
  });
  return DocumentRunPromptContextSchema.parse({
    effectivePrompt,
    clarification: {
      sourceRunId: input.source.id,
      originalPrompt,
      question,
      answer,
    },
    history: input.history,
  });
}

async function buildClarificationHistory(input: {
  repository: DocumentRepository;
  userId: string;
  documentId: string;
  source: StoredAgentRun;
  question: string;
  answer: string;
}): Promise<NonNullable<DocumentRunPromptContext["history"]>> {
  const newestFirst = [
    {
      source: input.source,
      question: input.question,
      answer: input.answer,
    },
  ];
  const visited = new Set<string>([input.source.id]);
  let cursor = input.source;
  let truncated = false;

  while (cursor.replyToRunId !== null) {
    if (newestFirst.length >= MAX_CLARIFICATION_CONTEXT_TURNS) {
      truncated = true;
      break;
    }
    if (visited.has(cursor.replyToRunId)) {
      throw new FatalError("確認履歴を安全に読み取れませんでした。");
    }
    visited.add(cursor.replyToRunId);

    const source = await requireRun(
      input.repository,
      input.userId,
      cursor.replyToRunId,
    );
    if (source.documentId !== input.documentId || source.decision !== null) {
      throw new FatalError("確認履歴が現在の文書と一致しません。");
    }
    const question = needsInputQuestion(
      source,
      await input.repository.listRunEvents(input.userId, source.id),
      "clarification_required",
    );
    if (!question) {
      throw new FatalError("以前の確認内容を読み取れませんでした。");
    }
    newestFirst.push({
      source,
      question,
      answer: cursor.prompt,
    });
    cursor = source;
  }

  const chronological = newestFirst.reverse();
  const originalRequest = boundedPrompt(
    cursor.prompt,
    MAX_DOCUMENT_AGENT_PROMPT_CHARS,
  );
  const turns = chronological.map((turn) => ({
    question: boundedPrompt(turn.question, 300),
    answer: boundedPrompt(turn.answer, 800),
  }));
  truncated ||=
    cursor.prompt.normalize("NFKC").trim().length > originalRequest.length ||
    chronological.some(
      (turn, index) =>
        turn.question.normalize("NFKC").trim().length >
          (turns[index]?.question.length ?? 0) ||
        turn.answer.normalize("NFKC").trim().length >
          (turns[index]?.answer.length ?? 0),
    );

  return { originalRequest, turns, truncated };
}

export async function resolveAgentRuntimeStep(): Promise<AgentRuntimeSelection> {
  "use step";

  return selectAgentRuntime({
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
    VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    TEX64_AI_MODEL: process.env.TEX64_AI_MODEL,
    NODE_ENV: process.env.NODE_ENV,
    WORKFLOW_TARGET_WORLD: process.env.WORKFLOW_TARGET_WORLD,
    TEX64_LOCAL_DEVELOPMENT: process.env.TEX64_LOCAL_DEVELOPMENT,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
  });
}

export async function loadDocumentRunStep(
  inputValue: DocumentAgentWorkflowInput,
): Promise<WorkflowLoadResult> {
  "use step";

  const input = parseWorkflowInput(inputValue);
  const repository = getDocumentRepository();
  const [run, document] = await Promise.all([
    requireRun(repository, input.userId, input.runId),
    requireDocument(repository, input.userId, input.documentId),
  ]);

  if (
    run.documentId !== input.documentId ||
    run.prompt !== input.prompt ||
    run.baseRevision !== input.baseRevision ||
    run.replyToRunId !== input.replyToRunId ||
    run.decision !== input.decision ||
    run.targetNodeId !== input.targetNodeId
  ) {
    throw new FatalError("文書作成リクエストを確認できません。");
  }

  if (run.status === "completed") {
    if (run.resultRevision === null) {
      throw new Error("Completed document run has no result revision.");
    }
    const artifact = await repository.getArtifact(
      input.userId,
      input.documentId,
      run.resultRevision,
    );
    if (!runReleasesArtifact(run, artifact)) {
      throw new Error("Completed document artifact release is unavailable.");
    }
    return {
      state: "completed",
      revision: run.resultRevision,
      artifact: {
        revision: artifact.revision,
        sha256: artifact.sha256,
        byteSize: artifact.byteSize,
      },
    };
  }

  if (run.status === "cancelled") {
    return { state: "cancelled" };
  }

  if (run.status === "failed") {
    return {
      state: "failed",
      message: run.errorMessage ?? "文書の作成を完了できませんでした。",
    };
  }

  assertRunScope(run, input.documentId);
  const expectedCurrentRevision = run.resultRevision ?? input.baseRevision;
  if (document.currentRevision !== expectedCurrentRevision) {
    throw new FatalError(
      "文書が別の操作で更新されました。最新の内容からもう一度お試しください。",
    );
  }

  return {
    state: "active",
    currentRevision: document.currentRevision,
    resultRevision: run.resultRevision,
  };
}

export async function activateDocumentRunWorkflowStep(
  inputValue: DocumentAgentWorkflowInput,
  workflowRunIdValue: string,
): Promise<boolean> {
  "use step";

  const input = parseWorkflowInput(inputValue);
  const workflowRunId = z.string().trim().min(1).max(500).parse(workflowRunIdValue);
  const ownership = await getDocumentRepository().activateRunForWorkflow(
    input.userId,
    input.runId,
    workflowRunId,
  );
  return ownership.owned;
}

/** Resolves only the clarification run explicitly named by replyToRunId. */
export async function resolveDocumentRunPromptStep(
  inputValue: DocumentAgentWorkflowInput,
): Promise<DocumentRunPromptContext> {
  "use step";

  const input = parseWorkflowInput(inputValue);
  const repository = getDocumentRepository();
  const run = await requireRun(repository, input.userId, input.runId);
  assertRunScope(run, input.documentId);

  if (input.decision !== null) {
    throw new FatalError("承認の回答を本文として処理できません。");
  }
  if (input.replyToRunId === null) {
    return standalonePromptContext(input.prompt);
  }

  const continuation = await repository.consumeClarificationReply(
    input.userId,
    input.documentId,
    input.runId,
    input.replyToRunId,
  );
  const history = await buildClarificationHistory({
    repository,
    userId: input.userId,
    documentId: input.documentId,
    source: continuation.sourceRun,
    question: continuation.question,
    answer: input.prompt,
  });
  return clarificationPromptContext({
    source: continuation.sourceRun,
    question: continuation.question,
    answer: input.prompt,
    history,
  });
}

const AgentRuntimeSelectionSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("ai_gateway"),
    model: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    provider: z.literal("deterministic_fallback"),
    model: z.null(),
  }),
]);

const DocumentBriefAssessmentSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("needs_input"),
    question: z.string().trim().min(1).max(500),
    briefSummary: z.string().max(500),
  }),
  z.strictObject({
    status: z.literal("ready"),
    brief: DocumentBriefSchema.nullable(),
    briefVersion: z.number().int().positive().nullable(),
    legacyDocument: z.boolean(),
  }),
]);

function sessionActiveQuestion(
  session: DocumentAgentSession,
): ElicitationQuestion | null {
  if (!session.activeQuestionId) return null;
  return (
    session.questions.find(
      (question) => question.id === session.activeQuestionId,
    ) ?? null
  );
}

function replayedBriefAssessment(
  session: DocumentAgentSession,
  runId: string,
): DocumentBriefAssessment | null {
  if (session.lastProcessedRunId !== runId) return null;
  const question = sessionActiveQuestion(session);
  if (question?.sourceRunId === runId) {
    return DocumentBriefAssessmentSchema.parse({
      status: "needs_input",
      question: question.prompt,
      briefSummary: "",
    });
  }
  if (
    session.confirmedBriefVersion === session.briefVersion &&
    (session.phase === "planning" ||
      session.phase === "researching" ||
      session.phase === "drafting" ||
      session.phase === "reviewing" ||
      session.phase === "formatting" ||
      session.phase === "ready")
  ) {
    return DocumentBriefAssessmentSchema.parse({
      status: "ready",
      brief: session.brief,
      briefVersion: session.briefVersion,
      legacyDocument: false,
    });
  }
  return null;
}

function prepareStoredAgentSession(input: {
  userId: string;
  documentId: string;
  session: DocumentAgentSession;
  expectedStateVersion: number | null;
  runId: string;
  now: string;
}) {
  const nextStateVersion =
    input.expectedStateVersion === null ? 0 : input.expectedStateVersion + 1;
  const session = DocumentAgentSessionSchema.parse({
    ...input.session,
    lastProcessedRunId: input.runId,
    stateVersion: nextStateVersion,
    updatedAt: input.now,
  });
  return StoredDocumentAgentSessionSchema.parse({
    userId: input.userId,
    documentId: input.documentId,
    session,
    stateVersion: nextStateVersion,
    updatedAt: input.now,
  });
}

/**
 * Converts a sparse request into a durable, typed brief before any writing
 * tool becomes usable. A model may extract explicit facts, but only this
 * deterministic state machine decides whether the brief is ready.
 */
export async function assessDocumentBriefStep(inputValue: {
  workflow: DocumentAgentWorkflowInput;
  promptContext: DocumentRunPromptContext;
  runtime: AgentRuntimeSelection;
}): Promise<DocumentBriefAssessment> {
  "use step";

  const input = parseWorkflowInput(inputValue.workflow);
  const promptContext = DocumentRunPromptContextSchema.parse(
    inputValue.promptContext,
  );
  const runtime = AgentRuntimeSelectionSchema.parse(inputValue.runtime);
  const repository = getDocumentRepository();
  const [run, document, stored] = await Promise.all([
    requireRun(repository, input.userId, input.runId),
    requireDocument(repository, input.userId, input.documentId),
    repository.getDocumentAgentSession(input.userId, input.documentId),
  ]);
  assertRunScope(run, input.documentId);

  if (stored) {
    const replay = replayedBriefAssessment(stored.session, input.runId);
    if (replay) return replay;
  }

  // Conversational edit path: a fresh prompt against a document that already
  // has content skips intake entirely and runs the agent directly (Base44-style
  // iteration). Without a stored session this also covers ANSWERS to questions
  // an edit run itself raised — a sessionless reply has no intake to return to
  // and must stay an edit run. With a session, replies continue their original
  // flow below, and mid-intake sessions (brief not yet confirmed at its
  // current version) still go through elicitation.
  if (
    document.document.root.length > 0 &&
    (!stored
      ? true
      : input.replyToRunId === null &&
        stored.session.confirmedBriefVersion === stored.session.briefVersion)
  ) {
    return DocumentBriefAssessmentSchema.parse({
      status: "ready",
      brief: null,
      briefVersion: null,
      legacyDocument: true,
    });
  }

  const now = run.createdAt;
  let session =
    stored?.session ??
    createDocumentAgentSession({
      sessionId: deterministicUuid(
        `${input.documentId}:document-agent-session:${input.runId}`,
      ),
      documentId: input.documentId,
      rootRunId: input.runId,
      deliverable: document.document.metadata.documentType,
      now,
    });

  // Older sessions could confirm a figures mode that the current runtime
  // cannot execute because file ingestion is not available yet. Reopen that
  // single requirement before any planning or writing tool becomes usable.
  if (
    session.brief.figures.policy.value === "provided_only" &&
    session.confirmedBriefVersion === session.briefVersion
  ) {
    session = DocumentAgentSessionSchema.parse({
      ...session,
      phase: "eliciting",
      confirmedBriefVersion: null,
    });
  }

  const activeQuestion = sessionActiveQuestion(session);
  if (activeQuestion) {
    if (
      input.replyToRunId !== activeQuestion.sourceRunId ||
      promptContext.clarification?.sourceRunId !== activeQuestion.sourceRunId
    ) {
      throw new FatalError(
        "回答先の確認内容が現在の文書と一致しません。最新の質問からもう一度お答えください。",
      );
    }
  } else if (input.replyToRunId !== null && stored) {
    // A question discovered during writing is not part of intake. Its answer
    // uses the already-confirmed brief and continues the writer unchanged.
    if (session.confirmedBriefVersion === session.briefVersion) {
      session = DocumentAgentSessionSchema.parse({
        ...session,
        phase: "drafting",
      });
    } else {
      throw new FatalError("確認内容がすでに更新されています。");
    }
  }

  if (
    session.confirmedBriefVersion !== session.briefVersion ||
    activeQuestion !== null ||
    !stored ||
    input.replyToRunId === null
  ) {
    const extraction = await extractBriefRequirements({
      prompt: input.prompt,
      runtime,
      activeQuestion,
    });
    session = applyBriefExtraction({
      session,
      extraction,
      answerText: input.prompt,
      runId: input.runId,
      now,
      ...(activeQuestion ? { questionId: activeQuestion.id } : {}),
    });
  }

  // Build-first: with the subject in hand, remaining requirements delegate to
  // their defaults and the brief self-confirms so writing starts immediately.
  const autopilot = autopilotDocumentBrief({
    session,
    runId: input.runId,
    now,
  });
  if (autopilot) session = autopilot;

  const advanced = advanceElicitation({
    session,
    sourceRunId: input.runId,
    now,
  });
  const executionSession = advanced.ready
    ? DocumentAgentSessionSchema.parse({
        ...advanced.session,
        phase: "drafting",
      })
    : advanced.session;
  const candidate = prepareStoredAgentSession({
    userId: input.userId,
    documentId: input.documentId,
    session: executionSession,
    expectedStateVersion: stored?.stateVersion ?? null,
    runId: input.runId,
    now,
  });
  const saved = input.replyToRunId
    ? await repository.saveDocumentAgentSessionForClarificationReply(
        candidate,
        stored?.stateVersion ?? null,
        {
          responseRunId: input.runId,
          sourceRunId: input.replyToRunId,
        },
      )
    : await repository.saveDocumentAgentSession(
        candidate,
        stored?.stateVersion ?? null,
      );

  if (!advanced.ready) {
    const question = sessionActiveQuestion(saved.session);
    if (!question) {
      throw new Error("An incomplete document brief has no active question.");
    }
    return DocumentBriefAssessmentSchema.parse({
      status: "needs_input",
      question: question.prompt,
      briefSummary: advanced.briefSummary,
    });
  }
  return DocumentBriefAssessmentSchema.parse({
    status: "ready",
    brief: saved.session.brief,
    briefVersion: saved.session.briefVersion,
    legacyDocument: false,
  });
}

/** Creates a durable typed plan only from the persisted confirmed brief. */
export async function createDocumentPlanStep(inputValue: {
  workflow: DocumentAgentWorkflowInput;
  runtime: AgentRuntimeSelection;
}): Promise<DocumentPlan> {
  "use step";

  const input = parseWorkflowInput(inputValue.workflow);
  const runtime = AgentRuntimeSelectionSchema.parse(inputValue.runtime);
  const repository = getDocumentRepository();
  const [run, stored] = await Promise.all([
    requireRun(repository, input.userId, input.runId),
    repository.getDocumentAgentSession(input.userId, input.documentId),
  ]);
  assertRunScope(run, input.documentId);
  if (!stored) throw new FatalError("確定した文書の条件を読み取れませんでした。");
  const { session } = stored;
  if (
    session.confirmedBriefVersion !== session.briefVersion ||
    session.phase !== "drafting"
  ) {
    throw new FatalError("文書の条件を確認してから構成を作成してください。");
  }

  const plan = await createDocumentPlan({
    brief: session.brief,
    briefVersion: session.briefVersion,
    now: run.createdAt,
    runtime,
  });
  if (
    plan.documentId !== input.documentId ||
    plan.briefVersion !== session.briefVersion ||
    plan.briefDigest !== createDocumentBriefDigest(session.brief)
  ) {
    throw new Error("The generated document plan does not match the brief.");
  }
  return DocumentPlanSchema.parse(plan);
}

/** Reviews a fixed document revision in a model call independent of writing. */
export async function reviewDocumentStep(inputValue: {
  workflow: DocumentAgentWorkflowInput;
  revision: number;
  plan: DocumentPlan;
  runtime: Extract<AgentRuntimeSelection, { provider: "ai_gateway" }>;
}): Promise<IndependentDocumentReview> {
  "use step";

  const input = parseWorkflowInput(inputValue.workflow);
  const revisionNumber = z.number().int().positive().parse(inputValue.revision);
  const plan = DocumentPlanSchema.parse(inputValue.plan);
  const runtime = AgentRuntimeSelectionSchema.parse(inputValue.runtime);
  if (runtime.provider !== "ai_gateway") {
    throw new Error("Independent review requires the configured AI runtime.");
  }
  const repository = getDocumentRepository();
  const [run, document, stored] = await Promise.all([
    requireRun(repository, input.userId, input.runId),
    requireDocument(repository, input.userId, input.documentId),
    repository.getDocumentAgentSession(input.userId, input.documentId),
  ]);
  assertRunScope(run, input.documentId);
  if (!stored || stored.session.confirmedBriefVersion !== plan.briefVersion) {
    throw new FatalError("確認済みの条件と文書を照合できませんでした。");
  }
  const target =
    document.currentRevision === revisionNumber
      ? document.document
      : (
          await repository.getRevision(
            input.userId,
            input.documentId,
            revisionNumber,
          )
        )?.document;
  if (!target) throw new FatalError("確認する文書の版が見つかりません。");

  const reviewedDocument = validateDocument(target);
  const projection = createReviewPlanProjection(plan);
  const deterministicAcceptance = evaluateDeterministicAcceptance({
    brief: stored.session.brief,
    briefVersion: stored.session.briefVersion,
    plan: projection,
    document: reviewedDocument,
    documentRevision: revisionNumber,
    additionalCriteria: [],
  });

  const citedSourceIds = [
    ...new Set(
      reviewedDocument.nodes.flatMap((node) =>
        node.type === "citation" && node.sourceId ? [node.sourceId] : [],
      ),
    ),
  ].sort();
  // At most 100 immutable source records can belong to one document. Extra
  // identifiers remain visible in the document snapshot and are therefore
  // recorded as unavailable rather than queried in an oversized batch.
  const sources = await repository.listSourceRecordsByIds(
    input.userId,
    input.documentId,
    citedSourceIds.slice(0, 100),
  );
  const researchReviewRunId = createResearchReviewRunId({
    authoringRunId: input.runId,
    documentRevision: revisionNumber,
  });
  const researchContext: ResearchLedgerContext = {
    userId: input.userId,
    document: reviewedDocument,
    documentRevision: revisionNumber,
    briefVersion: stored.session.briefVersion,
    briefDigest: createDocumentBriefDigest(stored.session.brief),
    plan,
    authoringRunId: input.runId,
    reviewer: {
      provider: "AI Gateway",
      model: runtime.model,
      reviewRunId: researchReviewRunId,
    },
    sources,
    createdAt: run.createdAt,
  };
  const researchLedgerId = createResearchLedgerId(researchContext);
  const replayedLedger = await repository.getResearchLedger(
    input.userId,
    input.documentId,
    researchLedgerId,
  );
  let researchLedger = replayedLedger
    ? validateResearchLedgerAgainstContext({
        ledger: replayedLedger,
        context: researchContext,
      })
    : null;
  if (!researchLedger) {
    const researchReview = await reviewResearchEvidenceIndependently({
      document: reviewedDocument,
      documentRevision: revisionNumber,
      plan,
      sources,
      authoringRunId: input.runId,
      runtime,
    });
    if (researchReview.reviewRunId !== researchReviewRunId) {
      throw new Error("Independent research review did not match its target.");
    }
    try {
      researchLedger = buildResearchLedger({
        context: researchContext,
        draft: researchReview.draft,
      });
    } catch {
      // Invalid or invented evidence is never repaired into a passing result.
      // Preserve a durable blocked assessment so retries cannot reinterpret it.
      researchLedger = buildResearchLedger({
        context: researchContext,
        draft: ResearchEvidenceDraftSchema.parse({
          claims: plan.sections.flatMap((section) =>
            section.researchClaims.map((claim) => ({
              claimId: claim.id,
              rationale: "この主張と本文、資料の対応を確認できませんでした。",
              realization: null,
              evidence: [],
            })),
          ),
        }),
      });
    }
    researchLedger = validateResearchLedgerAgainstContext({
      ledger: await repository.saveResearchLedger(researchLedger),
      context: researchContext,
    });
  }

  return reviewDocumentIndependently({
    document: reviewedDocument,
    documentRevision: revisionNumber,
    brief: stored.session.brief,
    plan,
    authoringRunId: input.runId,
    runtime,
    now: run.createdAt,
    deterministicAcceptance,
    researchLedger,
    frozenSources: freezeResearchSources(sources),
  });
}

export async function recordSemanticStageStep(
  inputValue: DocumentAgentWorkflowInput,
  stageValue: AgentRunStage,
  eventKey: string,
  detailValue: { code?: string; attempt?: number; issueCount?: number } = {},
): Promise<void> {
  "use step";

  const input = parseWorkflowInput(inputValue);
  const stage = SemanticStageSchema.parse(stageValue);
  const detail = SafeEventDetailSchema.parse(detailValue);
  const repository = getDocumentRepository();
  const run = await requireRun(repository, input.userId, input.runId);
  assertRunScope(run, input.documentId);

  await repository.updateRun(input.userId, input.runId, {
    status: stage === "needs_input" ? "waiting_approval" : "running",
    stage,
  });

  const events = await repository.listRunEvents(input.userId, input.runId);
  if (hasSemanticEvent(events, eventKey)) return;

  await repository.appendRunEvent({
    userId: input.userId,
    runId: input.runId,
    stage,
    message: SEMANTIC_PROGRESS_LABELS[stage],
    detail: { eventKey, ...detail },
  });
}

export async function readDocumentToolStep(
  input: ReadDocumentInput,
  contextValue: DocumentToolContext,
): Promise<DocumentModel> {
  "use step";

  const { context, repository, document } = await loadToolScope(contextValue);
  if (input.revision === undefined) {
    return validateDocument(document.document);
  }

  const revision = await repository.getRevision(
    context.actorId,
    context.documentId,
    input.revision,
  );
  if (!revision) throw new FatalError("指定された文書の版が見つかりません。");
  return validateDocument(revision.document);
}

const DIRECT_TRANSPORT_SCHOLARLY_HOSTS = new Set([
  "arxiv.org",
  "www.arxiv.org",
  "export.arxiv.org",
  "doi.org",
  "dx.doi.org",
  "www.doi.org",
]);

/**
 * Without the provider-executed search tool, the direct transport has no
 * authorization evidence for sources the model proposes from its own
 * knowledge. Instead of blocking autonomous sourcing entirely, the fetch
 * surface narrows to canonical DOI locators and arXiv HTTPS URLs: untrusted
 * content can steer fetches only within these public archives, arbitrary
 * hosts stay closed, and the resolver's IP policy still applies to every
 * request.
 */
function directTransportScholarlyLocator(
  locator: string,
): CanonicalizedSourceLocator | null {
  if (!usesDirectOpenAiTransport()) return null;
  let canonical: CanonicalizedSourceLocator;
  try {
    canonical = canonicalizeSourceLocator(locator);
  } catch {
    return null;
  }
  if (canonical.kind === "doi") return canonical;
  try {
    const host = new URL(canonical.canonicalLocator).hostname.toLowerCase();
    return DIRECT_TRANSPORT_SCHOLARLY_HOSTS.has(host) ? canonical : null;
  } catch {
    return null;
  }
}

export async function resolveSourceToolStep(
  input: ResolveSourceInput,
  contextValue: DocumentToolContext,
  execution?: DocumentToolExecution,
): Promise<ResolveSourceResult> {
  "use step";

  const { context, repository, run } = await loadToolScope(contextValue);
  if (!execution) {
    throw new FatalError("この資料を確認できません。");
  }

  const trustedPrompt = await trustedSourcePromptForRun(repository, run);
  let authorized: ReturnType<typeof authorizedSourceLocator>;
  try {
    authorized = authorizedSourceLocator({
      locator: input.locator,
      trustedPrompt,
      messages: execution.messages,
      searchToolName: "search_sources",
    });
  } catch (error) {
    if (!(error instanceof SourceAuthorizationError)) throw error;
    const fallback = directTransportScholarlyLocator(input.locator);
    if (!fallback) {
      throw new FatalError("この資料は確認対象として指定されていません。");
    }
    authorized = fallback;
  }

  const existing = await repository.getSourceRecordByLocator(
    context.actorId,
    context.documentId,
    authorized.canonicalLocator,
  );
  if (existing) return resolvedSourceToolResult(existing);

  let source;
  try {
    source = await resolveSource({
      id: deterministicUuid(
        `${context.actorId}:${context.documentId}:source:${authorized.canonicalLocator}`,
      ),
      userId: context.actorId,
      documentId: context.documentId,
      locator: authorized.canonicalLocator,
    });
  } catch (error) {
    if (error instanceof SourceResolutionError) {
      return {
        status: "unavailable",
        message: "資料を確認できませんでした。別の候補を選んでください。",
      };
    }
    throw error;
  }

  const persisted = await repository.saveSourceRecord(source);
  return resolvedSourceToolResult(persisted);
}

async function applyPatchDurably(
  scope: Awaited<ReturnType<typeof loadToolScope>>,
  input: ApplyDocumentPatchInput,
): Promise<DocumentMutationResult> {
  const { context, repository, run, document } = scope;
  const storedSession = await repository.getDocumentAgentSession(
    context.actorId,
    context.documentId,
  );
  const scopedLegacyContract = storedSession
    ? null
    : parseStronglyScopedLegacyEdit(run.prompt);
  const scopedLegacyEdit = scopedLegacyContract
    ? patchMatchesScopedLegacyEdit({
        contract: scopedLegacyContract,
        document: document.document,
        currentRevision: document.currentRevision,
        patch: input.patch,
      })
    : false;
  const mutationReadiness = documentMutationReadiness({
    session: storedSession?.session ?? null,
    documentHasContent: document.document.root.length > 0,
    scopedLegacyEdit,
    // Recomputed from the persisted run so tool-step replays agree.
    contentEditRun: isContentEditRun({
      replyToRunId: run.replyToRunId,
      decision: run.decision,
      documentHasContent: document.document.root.length > 0,
    }),
  });
  if (!mutationReadiness.allowed) {
    throw new FatalError(
      "文書の条件がまだ確定していません。必要な確認に回答してから続けてください。",
    );
  }
  // The workflow boundary serializes tool schemas without their zod
  // validators, so the raw model output lands here unparsed. Normalize
  // model-invented slug ids into stable UUIDs, then make zod the gate and
  // return its findings as a repairable tool error instead of a dead end.
  const parsedPatch = DocumentPatchSchema.safeParse(
    normalizeModelDocumentPatch(context.documentId, input.patch),
  );
  if (!parsedPatch.success) {
    const details = parsedPatch.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(" / ");
    throw new FatalError(
      `文書パッチが契約に合いません。修正して再送してください: ${details}`,
    );
  }
  let patch: DocumentPatch = parsedPatch.data;

  if (patch.documentId !== context.documentId) {
    throw new FatalError("この文書には変更を適用できません。");
  }

  let baseRevision: DocumentRevision;
  if (document.currentRevision === patch.baseRevision) {
    baseRevision = storedDocumentRevision(document);
  } else {
    const storedBase = await repository.getRevision(
      context.actorId,
      context.documentId,
      patch.baseRevision,
    );
    if (!storedBase) {
      throw new FatalError(
        "文書の基準となる版が見つかりません。内容を読み直してください。",
      );
    }
    baseRevision = {
      revisionId: storedBase.commitId,
      revision: storedBase.revision,
      parentRevisionId: null,
      committedAt: storedBase.createdAt,
      document: storedBase.document,
    };
  }

  let citationSourceIds: string[];
  try {
    citationSourceIds = citationSourceIdsForPatch(
      baseRevision.document,
      patch,
    );
  } catch (error) {
    if (!(error instanceof SourceProvenanceError)) throw error;
    await persistNeedsInput(
      repository,
      run,
      "clarification_required",
      "確認できる出典がないため、この引用は追加できません。別の出典を指定するか、出典なしの下書きとして進めますか？",
    );
    throw new FatalError(
      "確認済みの出典に結び付かない引用情報は変更できません。",
    );
  }

  const citationSources = await repository.listSourceRecordsByIds(
    context.actorId,
    context.documentId,
    citationSourceIds,
  );
  try {
    patch = normalizeCitationPatchWithSources({
      document: baseRevision.document,
      patch,
      sources: citationSources,
    });
  } catch (error) {
    if (!(error instanceof SourceProvenanceError)) throw error;
    await persistNeedsInput(
      repository,
      run,
      "clarification_required",
      "確認できる出典がないため、この引用は追加できません。別の出典を指定するか、出典なしの下書きとして進めますか？",
    );
    throw new FatalError(
      "確認済みの出典に結び付かない引用情報は変更できません。",
    );
  }

  if (workflowNeedsApproval("apply_document_patch", { ...input, patch })) {
    await persistNeedsInput(
      repository,
      run,
      "approval_required",
      "この内容を削除してよいですか？",
      { patch, summary: input.summary },
    );
    throw new FatalError(
      "この変更には明示的な承認が必要です。現在の実行では変更しません。",
    );
  }

  let next: DocumentRevision;
  try {
    next = applyDocumentPatch(baseRevision, patch);
  } catch (error) {
    // The bare "Document validation failed" is unrepairable for the model;
    // surface the concrete issues so the next patch attempt can fix them.
    if (error instanceof DocumentValidationError) {
      const details = error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join(" / ");
      throw new FatalError(
        `適用後の文書が検証に失敗しました。修正して再送してください: ${details}`,
      );
    }
    throw error;
  }
  try {
    await repository.commitDocument({
      userId: context.actorId,
      documentId: context.documentId,
      commitId: patch.id,
      expectedRevision: patch.baseRevision,
      document: next.document,
      actor: "agent",
      summary: input.summary,
      operations: patch.operations,
    });
  } catch (error) {
    if (!(error instanceof RevisionConflictError)) throw error;
    throw new FatalError(
      "文書が別の操作で更新されました。内容を読み直してください。",
    );
  }

  const persisted = await repository.getRevision(
    context.actorId,
    context.documentId,
    patch.baseRevision + 1,
  );
  if (!persisted || persisted.commitId !== patch.id) {
    throw new Error("Committed document revision is unavailable.");
  }
  const persistedRevision = persisted.revision;

  await repository.updateRun(context.actorId, context.runId, {
    status: "running",
    stage: "writing",
    resultRevision: Math.max(run.resultRevision ?? 0, persistedRevision),
  });

  return {
    ok: true,
    revision: persistedRevision,
    summary: input.summary,
  };
}

export async function applyDocumentPatchToolStep(
  input: ApplyDocumentPatchInput,
  contextValue: DocumentToolContext,
  execution?: DocumentToolExecution,
): Promise<DocumentMutationResult> {
  "use step";

  const scope = await loadToolScope(contextValue);
  await claimToolMutation(
    scope.repository,
    scope.run,
    "apply_document_patch",
    execution,
  );
  return applyPatchDurably(scope, input);
}

export async function checkDocumentToolStep(
  input: CheckDocumentInput,
  contextValue: DocumentToolContext,
): Promise<DocumentCheckResult> {
  "use step";

  const { context, repository, document } = await loadToolScope(contextValue);
  const revisionNumber = input.revision ?? document.currentRevision;
  const revision =
    revisionNumber === document.currentRevision
      ? { document: document.document }
      : await repository.getRevision(
          context.actorId,
          context.documentId,
          revisionNumber,
        );
  if (!revision) throw new FatalError("指定された文書の版が見つかりません。");

  const validation = safeValidateDocument(revision.document);
  if (validation.success) {
    return { ok: true, revision: revisionNumber, issues: [] };
  }

  return {
    ok: false,
    revision: revisionNumber,
    issues: validation.error.issues.slice(0, 100).map((issue) => ({
      code: issue.code,
      message: safeValidationMessage(issue.code),
    })),
  };
}

class ConfirmedLayoutNeedsInput extends Error {
  constructor(readonly question: string) {
    super(question);
    this.name = "ConfirmedLayoutNeedsInput";
  }
}

function normalizeConfirmedPageSize(value: string | null): DocumentLayout["pageSize"] {
  if (!value) {
    throw new ConfirmedLayoutNeedsInput(
      "用紙サイズを確認できません。A3、A4、A5、B4、B5、レターから選んでください。",
    );
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  const aliases: Readonly<Record<string, DocumentLayout["pageSize"]>> =
    Object.freeze({
      a3: "A3",
      a4: "A4",
      a5: "A5",
      b4: "B4",
      b5: "B5",
      letter: "letter",
      lettersize: "letter",
      "レター": "letter",
      "レターサイズ": "letter",
    });
  const pageSize = aliases[normalized];
  if (!pageSize) {
    throw new ConfirmedLayoutNeedsInput(
      "この用紙サイズには対応していません。A3、A4、A5、B4、B5、レターから選んでください。",
    );
  }
  return pageSize;
}

/** Converts only a confirmed, allowlisted brief layout into renderer data. */
export function documentLayoutFromConfirmedBrief(
  brief: DocumentBrief,
): DocumentLayout {
  const family = brief.template.family.value;
  let preset: DocumentLayout["preset"];
  switch (family) {
    case "academic":
      preset = "academic";
      break;
    case "business":
      preset = "business";
      break;
    case "notes":
    case "compact":
      preset = "compact";
      break;
    case "general":
    case "letter":
      preset = "standard";
      break;
    case "custom": {
      const safePreset = resolveSafeCustomTemplatePreset(
        brief.template.customTemplate.value,
      );
      if (!safePreset) {
        throw new ConfirmedLayoutNeedsInput(
          "仕上がりに近い形式を、標準、学術、ビジネス、コンパクトから選んでください。",
        );
      }
      preset = safePreset;
      break;
    }
    case null:
      throw new ConfirmedLayoutNeedsInput(
        "文書の体裁を確認できません。標準、学術、ビジネス、コンパクトから選んでください。",
      );
  }

  const columns = brief.template.columns.value;
  if (columns !== 1 && columns !== 2) {
    throw new ConfirmedLayoutNeedsInput(
      "段組を確認できません。1段または2段から選んでください。",
    );
  }
  return DocumentLayoutSchema.parse({
    preset,
    pageSize: normalizeConfirmedPageSize(brief.template.pageSize.value),
    columns,
  });
}

/** Normalizes only known citation-style aliases from the confirmed brief. */
export function documentCitationStyleFromConfirmedBrief(
  brief: DocumentBrief,
): DocumentCitationStyle | null {
  if (brief.sources.policy.value === "none") return null;
  const value = brief.sources.citationStyle.value;
  if (!value) {
    throw new ConfirmedLayoutNeedsInput(
      "引用形式を確認できません。著者年、APA第7版、IEEE、番号方式から選んでください。",
    );
  }
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/gu, "-");
  let style: DocumentCitationStyle["style"] | null = null;
  if (
    ["author-year", "authoryear", "著者年", "著者年方式", "harvard", "ハーバード"].includes(
      normalized,
    )
  ) {
    style = "author-year";
  } else if (["apa", "apa7", "apa-7", "apa第7版", "apa-第7版"].includes(normalized)) {
    style = "apa7";
  } else if (normalized === "ieee") {
    style = "ieee";
  } else if (
    ["numeric", "numbered", "番号", "番号方式", "数値", "数値方式"].includes(
      normalized,
    )
  ) {
    style = "numeric";
  }
  if (!style) {
    throw new ConfirmedLayoutNeedsInput(
      "指定された引用形式には対応していません。著者年、APA第7版、IEEE、番号方式から選んでください。",
    );
  }
  return DocumentCitationStyleSchema.parse({ schemaVersion: 1, style });
}

function assertSupportedConfirmedPageTarget(brief: DocumentBrief): void {
  const targetLength = brief.scope.targetLength.value;
  if (
    targetLength &&
    /(?:ページ|頁|pages?)/iu.test(targetLength) &&
    parsePageTarget(targetLength) === null
  ) {
    throw new ConfirmedLayoutNeedsInput(
      "ページ数は1〜500ページの範囲で、数値または範囲を指定してください。",
    );
  }
}

function confirmedDocumentMetadata(brief: DocumentBrief): {
  documentType: DocumentModel["metadata"]["documentType"];
  language: string;
  writingStyle: DocumentWritingStyle;
} {
  const documentType = brief.goal.deliverable.value;
  if (!documentType) {
    throw new ConfirmedLayoutNeedsInput(
      "作成する文書の種類を確認してください。",
    );
  }
  const languageValue = brief.scope.language.value;
  const language = languageValue
    ? normalizeDocumentLanguage(languageValue)
    : null;
  if (!language) {
    throw new ConfirmedLayoutNeedsInput(
      "本文に使う言語を、言語名または言語コードで指定してください。",
    );
  }
  const style = {
    register: brief.tone.register.value,
    voice: brief.tone.voice.value,
    jargonLevel: brief.tone.jargonLevel.value,
    sentenceStyle: brief.tone.sentenceStyle.value,
  };
  const writingStyle = DocumentWritingStyleSchema.safeParse(style);
  if (!writingStyle.success) {
    throw new ConfirmedLayoutNeedsInput(
      "文章の調子を確認してください。",
    );
  }
  return { documentType, language, writingStyle: writingStyle.data };
}

function layoutsEqual(
  left: DocumentLayout | undefined,
  right: DocumentLayout,
): boolean {
  return (
    left?.preset === right.preset &&
    left.pageSize === right.pageSize &&
    left.columns === right.columns
  );
}

async function formatDocumentDurably(
  scope: Awaited<ReturnType<typeof loadToolScope>>,
  baseRevision: number,
  layout: DocumentLayout,
  summary: string,
  citationStyle: DocumentCitationStyle | null | undefined = undefined,
  confirmedMetadata?: {
    documentType: DocumentModel["metadata"]["documentType"];
    language: string;
    writingStyle: DocumentWritingStyle;
  },
): Promise<DocumentMutationResult> {
  const { context, document, run } = scope;
  if (baseRevision > document.currentRevision) {
    throw new FatalError("指定された文書の版が見つかりません。内容を読み直してください。");
  }
  const currentCitationStyle = document.document.metadata.citationStyle;
  const targetCitationStyle =
    citationStyle === undefined ? currentCitationStyle : citationStyle ?? undefined;
  const citationStylesEqual =
    currentCitationStyle?.schemaVersion === targetCitationStyle?.schemaVersion &&
    currentCitationStyle?.style === targetCitationStyle?.style;
  const metadataMatches =
    !confirmedMetadata ||
    (document.document.metadata.documentType === confirmedMetadata.documentType &&
      document.document.metadata.language === confirmedMetadata.language &&
      JSON.stringify(document.document.metadata.writingStyle) ===
        JSON.stringify(confirmedMetadata.writingStyle));
  if (
    layoutsEqual(document.document.metadata.layout, layout) &&
    citationStylesEqual &&
    metadataMatches
  ) {
    return {
      ok: true,
      revision: document.currentRevision,
      summary,
    };
  }
  if (baseRevision !== document.currentRevision) {
    throw new FatalError(
      "文書が別の操作で更新されました。内容を読み直してください。",
    );
  }

  const metadata: DocumentModel["metadata"] = {
    ...structuredClone(document.document.metadata),
    layout,
    ...(confirmedMetadata ?? {}),
  };
  if (targetCitationStyle) metadata.citationStyle = targetCitationStyle;
  else delete metadata.citationStyle;
  const patch: DocumentPatch = {
    id: deterministicUuid(
      `${context.actorId}:${context.documentId}:${run.id}:layout:${baseRevision}:${layout.preset}:${layout.pageSize}:${layout.columns}:citation:${targetCitationStyle?.style ?? "none"}:type:${confirmedMetadata?.documentType ?? "unchanged"}:language:${confirmedMetadata?.language ?? "unchanged"}:style:${confirmedMetadata ? JSON.stringify(confirmedMetadata.writingStyle) : "unchanged"}`,
    ),
    documentId: context.documentId,
    baseRevision,
    createdAt: run.createdAt,
    operations: [{ op: "setMetadata", metadata }],
  };
  return applyPatchDurably(scope, { patch, summary });
}

export async function formatDocumentToolStep(
  input: FormatDocumentInput,
  contextValue: DocumentToolContext,
  execution?: DocumentToolExecution,
): Promise<DocumentMutationResult> {
  "use step";

  const scope = await loadToolScope(contextValue);
  await claimToolMutation(
    scope.repository,
    scope.run,
    "format_document",
    execution,
  );
  const currentLayout = scope.document.document.metadata.layout;
  const layout = DocumentLayoutSchema.parse({
    preset: input.preset,
    pageSize: input.pageSize ?? currentLayout?.pageSize ?? "A4",
    columns: input.columns ?? currentLayout?.columns ?? 1,
  });
  const citationStyle = input.citationStyle
    ? DocumentCitationStyleSchema.parse({
        schemaVersion: 1,
        style: input.citationStyle,
      })
    : undefined;
  return formatDocumentDurably(
    scope,
    input.baseRevision,
    layout,
    "文書の体裁を整えました",
    citationStyle,
  );
}

/** Re-applies the persisted confirmed layout independently of model behavior. */
export async function applyConfirmedBriefLayoutStep(inputValue: {
  workflow: DocumentAgentWorkflowInput;
  briefVersion: number;
  baseRevision: number;
}): Promise<
  | ({ status: "applied" } & DocumentMutationResult)
  | { status: "needs_input"; question: string }
> {
  "use step";

  const input = parseWorkflowInput(inputValue.workflow);
  const briefVersion = z.number().int().positive().parse(inputValue.briefVersion);
  const baseRevision = z.number().int().nonnegative().parse(inputValue.baseRevision);
  const scope = await loadToolScope({
    actorId: input.userId,
    documentId: input.documentId,
    runId: input.runId,
  });
  const stored = await scope.repository.getDocumentAgentSession(
    input.userId,
    input.documentId,
  );
  if (
    !stored ||
    stored.session.briefVersion !== briefVersion ||
    stored.session.confirmedBriefVersion !== briefVersion
  ) {
    throw new FatalError("確認済みの文書の体裁を読み取れませんでした。");
  }
  let layout: DocumentLayout;
  let citationStyle: DocumentCitationStyle | null;
  let metadata: ReturnType<typeof confirmedDocumentMetadata>;
  try {
    assertSupportedConfirmedPageTarget(stored.session.brief);
    layout = documentLayoutFromConfirmedBrief(stored.session.brief);
    citationStyle = documentCitationStyleFromConfirmedBrief(
      stored.session.brief,
    );
    metadata = confirmedDocumentMetadata(stored.session.brief);
  } catch (error) {
    if (!(error instanceof ConfirmedLayoutNeedsInput)) throw error;
    await persistNeedsInput(
      scope.repository,
      scope.run,
      "clarification_required",
      error.question,
    );
    return { status: "needs_input", question: error.question };
  }
  const result = await formatDocumentDurably(
    scope,
    baseRevision,
    layout,
    "確認した体裁を反映しました",
    citationStyle,
    metadata,
  );
  return { status: "applied", ...result };
}

export async function requestInputToolStep(
  input: RequestInputInput,
  contextValue: DocumentToolContext,
  execution?: DocumentToolExecution,
): Promise<{ ok: true }> {
  "use step";

  const context = DocumentToolContextSchema.parse(contextValue);
  const repository = getDocumentRepository();
  const run = await requireRun(repository, context.actorId, context.runId);
  if (run.documentId !== context.documentId) {
    throw new FatalError("この文書操作を実行できません。");
  }
  if (run.status === "waiting_approval" && run.stage === "needs_input") {
    // A model may emit more than one tool call in one response. The first
    // persisted question wins and later calls become harmless replays.
    return { ok: true };
  }
  assertRunScope(run, context.documentId);
  await requireDocument(repository, context.actorId, context.documentId);
  await claimToolMutation(repository, run, "request_input", execution);
  await persistNeedsInput(
    repository,
    run,
    "clarification_required",
    input.question,
  );
  return { ok: true };
}

export async function deleteDocumentToolStep(
  _input: DeleteDocumentInput,
  contextValue: DocumentToolContext,
  execution?: DocumentToolExecution,
): Promise<{ ok: true }> {
  "use step";

  const { repository, run } = await loadToolScope(contextValue);
  await claimToolMutation(repository, run, "delete_document", execution);
  throw new FatalError(
    "文書全体の削除は現在利用できません。",
  );
}

export async function publishDocumentToolStep(
  _input: PublishDocumentInput,
  contextValue: DocumentToolContext,
  execution?: DocumentToolExecution,
): Promise<never> {
  "use step";

  const { repository, run } = await loadToolScope(contextValue);
  await claimToolMutation(repository, run, "publish_document", execution);
  throw new FatalError(
    "文書の公開は現在利用できません。自動では実行しません。",
  );
}

export async function runExpensiveTaskToolStep(
  _input: RunExpensiveTaskInput,
  contextValue: DocumentToolContext,
  execution?: DocumentToolExecution,
): Promise<never> {
  "use step";

  const { repository, run } = await loadToolScope(contextValue);
  await claimToolMutation(repository, run, "run_expensive_task", execution);
  throw new FatalError(
    "この高コスト処理は現在利用できません。自動では実行しません。",
  );
}

export async function planFallbackDocumentStep(
  inputValue: {
    workflow: DocumentAgentWorkflowInput;
    promptContext: DocumentRunPromptContext;
  },
): Promise<DeterministicFallbackPlan> {
  "use step";

  const input = parseWorkflowInput(inputValue.workflow);
  const promptContext = DocumentRunPromptContextSchema.parse(
    inputValue.promptContext,
  );
  const repository = getDocumentRepository();
  const [run, document] = await Promise.all([
    requireRun(repository, input.userId, input.runId),
    requireDocument(repository, input.userId, input.documentId),
  ]);
  assertRunScope(run, input.documentId);

  return planDocumentDeterministically({
    prompt: promptContext.effectivePrompt,
    currentDocument: document.document,
    baseRevision: document.currentRevision,
    now: run.createdAt,
  });
}

/** Applies or rejects only the exact patch persisted by the targeted run. */
export async function resolveDocumentRunDecisionStep(
  inputValue: DocumentAgentWorkflowInput,
): Promise<DocumentDecisionRunResult> {
  "use step";

  const input = parseWorkflowInput(inputValue);
  if (input.decision === null) {
    return { status: "not_requested" };
  }
  if (input.replyToRunId === null) {
    throw new FatalError("承認対象を確認できません。");
  }

  const repository = getDocumentRepository();
  const result = await repository.resolvePendingDocumentDecision(
    input.userId,
    input.documentId,
    input.runId,
    input.replyToRunId,
  );
  if (result.status === "applied") {
    return { status: "applied", revision: result.revision };
  }
  if (result.status === "rejected") return { status: "rejected" };
  return { status: "stale", message: result.message };
}

export async function getRunDocumentRevisionStep(
  inputValue: DocumentAgentWorkflowInput,
): Promise<RunDocumentRevisionResult> {
  "use step";

  const input = parseWorkflowInput(inputValue);
  const repository = getDocumentRepository();
  const [run, document] = await Promise.all([
    requireRun(repository, input.userId, input.runId),
    requireDocument(repository, input.userId, input.documentId),
  ]);
  if (run.documentId !== input.documentId) {
    throw new FatalError("この文書操作を実行できません。");
  }
  if (run.status === "waiting_approval" || run.stage === "needs_input") {
    return {
      revision: document.currentRevision,
      changed: document.currentRevision > input.baseRevision,
      hasContent: document.document.root.length > 0,
      needsInput: true,
      question: run.errorMessage ?? undefined,
    };
  }
  assertRunScope(run, input.documentId);

  if (
    run.resultRevision !== null &&
    run.resultRevision !== document.currentRevision
  ) {
    throw new FatalError(
      "文書が別の操作で更新されました。最新の内容からもう一度お試しください。",
    );
  }

  return {
    revision: document.currentRevision,
    changed: document.currentRevision > input.baseRevision,
    hasContent: document.document.root.length > 0,
    needsInput: false,
  };
}

export async function validateRenderCompileAndStoreStep(inputValue: {
  workflow: DocumentAgentWorkflowInput;
  revision: number;
}): Promise<CompileAndStoreResult> {
  "use step";

  const input = parseWorkflowInput(inputValue.workflow);
  const revisionNumber = z.number().int().positive().parse(inputValue.revision);
  const repository = getDocumentRepository();
  const [run, storedSession] = await Promise.all([
    requireRun(repository, input.userId, input.runId),
    repository.getDocumentAgentSession(input.userId, input.documentId),
  ]);
  assertRunScope(run, input.documentId);
  // The brief's page target binds runs the brief flow itself processed
  // (session.lastProcessedRunId advances for those). Conversational edit runs
  // never touch the session, and shrinking or growing the document on request
  // must not fight a page target confirmed for the original commission.
  let targetLength: string | null = null;
  if (
    storedSession &&
    storedSession.session.lastProcessedRunId === input.runId &&
    storedSession.session.confirmedBriefVersion ===
      storedSession.session.briefVersion &&
    (storedSession.session.brief.scope.targetLength.status === "provided" ||
      storedSession.session.brief.scope.targetLength.status === "delegated")
  ) {
    targetLength = storedSession.session.brief.scope.targetLength.value;
  }

  const runtime = selectAgentRuntime(process.env);
  return compileDocumentRevision({
    userId: input.userId,
    documentId: input.documentId,
    revision: revisionNumber,
    targetLength,
    visualReviewRuntime: runtime.provider === "ai_gateway" ? runtime : null,
  });
}

export async function completeDocumentRunStep(inputValue: {
  workflow: DocumentAgentWorkflowInput;
  revision: number;
  artifact: ArtifactReleaseBinding;
  eventKey: string;
  resultNote?: string | null;
}): Promise<DocumentAgentArtifactSummary> {
  "use step";

  const input = parseWorkflowInput(inputValue.workflow);
  const revision = z.number().int().positive().parse(inputValue.revision);
  // Sanitized where produced, and re-sanitized here so the stored note is
  // safe regardless of the caller.
  const resultNote = normalizeUserFacingResultNote(inputValue.resultNote);
  const completed = await getDocumentRepository().completeRunForCurrentRevision({
    userId: input.userId,
    documentId: input.documentId,
    runId: input.runId,
    revision,
    artifact: inputValue.artifact,
    eventKey: inputValue.eventKey,
    eventMessage: SEMANTIC_PROGRESS_LABELS.ready,
    resultNote,
  });

  return {
    revision,
    sha256: completed.artifact.sha256,
    byteSize: completed.artifact.byteSize,
  };
}

export async function markDocumentRunNeedsInputStep(inputValue: {
  workflow: DocumentAgentWorkflowInput;
  code: "clarification_required" | "approval_required";
  question: string;
  pendingAction?: { patch: DocumentPatch; summary: string };
}): Promise<void> {
  "use step";

  const input = parseWorkflowInput(inputValue.workflow);
  const repository = getDocumentRepository();
  const run = await requireRun(repository, input.userId, input.runId);
  assertRunScope(run, input.documentId);
  await persistNeedsInput(
    repository,
    run,
    inputValue.code,
    inputValue.question,
    inputValue.pendingAction,
  );
}

export async function failDocumentRunStep(inputValue: {
  workflow: DocumentAgentWorkflowInput;
  code: string;
}): Promise<void> {
  "use step";

  const parsed = WorkflowInputSchema.safeParse(inputValue.workflow);
  if (!parsed.success) return;
  const input = parsed.data;
  const repository = getDocumentRepository();
  const run = await repository.getRun(input.userId, input.runId);
  if (!run || run.status === "completed" || run.status === "cancelled") return;
  if (run.documentId !== input.documentId) return;
  if (run.status === "waiting_approval" || run.stage === "needs_input") return;

  // Brief assessment persists the next active question before the workflow
  // presents it. If that presentation step exhausts its retries, heal the run
  // into the persisted question instead of making its reply target impossible.
  const storedSession = await repository.getDocumentAgentSession(
    input.userId,
    input.documentId,
  );
  const activeQuestion = storedSession?.session.activeQuestionId
    ? storedSession.session.questions.find(
        (question) => question.id === storedSession.session.activeQuestionId,
      )
    : null;
  if (
    activeQuestion?.status === "pending" &&
    activeQuestion.sourceRunId === run.id
  ) {
    await persistNeedsInput(
      repository,
      run,
      "clarification_required",
      activeQuestion.prompt,
    );
    return;
  }

  await repository.updateRun(input.userId, input.runId, {
    status: "failed",
    stage: "failed",
    errorMessage: "文書の作成を完了できませんでした。",
  });
  const eventKey = semanticEventKey(input.runId, "failed");
  const events = await repository.listRunEvents(input.userId, input.runId);
  if (hasSemanticEvent(events, eventKey)) return;
  await repository.appendRunEvent({
    userId: input.userId,
    runId: input.runId,
    stage: "failed",
    message: SEMANTIC_PROGRESS_LABELS.failed,
    detail: {
      eventKey,
      code: inputValue.code.slice(0, 100),
    },
  });
}

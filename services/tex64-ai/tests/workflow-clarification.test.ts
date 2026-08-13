import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyDocumentPatch,
  DocumentSchema,
  type DocumentPatch,
} from "@/domain/document";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import {
  RunReplyConflictError,
  type DocumentRepository,
  type RunDecision,
} from "@/server/persistence";
import { documentPatchDigest } from "@/server/persistence/pending-actions";
import {
  markDocumentRunNeedsInputStep,
  planFallbackDocumentStep,
  requestInputToolStep,
  resolveDocumentRunPromptStep,
} from "@/workflows/document-agent/steps";
import { buildInitialAgentPrompt } from "@/workflows/document-agent/helpers";
import type { DocumentAgentWorkflowInput } from "@/workflows/document-agent/types";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "40c7df69-05ef-4fe0-bb2d-a21779510c9a";
const QUESTION_RUN_ID = "10000000-0000-4000-8000-000000000001";
const ANSWER_RUN_ID = "10000000-0000-4000-8000-000000000002";
const INTERVENING_RUN_ID = "10000000-0000-4000-8000-000000000003";
const LATER_RUN_ID = "10000000-0000-4000-8000-000000000004";
const NOW = "2026-08-07T12:00:00.000+09:00";

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-clarification-"));
  repository = new LocalDocumentRepository(
    path.join(temporaryDirectory, "store.json"),
  );
  (globalThis as RepositoryGlobal).__tex64DocumentRepository = repository;
  await repository.createDocument(
    USER_ID,
    DocumentSchema.parse({
      schemaVersion: 1,
      id: DOCUMENT_ID,
      metadata: {
        title: "新しい論文",
        language: "ja",
        documentType: "paper",
        authors: [],
        keywords: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
      root: [],
      nodes: [],
    }),
  );
});

afterEach(async () => {
  delete (globalThis as RepositoryGlobal).__tex64DocumentRepository;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function createRunningRun(input: {
  id: string;
  prompt: string;
  idempotencyKey: string;
  replyToRunId?: string | null;
  decision?: RunDecision | null;
}): Promise<DocumentAgentWorkflowInput> {
  const run = await repository.createRun({
    id: input.id,
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    prompt: input.prompt,
    replyToRunId: input.replyToRunId ?? null,
    decision: input.decision ?? null,
    idempotencyKey: input.idempotencyKey,
    baseRevision: 1,
  });
  await repository.activateRunForWorkflow(
    USER_ID,
    run.id,
    `workflow-${run.id}`,
  );
  return {
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    runId: run.id,
    prompt: run.prompt,
    baseRevision: run.baseRevision,
    replyToRunId: run.replyToRunId,
    decision: run.decision,
  };
}

function destructivePatch(): DocumentPatch {
  return {
    id: "50000000-0000-4000-8000-000000000001",
    documentId: DOCUMENT_ID,
    baseRevision: 1,
    createdAt: NOW,
    operations: [
      {
        op: "insert",
        node: {
          id: "50000000-0000-4000-8000-000000000002",
          type: "paragraph",
          content: [{ type: "text", text: "削除対象", marks: [] }],
        },
        position: { kind: "root", index: 0 },
      },
      {
        op: "delete",
        nodeId: "50000000-0000-4000-8000-000000000002",
      },
    ],
  };
}

describe.sequential("durable clarification continuation", () => {
  it("passes the full accepted standalone request to the model prompt", async () => {
    const fullPrompt = `${"長い依頼".repeat(4_999)}TAIL`;
    expect(fullPrompt.length).toBe(20_000);
    const run = await createRunningRun({
      id: QUESTION_RUN_ID,
      prompt: fullPrompt,
      idempotencyKey: "full-standalone-prompt-1",
    });

    const context = await resolveDocumentRunPromptStep(run);
    expect(context.effectivePrompt).toBe(fullPrompt);
    expect(
      buildInitialAgentPrompt({
        promptContext: context,
        documentId: DOCUMENT_ID,
        currentRevision: 1,
      }),
    ).toContain(fullPrompt);
  });

  it("passes a long newest clarification answer in full despite bounded history", async () => {
    const questionRun = await createRunningRun({
      id: QUESTION_RUN_ID,
      prompt: "論文を書いて",
      idempotencyKey: "long-answer-question-1",
    });
    await markDocumentRunNeedsInputStep({
      workflow: questionRun,
      code: "clarification_required",
      question: "どの条件を反映しますか？",
    });

    const fullAnswer = `${"詳細条件".repeat(2_000)}LATEST_TAIL`;
    expect(fullAnswer.length).toBeGreaterThan(6_000);
    const answerRun = await createRunningRun({
      id: ANSWER_RUN_ID,
      prompt: fullAnswer,
      idempotencyKey: "long-answer-reply-1",
      replyToRunId: QUESTION_RUN_ID,
    });
    const context = await resolveDocumentRunPromptStep(answerRun);
    const modelPrompt = buildInitialAgentPrompt({
      promptContext: context,
      documentId: DOCUMENT_ID,
      currentRevision: 1,
    });

    expect(context.clarification?.answer).toBe(fullAnswer);
    expect(context.history).toMatchObject({ truncated: true });
    expect(context.history?.turns[0]?.answer.length).toBe(800);
    expect(modelPrompt).toContain(fullAnswer);
    expect(modelPrompt).toContain("LATEST_TAIL");
    expect(modelPrompt).toContain("currentClarification");
  });

  it("persists only the first question from an agent run", async () => {
    const run = await createRunningRun({
      id: QUESTION_RUN_ID,
      prompt: "論文を書いて",
      idempotencyKey: "single-question-1",
    });
    const context = {
      documentId: DOCUMENT_ID,
      runId: run.runId,
      actorId: USER_ID,
    };

    await requestInputToolStep(
      { question: "何について書きますか？" },
      context,
    );
    await requestInputToolStep(
      { question: "文字数はいくつですか？" },
      context,
    );

    expect(await repository.getRun(USER_ID, QUESTION_RUN_ID)).toMatchObject({
      status: "waiting_approval",
      stage: "needs_input",
      errorMessage: "何について書きますか？",
    });
    const events = await repository.listRunEvents(USER_ID, QUESTION_RUN_ID);
    expect(events.filter((event) => event.stage === "needs_input")).toHaveLength(
      1,
    );
    expect(events.at(-1)?.detail).toMatchObject({
      code: "clarification_required",
      question: "何について書きますか？",
    });
  });

  it("continues a generic paper request from exactly one question and answer without a gateway", async () => {
    const questionRun = await createRunningRun({
      id: QUESTION_RUN_ID,
      prompt: "論文を書いて",
      idempotencyKey: "clarification-question-1",
    });
    await markDocumentRunNeedsInputStep({
      workflow: questionRun,
      code: "clarification_required",
      question: "何について書きますか？",
    });

    const answerRun = await createRunningRun({
      id: ANSWER_RUN_ID,
      prompt: "注意機構について",
      idempotencyKey: "clarification-answer-1",
      replyToRunId: QUESTION_RUN_ID,
    });
    const context = await resolveDocumentRunPromptStep(answerRun);

    expect(context).toMatchObject({
      effectivePrompt: "注意機構について論文を書いて",
      clarification: {
        sourceRunId: QUESTION_RUN_ID,
        originalPrompt: "論文を書いて",
        question: "何について書きますか？",
        answer: "注意機構について",
      },
      history: {
        originalRequest: "論文を書いて",
        turns: [
          {
            question: "何について書きますか?",
            answer: "注意機構について",
          },
        ],
        truncated: false,
      },
    });
    expect(await repository.getRun(USER_ID, QUESTION_RUN_ID)).toMatchObject({
      // Resolving the reply only claims it. The source is retired atomically
      // with the resulting brief save, so extraction failures stay recoverable.
      status: "waiting_approval",
      stage: "needs_input",
    });

    // A durable-step replay reconstructs the same bounded context instead of
    // consuming an older question or losing the original topic.
    await expect(resolveDocumentRunPromptStep(answerRun)).resolves.toEqual(
      context,
    );

    const plan = await planFallbackDocumentStep({
      workflow: answerRun,
      promptContext: context,
    });
    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.title).toBe("注意機構");
    expect(plan.initialDocument.metadata.documentType).toBe("paper");

    const base = await repository.getRevision(USER_ID, DOCUMENT_ID, 1);
    expect(base).not.toBeNull();
    if (!base) return;
    const written = applyDocumentPatch(
      {
        revisionId: "50000000-0000-4000-8000-000000000001",
        revision: 1,
        parentRevisionId: null,
        committedAt: NOW,
        document: base.document,
      },
      plan.patch,
    ).document;
    expect(written.root).toHaveLength(3);
    expect(
      written.nodes.some(
        (node) =>
          node.type === "paragraph" &&
          node.content.some(
            (part) => part.type === "text" && part.text.includes("注意機構"),
          ),
      ),
    ).toBe(true);
  });

  it("preserves the originating request and every bounded answer across repeated questions", async () => {
    const firstQuestionRun = await createRunningRun({
      id: QUESTION_RUN_ID,
      prompt: "論文を書いて",
      idempotencyKey: "history-question-1",
    });
    await markDocumentRunNeedsInputStep({
      workflow: firstQuestionRun,
      code: "clarification_required",
      question: "何について書きますか？",
    });

    const secondQuestionRun = await createRunningRun({
      id: ANSWER_RUN_ID,
      prompt: "注意機構について",
      idempotencyKey: "history-answer-1",
      replyToRunId: QUESTION_RUN_ID,
    });
    await resolveDocumentRunPromptStep(secondQuestionRun);
    await markDocumentRunNeedsInputStep({
      workflow: secondQuestionRun,
      code: "clarification_required",
      question: "対象読者は誰ですか？",
    });

    const finalAnswerRun = await createRunningRun({
      id: LATER_RUN_ID,
      prompt: "学部生です",
      idempotencyKey: "history-answer-2",
      replyToRunId: ANSWER_RUN_ID,
    });
    const context = await resolveDocumentRunPromptStep(finalAnswerRun);

    expect(context.history).toEqual({
      originalRequest: "論文を書いて",
      turns: [
        {
          question: "何について書きますか?",
          answer: "注意機構について",
        },
        {
          question: "対象読者は誰ですか?",
          answer: "学部生です",
        },
      ],
      truncated: false,
    });
    expect(context.effectivePrompt).toContain("注意機構について論文を書いて");
    expect(context.effectivePrompt).toContain("対象読者は誰ですか?");
    expect(context.effectivePrompt).toContain("学部生です");
  });

  it("does not consume any pending input without an explicit reply target", async () => {
    const approvalRun = await createRunningRun({
      id: QUESTION_RUN_ID,
      prompt: "考察を削除して",
      idempotencyKey: "approval-question-1",
    });
    const patch = destructivePatch();
    const storedApprovalRun = await repository.getRun(
      USER_ID,
      approvalRun.runId,
    );
    expect(storedApprovalRun).not.toBeNull();
    if (!storedApprovalRun) return;
    await repository.setRunNeedsInput({
      userId: USER_ID,
      documentId: DOCUMENT_ID,
      runId: approvalRun.runId,
      expectedStateVersion: storedApprovalRun.stateVersion,
      code: "approval_required",
      question: "この内容を削除してよいですか？",
      pendingAction: {
        id: "50000000-0000-4000-8000-000000000003",
        patch,
        patchDigest: documentPatchDigest(patch),
        summary: "承認対象の変更",
      },
    });

    const nextRun = await createRunningRun({
      id: ANSWER_RUN_ID,
      prompt: "注意機構について",
      idempotencyKey: "approval-answer-1",
    });
    const context = await resolveDocumentRunPromptStep(nextRun);

    expect(context).toEqual({
      effectivePrompt: "注意機構について",
      clarification: null,
      history: null,
    });
    expect(await repository.getRun(USER_ID, QUESTION_RUN_ID)).toMatchObject({
      status: "waiting_approval",
      errorMessage: "この内容を削除してよいですか？",
    });
  });

  it("uses the explicit reply target even when other runs intervened", async () => {
    const oldQuestion = await createRunningRun({
      id: QUESTION_RUN_ID,
      prompt: "論文を書いて",
      idempotencyKey: "old-clarification-question-1",
    });
    await markDocumentRunNeedsInputStep({
      workflow: oldQuestion,
      code: "clarification_required",
      question: "何について書きますか？",
    });

    await createRunningRun({
      id: INTERVENING_RUN_ID,
      prompt: "別の作業",
      idempotencyKey: "intervening-run-1",
    });
    await repository.updateRun(USER_ID, INTERVENING_RUN_ID, {
      status: "failed",
      stage: "failed",
      errorMessage: "文書の作成を完了できませんでした。",
    });

    const laterRun = await createRunningRun({
      id: LATER_RUN_ID,
      prompt: "注意機構について",
      idempotencyKey: "later-answer-1",
      replyToRunId: QUESTION_RUN_ID,
    });
    await expect(resolveDocumentRunPromptStep(laterRun)).resolves.toMatchObject({
      effectivePrompt: "注意機構について論文を書いて",
      clarification: {
        sourceRunId: QUESTION_RUN_ID,
        answer: "注意機構について",
      },
    });
    expect(await repository.getRun(USER_ID, QUESTION_RUN_ID)).toMatchObject({
      status: "waiting_approval",
    });
  });

  it("rejects an explicit clarification reply that targets an approval request", async () => {
    const approvalRun = await createRunningRun({
      id: QUESTION_RUN_ID,
      prompt: "考察を削除して",
      idempotencyKey: "approval-target-1",
    });
    const patch = destructivePatch();
    const source = await repository.getRun(USER_ID, approvalRun.runId);
    expect(source).not.toBeNull();
    if (!source) return;
    await repository.setRunNeedsInput({
      userId: USER_ID,
      documentId: DOCUMENT_ID,
      runId: approvalRun.runId,
      expectedStateVersion: source.stateVersion,
      code: "approval_required",
      question: "この内容を削除してよいですか？",
      pendingAction: {
        id: "50000000-0000-4000-8000-000000000003",
        patch,
        patchDigest: documentPatchDigest(patch),
        summary: "承認対象の変更",
      },
    });
    await expect(
      createRunningRun({
        id: ANSWER_RUN_ID,
        prompt: "はい",
        replyToRunId: QUESTION_RUN_ID,
        idempotencyKey: "approval-target-answer-1",
      }),
    ).rejects.toBeInstanceOf(RunReplyConflictError);
    await expect(repository.getRun(USER_ID, QUESTION_RUN_ID)).resolves.toMatchObject({
      status: "waiting_approval",
    });
  });
});

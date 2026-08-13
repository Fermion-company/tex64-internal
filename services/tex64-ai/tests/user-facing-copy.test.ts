import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DocumentSchema } from "@/domain/document";
import {
  createRunReplyInput,
  userFacingRunNote,
} from "@/lib/client/run-input";
import type { AgentRun } from "@/lib/client/types";
import {
  USER_FACING_QUESTION_FALLBACKS,
  containsUnsafeUserFacingCopy,
  normalizeUserFacingQuestion,
} from "@/lib/user-facing-copy";
import { CompileFailure } from "@/server/compiler";
import { handleRouteError } from "@/server/http/responses";
import { InvalidRequestBodyError } from "@/server/http/request";
import {
  ResourceLimitExceededError,
  type DocumentRepository,
  type StoredAgentRun,
} from "@/server/persistence";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import {
  presentAgentRun,
  toAgentRun,
} from "@/server/presentation/document-view";
import {
  markDocumentRunNeedsInputStep,
  requestInputToolStep,
  resolveDocumentRunPromptStep,
} from "@/workflows/document-agent/steps";
import type { DocumentAgentWorkflowInput } from "@/workflows/document-agent/types";

const USER_ID = "81000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "81000000-0000-4000-8000-000000000002";
const QUESTION_RUN_ID = "81000000-0000-4000-8000-000000000003";
const ANSWER_RUN_ID = "81000000-0000-4000-8000-000000000004";
const NOW = "2026-08-08T00:00:00.000+09:00";

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-user-copy-"));
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
  replyToRunId?: string;
}): Promise<DocumentAgentWorkflowInput> {
  const run = await repository.createRun({
    id: input.id,
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    prompt: input.prompt,
    replyToRunId: input.replyToRunId ?? null,
    decision: null,
    idempotencyKey: `copy-safety-${input.id}`,
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

describe.sequential("user-facing question boundary", () => {
  it.each([
    "LaTeXコンパイル処理について、想定する読者を教えてください。",
    "AIエージェントのtool callingワークフローについて、扱う範囲を教えてください。",
    "ワークフロー実行とtool callの違いをどこまで説明しますか？",
    "OpenAIのモデル比較について、中心となる論点は何ですか？",
    "指定資料 https://example.com/items/81000000-0000-4000-8000-000000000099?documentId=public を使いますか？",
  ])("preserves ordinary domain copy: %s", async (question) => {
    expect(containsUnsafeUserFacingCopy(question)).toBe(false);
    expect(
      normalizeUserFacingQuestion(question, "clarification_required"),
    ).toBe(question);

    const workflow = await createRunningRun({
      id: QUESTION_RUN_ID,
      prompt: "論文を書いて",
    });
    await markDocumentRunNeedsInputStep({
      workflow,
      code: "clarification_required",
      question,
    });
    await expect(repository.getRun(USER_ID, QUESTION_RUN_ID)).resolves.toMatchObject({
      errorMessage: question,
    });
  });

  it.each([
    "request_inputで回答を集めますか？",
    "toolCallId: call_456 の内容を確認してください。",
    `documentId=${DOCUMENT_ID} の対象を教えてください。`,
    "providerMetadata={model: openai/gpt-5.6-sol}",
    "AI Gateway の model=openai/gpt-5.6-sol で続けますか？",
    "baseRevision=4 の内容を確認してください。",
    "識別子 ffffffff-ffff-ffff-ffff-ffffffffffff を選びますか？",
    "Error: provider request failed\n    at execute (/workspace/src/run.ts:12:4)",
    "生成元は /private/tmp/tex64/build/main.tex です。",
    "src/server/presentation/document-view.ts を確認しますか？",
    "main.tex を添付しますか？",
    String.raw`\documentclass{article} と \begin{document} のどちらを使いますか？`,
  ])("replaces concrete execution copy: %s", (question) => {
    expect(containsUnsafeUserFacingCopy(question)).toBe(true);
    expect(
      normalizeUserFacingQuestion(question, "clarification_required"),
    ).toBe(USER_FACING_QUESTION_FALLBACKS.clarification_required);
    expect(userFacingRunNote(question, "安全な案内です。")).toBe(
      "安全な案内です。",
    );
  });

  it("normalizes an agent question before real persistence and keeps its reply path usable", async () => {
    await createRunningRun({
      id: QUESTION_RUN_ID,
      prompt: "論文を書いて",
    });
    await requestInputToolStep(
      {
        question: `request_input: documentId=${DOCUMENT_ID} を確認してください。`,
      },
      {
        documentId: DOCUMENT_ID,
        runId: QUESTION_RUN_ID,
        actorId: USER_ID,
      },
    );

    const stored = await repository.getRun(USER_ID, QUESTION_RUN_ID);
    expect(stored).not.toBeNull();
    if (!stored) return;
    expect(stored.errorMessage).toBe(
      USER_FACING_QUESTION_FALLBACKS.clarification_required,
    );
    const events = await repository.listRunEvents(USER_ID, QUESTION_RUN_ID);
    expect(events.at(-1)?.detail?.question).toBe(
      USER_FACING_QUESTION_FALLBACKS.clarification_required,
    );
    await expect(
      presentAgentRun(repository, USER_ID, stored),
    ).resolves.toMatchObject({
      resultNote: USER_FACING_QUESTION_FALLBACKS.clarification_required,
      inputKind: "clarification",
    });

    const answer = await createRunningRun({
      id: ANSWER_RUN_ID,
      prompt: "対象は大学院生で、理論と実例の両方を扱います。",
      replyToRunId: QUESTION_RUN_ID,
    });
    await expect(resolveDocumentRunPromptStep(answer)).resolves.toMatchObject({
      clarification: {
        question: USER_FACING_QUESTION_FALLBACKS.clarification_required,
        answer: "対象は大学院生で、理論と実例の両方を扱います。",
      },
    });
  });

  it("uses an approval fallback that the existing reply control can answer", () => {
    const question = normalizeUserFacingQuestion(
      `apply_document_patch runId=${QUESTION_RUN_ID}`,
      "approval_required",
    );
    expect(question).toBe(USER_FACING_QUESTION_FALLBACKS.approval_required);

    const run: AgentRun = {
      id: QUESTION_RUN_ID,
      documentId: DOCUMENT_ID,
      prompt: "結論を削除して",
      stage: "needs_input",
      status: "waiting_approval",
      createdAt: NOW,
      updatedAt: NOW,
      inputKind: "approval",
      resultNote: question,
    };
    expect(createRunReplyInput(run, "はい")).toMatchObject({
      replyToRunId: QUESTION_RUN_ID,
      decision: "approve",
    });
    expect(createRunReplyInput(run, "いいえ")).toMatchObject({
      replyToRunId: QUESTION_RUN_ID,
      decision: "reject",
    });
  });

  it("sanitizes unsafe legacy copy again at every server presentation boundary", async () => {
    const legacyRun: StoredAgentRun = {
      id: QUESTION_RUN_ID,
      userId: USER_ID,
      documentId: DOCUMENT_ID,
      prompt: "結論を整理して",
      replyToRunId: null,
      decision: null,
      idempotencyKey: "legacy-unsafe-copy",
      workflowRunId: "workflow-legacy-unsafe-copy",
      status: "waiting_approval",
      stage: "needs_input",
      baseRevision: 1,
      resultRevision: null,
      artifactRelease: null,
      errorMessage: `apply_document_patch runId=${QUESTION_RUN_ID}`,
      resultNote: null,
      targetNodeId: null,
      stateVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };

    expect(toAgentRun(legacyRun)).toMatchObject({
      resultNote: USER_FACING_QUESTION_FALLBACKS.clarification_required,
    });
    await expect(
      presentAgentRun(
        { getPendingDocumentAction: async () => ({}) as never },
        USER_ID,
        legacyRun,
      ),
    ).resolves.toMatchObject({
      resultNote: USER_FACING_QUESTION_FALLBACKS.approval_required,
      inputKind: "approval",
    });
    await expect(
      presentAgentRun(
        { getPendingDocumentAction: async () => null },
        USER_ID,
        legacyRun,
      ),
    ).resolves.toMatchObject({
      resultNote: USER_FACING_QUESTION_FALLBACKS.clarification_required,
      inputKind: "clarification",
    });
  });
});

describe("plain API recovery copy", () => {
  it.each([
    [
      new InvalidRequestBodyError("content_type"),
      "入力を送信できませんでした。画面を更新して、もう一度お試しください。",
    ],
    [
      new ResourceLimitExceededError("documents"),
      "保存上限に達しました。続けるには管理者にお問い合わせください。",
    ],
    [
      new CompileFailure("private compiler detail", []),
      "文書を仕上げられませんでした。もう一度お試しください。",
    ],
  ])("returns an actionable message without implementation terms", async (error, message) => {
    const response = handleRouteError(error);
    const body = await response.json();
    expect(body.error.message).toBe(message);
    expect(JSON.stringify(body)).not.toContain("private compiler detail");
    expect(JSON.stringify(body)).not.toMatch(/送信形式|作業領域/u);
  });
});

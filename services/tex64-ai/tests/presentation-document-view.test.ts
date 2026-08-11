import { describe, expect, it, vi } from "vitest";
import { SAMPLE_DOCUMENT, SAMPLE_DOCUMENT_IDS } from "@/domain/document";
import { USER_FACING_QUESTION_FALLBACKS } from "@/lib/user-facing-copy";
import {
  ClientDocumentPatchSchema,
  createEmptyDocument,
  createDomainPatchFromClient,
  presentAgentRun,
  presentAgentRuns,
  toAgentRun,
  toDocumentDetail,
} from "@/server/presentation/document-view";
import type { StoredAgentRun, StoredDocument } from "@/server/persistence";

const USER_ID = "30000000-0000-4000-8000-000000000001";

function storedDocument(): StoredDocument {
  return {
    id: SAMPLE_DOCUMENT.id,
    userId: USER_ID,
    title: SAMPLE_DOCUMENT.metadata.title,
    document: structuredClone(SAMPLE_DOCUMENT),
    currentRevision: 1,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}

describe("document presentation", () => {
  it.each([
    ["論文を書いて", "新しい論文"],
    ["注意機構について論文を書いて", "注意機構"],
    ["注意機構に関する論文を作成してください", "注意機構"],
  ])("derives a useful title from %s", (prompt, expectedTitle) => {
    const document = createEmptyDocument({
      id: "30000000-0000-4000-8000-000000000003",
      prompt,
      kind: "paper",
      now: "2026-08-07T00:00:00.000Z",
    });

    expect(document.metadata.title).toBe(expectedTitle);
  });

  it("preserves proposal as a first-class document type", () => {
    const document = createEmptyDocument({
      id: "30000000-0000-4000-8000-000000000004",
      prompt: "監査可能なAIの提案書を作成して",
      kind: "proposal",
      now: "2026-08-07T00:00:00.000Z",
    });

    expect(document.metadata.documentType).toBe("proposal");
    expect(document.metadata.subtitle).toBe("提案書");
  });

  it("keeps an edited list valid when the client submits no items", () => {
    const current = storedDocument();
    const detail = toDocumentDetail({
      stored: current,
      revisions: [],
      runs: [],
      artifact: null,
    });
    const input = ClientDocumentPatchSchema.parse({
      baseRevision: current.currentRevision,
      blocks: detail.blocks.map((block) =>
        block.id === SAMPLE_DOCUMENT_IDS.list && block.type === "list"
          ? { ...block, items: [] }
          : block,
      ),
    });

    const converted = createDomainPatchFromClient({ current, patch: input });
    expect(converted).not.toBeNull();

    const list = converted?.next.document.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.list,
    );
    expect(list?.type).toBe("list");
    if (list?.type !== "list") throw new Error("List node is missing");
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.content).toEqual([]);
    expect(list.items[0]?.children).toEqual([]);
  });

  it("preserves rich nodes when an older client resends unchanged projected blocks", () => {
    const current = storedDocument();
    const detail = toDocumentDetail({
      stored: current,
      revisions: [],
      runs: [],
      artifact: null,
    });
    const input = ClientDocumentPatchSchema.parse({
      baseRevision: current.currentRevision,
      title: "新しい題名",
      blocks: detail.blocks,
    });

    const converted = createDomainPatchFromClient({ current, patch: input });

    expect(converted?.next.document.metadata.title).toBe("新しい題名");
    expect(converted?.next.document.nodes).toEqual(current.document.nodes);
  });

  it("keeps figures and tables out of the lossy plain-text preview", () => {
    const current = storedDocument();
    const figure = current.document.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.figure,
    );
    if (figure?.type !== "figure") throw new Error("Sample figure is missing");
    figure.assetId = "30000000-0000-4000-8000-000000000099";
    figure.assetKind = "png";

    const detail = toDocumentDetail({
      stored: current,
      revisions: [],
      runs: [],
      artifact: null,
    });
    expect(
      detail.blocks.some((block) => block.id === SAMPLE_DOCUMENT_IDS.figure),
    ).toBe(false);
    const input = ClientDocumentPatchSchema.parse({
      baseRevision: current.currentRevision,
      blocks: [
        ...detail.blocks,
        {
          id: SAMPLE_DOCUMENT_IDS.figure,
          type: "quote",
          text: "更新した代替説明",
          attribution: "更新した図の説明",
        },
      ],
    });

    expect(() => createDomainPatchFromClient({ current, patch: input })).toThrow(
      "Structured content cannot be replaced",
    );
  });

  it("rejects lossy plain-text replacement of a referenced paragraph", () => {
    const current = storedDocument();
    const detail = toDocumentDetail({
      stored: current,
      revisions: [],
      runs: [],
      artifact: null,
    });
    const input = ClientDocumentPatchSchema.parse({
      baseRevision: current.currentRevision,
      blocks: detail.blocks.map((block) =>
        block.id === SAMPLE_DOCUMENT_IDS.citedParagraph && block.type === "paragraph"
          ? { ...block, text: `${block.text}追記` }
          : block,
      ),
    });

    expect(() => createDomainPatchFromClient({ current, patch: input })).toThrow(
      "Structured content cannot be replaced",
    );
  });

  it("gives a waiting run an actionable user-facing note", () => {
    const run: StoredAgentRun = {
      id: "30000000-0000-4000-8000-000000000002",
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "内容を整理して",
      replyToRunId: null,
      decision: null,
      idempotencyKey: "waiting-run-key",
      workflowRunId: "workflow-run-id",
      status: "waiting_approval",
      stage: "needs_input",
      baseRevision: 1,
      resultRevision: null,
      artifactRelease: null,
      errorMessage: null,
      stateVersion: 1,
      createdAt: "2026-08-07T00:01:00.000Z",
      updatedAt: "2026-08-07T00:02:00.000Z",
    };

    expect(toAgentRun(run)).toMatchObject({
      status: "waiting_approval",
      stage: "needs_input",
      resultNote: USER_FACING_QUESTION_FALLBACKS.clarification_required,
    });

    expect(
      toAgentRun({ ...run, errorMessage: "何について書きますか？" }),
    ).toMatchObject({ resultNote: "何について書きますか？" });
  });

  it("does not claim that a no-change review updated the document", () => {
    const run: StoredAgentRun = {
      id: "30000000-0000-4000-8000-000000000004",
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "問題がないか確認して",
      idempotencyKey: "review-run-key",
      workflowRunId: "workflow-run-id",
      replyToRunId: null,
      decision: null,
      status: "completed",
      stage: "ready",
      baseRevision: 3,
      resultRevision: 3,
      artifactRelease: null,
      errorMessage: null,
      stateVersion: 2,
      createdAt: "2026-08-07T00:01:00.000Z",
      updatedAt: "2026-08-07T00:02:00.000Z",
    };

    expect(toAgentRun(run).resultNote).toBe("文書を確認しました");
  });

  it("presents waiting run replays with the response kind required by the UI", async () => {
    const run: StoredAgentRun = {
      id: "30000000-0000-4000-8000-000000000002",
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "内容を整理して",
      replyToRunId: null,
      decision: null,
      idempotencyKey: "waiting-run-key",
      workflowRunId: "workflow-run-id",
      status: "waiting_approval",
      stage: "needs_input",
      baseRevision: 1,
      resultRevision: null,
      artifactRelease: null,
      errorMessage: "この内容を削除してよいですか？",
      stateVersion: 1,
      createdAt: "2026-08-07T00:01:00.000Z",
      updatedAt: "2026-08-07T00:02:00.000Z",
    };

    await expect(
      presentAgentRun(
        { getPendingDocumentAction: async () => ({}) as never },
        USER_ID,
        run,
      ),
    ).resolves.toMatchObject({ inputKind: "approval" });
    await expect(
      presentAgentRun(
        { getPendingDocumentAction: async () => null },
        USER_ID,
        run,
      ),
    ).resolves.toMatchObject({ inputKind: "clarification" });
  });

  it("resolves input kinds for a run page with one batch lookup", async () => {
    const waitingRun: StoredAgentRun = {
      id: "30000000-0000-4000-8000-000000000012",
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "内容を整理して",
      replyToRunId: null,
      decision: null,
      idempotencyKey: "waiting-run-page-key",
      workflowRunId: "workflow-run-page-id",
      status: "waiting_approval",
      stage: "needs_input",
      baseRevision: 1,
      resultRevision: null,
      artifactRelease: null,
      errorMessage: "変更してよいですか？",
      stateVersion: 1,
      createdAt: "2026-08-07T00:01:00.000Z",
      updatedAt: "2026-08-07T00:02:00.000Z",
    };
    const clarificationRun = {
      ...waitingRun,
      id: "30000000-0000-4000-8000-000000000013",
      idempotencyKey: "clarification-run-page-key",
    };
    const listPendingDocumentActions = vi.fn(async () => [
      { sourceRunId: waitingRun.id } as never,
    ]);

    await expect(
      presentAgentRuns(
        { listPendingDocumentActions },
        USER_ID,
        [waitingRun, clarificationRun],
      ),
    ).resolves.toMatchObject([
      { id: waitingRun.id, inputKind: "approval" },
      { id: clarificationRun.id, inputKind: "clarification" },
    ]);
    expect(listPendingDocumentActions).toHaveBeenCalledTimes(1);
    expect(listPendingDocumentActions).toHaveBeenCalledWith(USER_ID, [
      waitingRun.id,
      clarificationRun.id,
    ]);
  });
});

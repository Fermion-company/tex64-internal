import { describe, expect, it } from "vitest";
import { SAMPLE_DOCUMENT, SAMPLE_DOCUMENT_IDS } from "@/domain/document";
import {
  ClientDocumentPatchSchema,
  createEmptyDocument,
  createDomainPatchFromClient,
  inferDocumentKind,
  presentConversation,
  toDocumentDetail,
} from "@/server/presentation/document-view";
import type { StoredDocument } from "@/server/persistence";

const USER_ID = "30000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = SAMPLE_DOCUMENT.id;
const RUN_ID = "30000000-0000-4000-8000-000000000009";

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

    // The stored/API value stays `proposal`; only the Japanese label changed.
    expect(document.metadata.documentType).toBe("proposal");
    expect(document.metadata.subtitle).toBe("企画書");
  });

  it.each([
    ["ゲームの企画書を作って", "proposal"],
    ["新規事業の提案書をまとめて", "proposal"],
    ["要点をメモして", "memo"],
    ["会議の議事録をまとめて", "memo"],
    ["市場調査の報告書を作成して", "report"],
    ["注意機構について論文を書いて", "paper"],
    ["拡散モデルの研究をまとめて", "paper"],
    ["カフェの新メニューについて書いて", "paper"],
  ])("infers the document kind from %s", (prompt, expected) => {
    expect(inferDocumentKind(prompt)).toBe(expected);
  });

  it("infers the kind when the caller omits it", () => {
    const document = createEmptyDocument({
      id: "30000000-0000-4000-8000-000000000005",
      prompt: "ゲームの企画書を作って",
      now: "2026-08-07T00:00:00.000Z",
    });

    expect(document.metadata.documentType).toBe("proposal");
    expect(document.metadata.subtitle).toBe("企画書");
  });

  it("keeps an edited list valid when the client submits no items", () => {
    const current = storedDocument();
    const detail = toDocumentDetail({
      stored: current,
      revisions: [],
      messages: [],
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
      messages: [],
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
      messages: [],
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
      messages: [],
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

  it("shows the thread as user and assistant turns, hiding tool traffic", () => {
    const presented = presentConversation([
      {
        userId: USER_ID,
        documentId: DOCUMENT_ID,
        sequence: 1,
        turnId: RUN_ID,
        role: "user",
        content: "注意機構について書いて",
        createdAt: "2026-08-07T00:00:00.000Z",
      },
      {
        userId: USER_ID,
        documentId: DOCUMENT_ID,
        sequence: 2,
        turnId: RUN_ID,
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "1", toolName: "read_document", input: {} },
        ],
        createdAt: "2026-08-07T00:00:01.000Z",
      },
      {
        userId: USER_ID,
        documentId: DOCUMENT_ID,
        sequence: 3,
        turnId: RUN_ID,
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "1", toolName: "read_document" }],
        createdAt: "2026-08-07T00:00:02.000Z",
      },
      {
        userId: USER_ID,
        documentId: DOCUMENT_ID,
        sequence: 4,
        turnId: RUN_ID,
        role: "assistant",
        content: [{ type: "text", text: "序論を書きました。" }],
        createdAt: "2026-08-07T00:00:03.000Z",
      },
    ]);

    expect(presented).toEqual([
      {
        id: "1",
        role: "user",
        text: "注意機構について書いて",
        createdAt: "2026-08-07T00:00:00.000Z",
      },
      {
        id: "4",
        role: "assistant",
        text: "序論を書きました。",
        createdAt: "2026-08-07T00:00:03.000Z",
      },
    ]);
  });
});

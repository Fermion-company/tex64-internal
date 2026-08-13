import { describe, expect, it } from "vitest";

import { applyDocumentPatch } from "@/domain/document/apply";
import { DocumentSchema } from "@/domain/document/schema";
import {
  buildClarifiedDocumentPrompt,
  deterministicUuid,
  isEmptyDocument,
  planDocumentDeterministically,
} from "@/server/agent/fallback-planner";

const NOW = "2026-08-07T12:00:00.000+09:00";

describe("deterministic fallback planner", () => {
  it("reconstructs a generic paper request from one clarification answer", () => {
    const prompt = buildClarifiedDocumentPrompt({
      originalPrompt: "論文を書いて",
      question: "何について書きますか？",
      answer: "注意機構について",
    });
    expect(prompt).toBe("注意機構について論文を書いて");

    const plan = planDocumentDeterministically({ prompt, now: NOW });
    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.title).toBe("注意機構");
    expect(plan.initialDocument.metadata.documentType).toBe("paper");
    expect(
      plan.patch.operations.some(
        (operation) =>
          operation.op === "insert" &&
          operation.node.type === "paragraph" &&
          operation.node.content.some(
            (part) => part.type === "text" && part.text.includes("注意機構"),
          ),
      ),
    ).toBe(true);
  });

  it("preserves a complete clarified writing request and extracts its topic", () => {
    const answer =
      "Transformerの注意機構について、研究論文の形式で背景・仕組み・課題をまとめて";
    const prompt = buildClarifiedDocumentPrompt({
      originalPrompt: "論文を書いて",
      question: "何について書きますか？",
      answer,
    });
    expect(prompt).toBe(answer);

    const plan = planDocumentDeterministically({ prompt, now: NOW });
    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.title).toBe("Transformerの注意機構");
    expect(plan.initialDocument.metadata.documentType).toBe("paper");
    expect(plan.outline).toEqual(["はじめに", "考察", "結論"]);
  });

  it("creates a valid title, outline, and body without a model", () => {
    const input = {
      prompt: "量子コンピューティングについてレポートを書いて",
      now: NOW,
    };
    const first = planDocumentDeterministically(input);
    const second = planDocumentDeterministically(input);

    expect(first).toEqual(second);
    expect(first.status).toBe("planned");
    if (first.status !== "planned") return;

    expect(first).toMatchObject({
      provider: "deterministic_fallback",
      mode: "create",
      title: "量子コンピューティング",
      outline: ["概要", "背景", "まとめ"],
      requiresApproval: false,
    });
    expect(first.patch.operations.some((operation) => operation.op === "setMetadata")).toBe(true);
    expect(first.patch.operations.filter((operation) => operation.op === "insert")).toHaveLength(6);

    const initialRevision = {
      revisionId: deterministicUuid("initial-revision"),
      revision: 0,
      parentRevisionId: null,
      committedAt: NOW,
      document: first.initialDocument,
    };
    const applied = applyDocumentPatch(initialRevision, first.patch);
    expect(DocumentSchema.safeParse(applied.document).success).toBe(true);
    expect(applied.document.root).toHaveLength(3);
  });

  it("does not collapse a proposal into an article", () => {
    const plan = planDocumentDeterministically({
      prompt: "監査可能なAIについて提案書を作って",
      now: NOW,
    });
    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.initialDocument.metadata.documentType).toBe("proposal");
    expect(plan.outline).toEqual(["目的", "提案内容", "次のステップ"]);
  });

  it("updates a named section while preserving stable IDs", () => {
    const created = planDocumentDeterministically({
      prompt: "注意機構について論文を書いて",
      now: NOW,
    });
    expect(created.status).toBe("planned");
    if (created.status !== "planned") return;

    const revision = applyDocumentPatch(
      {
        revisionId: deterministicUuid("paper-initial"),
        revision: 0,
        parentRevisionId: null,
        committedAt: NOW,
        document: created.initialDocument,
      },
      created.patch,
    );
    const conclusion = revision.document.nodes.find(
      (node) =>
        node.type === "section" &&
        node.title.some(
          (inline) => inline.type === "text" && inline.text === "結論",
        ),
    );
    expect(conclusion?.type).toBe("section");
    if (conclusion?.type !== "section") return;

    const paragraphId = conclusion.children[0];
    const plan = planDocumentDeterministically({
      prompt: "結論をもっと簡潔に書き直して",
      currentDocument: revision.document,
      baseRevision: revision.revision,
      now: "2026-08-07T12:05:00.000+09:00",
    });

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.mode).toBe("update");
    expect(plan.requiresApproval).toBe(false);
    expect(plan.patch.operations).toEqual([
      expect.objectContaining({ op: "update", nodeId: paragraphId }),
    ]);
  });

  it("executes an exact legacy replacement without appending content", () => {
    const created = planDocumentDeterministically({
      prompt: "注意機構について論文を書いて",
      now: NOW,
    });
    if (created.status !== "planned") throw new Error("expected plan");
    const revision = applyDocumentPatch(
      {
        revisionId: deterministicUuid("replacement-initial"),
        revision: 0,
        parentRevisionId: null,
        committedAt: NOW,
        document: created.initialDocument,
      },
      created.patch,
    );

    const plan = planDocumentDeterministically({
      prompt: "「注意機構」を「自己注意機構」に置換して",
      currentDocument: revision.document,
      baseRevision: revision.revision,
      now: "2026-08-07T12:04:00.000+09:00",
    });

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.patch.operations.length).toBeGreaterThan(0);
    expect(
      plan.patch.operations.every((operation) => operation.op === "update"),
    ).toBe(true);
    expect(plan.outline).not.toContain("追記");
    const applied = applyDocumentPatch(revision, plan.patch);
    expect(JSON.stringify(applied.document)).toContain("自己注意機構を扱う");
    expect(plan.patch.operations).toHaveLength(3);
  });

  it("fails closed when local fallback cannot infer punctuation changes", () => {
    const created = planDocumentDeterministically({
      prompt: "注意機構について論文を書いて",
      now: NOW,
    });
    if (created.status !== "planned") throw new Error("expected plan");
    const revision = applyDocumentPatch(
      {
        revisionId: deterministicUuid("punctuation-initial"),
        revision: 0,
        parentRevisionId: null,
        committedAt: NOW,
        document: created.initialDocument,
      },
      created.patch,
    );

    expect(
      planDocumentDeterministically({
        prompt: "第2節の句読点だけ直して",
        currentDocument: revision.document,
        baseRevision: revision.revision,
        now: "2026-08-07T12:04:00.000+09:00",
      }),
    ).toMatchObject({
      status: "needs_input",
      provider: "deterministic_fallback",
    });
  });

  it("makes the whole document concise without adding an unrelated section", () => {
    const created = planDocumentDeterministically({
      prompt: "注意機構について論文を書いて",
      now: NOW,
    });
    if (created.status !== "planned") throw new Error("expected plan");
    const revision = applyDocumentPatch(
      {
        revisionId: deterministicUuid("concise-initial"),
        revision: 0,
        parentRevisionId: null,
        committedAt: NOW,
        document: created.initialDocument,
      },
      created.patch,
    );

    const plan = planDocumentDeterministically({
      prompt: "短くする",
      currentDocument: revision.document,
      baseRevision: revision.revision,
      now: "2026-08-07T12:06:00.000+09:00",
    });

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.summary).toBe("本文全体を簡潔に整えます。");
    expect(plan.patch.operations.length).toBeGreaterThan(0);
    expect(plan.patch.operations.every((operation) => operation.op === "update")).toBe(true);
    const applied = applyDocumentPatch(revision, plan.patch);
    const paragraphs = applied.document.nodes.filter(
      (node): node is Extract<typeof node, { type: "paragraph" }> =>
        node.type === "paragraph",
    );
    expect(
      paragraphs.every((paragraph) =>
        paragraph.content.every(
          (content) => content.type !== "text" || !content.text.includes("読み手が判断しやすい"),
        ),
      ),
    ).toBe(true);
    expect(plan.outline).not.toContain("追記");
  });

  it("polishes tone across the document without creating a new section", () => {
    const created = planDocumentDeterministically({
      prompt: "注意機構について論文を書いて",
      now: NOW,
    });
    if (created.status !== "planned") throw new Error("expected plan");
    const revision = applyDocumentPatch(
      {
        revisionId: deterministicUuid("tone-initial"),
        revision: 0,
        parentRevisionId: null,
        committedAt: NOW,
        document: created.initialDocument,
      },
      created.patch,
    );

    const plan = planDocumentDeterministically({
      prompt: "語調を整える",
      currentDocument: revision.document,
      baseRevision: revision.revision,
      now: "2026-08-07T12:07:00.000+09:00",
    });

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.summary).toBe("本文全体の語調を整えます。");
    expect(plan.patch.operations.length).toBeGreaterThan(0);
    expect(plan.patch.operations.every((operation) => operation.op === "update")).toBe(true);
    const applied = applyDocumentPatch(revision, plan.patch);
    expect(JSON.stringify(applied.document)).toContain("読者が検討しやすい構成とする");
    expect(plan.outline).not.toContain("追記");
  });

  it("adds a specifically named argument section for the argument quick action", () => {
    const created = planDocumentDeterministically({
      prompt: "注意機構について論文を書いて",
      now: NOW,
    });
    if (created.status !== "planned") throw new Error("expected plan");
    const revision = applyDocumentPatch(
      {
        revisionId: deterministicUuid("argument-initial"),
        revision: 0,
        parentRevisionId: null,
        committedAt: NOW,
        document: created.initialDocument,
      },
      created.patch,
    );

    const plan = planDocumentDeterministically({
      prompt: "論点を補う",
      currentDocument: revision.document,
      baseRevision: revision.revision,
      now: "2026-08-07T12:08:00.000+09:00",
    });

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.summary).toBe("追加の論点を補います。");
    expect(plan.outline.at(-1)).toBe("追加の論点");
    expect(plan.outline).not.toContain("追記");
  });

  it("fills an existing empty service document with a complete outline", () => {
    const documentId = "40c7df69-05ef-4fe0-bb2d-a21779510c9a";
    const emptyDocument = DocumentSchema.parse({
      schemaVersion: 1,
      id: documentId,
      metadata: {
        title: "仮タイトル",
        subtitle: "レポート",
        language: "ja",
        documentType: "report",
        authors: [],
        keywords: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
      root: [],
      nodes: [],
    });

    expect(isEmptyDocument(emptyDocument)).toBe(true);
    const plan = planDocumentDeterministically({
      prompt: "量子コンピューティングについてレポートを書いて",
      currentDocument: emptyDocument,
      baseRevision: 1,
      now: NOW,
    });

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan).toMatchObject({
      mode: "update",
      title: "量子コンピューティング",
      outline: ["概要", "背景", "まとめ"],
      requiresApproval: false,
    });
    expect(plan.patch.documentId).toBe(documentId);
    expect(
      plan.patch.operations.filter((operation) => operation.op === "insert"),
    ).toHaveLength(6);

    const applied = applyDocumentPatch(
      {
        revisionId: deterministicUuid("existing-empty-revision"),
        revision: 1,
        parentRevisionId: null,
        committedAt: NOW,
        document: emptyDocument,
      },
      plan.patch,
    );
    expect(applied.document.id).toBe(documentId);
    expect(applied.document.root).toHaveLength(3);
    expect(applied.document.nodes).toHaveLength(6);
  });

  it("marks a requested deletion for approval", () => {
    const created = planDocumentDeterministically({
      prompt: "再生可能エネルギーについて論文を書いて",
      now: NOW,
    });
    if (created.status !== "planned") throw new Error("expected plan");
    const revision = applyDocumentPatch(
      {
        revisionId: deterministicUuid("energy-initial"),
        revision: 0,
        parentRevisionId: null,
        committedAt: NOW,
        document: created.initialDocument,
      },
      created.patch,
    );

    const plan = planDocumentDeterministically({
      prompt: "考察を削除して",
      currentDocument: revision.document,
      baseRevision: revision.revision,
      now: "2026-08-07T12:10:00.000+09:00",
    });

    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") return;
    expect(plan.requiresApproval).toBe(true);
    expect(plan.patch.operations).toEqual([
      expect.objectContaining({ op: "delete" }),
    ]);
  });

  it("asks one concise question when the request lacks a subject", () => {
    const plan = planDocumentDeterministically({ prompt: "   " });
    expect(plan).toEqual({
      status: "needs_input",
      provider: "deterministic_fallback",
      question: "どのような文書を作成しますか？",
    });

    const emptyDocument = DocumentSchema.parse({
      schemaVersion: 1,
      id: "40c7df69-05ef-4fe0-bb2d-a21779510c9a",
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
    });
    expect(
      planDocumentDeterministically({
        prompt: "論文を書いて",
        currentDocument: emptyDocument,
        baseRevision: 1,
        now: NOW,
      }),
    ).toEqual({
      status: "needs_input",
      provider: "deterministic_fallback",
      question: "何について書きますか？",
    });
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createDocumentAgentSession } from "@/domain/brief/initialize";
import {
  DocumentPatchSchema,
  SAMPLE_DOCUMENT,
  SAMPLE_DOCUMENT_IDS,
} from "@/domain/document";
import {
  documentMutationReadiness,
  isStronglyScopedLegacyEdit,
  parseStronglyScopedLegacyEdit,
  patchMatchesScopedLegacyEdit,
} from "@/server/agent/session-policy";

function session() {
  const now = new Date().toISOString();
  return createDocumentAgentSession({
    sessionId: randomUUID(),
    documentId: randomUUID(),
    rootRunId: randomUUID(),
    deliverable: "paper",
    now,
  });
}

describe("document mutation readiness", () => {
  it("forbids writing a new document without a brief", () => {
    expect(
      documentMutationReadiness({
        session: null,
        documentHasContent: false,
      }),
    ).toEqual({ allowed: false, reason: "missing_brief" });
  });

  it("keeps an unconfirmed brief immutable", () => {
    expect(
      documentMutationReadiness({
        session: session(),
        documentHasContent: false,
      }),
    ).toEqual({ allowed: false, reason: "unconfirmed_brief" });
  });

  it("requires the confirmed brief version and drafting phase", () => {
    const initial = session();
    const confirmed = {
      ...initial,
      confirmedBriefVersion: initial.briefVersion,
      phase: "drafting" as const,
    };
    expect(
      documentMutationReadiness({
        session: confirmed,
        documentHasContent: false,
      }),
    ).toEqual({ allowed: true, reason: "confirmed_brief" });

    expect(
      documentMutationReadiness({
        session: { ...confirmed, briefVersion: confirmed.briefVersion + 1 },
        documentHasContent: false,
      }),
    ).toEqual({ allowed: false, reason: "brief_changed" });
  });

  it("requires a confirmed brief for existing legacy documents", () => {
    expect(
      documentMutationReadiness({
        session: null,
        documentHasContent: true,
      }),
    ).toEqual({ allowed: false, reason: "missing_brief" });
  });

  it("allows only a deterministically scoped legacy edit without a brief", () => {
    expect(isStronglyScopedLegacyEdit("「誤字A」を「正字B」に置換して")).toBe(
      true,
    );
    expect(isStronglyScopedLegacyEdit("第2節の句読点だけ直して")).toBe(true);
    expect(
      documentMutationReadiness({
        session: null,
        documentHasContent: true,
        scopedLegacyEdit: true,
      }),
    ).toEqual({ allowed: true, reason: "scoped_legacy_edit" });
  });

  it.each([
    "全面改稿して",
    "主題を量子計算に変えて",
    "10ページにして",
    "章立てを変えて",
    "IEEEの引用を追加して",
    "図表を増やして",
    "文体を学術的にして",
    "第2節をいい感じに直して",
  ])("fails closed for a contract-changing or ambiguous legacy edit: %s", (prompt) => {
    expect(isStronglyScopedLegacyEdit(prompt)).toBe(false);
  });

  it("binds a quoted replacement to the exact resulting patch", () => {
    const contract = parseStronglyScopedLegacyEdit(
      "「TeXコード」を「生成コード」に置換して",
    );
    if (!contract) throw new Error("Missing exact edit contract.");
    const paragraph = SAMPLE_DOCUMENT.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.paragraph,
    );
    if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph.");
    const replacement = {
      ...paragraph,
      content: paragraph.content.map((inline) =>
        inline.type === "text"
          ? { ...inline, text: inline.text.replaceAll("TeXコード", "生成コード") }
          : inline,
      ),
    };
    const patch = DocumentPatchSchema.parse({
      id: randomUUID(),
      documentId: SAMPLE_DOCUMENT.id,
      baseRevision: 1,
      createdAt: new Date().toISOString(),
      operations: [
        {
          op: "update",
          nodeId: paragraph.id,
          node: replacement,
        },
      ],
    });

    expect(
      patchMatchesScopedLegacyEdit({
        contract,
        document: SAMPLE_DOCUMENT,
        currentRevision: 1,
        patch,
      }),
    ).toBe(true);

    const operationVariants = [
      {
        op: "setMetadata" as const,
        metadata: { ...SAMPLE_DOCUMENT.metadata, title: "別タイトル" },
      },
      { op: "delete" as const, nodeId: paragraph.id },
      {
        op: "move" as const,
        nodeId: paragraph.id,
        position: { kind: "root" as const, index: 0 },
      },
      {
        op: "insert" as const,
        node: { ...paragraph, id: randomUUID() },
        position: { kind: "root" as const, index: 0 },
      },
      {
        op: "update" as const,
        nodeId: paragraph.id,
        node: {
          ...replacement,
          content: [
            {
              type: "text" as const,
              text: "要求と無関係な本文です。",
              marks: [],
            },
          ],
        },
      },
      {
        op: "update" as const,
        nodeId: paragraph.id,
        node: {
          ...replacement,
          content: replacement.content.map((inline) =>
            inline.type === "text"
              ? { ...inline, marks: ["bold" as const] }
              : inline,
          ),
        },
      },
    ];
    for (const operation of operationVariants) {
      const adversarial = DocumentPatchSchema.parse({
        ...patch,
        id: randomUUID(),
        operations: [operation],
      });
      expect(
        patchMatchesScopedLegacyEdit({
          contract,
          document: SAMPLE_DOCUMENT,
          currentRevision: 1,
          patch: adversarial,
        }),
      ).toBe(false);
    }
  });
});

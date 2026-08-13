import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DocumentPatchSchema,
  DocumentSchema,
  SAMPLE_DOCUMENT,
  SAMPLE_DOCUMENT_IDS,
} from "@/domain/document";
import type { DocumentRepository } from "@/server/persistence";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import { applyDocumentPatchToolStep } from "@/workflows/document-agent/steps";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const RUN_ID = "10000000-0000-4000-8000-000000000001";
const PROMPT = "「TeXコード」を「生成コード」に置換して";

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "tex64-legacy-edit-boundary-"),
  );
  repository = new LocalDocumentRepository(
    path.join(temporaryDirectory, "store.json"),
  );
  (globalThis as RepositoryGlobal).__tex64DocumentRepository = repository;
  await repository.createDocument(USER_ID, SAMPLE_DOCUMENT);
  await repository.createRun({
    id: RUN_ID,
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    prompt: PROMPT,
    idempotencyKey: "legacy-exact-edit",
    baseRevision: 1,
  });
  await repository.activateRunForWorkflow(
    USER_ID,
    RUN_ID,
    "workflow-legacy-exact-edit",
  );
});

afterEach(async () => {
  delete (globalThis as RepositoryGlobal).__tex64DocumentRepository;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function context() {
  return {
    documentId: SAMPLE_DOCUMENT.id,
    runId: RUN_ID,
    actorId: USER_ID,
  };
}

function exactReplacementPatch() {
  const paragraph = SAMPLE_DOCUMENT.nodes.find(
    (node) => node.id === SAMPLE_DOCUMENT_IDS.paragraph,
  );
  if (paragraph?.type !== "paragraph") {
    throw new Error("Missing paragraph fixture.");
  }
  return DocumentPatchSchema.parse({
    id: randomUUID(),
    documentId: SAMPLE_DOCUMENT.id,
    baseRevision: 1,
    createdAt: new Date().toISOString(),
    operations: [
      {
        op: "update",
        nodeId: paragraph.id,
        node: {
          ...paragraph,
          content: paragraph.content.map((inline) =>
            inline.type === "text"
              ? {
                  ...inline,
                  text: inline.text.replaceAll("TeXコード", "生成コード"),
                }
              : inline,
          ),
        },
      },
    ],
  });
}

describe.sequential("legacy exact-edit tool boundary", () => {
  it("lets the deterministic path apply only the exact requested replacement", async () => {
    await expect(
      applyDocumentPatchToolStep(
        { patch: exactReplacementPatch(), summary: "表記を置換" },
        context(),
      ),
    ).resolves.toMatchObject({ ok: true, revision: 2 });

    const document = await repository.getDocument(
      USER_ID,
      SAMPLE_DOCUMENT.id,
    );
    const paragraph = document?.document.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.paragraph,
    );
    expect(paragraph).toMatchObject({ type: "paragraph" });
    expect(JSON.stringify(paragraph)).toContain("生成コード");
    expect(JSON.stringify(paragraph)).not.toContain("TeXコード");
  });

  it("lets a conversational edit run apply edits beyond the literal prompt scope", async () => {
    // Content-bearing documents accept conversational edit runs (content_edit)
    // so iteration is no longer limited to the scoped-legacy contract.
    const broadened = DocumentPatchSchema.parse({
      ...exactReplacementPatch(),
      id: randomUUID(),
      operations: [
        {
          op: "insert",
          node: {
            id: randomUUID(),
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "補足の本文です。",
                marks: [],
              },
            ],
          },
          position: { kind: "root", index: 0 },
        },
      ],
    });

    await expect(
      applyDocumentPatchToolStep(
        { patch: broadened, summary: "本文を更新" },
        context(),
        {
          toolCallId: "call-content-edit-insert",
          messages: [{ role: "user", content: PROMPT }],
        },
      ),
    ).resolves.toMatchObject({ ok: true, revision: 2 });
  });

  it("still rejects mutations for a sessionless document without content", async () => {
    const emptyDocumentId = "40000000-0000-4000-8000-000000000099";
    const emptyRunId = "10000000-0000-4000-8000-000000000099";
    await repository.createDocument(
      USER_ID,
      DocumentSchema.parse({
        schemaVersion: 1,
        id: emptyDocumentId,
        metadata: {
          title: "空の文書",
          language: "ja",
          documentType: "report",
          authors: [],
          keywords: [],
          createdAt: "2026-08-08T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z",
        },
        root: [],
        nodes: [],
      }),
    );
    await repository.createRun({
      id: emptyRunId,
      userId: USER_ID,
      documentId: emptyDocumentId,
      prompt: "本文を書いて",
      idempotencyKey: "empty-document-edit",
      baseRevision: 1,
    });
    await repository.activateRunForWorkflow(
      USER_ID,
      emptyRunId,
      "workflow-empty-document-edit",
    );

    const insert = DocumentPatchSchema.parse({
      id: randomUUID(),
      documentId: emptyDocumentId,
      baseRevision: 1,
      createdAt: new Date().toISOString(),
      operations: [
        {
          op: "insert",
          node: {
            id: randomUUID(),
            type: "paragraph",
            content: [
              { type: "text", text: "勝手に始める本文です。", marks: [] },
            ],
          },
          position: { kind: "root", index: 0 },
        },
      ],
    });

    await expect(
      applyDocumentPatchToolStep(
        { patch: insert, summary: "本文を更新" },
        { documentId: emptyDocumentId, runId: emptyRunId, actorId: USER_ID },
      ),
    ).rejects.toThrow("文書の条件がまだ確定していません");

    await expect(
      repository.getDocument(USER_ID, emptyDocumentId),
    ).resolves.toMatchObject({ currentRevision: 1 });
  });
});

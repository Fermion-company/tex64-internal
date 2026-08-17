import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import {
  DocumentAgentSessionSchema,
  StoredDocumentAgentSessionSchema,
  createDocumentAgentSession,
} from "@/domain/brief";
import { DocumentSchema } from "@/domain/document";
import { type DocumentToolExecution } from "@/server/agent";
import type { DocumentRepository } from "@/server/persistence";
import { IdempotencyConflictError } from "@/server/persistence";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import type { SourceRecord } from "@/server/sources";
import {
  applyConfirmedBriefLayoutStep,
  applyDocumentPatchToolStep,
  formatDocumentToolStep,
  requestInputToolStep,
} from "@/workflows/document-agent/steps";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "40c7df69-05ef-4fe0-bb2d-a21779510c9a";
const RUN_ID = "10000000-0000-4000-8000-000000000001";
const NOW = "2026-08-07T12:00:00.000+09:00";

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-tool-mutation-"));
  repository = new LocalDocumentRepository(path.join(temporaryDirectory, "store.json"));
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
  await repository.createRun({
    id: RUN_ID,
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    prompt: "注意機構について論文を書いて",
    idempotencyKey: "tool-mutation-run-1",
    baseRevision: 1,
  });
  await repository.activateRunForWorkflow(USER_ID, RUN_ID, "workflow-tool-test");
  const initializedSession = createDocumentAgentSession({
    sessionId: "20000000-0000-4000-8000-000000000001",
    documentId: DOCUMENT_ID,
    rootRunId: RUN_ID,
    deliverable: "paper",
    now: NOW,
  });
  const session = DocumentAgentSessionSchema.parse({
    ...initializedSession,
    phase: "drafting",
    confirmedBriefVersion: initializedSession.briefVersion,
    lastProcessedRunId: RUN_ID,
  });
  await repository.saveDocumentAgentSession(
    StoredDocumentAgentSessionSchema.parse({
      userId: USER_ID,
      documentId: DOCUMENT_ID,
      session,
      stateVersion: session.stateVersion,
      updatedAt: session.updatedAt,
    }),
    null,
  );
});

afterEach(async () => {
  delete (globalThis as RepositoryGlobal).__tex64DocumentRepository;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function execution(toolCallId: string, messages: ModelMessage[]): DocumentToolExecution {
  return { toolCallId, messages };
}

function toolContext() {
  return { documentId: DOCUMENT_ID, runId: RUN_ID, actorId: USER_ID };
}

/** Minimal semantic patch used to exercise the durable mutation boundary. */
function insertParagraphPatch(input: {
  patchId: string;
  nodeId: string;
  baseRevision: number;
  text: string;
  createdAt?: string;
}) {
  return {
    id: input.patchId,
    documentId: DOCUMENT_ID,
    baseRevision: input.baseRevision,
    createdAt: input.createdAt ?? NOW,
    operations: [
      {
        op: "insert" as const,
        node: {
          id: input.nodeId,
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: input.text, marks: [] }],
        },
        position: { kind: "root" as const, index: 0 },
      },
    ],
  };
}

function verifiedSource(
  overrides: Partial<SourceRecord> = {},
): SourceRecord {
  const contentText = "Attention selects relevant signals.";
  return {
    schemaVersion: 1,
    id: "50000000-0000-4000-8000-000000000022",
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    kind: "doi",
    canonicalLocator: "https://doi.org/10.5555/attention",
    resolvedLocator:
      "https://api.crossref.org/works/10.5555%2Fattention",
    verification: "verified_content",
    evidenceScope: "abstract",
    contentText,
    contentSha256: createHash("sha256")
      .update(contentText, "utf8")
      .digest("hex"),
    metadata: {
      provider: "crossref",
      title: "Selective attention",
      authors: [{ name: "Ada Lovelace" }],
      publication: "Journal of Attention",
      publishedAt: "2025-07-02",
      doi: "10.5555/attention",
      contentType: "application/json",
    },
    fetchedAt: NOW,
    ...overrides,
  };
}

describe.sequential("durable tool mutation serialization", () => {
  it("deterministically enforces the confirmed brief layout and replays without a new revision", async () => {
    const stored = await repository.getDocumentAgentSession(USER_ID, DOCUMENT_ID);
    if (!stored) throw new Error("expected document agent session");
    const provided = <T,>(value: T) => ({
      status: "provided" as const,
      value,
      source: { kind: "user" as const, runId: RUN_ID },
      updatedAt: NOW,
    });
    const stateVersion = stored.stateVersion + 1;
    const session = DocumentAgentSessionSchema.parse({
      ...stored.session,
      brief: {
        ...stored.session.brief,
        scope: {
          ...stored.session.brief.scope,
          language: provided("日本語"),
        },
        tone: {
          register: provided("professional"),
          voice: provided("neutral"),
          jargonLevel: provided("moderate"),
          sentenceStyle: provided("balanced"),
        },
        sources: {
          ...stored.session.brief.sources,
          policy: provided("agent_research"),
          citationStyle: provided("APA第7版"),
        },
        template: {
          ...stored.session.brief.template,
          family: provided("business"),
          pageSize: provided("letter"),
          columns: provided(1),
        },
      },
      stateVersion,
      lastProcessedRunId: "90000000-0000-4000-8000-000000000001",
      updatedAt: NOW,
    });
    await repository.saveDocumentAgentSession(
      StoredDocumentAgentSessionSchema.parse({
        ...stored,
        session,
        stateVersion,
        updatedAt: NOW,
      }),
      stored.stateVersion,
    );
    const workflow = {
      userId: USER_ID,
      documentId: DOCUMENT_ID,
      runId: RUN_ID,
      prompt: "注意機構について論文を書いて",
      baseRevision: 1,
      replyToRunId: null,
    } as const;

    await expect(
      applyConfirmedBriefLayoutStep({
        workflow,
        briefVersion: session.briefVersion,
        baseRevision: 1,
      }),
    ).resolves.toMatchObject({ revision: 2 });
    await expect(
      applyConfirmedBriefLayoutStep({
        workflow,
        briefVersion: session.briefVersion,
        baseRevision: 1,
      }),
    ).resolves.toMatchObject({ revision: 2 });

    expect(await repository.getDocument(USER_ID, DOCUMENT_ID)).toMatchObject({
      currentRevision: 2,
      document: {
        metadata: {
          layout: { preset: "business", pageSize: "letter", columns: 1 },
          citationStyle: { schemaVersion: 1, style: "apa7" },
          writingStyle: {
            register: "professional",
            voice: "neutral",
            jargonLevel: "moderate",
            sentenceStyle: "balanced",
          },
        },
      },
    });
    expect(await repository.listRevisions(USER_ID, DOCUMENT_ID)).toHaveLength(2);
  });

  it("returns an unsupported custom template to a concrete input question without mutating", async () => {
    const stored = await repository.getDocumentAgentSession(USER_ID, DOCUMENT_ID);
    if (!stored) throw new Error("expected document agent session");
    const provided = <T,>(value: T) => ({
      status: "provided" as const,
      value,
      source: { kind: "user" as const, runId: RUN_ID },
      updatedAt: NOW,
    });
    const stateVersion = stored.stateVersion + 1;
    const session = DocumentAgentSessionSchema.parse({
      ...stored.session,
      brief: {
        ...stored.session.brief,
        template: {
          ...stored.session.brief.template,
          family: provided("custom"),
          customTemplate: provided(String.raw`evil.cls}\input{/etc/passwd}`),
          pageSize: provided("A4"),
          columns: provided(1),
        },
      },
      stateVersion,
      lastProcessedRunId: "90000000-0000-4000-8000-000000000002",
      updatedAt: NOW,
    });
    await repository.saveDocumentAgentSession(
      StoredDocumentAgentSessionSchema.parse({
        ...stored,
        session,
        stateVersion,
        updatedAt: NOW,
      }),
      stored.stateVersion,
    );

    const result = await applyConfirmedBriefLayoutStep({
      workflow: {
        userId: USER_ID,
        documentId: DOCUMENT_ID,
        runId: RUN_ID,
        prompt: "指定テンプレートで論文を書いて",
        baseRevision: 1,
        replyToRunId: null,
      },
      briefVersion: session.briefVersion,
      baseRevision: 1,
    });

    expect(result).toEqual({
      status: "needs_input",
      question:
        "仕上がりに近い形式を、標準、学術、ビジネス、コンパクトから選んでください。",
    });
    const document = await repository.getDocument(USER_ID, DOCUMENT_ID);
    expect(document?.currentRevision).toBe(1);
    expect(document?.document.metadata.layout).toBeUndefined();
    expect(await repository.getRun(USER_ID, RUN_ID)).toMatchObject({
      status: "waiting_approval",
      stage: "needs_input",
      errorMessage:
        "仕上がりに近い形式を、標準、学術、ビジネス、コンパクトから選んでください。",
    });
  });

  it("returns an unsupported citation style to a concrete input question without mutating", async () => {
    const stored = await repository.getDocumentAgentSession(USER_ID, DOCUMENT_ID);
    if (!stored) throw new Error("expected document agent session");
    const provided = <T,>(value: T) => ({
      status: "provided" as const,
      value,
      source: { kind: "user" as const, runId: RUN_ID },
      updatedAt: NOW,
    });
    const stateVersion = stored.stateVersion + 1;
    const session = DocumentAgentSessionSchema.parse({
      ...stored.session,
      brief: {
        ...stored.session.brief,
        template: {
          ...stored.session.brief.template,
          family: provided("academic"),
          pageSize: provided("A4"),
          columns: provided(1),
        },
        sources: {
          ...stored.session.brief.sources,
          policy: provided("agent_research"),
          citationStyle: provided("Chicago Notes with arbitrary CSL"),
        },
      },
      stateVersion,
      lastProcessedRunId: "90000000-0000-4000-8000-000000000003",
      updatedAt: NOW,
    });
    await repository.saveDocumentAgentSession(
      StoredDocumentAgentSessionSchema.parse({
        ...stored,
        session,
        stateVersion,
        updatedAt: NOW,
      }),
      stored.stateVersion,
    );

    const result = await applyConfirmedBriefLayoutStep({
      workflow: {
        userId: USER_ID,
        documentId: DOCUMENT_ID,
        runId: RUN_ID,
        prompt: "Chicago形式で論文を書いて",
        baseRevision: 1,
        replyToRunId: null,
      },
      briefVersion: session.briefVersion,
      baseRevision: 1,
    });

    expect(result).toEqual({
      status: "needs_input",
      question:
        "指定された引用形式には対応していません。著者年、APA第7版、IEEE、番号方式から選んでください。",
    });
    expect((await repository.getDocument(USER_ID, DOCUMENT_ID))?.currentRevision).toBe(1);
  });

  it("applies and idempotently replays an allowlisted layout mutation", async () => {
    const toolExecution = execution("call-format", [
      { role: "user", content: "B5の2段組の学術形式にして" },
    ]);
    const input = {
      baseRevision: 1,
      preset: "academic" as const,
      pageSize: "B5" as const,
      columns: 2 as const,
      citationStyle: "ieee" as const,
    };

    await expect(
      formatDocumentToolStep(input, toolContext(), toolExecution),
    ).resolves.toMatchObject({ ok: true, revision: 2 });
    await expect(
      formatDocumentToolStep(input, toolContext(), toolExecution),
    ).resolves.toMatchObject({ ok: true, revision: 2 });

    const document = await repository.getDocument(USER_ID, DOCUMENT_ID);
    expect(document).toMatchObject({
      currentRevision: 2,
      document: {
        schemaVersion: 2,
        metadata: {
          layout: { preset: "academic", pageSize: "B5", columns: 2 },
          citationStyle: { schemaVersion: 1, style: "ieee" },
        },
      },
    });
    expect(await repository.listRevisions(USER_ID, DOCUMENT_ID)).toHaveLength(2);
  });

  it("canonicalizes citation metadata from an immutable verified source", async () => {
    const source = await repository.saveSourceRecord(verifiedSource());
    await expect(
      applyDocumentPatchToolStep(
        {
          summary: "確認済みの引用を追加",
          patch: {
            id: "50000000-0000-4000-8000-000000000020",
            documentId: DOCUMENT_ID,
            baseRevision: 1,
            createdAt: NOW,
            operations: [
              {
                op: "insert",
                node: {
                  id: "50000000-0000-4000-8000-000000000021",
                  type: "citation",
                  sourceId: source.id,
                  authors: ["モデルが作った著者"],
                  title: "モデルが作った題名",
                  year: "2026",
                  url: "https://example.com/forged",
                },
                position: { kind: "definitions" },
              },
            ],
          },
        },
        toolContext(),
      ),
    ).resolves.toMatchObject({ ok: true, revision: 2 });

    const document = await repository.getDocument(USER_ID, DOCUMENT_ID);
    expect(document?.document.nodes).toContainEqual({
      id: "50000000-0000-4000-8000-000000000021",
      type: "citation",
      sourceId: source.id,
      authors: ["Ada Lovelace"],
      title: "Selective attention",
      year: "2025",
      publication: "Journal of Attention",
      doi: "10.5555/attention",
      url: "https://doi.org/10.5555/attention",
    });
  });

  it("fails closed before commit for a metadata-only citation source", async () => {
    const source = await repository.saveSourceRecord(
      verifiedSource({
        verification: "metadata_only",
        evidenceScope: "none",
        contentText: null,
        contentSha256: null,
      }),
    );

    await expect(
      applyDocumentPatchToolStep(
        {
          summary: "本文を確認できない引用を追加",
          patch: {
            id: "50000000-0000-4000-8000-000000000023",
            documentId: DOCUMENT_ID,
            baseRevision: 1,
            createdAt: NOW,
            operations: [
              {
                op: "insert",
                node: {
                  id: "50000000-0000-4000-8000-000000000024",
                  type: "citation",
                  sourceId: source.id,
                  authors: ["Ada Lovelace"],
                  title: "Selective attention",
                  year: "2025",
                },
                position: { kind: "definitions" },
              },
            ],
          },
        },
        toolContext(),
      ),
    ).rejects.toThrow("確認済みの出典");

    await expect(
      repository.getDocument(USER_ID, DOCUMENT_ID),
    ).resolves.toMatchObject({ currentRevision: 1 });
  });

  it("never commits a patch while the same model response is waiting for an answer", async () => {
    const patch = insertParagraphPatch({
      patchId: "50000000-0000-4000-8000-000000000101",
      nodeId: "50000000-0000-4000-8000-000000000102",
      baseRevision: 1,
      text: "注意機構は入力の関連部分を選択する仕組みである。",
    });
    const summary = "本文を追加";

    const batchMessages: ModelMessage[] = [
      { role: "user", content: "注意機構について論文を書いて" },
    ];
    const outcomes = await Promise.allSettled([
      applyDocumentPatchToolStep(
        { patch, summary },
        toolContext(),
        execution("call-write", batchMessages),
      ),
      requestInputToolStep(
        { question: "対象とする読者は誰ですか？" },
        toolContext(),
        execution("call-question", batchMessages),
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

    const [storedDocument, run, events] = await Promise.all([
      repository.getDocument(USER_ID, DOCUMENT_ID),
      repository.getRun(USER_ID, RUN_ID),
      repository.listRunEvents(USER_ID, RUN_ID),
    ]);
    const claims = events.filter(
      (event) => event.detail?.code === "tool_mutation_claim",
    );
    expect(claims).toHaveLength(1);

    if (run?.status === "waiting_approval") {
      expect(run).toMatchObject({
        stage: "needs_input",
        resultRevision: null,
        errorMessage: "対象とする読者は誰ですか？",
      });
      expect(storedDocument?.currentRevision).toBe(1);
      expect(await repository.listRevisions(USER_ID, DOCUMENT_ID)).toHaveLength(1);
      await expect(
        requestInputToolStep(
          { question: "対象とする読者は誰ですか？" },
          toolContext(),
          execution("call-question", batchMessages),
        ),
      ).resolves.toEqual({ ok: true });
    } else {
      expect(run).toMatchObject({
        status: "running",
        stage: "writing",
        resultRevision: 2,
        errorMessage: null,
      });
      expect(storedDocument?.currentRevision).toBe(2);
      expect(events.filter((event) => event.stage === "needs_input")).toHaveLength(0);
      await expect(
        applyDocumentPatchToolStep(
          { patch, summary },
          toolContext(),
          execution("call-write", batchMessages),
        ),
      ).resolves.toMatchObject({ ok: true, revision: 2 });
      expect(await repository.listRevisions(USER_ID, DOCUMENT_ID)).toHaveLength(2);
    }
  });

  it("allows a later model turn to apply a second durable mutation", async () => {
    const first = insertParagraphPatch({
      patchId: "50000000-0000-4000-8000-000000000111",
      nodeId: "50000000-0000-4000-8000-000000000112",
      baseRevision: 1,
      text: "最初の本文。",
    });

    await applyDocumentPatchToolStep(
      { patch: first, summary: "本文を追加" },
      toolContext(),
      execution("call-first", [{ role: "user", content: "最初の依頼" }]),
    );

    const second = insertParagraphPatch({
      patchId: "50000000-0000-4000-8000-000000000113",
      nodeId: "50000000-0000-4000-8000-000000000114",
      baseRevision: 2,
      text: "今後の課題。",
      createdAt: "2026-08-07T12:01:00.000+09:00",
    });

    await expect(
      applyDocumentPatchToolStep(
        { patch: second, summary: "今後の課題を追加" },
        toolContext(),
        execution("call-second", [
          { role: "user", content: "最初の依頼" },
          { role: "assistant", content: "最初の変更を反映しました" },
          { role: "user", content: "今後の課題も追加して" },
        ]),
      ),
    ).resolves.toMatchObject({ ok: true, revision: 3 });

    expect(await repository.getDocument(USER_ID, DOCUMENT_ID)).toMatchObject({
      currentRevision: 3,
    });
    const events = await repository.listRunEvents(USER_ID, RUN_ID);
    expect(
      events.filter((event) => event.detail?.code === "tool_mutation_claim"),
    ).toHaveLength(2);
  });

  it("rejects a reused patch id when its durable commit payload differs", async () => {
    const patch = insertParagraphPatch({
      patchId: "50000000-0000-4000-8000-000000000121",
      nodeId: "50000000-0000-4000-8000-000000000122",
      baseRevision: 1,
      text: "注意機構の概要。",
    });

    await applyDocumentPatchToolStep(
      { patch, summary: "本文を追加" },
      toolContext(),
      execution("call-original", [{ role: "user", content: "最初の依頼" }]),
    );

    await expect(
      applyDocumentPatchToolStep(
        { patch, summary: "異なる要約" },
        toolContext(),
        execution("call-conflicting-replay", [
          { role: "user", content: "最初の依頼" },
          { role: "assistant", content: "反映しました" },
          { role: "user", content: "もう一度反映して" },
        ]),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(await repository.listRevisions(USER_ID, DOCUMENT_ID)).toHaveLength(2);
  });
});

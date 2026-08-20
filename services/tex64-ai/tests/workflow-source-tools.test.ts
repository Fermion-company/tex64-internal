import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import { DocumentSchema } from "@/domain/document";
import type {
  DocumentRepository,
  StoredAgentRun,
} from "@/server/persistence";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import type { SourceRecord } from "@/server/sources";
import {
  resolveSourceToolStep,
} from "@/workflows/document-agent/steps";
import { trustedSourcePromptForRun } from "@/workflows/document-agent/trusted-source-prompt";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "40c7df69-05ef-4fe0-bb2d-a21779510c9a";
const RUN_ID = "10000000-0000-4000-8000-000000000001";
const REPLY_RUN_ID = "10000000-0000-4000-8000-000000000002";
const UNRELATED_RUN_ID = "10000000-0000-4000-8000-000000000003";
const SOURCE_ID = "50000000-0000-4000-8000-000000000001";
const AUTHORIZED_LOCATOR = "https://doi.org/10.5555/attention";
const NOW = "2026-08-07T12:00:00.000+09:00";

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

function record(locator = AUTHORIZED_LOCATOR): SourceRecord {
  const contentText = "検証済みの要旨".repeat(2_000);
  return {
    schemaVersion: 1,
    id: SOURCE_ID,
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    kind: "doi",
    canonicalLocator: locator,
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
  };
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-source-tool-"));
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
        title: "出典付き文書",
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
    prompt: `${AUTHORIZED_LOCATOR} を確認して論文を書いて`,
    idempotencyKey: "source-tool-run-1",
    baseRevision: 1,
  });
  await repository.activateRunForWorkflow(USER_ID, RUN_ID, "workflow-source-tool");
});

afterEach(async () => {
  delete (globalThis as RepositoryGlobal).__tex64DocumentRepository;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function context(runId = RUN_ID) {
  return { documentId: DOCUMENT_ID, runId, actorId: USER_ID };
}

function execution(): { toolCallId: string; messages: ModelMessage[] } {
  return {
    toolCallId: "call-resolve-source",
    messages: [{ role: "user", content: "依頼を続けて" }],
  };
}

describe.sequential("durable source tool", () => {
  it("authorizes the stored prompt and returns a bounded cached projection", async () => {
    const stored = await repository.saveSourceRecord(record());
    expect(stored.id).toBe(SOURCE_ID);

    const result = await resolveSourceToolStep(
      { locator: "DOI:10.5555/ATTENTION" },
      context(),
      execution(),
    );
    expect(result).toMatchObject({
      status: "resolved",
      sourceId: SOURCE_ID,
      canonicalLocator: AUTHORIZED_LOCATOR,
      usableForClaims: true,
      citationReady: true,
    });
    if (result.status !== "resolved") return;
    expect(result.excerpt?.length).toBeLessThanOrEqual(12_000);
    expect(JSON.stringify(result)).not.toContain(record().contentText);
    expect(result).not.toHaveProperty("resolvedLocator");
    expect(result).not.toHaveProperty("fetchedAt");
  });

  it("authorizes only prompts in the current durable reply chain", async () => {
    const sourceRun = await repository.getRun(USER_ID, RUN_ID);
    if (!sourceRun) throw new Error("expected source run");
    await repository.setRunNeedsInput({
      userId: USER_ID,
      documentId: DOCUMENT_ID,
      runId: RUN_ID,
      expectedStateVersion: sourceRun.stateVersion,
      code: "clarification_required",
      question: "この資料を使いますか？",
    });
    await repository.createRun({
      id: REPLY_RUN_ID,
      userId: USER_ID,
      documentId: DOCUMENT_ID,
      prompt: "はい、その資料を使ってください",
      replyToRunId: RUN_ID,
      idempotencyKey: "source-tool-reply-1",
      baseRevision: 1,
    });
    await repository.activateRunForWorkflow(
      USER_ID,
      REPLY_RUN_ID,
      "workflow-source-tool-reply",
    );
    await repository.saveSourceRecord(record());

    await expect(
      resolveSourceToolStep(
        { locator: AUTHORIZED_LOCATOR },
        context(REPLY_RUN_ID),
        execution(),
      ),
    ).resolves.toMatchObject({
      status: "resolved",
      canonicalLocator: AUTHORIZED_LOCATOR,
    });
  });

  it("hard-fails an untrusted locator even when a matching record exists", async () => {
    const untrusted = "https://doi.org/10.5555/untrusted";
    await repository.createRun({
      id: UNRELATED_RUN_ID,
      userId: USER_ID,
      documentId: DOCUMENT_ID,
      prompt: `${untrusted} を確認して`,
      idempotencyKey: "source-tool-unrelated-1",
      baseRevision: 1,
    });
    await repository.saveSourceRecord({
      ...record(untrusted),
      metadata: {
        ...record().metadata,
        doi: "10.5555/untrusted",
      },
    });

    await expect(
      resolveSourceToolStep(
        { locator: untrusted },
        context(),
        execution(),
      ),
    ).rejects.toThrow("確認対象として指定されていません");
  });

  it("does not resolve without AI SDK execution evidence", async () => {
    await expect(
      resolveSourceToolStep(
        { locator: AUTHORIZED_LOCATOR },
        context(),
      ),
    ).rejects.toThrow("この資料を確認できません");
  });

  it("rejects a loop in the trusted prompt chain", async () => {
    const first = storedRun("run-first", "run-second", "first");
    const second = storedRun("run-second", "run-first", "second");
    const runs = new Map([
      [first.id, first],
      [second.id, second],
    ]);
    const fakeRepository = {
      getRun: async (_userId: string, runId: string) => runs.get(runId) ?? null,
    } as unknown as DocumentRepository;

    await expect(
      trustedSourcePromptForRun(fakeRepository, first),
    ).rejects.toThrow("安全に読み取れません");
  });

  it("rejects a trusted prompt chain longer than eight runs", async () => {
    const runs = Array.from({ length: 9 }, (_, index) =>
      storedRun(
        `run-${index}`,
        index === 0 ? null : `run-${index - 1}`,
        `prompt-${index}`,
      ),
    );
    const runById = new Map(runs.map((run) => [run.id, run]));
    const fakeRepository = {
      getRun: async (_userId: string, runId: string) => runById.get(runId) ?? null,
    } as unknown as DocumentRepository;

    await expect(
      trustedSourcePromptForRun(fakeRepository, runs[8]!),
    ).rejects.toThrow("長すぎる");
    await expect(
      trustedSourcePromptForRun(fakeRepository, runs[7]!),
    ).resolves.toContain("prompt-0");
  });
});

function storedRun(
  id: string,
  replyToRunId: string | null,
  prompt: string,
): StoredAgentRun {
  return {
    id,
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    prompt,
    replyToRunId,
    idempotencyKey: `idempotency-${id}`,
    workflowRunId: "workflow-test",
    status: "running",
    stage: "writing",
    baseRevision: 1,
    resultRevision: null,
    artifactRelease: null,
    errorMessage: null,
    resultNote: null,
    targetNodeId: null,
    stateVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

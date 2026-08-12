import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SAMPLE_DOCUMENT } from "@/domain/document";
import { ResearchLedgerConflictError } from "@/server/persistence";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import {
  createResearchLedgerDigest,
  type ResearchLedger,
} from "@/server/research";

const USER_ID = "71000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "71000000-0000-4000-8000-000000000002";
const RUN_ID = "71000000-0000-4000-8000-000000000003";
const REVIEW_RUN_ID = "71000000-0000-4000-8000-000000000004";
const LEDGER_ID = "71000000-0000-4000-8000-000000000005";
const PLAN_ID = "71000000-0000-4000-8000-000000000006";
const NOW = "2026-08-08T00:00:00.000Z";

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

function ledger(model = "independent-review-model"): ResearchLedger {
  const unsigned: Omit<ResearchLedger, "ledgerDigest"> = {
    schemaVersion: 1,
    id: LEDGER_ID,
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    authoringRunId: RUN_ID,
    target: {
      documentRevision: 1,
      documentDigest: "a".repeat(64),
      briefVersion: 1,
      briefDigest: "b".repeat(64),
      planId: PLAN_ID,
      planVersion: 1,
      planDigest: "c".repeat(64),
      sourceSnapshotDigest: "d".repeat(64),
    },
    reviewer: {
      provider: "AI Gateway",
      model,
      reviewRunId: REVIEW_RUN_ID,
    },
    sourceSnapshot: {
      status: "complete",
      citedSourceIds: [],
      unavailableSourceIds: [],
      nonEvidenceSourceIds: [],
    },
    claims: [],
    requirements: [],
    status: "passed",
    createdAt: NOW,
  };
  return { ...unsigned, ledgerDigest: createResearchLedgerDigest(unsigned) };
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "tex64-research-ledger-"),
  );
  repository = new LocalDocumentRepository(
    path.join(temporaryDirectory, "store.json"),
  );
  await repository.createDocument(USER_ID, SAMPLE_DOCUMENT);
  await repository.createRun({
    id: RUN_ID,
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    prompt: "根拠を確認して文書を書く",
    idempotencyKey: "research-ledger-run",
    baseRevision: 1,
  });
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("research review persistence", () => {
  it("replays the same immutable result offline without recomputation", async () => {
    const saved = await repository.saveResearchLedger(ledger());
    const reloadedRepository = new LocalDocumentRepository(repository.filePath);
    const replayed = await reloadedRepository.getResearchLedger(
      USER_ID,
      SAMPLE_DOCUMENT.id,
      LEDGER_ID,
    );

    expect(replayed).toEqual(saved);
    expect(await reloadedRepository.saveResearchLedger(ledger())).toEqual(saved);
  });

  it("rejects identifier reuse with a different recomputed digest", async () => {
    await repository.saveResearchLedger(ledger());
    await expect(
      repository.saveResearchLedger(ledger("different-review-model")),
    ).rejects.toBeInstanceOf(ResearchLedgerConflictError);
  });

  it("does not expose a tenant's review to another tenant", async () => {
    await repository.saveResearchLedger(ledger());
    await expect(
      repository.getResearchLedger(
        OTHER_USER_ID,
        SAMPLE_DOCUMENT.id,
        LEDGER_ID,
      ),
    ).resolves.toBeNull();
  });
});

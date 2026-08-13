import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  StoredDocumentAgentSessionSchema,
  type StoredDocumentAgentSession,
} from "@/domain/brief";
import { SAMPLE_DOCUMENT } from "@/domain/document";
import { LocalDocumentRepository } from "./local-repository";
import { DocumentAgentSessionConflictError } from "./types";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "40000000-0000-4000-8000-000000000002";
const SESSION_ID = "50000000-0000-4000-8000-000000000001";
const ROOT_RUN_ID = "60000000-0000-4000-8000-000000000001";
const FIRST_RUN_ID = "60000000-0000-4000-8000-000000000002";
const SECOND_RUN_ID = "60000000-0000-4000-8000-000000000003";
const COMPETING_RUN_ID = "60000000-0000-4000-8000-000000000004";
const CREATED_AT = "2026-08-08T00:00:00.000Z";

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-session-"));
  repository = new LocalDocumentRepository(
    path.join(temporaryDirectory, "store.json"),
  );
  await repository.createDocument(USER_ID, structuredClone(SAMPLE_DOCUMENT));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function unknownRequirement(updatedAt: string) {
  return {
    status: "unknown" as const,
    value: null,
    source: null,
    updatedAt,
  };
}

function storedSession(input: {
  stateVersion: number;
  lastProcessedRunId: string | null;
  updatedAt: string;
  phase?: "intake" | "eliciting" | "drafting";
}): StoredDocumentAgentSession {
  const requirement = () => unknownRequirement(input.updatedAt);
  return StoredDocumentAgentSessionSchema.parse({
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    stateVersion: input.stateVersion,
    updatedAt: input.updatedAt,
    session: {
      schemaVersion: 1,
      id: SESSION_ID,
      documentId: SAMPLE_DOCUMENT.id,
      rootRunId: ROOT_RUN_ID,
      phase: input.phase ?? "intake",
      brief: {
        schemaVersion: 1,
        documentId: SAMPLE_DOCUMENT.id,
        goal: {
          deliverable: requirement(),
          subject: requirement(),
          purpose: requirement(),
          audience: requirement(),
          intendedOutcome: requirement(),
        },
        scope: {
          includedTopics: requirement(),
          excludedTopics: requirement(),
          depth: requirement(),
          targetLength: requirement(),
          language: requirement(),
        },
        template: {
          family: requirement(),
          customTemplate: requirement(),
          sectionOrder: requirement(),
          pageSize: requirement(),
          columns: requirement(),
        },
        figures: {
          policy: requirement(),
          items: requirement(),
        },
        equations: {
          policy: requirement(),
          derivationDetail: requirement(),
          proofRigor: requirement(),
          notationConvention: requirement(),
          numbering: requirement(),
        },
        sources: {
          policy: requirement(),
          citationStyle: requirement(),
          minimumCount: requirement(),
          dateRange: requirement(),
          requiredLocators: requirement(),
        },
        tone: {
          register: requirement(),
          voice: requirement(),
          jargonLevel: requirement(),
          sentenceStyle: requirement(),
        },
        constraints: {
          mustInclude: requirement(),
          mustExclude: requirement(),
          factualUncertaintyPolicy: requirement(),
          additional: requirement(),
        },
        acceptanceCriteria: [],
        assumptions: [],
        updatedAt: input.updatedAt,
      },
      briefVersion: 1,
      confirmedBriefVersion: null,
      activeQuestionId: null,
      questions: [],
      questionCount: 0,
      consecutiveQuestionCount: 0,
      lastProcessedRunId: input.lastProcessedRunId,
      stateVersion: input.stateVersion,
      createdAt: CREATED_AT,
      updatedAt: input.updatedAt,
    },
  });
}

describe("document agent session persistence", () => {
  it("isolates tenants and persists a schema-validated snapshot", async () => {
    const initial = storedSession({
      stateVersion: 0,
      lastProcessedRunId: FIRST_RUN_ID,
      updatedAt: CREATED_AT,
    });

    await expect(
      repository.saveDocumentAgentSession(initial, null),
    ).resolves.toEqual(initial);
    await expect(
      repository.getDocumentAgentSession(USER_ID, SAMPLE_DOCUMENT.id),
    ).resolves.toEqual(initial);
    await expect(
      repository.getDocumentAgentSession(OTHER_USER_ID, SAMPLE_DOCUMENT.id),
    ).resolves.toBeNull();
  });

  it("uses CAS while returning the first result for a processed-run replay", async () => {
    const initial = storedSession({
      stateVersion: 0,
      lastProcessedRunId: FIRST_RUN_ID,
      updatedAt: CREATED_AT,
    });
    await repository.saveDocumentAgentSession(initial, null);

    const updated = storedSession({
      stateVersion: 1,
      lastProcessedRunId: SECOND_RUN_ID,
      updatedAt: "2026-08-08T00:01:00.000Z",
      phase: "eliciting",
    });
    await expect(
      repository.saveDocumentAgentSession(updated, 0),
    ).resolves.toEqual(updated);

    const replayWithDifferentOutput = storedSession({
      stateVersion: 2,
      lastProcessedRunId: SECOND_RUN_ID,
      updatedAt: "2026-08-08T00:02:00.000Z",
      phase: "eliciting",
    });
    await expect(
      repository.saveDocumentAgentSession(replayWithDifferentOutput, 0),
    ).resolves.toEqual(updated);

    const staleDifferentRun = storedSession({
      stateVersion: 2,
      lastProcessedRunId: COMPETING_RUN_ID,
      updatedAt: "2026-08-08T00:02:00.000Z",
      phase: "eliciting",
    });
    await expect(
      repository.saveDocumentAgentSession(staleDifferentRun, 0),
    ).rejects.toMatchObject({
      name: "DocumentAgentSessionConflictError",
      expectedStateVersion: 0,
      actualStateVersion: 1,
    });
  });

  it("atomically accepts only one concurrent write for a state version", async () => {
    await repository.saveDocumentAgentSession(
      storedSession({
        stateVersion: 0,
        lastProcessedRunId: FIRST_RUN_ID,
        updatedAt: CREATED_AT,
      }),
      null,
    );
    const candidates = [SECOND_RUN_ID, COMPETING_RUN_ID].map((runId, index) =>
      storedSession({
        stateVersion: 1,
        lastProcessedRunId: runId,
        updatedAt: `2026-08-08T00:0${index + 1}:00.000Z`,
        phase: "eliciting",
      }),
    );

    const results = await Promise.allSettled(
      candidates.map((candidate) =>
        repository.saveDocumentAgentSession(candidate, 0),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(
      DocumentAgentSessionConflictError,
    );
  });

  it("rejects malformed session JSON read from the local store", async () => {
    const initial = storedSession({
      stateVersion: 0,
      lastProcessedRunId: FIRST_RUN_ID,
      updatedAt: CREATED_AT,
    });
    await repository.saveDocumentAgentSession(initial, null);
    const store = JSON.parse(await readFile(repository.filePath, "utf8")) as {
      documentAgentSessions: Record<string, { session: { phase: string } }>;
    };
    const key = `${USER_ID}:${SAMPLE_DOCUMENT.id}`;
    store.documentAgentSessions[key]!.session.phase = "not-a-real-phase";
    await writeFile(repository.filePath, JSON.stringify(store));

    const reloaded = new LocalDocumentRepository(repository.filePath);
    await expect(
      reloaded.getDocumentAgentSession(USER_ID, SAMPLE_DOCUMENT.id),
    ).rejects.toThrow();
  });
});

describe("PostgreSQL document agent session migration", () => {
  it("defines a tenant-scoped, RLS-protected session table", async () => {
    const migration = await readFile(
      new URL("./migrations/0006_document_agent_sessions.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS public.tex64_document_agent_sessions",
    );
    expect(migration).toContain("PRIMARY KEY (user_id, document_id)");
    expect(migration).toContain("REFERENCES public.tex64_documents(user_id, id)");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("session -> 'stateVersion' = to_jsonb(state_version)");
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DocumentAgentSessionSchema,
  StoredDocumentAgentSessionSchema,
  applyBriefExtraction,
  applyExplicitDelegation,
  confirmDocumentBrief,
  createDocumentAgentSession,
  extractBriefDeterministically,
} from "@/domain/brief";
import { DocumentSchema } from "@/domain/document";
import type { DocumentRepository } from "@/server/persistence";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";
import { RunReplyConflictError } from "@/server/persistence/types";
import {
  assessDocumentBriefStep,
  createDocumentPlanStep,
  failDocumentRunStep,
  resolveDocumentRunPromptStep,
} from "@/workflows/document-agent/steps";
import { AGENT_RUNTIME_UNCONFIGURED_MESSAGE } from "@/workflows/document-agent/helpers";
import type {
  DocumentAgentWorkflowInput,
  DocumentBriefAssessment,
} from "@/workflows/document-agent/types";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "40c7df69-05ef-4fe0-bb2d-a21779510c9a";
const RUN_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
  "10000000-0000-4000-8000-000000000006",
  "10000000-0000-4000-8000-000000000007",
  "10000000-0000-4000-8000-000000000008",
  "10000000-0000-4000-8000-000000000009",
] as const;
const NOW = "2026-08-07T12:00:00.000+09:00";

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

let temporaryDirectory: string;
let repository: LocalDocumentRepository;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-brief-"));
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
  index: number;
  prompt: string;
  replyToRunId?: string | null;
}): Promise<DocumentAgentWorkflowInput> {
  const id = RUN_IDS[input.index];
  if (!id) throw new Error("Missing run id fixture.");
  const document = await repository.getDocument(USER_ID, DOCUMENT_ID);
  if (!document) throw new Error("Missing document fixture.");
  const run = await repository.createRun({
    id,
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    prompt: input.prompt,
    replyToRunId: input.replyToRunId ?? null,
    idempotencyKey: `brief-run-${input.index}`,
    baseRevision: document.currentRevision,
  });
  await repository.activateRunForWorkflow(USER_ID, run.id, `workflow-${run.id}`);
  return {
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    runId: run.id,
    prompt: run.prompt,
    baseRevision: run.baseRevision,
    replyToRunId: run.replyToRunId,
  };
}

async function seedConfirmedPaperSession(
  options: { figurePolicy?: "provided_only" } = {},
): Promise<void> {
  const rootRunId = "20000000-0000-4000-8000-000000000001";
  const answerRunId = "20000000-0000-4000-8000-000000000002";
  const delegationRunId = "20000000-0000-4000-8000-000000000003";
  const confirmationRunId = "20000000-0000-4000-8000-000000000004";
  let session = createDocumentAgentSession({
    sessionId: "30000000-0000-4000-8000-000000000001",
    documentId: DOCUMENT_ID,
    rootRunId,
    deliverable: "paper",
    now: NOW,
  });
  const subjectAnswer = "注意機構について論文を書いて";
  session = applyBriefExtraction({
    session,
    extraction: extractBriefDeterministically({ text: subjectAnswer }),
    answerText: subjectAnswer,
    runId: answerRunId,
    now: NOW,
  });
  session = applyExplicitDelegation({
    session,
    groups: [
      "purpose_audience",
      "scope_structure",
      "sources_evidence",
      "mathematics",
      "visuals",
      "presentation",
      "acceptance",
    ],
    delegatedByRunId: delegationRunId,
    now: NOW,
  });
  session = confirmDocumentBrief({
    session,
    confirmedByRunId: confirmationRunId,
    now: NOW,
  });
  if (options.figurePolicy === "provided_only") {
    // Simulates a session confirmed by the previous runtime, where this mode
    // was incorrectly considered executable.
    session = DocumentAgentSessionSchema.parse({
      ...session,
      brief: {
        ...session.brief,
        figures: {
          ...session.brief.figures,
          policy: {
            status: "provided",
            value: "provided_only",
            source: { kind: "user", runId: answerRunId },
            updatedAt: NOW,
          },
        },
      },
      updatedAt: NOW,
    });
  }
  session = DocumentAgentSessionSchema.parse({
    ...session,
    stateVersion: 0,
  });
  await repository.saveDocumentAgentSession(
    StoredDocumentAgentSessionSchema.parse({
      userId: USER_ID,
      documentId: DOCUMENT_ID,
      session,
      stateVersion: 0,
      updatedAt: session.updatedAt,
    }),
    null,
  );
}

async function seedLegacyDocument(): Promise<void> {
  const current = await repository.getDocument(USER_ID, DOCUMENT_ID);
  if (!current) throw new Error("Missing document fixture.");
  const sectionId = "70000000-0000-4000-8000-000000000001";
  const paragraphId = "70000000-0000-4000-8000-000000000002";
  const existing = DocumentSchema.parse({
    ...current.document,
    root: [sectionId],
    nodes: [
      {
        id: sectionId,
        type: "section",
        title: [{ type: "text", text: "結論", marks: [] }],
        children: [paragraphId],
      },
      {
        id: paragraphId,
        type: "paragraph",
        content: [{ type: "text", text: "既存の誤字Aです。", marks: [] }],
      },
    ],
  });
  await repository.commitDocument({
    commitId: "70000000-0000-4000-8000-000000000003",
    userId: USER_ID,
    documentId: DOCUMENT_ID,
    expectedRevision: 1,
    document: existing,
    actor: "user",
    summary: "既存文書を用意",
    operations: [
      {
        op: "insert",
        node: existing.nodes[0]!,
        position: { kind: "root", index: 0 },
      },
      {
        op: "insert",
        node: existing.nodes[1]!,
        position: { kind: "section", parentId: sectionId, index: 0 },
      },
    ],
  });
}

async function assess(input: {
  index: number;
  prompt: string;
  replyToRunId?: string | null;
}): Promise<{
  workflow: DocumentAgentWorkflowInput;
  assessment: DocumentBriefAssessment;
}> {
  const workflow = await createRunningRun(input);
  const promptContext = await resolveDocumentRunPromptStep(workflow);
  const assessment = await assessDocumentBriefStep({
    workflow,
    promptContext,
    runtime: { provider: "deterministic_fallback", model: null },
  });
  return { workflow, assessment };
}

describe.sequential("typed document brief workflow", () => {
  it("autopilots a sparse request using the prompt itself as the subject", async () => {
    // Build-first: intake never asks. Even "論文を書いて" starts writing with
    // the raw prompt as the subject and every other requirement delegated.
    const result = await assess({
      index: 0,
      prompt: "論文を書いて",
    });
    expect(result.assessment).toMatchObject({
      status: "ready",
      legacyDocument: false,
    });

    const stored = await repository.getDocumentAgentSession(
      USER_ID,
      DOCUMENT_ID,
    );
    expect(stored?.session).toMatchObject({
      phase: "drafting",
      confirmedBriefVersion: stored?.session.briefVersion,
    });
    expect(stored?.session.brief.goal.subject).toMatchObject({
      status: "provided",
      value: "論文を書いて",
    });
    expect(stored?.session.questions).toHaveLength(0);
  });

  it("self-confirms a subject-bearing request with delegated defaults and plans it", async () => {
    const result = await assess({
      index: 0,
      prompt: "Transformerの注意機構について論文を書いて",
    });
    expect(result.assessment).toMatchObject({
      status: "ready",
      legacyDocument: false,
    });

    const stored = await repository.getDocumentAgentSession(
      USER_ID,
      DOCUMENT_ID,
    );
    expect(stored?.session).toMatchObject({
      phase: "drafting",
      confirmedBriefVersion: stored?.session.briefVersion,
    });
    expect(stored?.session.brief.goal.subject.value).toContain(
      "Transformerの注意機構",
    );
    expect(stored?.session.brief.sources.policy.status).toBe("delegated");
    expect(stored?.session.brief.equations.derivationDetail.status).toBe(
      "delegated",
    );
    expect(stored?.session.brief.figures.policy.status).toBe("delegated");
    const plan = await createDocumentPlanStep({
      workflow: result.workflow,
      runtime: { provider: "deterministic_fallback", model: null },
    });
    expect(plan.sections.map((section) => section.title)).toEqual(
      stored?.session.brief.template.sectionOrder.value,
    );
    await expect(repository.getDocument(USER_ID, DOCUMENT_ID)).resolves.toMatchObject({
      currentRevision: 1,
    });
  });

  it("replays the same intake run with an identical ready assessment", async () => {
    const workflow = await createRunningRun({
      index: 0,
      prompt: "注意機構について論文を書いて",
    });
    const promptContext = await resolveDocumentRunPromptStep(workflow);
    const input = {
      workflow,
      promptContext,
      runtime: { provider: "deterministic_fallback" as const, model: null },
    };
    const first = await assessDocumentBriefStep(input);
    const replay = await assessDocumentBriefStep(input);

    expect(replay).toEqual(first);
    const stored = await repository.getDocumentAgentSession(
      USER_ID,
      DOCUMENT_ID,
    );
    expect(stored?.session.questions).toHaveLength(0);
    expect(stored?.stateVersion).toBe(0);
  });

  it("stores the configuration failure message on the failed run", async () => {
    const workflow = await createRunningRun({
      index: 0,
      prompt: "論文を書いて",
    });

    await failDocumentRunStep({
      workflow,
      code: "agent_runtime_unconfigured",
      message: AGENT_RUNTIME_UNCONFIGURED_MESSAGE,
    });

    await expect(repository.getRun(USER_ID, workflow.runId)).resolves.toMatchObject({
      status: "failed",
      stage: "failed",
      errorMessage: AGENT_RUNTIME_UNCONFIGURED_MESSAGE,
    });
  });

  it("rejects a reply that does not target an awaiting-input run", async () => {
    await expect(
      createRunningRun({
        index: 0,
        prompt: "この回答です",
        replyToRunId: RUN_IDS[8],
      }),
    ).rejects.toBeInstanceOf(RunReplyConflictError);

    // Standalone prompts are never blocked by intake state anymore.
    await expect(
      createRunningRun({ index: 1, prompt: "別の文書を書いて" }),
    ).resolves.toMatchObject({ replyToRunId: null });
  });

  it.each([
    ["10ページへ変更", "scope.targetLength", "10ページ"],
    ["引用形式をIEEEへ変更", "sources.citationStyle", "ieee"],
    ["主題を量子計算に変えて全面改稿", "goal.subject", "量子計算"],
  ] as const)(
    "absorbs a standalone change to a confirmed requirement and re-confirms: %s",
    async (prompt, path, expectedValue) => {
      await seedConfirmedPaperSession();
      const before = await repository.getDocumentAgentSession(USER_ID, DOCUMENT_ID);
      const result = await assess({ index: 0, prompt });

      // Build-first: the change lands in the brief and confirmation renews
      // automatically instead of pausing for another approval round.
      expect(result.assessment).toMatchObject({ status: "ready" });
      const stored = await repository.getDocumentAgentSession(
        USER_ID,
        DOCUMENT_ID,
      );
      expect(stored?.session.briefVersion).toBe(
        (before?.session.briefVersion ?? 0) + 1,
      );
      expect(stored?.session.confirmedBriefVersion).toBe(
        stored?.session.briefVersion,
      );
      const actualValue =
        path === "scope.targetLength"
          ? stored?.session.brief.scope.targetLength.value
          : path === "sources.citationStyle"
            ? stored?.session.brief.sources.citationStyle.value
            : stored?.session.brief.goal.subject.value;
      expect(actualValue).toContain(expectedValue);
      await expect(
        repository.getDocument(USER_ID, DOCUMENT_ID),
      ).resolves.toMatchObject({ currentRevision: 1 });
    },
  );

  it("resolves a stored provided-only figure choice to agent proposals without asking", async () => {
    await seedConfirmedPaperSession({ figurePolicy: "provided_only" });

    const result = await assess({ index: 0, prompt: "続けて" });
    expect(result.assessment).toMatchObject({ status: "ready" });

    const stored = await repository.getDocumentAgentSession(
      USER_ID,
      DOCUMENT_ID,
    );
    expect(stored?.session.brief.figures.policy).toMatchObject({
      status: "delegated",
      value: "agent_proposes",
    });
    expect(stored?.session.confirmedBriefVersion).toBe(
      stored?.session.briefVersion,
    );
    await expect(
      repository.getDocument(USER_ID, DOCUMENT_ID),
    ).resolves.toMatchObject({ currentRevision: 1 });
  });

  it("lets an exact local edit of a legacy document bypass full intake", async () => {
    await seedLegacyDocument();

    const result = await assess({
      index: 0,
      prompt: "「誤字A」を「正字B」に置換して",
    });

    expect(result.assessment).toEqual({
      status: "ready",
      brief: null,
      briefVersion: null,
      legacyDocument: true,
    });
    await expect(
      repository.getDocumentAgentSession(USER_ID, DOCUMENT_ID),
    ).resolves.toBeNull();
    await expect(
      repository.getDocument(USER_ID, DOCUMENT_ID),
    ).resolves.toMatchObject({ currentRevision: 2 });
  });

  it("runs a legacy full rewrite as a conversational edit without intake", async () => {
    await seedLegacyDocument();

    // Content-bearing documents no longer re-enter intake for new prompts:
    // the agent handles the rewrite directly and asks at most one question
    // itself (request_input) when something essential is missing.
    const result = await assess({
      index: 0,
      prompt: "主題を量子計算へ変え、10ページのIEEE論文として全面改稿して",
    });

    expect(result.assessment).toEqual({
      status: "ready",
      brief: null,
      briefVersion: null,
      legacyDocument: true,
    });
    await expect(
      repository.getDocumentAgentSession(USER_ID, DOCUMENT_ID),
    ).resolves.toBeNull();
    await expect(
      repository.getDocument(USER_ID, DOCUMENT_ID),
    ).resolves.toMatchObject({ currentRevision: 2 });
  });
});

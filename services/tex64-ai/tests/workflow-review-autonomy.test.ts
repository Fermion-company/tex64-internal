import { beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: generateTextMock,
  };
});

import {
  ReviewDimensionSchema,
  createReviewPlanProjection,
  evaluateDeterministicAcceptance,
  type DeterministicAcceptanceResult,
} from "@/domain/review";
import {
  applyBriefExtraction,
  applyExplicitDelegation,
  confirmDocumentBrief,
  createDocumentAgentSession,
} from "@/domain/brief";
import {
  SAMPLE_DOCUMENT,
  SAMPLE_DOCUMENT_IDS,
} from "@/domain/document";
import {
  extractBriefRequirementsDeterministically,
} from "@/server/agent/brief-extractor";
import {
  createDocumentPlanDeterministically,
} from "@/server/agent/plan-generator";
import {
  ReviewDraftSchema,
  reviewDocumentIndependently,
} from "@/server/agent/reviewer";
import {
  ResearchEvidenceDraftSchema,
  buildResearchLedger,
  type ResearchLedger,
} from "@/server/research";
import { documentMutationReadiness } from "@/server/agent/session-policy";
import {
  MAX_CONTENT_REVIEW_REVISIONS,
  needsIndependentReviewAfterCompilation,
  nextContentReviewAction,
  safeWorkflowFailureCode,
} from "@/workflows/document-agent/helpers";

const NOW = "2026-08-08T12:00:00.000+09:00";
const AUTHORING_RUN_ID = "30000000-0000-4000-8000-000000000001";
const SUBJECT_RUN_ID = "30000000-0000-4000-8000-000000000002";
const DELEGATION_RUN_ID = "30000000-0000-4000-8000-000000000003";
const CONFIRMATION_RUN_ID = "30000000-0000-4000-8000-000000000004";
const UNKNOWN_ID = "30000000-0000-4000-8000-000000000099";

function confirmedBriefAndPlan() {
  let session = createDocumentAgentSession({
    sessionId: "30000000-0000-4000-8000-000000000010",
    documentId: SAMPLE_DOCUMENT.id,
    rootRunId: SUBJECT_RUN_ID,
    deliverable: "paper",
    now: NOW,
  });
  const answer =
    "構造化文書エージェントについて論文を書いて。対象読者は学部生で、目的は安全な自律執筆の仕組みを説明することです。";
  session = applyBriefExtraction({
    session,
    extraction: extractBriefRequirementsDeterministically({
      prompt: answer,
      activeQuestion: null,
    }),
    answerText: answer,
    runId: SUBJECT_RUN_ID,
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
    delegatedByRunId: DELEGATION_RUN_ID,
    now: NOW,
  });
  session = confirmDocumentBrief({
    session,
    confirmedByRunId: CONFIRMATION_RUN_ID,
    now: NOW,
  });
  const plan = createDocumentPlanDeterministically({
    brief: session.brief,
    briefVersion: session.briefVersion,
    now: NOW,
  });
  return { brief: session.brief, plan };
}

function reviewDocument(
  plan: ReturnType<typeof confirmedBriefAndPlan>["plan"],
) {
  const document = structuredClone(SAMPLE_DOCUMENT);
  const paragraph = document.nodes.find(
    (node) => node.id === SAMPLE_DOCUMENT_IDS.paragraph,
  );
  if (!paragraph || paragraph.type !== "paragraph") {
    throw new Error("Review fixture has no evidence paragraph.");
  }
  paragraph.content.push({
    type: "text",
    text: createReviewPlanProjection(plan).completionCriteria
      .map((criterion) => criterion.statement)
      .join("\n"),
    marks: [],
  });
  return document;
}

function concreteCriterionAnchor(statement: string): string {
  return statement.replace(/[。.!?！？]+$/u, "").trim();
}

function completeReviewDraft(plan: ReturnType<typeof confirmedBriefAndPlan>["plan"]) {
  const projection = createReviewPlanProjection(plan);
  return ReviewDraftSchema.parse({
    dimensions: ReviewDimensionSchema.options.map((dimension) => ({
      dimension,
      status: "reviewed",
      summary: `${dimension}を固定された文書版と照合した。`,
    })),
    findings: [],
    criterionAssessments: projection.completionCriteria.map((criterion) => {
      const anchor = concreteCriterionAnchor(criterion.statement);
      return {
        criterionId: criterion.id,
        outcome: "satisfied" as const,
        rationale: "完成条件の具体的な記述を文書内の根拠と照合した。",
        nodeEvidence: [
          {
            nodeId: SAMPLE_DOCUMENT_IDS.paragraph,
            excerpt: anchor,
            criterionAnchor: anchor,
          },
        ],
      };
    }),
  });
}

function requiredCriterionAssessment(
  draft: ReturnType<typeof completeReviewDraft>,
  plan: ReturnType<typeof confirmedBriefAndPlan>["plan"],
) {
  const requiredIds = new Set(
    createReviewPlanProjection(plan).completionCriteria
      .filter((criterion) => criterion.severity === "required")
      .map((criterion) => criterion.id),
  );
  const assessment = draft.criterionAssessments.find((criterion) =>
    requiredIds.has(criterion.criterionId),
  );
  if (!assessment) throw new Error("Plan fixture has no required criterion.");
  return assessment;
}

async function runReview(input?: {
  draft?: ReturnType<typeof completeReviewDraft>;
  deterministicAcceptance?: DeterministicAcceptanceResult;
  researchLedger?: ResearchLedger;
}) {
  const { brief, plan } = confirmedBriefAndPlan();
  generateTextMock.mockResolvedValueOnce({
    output: input?.draft ?? completeReviewDraft(plan),
  });
  return reviewDocumentIndependently({
    document: reviewDocument(plan),
    documentRevision: 1,
    brief,
    plan,
    authoringRunId: AUTHORING_RUN_ID,
    runtime: { provider: "ai_gateway", model: "review-model" },
    now: NOW,
    deterministicAcceptance: input?.deterministicAcceptance,
    researchLedger: input?.researchLedger,
    frozenSources: [],
  });
}

beforeEach(() => {
  generateTextMock.mockReset();
});

describe("independent reviewer fail-closed boundary", () => {
  it("accepts only a complete eight-dimension review bound to another run", async () => {
    const result = await runReview();

    expect(result.hasBlockingFindings).toBe(false);
    expect(result.review.dimensions.map((item) => item.dimension)).toEqual(
      ReviewDimensionSchema.options,
    );
    expect(result.review.reviewer.authoringRunId).toBe(AUTHORING_RUN_ID);
    expect(result.review.reviewer.reviewRunId).not.toBe(AUTHORING_RUN_ID);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("receives the full research plan rather than only a count projection", async () => {
    await runReview();

    const call = generateTextMock.mock.calls[0]?.[0] as
      | { prompt?: string }
      | undefined;
    const prompt = JSON.parse(call?.prompt ?? "{}") as {
      validatedPlan?: {
        sections?: Array<{
          researchClaims?: unknown[];
          sourceRequirements?: unknown[];
        }>;
      };
    };
    expect(prompt.validatedPlan?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          researchClaims: expect.any(Array),
          sourceRequirements: expect.any(Array),
        }),
      ]),
    );
  });

  it("does not let model output overwrite a failed deterministic gate", async () => {
    const { brief, plan } = confirmedBriefAndPlan();
    const document = reviewDocument(plan);
    const acceptance = evaluateDeterministicAcceptance({
      brief,
      briefVersion: plan.briefVersion,
      plan: createReviewPlanProjection(plan),
      document,
      documentRevision: 1,
      additionalCriteria: [],
    });
    expect(acceptance.status).toBe("failed");

    const result = await runReview({ deterministicAcceptance: acceptance });
    expect(result.hasBlockingFindings).toBe(true);
    expect(result.review.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "requirement_fulfillment",
          severity: "major",
          title: "完成条件を満たしていない箇所があります",
        }),
      ]),
    );
  });

  it("does not let a generic positive review override unsupported required claims", async () => {
    const { plan } = confirmedBriefAndPlan();
    const document = reviewDocument(plan);
    const evidenceDraft = ResearchEvidenceDraftSchema.parse({
      claims: plan.sections.flatMap((section) =>
        section.researchClaims.map((claim) => ({
          claimId: claim.id,
          rationale: "本文と資料の対応を確認できない。",
          realization: null,
          evidence: [],
        })),
      ),
    });
    const researchLedger = buildResearchLedger({
      context: {
        userId: "30000000-0000-4000-8000-000000000020",
        document,
        documentRevision: 1,
        briefVersion: plan.briefVersion,
        briefDigest: plan.briefDigest,
        plan,
        authoringRunId: AUTHORING_RUN_ID,
        reviewer: {
          provider: "AI Gateway",
          model: "review-model",
          reviewRunId: "30000000-0000-4000-8000-000000000021",
        },
        sources: [],
        createdAt: NOW,
      },
      draft: evidenceDraft,
    });
    expect(researchLedger.status).toBe("blocked");

    const result = await runReview({ researchLedger });
    expect(result.hasBlockingFindings).toBe(true);
    expect(result.review.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "factual_grounding",
          severity: "major",
          title: "根拠を確認できない主張があります",
        }),
      ]),
    );
  });

  it("rejects hallucinated node evidence instead of replacing it", async () => {
    const { plan } = confirmedBriefAndPlan();
    const draft = completeReviewDraft(plan);
    draft.findings.push({
      dimension: "factual_grounding",
      severity: "major",
      title: "根拠nodeが見つからない",
      detail: "入力にないnodeを根拠として参照している。",
      nodeEvidence: [{ nodeId: UNKNOWN_ID, excerpt: "存在しない根拠" }],
      criterionIds: [],
      autoFixable: false,
      needsUserInput: true,
      blockingUserInput: true,
      question: "根拠に使う資料を指定してください。",
    });

    await expect(runReview({ draft })).rejects.toThrow(
      "Review finding referenced unknown node",
    );
  });

  it("rejects hallucinated criterion evidence", async () => {
    const { plan } = confirmedBriefAndPlan();
    const draft = completeReviewDraft(plan);
    draft.findings.push({
      dimension: "requirement_fulfillment",
      severity: "major",
      title: "存在しない完成条件",
      detail: "計画にない完成条件を根拠としている。",
      nodeEvidence: [],
      criterionIds: [UNKNOWN_ID],
      autoFixable: false,
      needsUserInput: false,
      blockingUserInput: false,
      question: null,
    });

    await expect(runReview({ draft })).rejects.toThrow(
      "Review finding referenced unknown criterion",
    );
  });

  it("rejects an assessment for a criterion outside the fixed plan", async () => {
    const { plan } = confirmedBriefAndPlan();
    const draft = completeReviewDraft(plan);
    const assessment = draft.criterionAssessments[0];
    if (!assessment) throw new Error("Plan fixture has no criterion.");
    assessment.criterionId = UNKNOWN_ID;

    await expect(runReview({ draft })).rejects.toThrow(
      "Review assessed unknown criterion",
    );
  });

  it("rejects a missing review dimension", async () => {
    const { plan } = confirmedBriefAndPlan();
    const draft = completeReviewDraft(plan);
    draft.dimensions.pop();

    await expect(runReview({ draft })).rejects.toThrow();
  });

  it("rejects omitted and unassessed required completion criteria", async () => {
    const { plan } = confirmedBriefAndPlan();
    const omitted = completeReviewDraft(plan);
    omitted.criterionAssessments.pop();
    await expect(runReview({ draft: omitted })).rejects.toThrow(
      "Review omitted criterion",
    );

    const unassessed = completeReviewDraft(plan);
    const required = requiredCriterionAssessment(unassessed, plan);
    required.outcome = "not_assessed";
    await expect(runReview({ draft: unassessed })).rejects.toThrow(
      "was not assessed",
    );
  });

  it("rejects a satisfied declaration without document-node evidence", async () => {
    const { plan } = confirmedBriefAndPlan();
    const draft = completeReviewDraft(plan);
    const unsupported = draft.criterionAssessments.find(
      (assessment) => assessment.outcome === "satisfied",
    );
    if (!unsupported) throw new Error("Plan fixture has no satisfied criterion.");
    unsupported.nodeEvidence = [];

    await expect(runReview({ draft })).rejects.toThrow(
      "satisfied without document evidence",
    );
  });

  it("rejects a generic purpose heading as proof of a section criterion", async () => {
    const { plan } = confirmedBriefAndPlan();
    const draft = completeReviewDraft(plan);
    const assessment = draft.criterionAssessments.find((candidate) => {
      const criterion = createReviewPlanProjection(plan).completionCriteria.find(
        (item) => item.id === candidate.criterionId,
      );
      return criterion?.statement.includes("目的が本文") === true;
    });
    if (!assessment) throw new Error("Plan fixture has no section criterion.");
    assessment.nodeEvidence = [
      {
        nodeId: SAMPLE_DOCUMENT_IDS.heading,
        excerpt: "目的",
        criterionAnchor: "目的",
      },
    ];

    await expect(runReview({ draft })).rejects.toThrow(
      "evidence was unrelated to criterion",
    );
  });

  it("rejects a generic document word shared by an unrelated paragraph", async () => {
    const { plan } = confirmedBriefAndPlan();
    const draft = completeReviewDraft(plan);
    const assessment = draft.criterionAssessments.find((candidate) => {
      const criterion = createReviewPlanProjection(plan).completionCriteria.find(
        (item) => item.id === candidate.criterionId,
      );
      return criterion?.statement.includes("文書の構造") === true;
    });
    if (!assessment) throw new Error("Plan fixture has no document criterion.");
    assessment.nodeEvidence = [
      {
        nodeId: SAMPLE_DOCUMENT_IDS.paragraph,
        excerpt:
          "文書はTeXコードではなく、意味を持つブロックとインライン要素で表現されます。",
        criterionAnchor: "文書",
      },
    ];

    await expect(runReview({ draft })).rejects.toThrow(
      "evidence was unrelated to criterion",
    );
  });

  it("rejects a fabricated excerpt attached to a real node", async () => {
    const { plan } = confirmedBriefAndPlan();
    const draft = completeReviewDraft(plan);
    const assessment = requiredCriterionAssessment(draft, plan);
    assessment.nodeEvidence = [
      {
        nodeId: SAMPLE_DOCUMENT_IDS.paragraph,
        excerpt: "本文には存在しない引用です",
        criterionAnchor: "文書",
      },
    ];

    await expect(runReview({ draft })).rejects.toThrow(
      "excerpt did not match node",
    );
  });

  it("turns an unresolved required criterion into a blocking user question", async () => {
    const { plan } = confirmedBriefAndPlan();
    const draft = completeReviewDraft(plan);
    const unresolved = requiredCriterionAssessment(draft, plan);
    unresolved.outcome = "needs_user_input";
    unresolved.rationale = "ユーザー固有の結論を確定できない。";

    const result = await runReview({ draft });

    expect(result.hasBlockingFindings).toBe(true);
    expect(result.repairFindings).toEqual([]);
    expect(result.question).toContain("追加する情報や希望する方針");
    expect(result.review.findings).toContainEqual(
      expect.objectContaining({
        dimension: "requirement_fulfillment",
        severity: "major",
      }),
    );
  });

  it("cannot auto-repair a criterion that explicitly needs user input", async () => {
    const { plan } = confirmedBriefAndPlan();
    const draft = completeReviewDraft(plan);
    const unresolved = requiredCriterionAssessment(draft, plan);
    unresolved.outcome = "needs_user_input";
    unresolved.rationale = "ユーザー固有の選択がないと結論を確定できない。";
    draft.findings.push({
      dimension: "requirement_fulfillment",
      severity: "major",
      title: "結論が未確定",
      detail: "選択されていない結論を確定する必要がある。",
      nodeEvidence: [],
      criterionIds: [unresolved.criterionId],
      autoFixable: true,
      needsUserInput: false,
      blockingUserInput: false,
      question: null,
    });

    const result = await runReview({ draft });

    expect(result.question).toContain("追加する情報や希望する方針");
    expect(result.hasBlockingFindings).toBe(true);
    expect(result.review.findings).toContainEqual(
      expect.objectContaining({
        followUp: expect.objectContaining({
          required: true,
          blocking: true,
        }),
      }),
    );
  });

  it("propagates model failure without synthesizing a passing review", async () => {
    const { brief, plan } = confirmedBriefAndPlan();
    generateTextMock.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(
      reviewDocumentIndependently({
        document: SAMPLE_DOCUMENT,
        documentRevision: 1,
        brief,
        plan,
        authoringRunId: AUTHORING_RUN_ID,
        runtime: { provider: "ai_gateway", model: "review-model" },
        now: NOW,
      }),
    ).rejects.toThrow("provider unavailable");
    expect(safeWorkflowFailureCode(new Error("provider unavailable"))).toBe(
      "document_run_failed",
    );
  });
});

describe("workflow autonomy gates", () => {
  it("never permits a new-document mutation before brief confirmation", () => {
    const session = createDocumentAgentSession({
      sessionId: "30000000-0000-4000-8000-000000000020",
      documentId: SAMPLE_DOCUMENT.id,
      rootRunId: AUTHORING_RUN_ID,
      deliverable: "paper",
      now: NOW,
    });

    expect(
      documentMutationReadiness({
        session,
        documentHasContent: false,
      }),
    ).toEqual({ allowed: false, reason: "unconfirmed_brief" });
    expect(
      documentMutationReadiness({
        session: {
          ...session,
          phase: "drafting",
          confirmedBriefVersion: session.briefVersion,
        },
        documentHasContent: false,
      }),
    ).toEqual({ allowed: true, reason: "confirmed_brief" });
  });

  it("allows at most two automatic content-review repairs", () => {
    const repairable = {
      hasBlockingFindings: true,
      hasBlockingQuestion: false,
      repairFindingCount: 1,
    };

    expect(
      nextContentReviewAction({
        ...repairable,
        repairAttempts: 0,
      }),
    ).toBe("repair");
    expect(
      nextContentReviewAction({
        ...repairable,
        repairAttempts: 1,
      }),
    ).toBe("repair");
    expect(
      nextContentReviewAction({
        ...repairable,
        repairAttempts: MAX_CONTENT_REVIEW_REVISIONS,
      }),
    ).toBe("request_input");
  });

  it("requests input immediately when a blocker cannot be auto-repaired", () => {
    expect(
      nextContentReviewAction({
        hasBlockingFindings: true,
        hasBlockingQuestion: false,
        repairFindingCount: 0,
        repairAttempts: 0,
      }),
    ).toBe("request_input");
    expect(
      nextContentReviewAction({
        hasBlockingFindings: true,
        hasBlockingQuestion: true,
        repairFindingCount: 1,
        repairAttempts: 0,
      }),
    ).toBe("request_input");
    expect(
      nextContentReviewAction({
        hasBlockingFindings: false,
        hasBlockingQuestion: false,
        repairFindingCount: 0,
        repairAttempts: 0,
      }),
    ).toBe("accept");
  });

  it("requires another independent review when compilation repairs change revision", () => {
    expect(
      needsIndependentReviewAfterCompilation({
        reviewEnabled: true,
        lastReviewedRevision: 4,
        compiledRevision: 5,
      }),
    ).toBe(true);
    expect(
      needsIndependentReviewAfterCompilation({
        reviewEnabled: true,
        lastReviewedRevision: 5,
        compiledRevision: 5,
      }),
    ).toBe(false);
    expect(
      needsIndependentReviewAfterCompilation({
        reviewEnabled: false,
        lastReviewedRevision: null,
        compiledRevision: 5,
      }),
    ).toBe(false);
  });
});

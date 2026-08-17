import { describe, expect, it } from "vitest";

import {
  applyBriefExtraction,
  applyExplicitDelegation,
  createDocumentAgentSession,
} from "../brief";
import { initializeDocumentBrief } from "../brief/initialize";
import {
  DocumentBriefSchema,
  type DocumentBrief,
  type RequirementValue,
} from "../brief/schema";
import {
  SAMPLE_DOCUMENT,
  SAMPLE_DOCUMENT_IDS,
  type DocumentModel,
} from "../document";
import { createDocumentBriefDigest } from "../plan/digest";
import { extractBriefRequirementsDeterministically } from "../../server/agent/brief-extractor";
import { createDocumentPlanDeterministically } from "../../server/agent/plan-generator";
import {
  buildDeterministicAcceptanceCriteria,
  evaluateDeterministicAcceptance,
} from "./acceptance";
import {
  createReviewBriefDigest,
  createReviewDocumentDigest,
  createReviewPlanDigest,
} from "./digest";
import {
  AcceptanceEvaluationInputSchema,
  DeterministicAcceptanceResultSchema,
  IndependentReviewResultSchema,
  ReviewDimensionSchema,
  ReviewPlanProjectionSchema,
  type AcceptanceEvaluationInput,
  type IndependentReviewResult,
  type ReviewPlanProjection,
} from "./schema";
import { createReviewPlanProjection } from "./plan-projection";
import { validateIndependentReviewResult } from "./validate-review";

const NOW = "2026-08-08T00:00:00.000Z";
const AUTHORING_RUN_ID = "20000000-0000-4000-8000-000000000001";
const REVIEW_RUN_ID = "20000000-0000-4000-8000-000000000002";
const REVIEW_ID = "20000000-0000-4000-8000-000000000003";
const PLAN_ID = "20000000-0000-4000-8000-000000000010";
const PLAN_SECTION_INTRO_ID = "20000000-0000-4000-8000-000000000011";
const PLAN_SECTION_VALIDATION_ID = "20000000-0000-4000-8000-000000000012";
const PLAN_CRITERION_ID = "20000000-0000-4000-8000-000000000013";
const BRIEF_CRITERION_ID = "20000000-0000-4000-8000-000000000014";
const FINDING_ID = "20000000-0000-4000-8000-000000000020";
const UNKNOWN_NODE_ID = "20000000-0000-4000-8000-000000000099";
const VERIFIED_SOURCE_ID = "20000000-0000-4000-8000-000000000098";

function provided<T>(value: T): RequirementValue<T> {
  return {
    status: "provided",
    value,
    source: { kind: "user", runId: AUTHORING_RUN_ID },
    updatedAt: NOW,
  };
}

function reviewBrief(): DocumentBrief {
  const brief = structuredClone(
    initializeDocumentBrief({
      documentId: SAMPLE_DOCUMENT.id,
      deliverable: "article",
      now: NOW,
    }),
  );
  brief.goal.subject = provided("構造化文書エージェント");
  brief.scope.targetLength = provided("1〜10000文字");
  brief.template.sectionOrder = provided(["はじめに", "検証"]);
  brief.figures.policy = provided("required");
  brief.figures.items = provided(["生成フロー", "操作比較表"]);
  brief.equations.policy = provided("required");
  brief.sources.policy = provided("agent_research");
  brief.sources.minimumCount = provided(1);
  brief.acceptanceCriteria = [
    {
      id: BRIEF_CRITERION_ID,
      statement: "本文中で最低1件の出典を用いる",
      kind: "deterministic",
      severity: "required",
    },
  ];
  return DocumentBriefSchema.parse(brief);
}

function reviewPlan(brief: DocumentBrief = reviewBrief()): ReviewPlanProjection {
  return ReviewPlanProjectionSchema.parse({
    schemaVersion: 1,
    id: PLAN_ID,
    documentId: brief.documentId,
    briefVersion: 4,
    briefDigest: createReviewBriefDigest(brief),
    status: "completed",
    version: 2,
    sections: [
      {
        id: PLAN_SECTION_INTRO_ID,
        title: "はじめに",
        expectedAmount: {
          unit: "characters",
          minimum: 1,
          target: 100,
          maximum: 10_000,
        },
        figureCount: 1,
        tableCount: 1,
        equationCount: 1,
        minimumSourceCount: 1,
      },
      {
        id: PLAN_SECTION_VALIDATION_ID,
        title: "検証",
        expectedAmount: {
          unit: "characters",
          minimum: 1,
          target: 30,
          maximum: 10_000,
        },
        figureCount: 0,
        tableCount: 0,
        equationCount: 0,
        minimumSourceCount: 0,
      },
    ],
    completionCriteria: [
      {
        id: PLAN_CRITERION_ID,
        statement: "本文中で最低1件の出典を用いる",
        verification: "deterministic",
        severity: "required",
        briefCriterionId: BRIEF_CRITERION_ID,
        sectionId: null,
      },
    ],
  });
}

function acceptanceInput(input?: {
  brief?: DocumentBrief;
  plan?: ReviewPlanProjection;
  document?: DocumentModel;
}): AcceptanceEvaluationInput {
  const brief = input?.brief ?? reviewBrief();
  const plan = input?.plan ?? reviewPlan(brief);
  const defaultDocument = structuredClone(SAMPLE_DOCUMENT);
  defaultDocument.schemaVersion = 2;
  const citation = defaultDocument.nodes.find(
    (node) => node.type === "citation",
  );
  if (!citation || citation.type !== "citation") {
    throw new Error("Test fixture has no citation node.");
  }
  citation.sourceId = VERIFIED_SOURCE_ID;
  const figure = defaultDocument.nodes.find((node) => node.type === "figure");
  if (!figure || figure.type !== "figure") {
    throw new Error("Test fixture has no figure node.");
  }
  figure.content = {
    kind: "flowDiagram",
    direction: "left-to-right",
    nodes: [
      {
        id: "20000000-0000-4000-8000-000000000031",
        label: "依頼",
        shape: "terminator",
      },
      {
        id: "20000000-0000-4000-8000-000000000032",
        label: "完成",
        shape: "process",
      },
    ],
    edges: [
      {
        from: "20000000-0000-4000-8000-000000000031",
        to: "20000000-0000-4000-8000-000000000032",
      },
    ],
  };
  return AcceptanceEvaluationInputSchema.parse({
    brief,
    briefVersion: 4,
    plan,
    document: input?.document ?? defaultDocument,
    documentRevision: 7,
    additionalCriteria: [
      {
        id: "plan:minimum-cited-source",
        label: "At least one source",
        severity: "required",
        provenance: {
          kind: "plan_criterion",
          criterionId: PLAN_CRITERION_ID,
        },
        kind: "source_count",
        minimum: 1,
      },
    ],
  });
}

function reviewResult(input: {
  plan?: ReviewPlanProjection;
  nodeId?: string;
} = {}): IndependentReviewResult {
  const plan = input.plan ?? reviewPlan();
  return IndependentReviewResultSchema.parse({
    schemaVersion: 1,
    id: REVIEW_ID,
    target: {
      documentId: SAMPLE_DOCUMENT.id,
      documentRevision: 7,
      documentDigest: createReviewDocumentDigest(SAMPLE_DOCUMENT),
      briefVersion: plan.briefVersion,
      briefDigest: plan.briefDigest,
      planId: plan.id,
      planVersion: plan.version,
      planDigest: createReviewPlanDigest(plan),
    },
    reviewer: {
      kind: "model",
      provider: "review-provider",
      model: "independent-review-model",
      authoringRunId: AUTHORING_RUN_ID,
      reviewRunId: REVIEW_RUN_ID,
    },
    dimensions: ReviewDimensionSchema.options.map((dimension) => ({
      dimension,
      status: "reviewed",
      summary: `${dimension}を独立に確認した`,
      findingIds: dimension === "references" ? [FINDING_ID] : [],
    })),
    findings: [
      {
        id: FINDING_ID,
        dimension: "references",
        severity: "minor",
        title: "参照箇所の説明を明確にできる",
        detail: "参照直前の主張と出典の関係をより具体的に示せる。",
        evidence: [
          {
            kind: "node",
            nodeId: input.nodeId ?? SAMPLE_DOCUMENT_IDS.citedParagraph,
            excerpt: "構造化編集は再現性を高めます",
            observation: "引用直前の文が広い主張になっている。",
          },
          {
            kind: "criterion",
            criterionId: PLAN_CRITERION_ID,
            observation: "出典数の完成条件には達している。",
          },
        ],
        autoFix: {
          eligible: true,
          strategy: "replace_text",
          requiresApproval: false,
        },
        followUp: {
          required: true,
          blocking: false,
          target: "document_content",
          prompt: "この主張をどの範囲まで限定しますか？",
        },
      },
    ],
    criterionAssessments: [
      {
        criterionId: PLAN_CRITERION_ID,
        outcome: "satisfied",
        rationale: "本文の引用と参考文献を確認した。",
        evidence: [
          {
            kind: "criterion",
            criterionId: PLAN_CRITERION_ID,
            observation: "1件の出典が本文から参照されている。",
          },
        ],
      },
    ],
    generatedAt: NOW,
  });
}

describe("deterministic acceptance", () => {
  it("uses the same canonical brief digest as DocumentPlan validation", () => {
    const brief = reviewBrief();

    expect(createReviewBriefDigest(brief)).toBe(
      createDocumentBriefDigest(brief),
    );
  });

  it("maps the current fallback plan without adding a permanent external gate", () => {
    const answer = "注意機構について論文を書いて";
    const initial = createDocumentAgentSession({
      sessionId: "20000000-0000-4000-8000-000000000030",
      documentId: "20000000-0000-4000-8000-000000000031",
      rootRunId: AUTHORING_RUN_ID,
      deliverable: "paper",
      now: NOW,
    });
    const withSubject = applyBriefExtraction({
      session: initial,
      extraction: extractBriefRequirementsDeterministically({
        prompt: answer,
      }),
      answerText: answer,
      runId: AUTHORING_RUN_ID,
      now: NOW,
    });
    const delegated = applyExplicitDelegation({
      session: withSubject,
      groups: [
        "purpose_audience",
        "scope_structure",
        "sources_evidence",
        "mathematics",
        "visuals",
        "presentation",
        "acceptance",
      ],
      delegatedByRunId: REVIEW_RUN_ID,
      now: NOW,
    });
    const plan = createDocumentPlanDeterministically({
      brief: delegated.brief,
      briefVersion: delegated.briefVersion,
      now: NOW,
    });
    const projection = createReviewPlanProjection(plan);
    const built = buildDeterministicAcceptanceCriteria({
      brief: delegated.brief,
      plan: projection,
    });

    expect(
      built.issues.filter((issue) =>
        [
          "unmapped_plan_criterion",
          "unmapped_brief_criterion",
          "unsupported_page_length",
          "unsupported_target_length",
        ].includes(issue.code),
      ),
    ).toEqual([]);
    expect(new Set(built.criteria.map((criterion) => criterion.id)).size).toBe(
      built.criteria.length,
    );
    expect(
      built.criteria.some((criterion) =>
        criterion.id.startsWith("plan:criterion:"),
      ),
    ).toBe(false);
    expect(
      projection.completionCriteria.filter(
        (criterion) =>
          criterion.briefCriterionId !== null &&
          criterion.verification === "model_assessed" &&
          criterion.severity === "required",
      ),
    ).toEqual([]);
    expect(
      projection.completionCriteria.filter(
        (criterion) => criterion.verification === "user_review",
      ),
    ).toEqual([]);
    expect(
      projection.completionCriteria.filter(
        (criterion) => criterion.verification === "deterministic",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deterministicEvaluator: {
            kind: "derived",
            rules: ["section_order", "reference_integrity"],
          },
        }),
      ]),
    );
  });

  it("passes only after recomputing all measurable requirements", () => {
    const result = evaluateDeterministicAcceptance(acceptanceInput());

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.summary.required.failed).toBe(0);
    expect(result.summary.required.notEvaluable).toBe(0);
    expect(
      new Set(result.criteria.map((criterion) => criterion.kind)),
    ).toEqual(
      new Set([
        "required_section",
        "section_order",
        "text_length",
        "figure_count",
        "table_count",
        "visual_count",
        "equation_count",
        "source_count",
        "document_type",
        "reference_integrity",
      ]),
    );
  });

  it("requires each planned derivation and visual to have one compatible document realization", () => {
    const mathPlanItemId = "29000000-0000-4000-8000-000000000001";
    const visualPlanItemId = "29000000-0000-4000-8000-000000000002";
    const plan = structuredClone(reviewPlan());
    plan.sections[0]!.mathItems = [
      {
        id: mathPlanItemId,
        minimumExpressionSteps: 1,
        numbered: true,
      },
    ];
    plan.sections[0]!.visuals = [
      { id: visualPlanItemId, kind: "diagram" },
    ];
    const input = acceptanceInput({
      plan: ReviewPlanProjectionSchema.parse(plan),
    });

    const missingLinks = evaluateDeterministicAcceptance(input);
    expect(
      missingLinks.criteria.filter(
        (criterion) =>
          (criterion.kind === "planned_math" ||
            criterion.kind === "planned_visual") &&
          criterion.status === "failed",
      ),
    ).toHaveLength(2);

    const equation = input.document.nodes.find(
      (node) => node.type === "equation",
    );
    const figure = input.document.nodes.find((node) => node.type === "figure");
    if (equation?.type !== "equation" || figure?.type !== "figure") {
      throw new Error("Expected math and figure fixtures");
    }
    equation.planItemId = mathPlanItemId;
    equation.numbered = true;
    figure.planItemId = visualPlanItemId;

    const linked = evaluateDeterministicAcceptance(input);
    expect(
      linked.criteria.filter(
        (criterion) =>
          criterion.kind === "planned_math" ||
          criterion.kind === "planned_visual",
      ),
    ).toEqual([
      expect.objectContaining({ kind: "planned_math", status: "passed" }),
      expect.objectContaining({ kind: "planned_visual", status: "passed" }),
    ]);
  });

  it("defers confirmed page targets to compiled PDF inspection", () => {
    const brief = reviewBrief();
    brief.scope.targetLength = provided("3〜5ページ");
    const plan = reviewPlan(brief);
    const built = buildDeterministicAcceptanceCriteria({ brief, plan });

    expect(
      built.issues.some((issue) => issue.code === "unsupported_target_length"),
    ).toBe(false);
    expect(
      built.criteria.some(
        (criterion) => criterion.id === "brief:scope.targetLength",
      ),
    ).toBe(false);
  });

  it("turns explicit algorithm, code, proof, and appendix requirements into typed gates", () => {
    const brief = reviewBrief();
    brief.constraints.mustInclude = provided([
      "擬似コードを掲載",
      "source code example",
      "証明を提示",
      "付録",
    ]);
    const result = evaluateDeterministicAcceptance(
      acceptanceInput({ brief, plan: reviewPlan(brief) }),
    );
    const structural = result.criteria.filter(
      (criterion) => criterion.kind === "node_type_count",
    );

    expect(structural).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", observed: { nodeType: "algorithm", count: 0 } }),
        expect.objectContaining({ status: "failed", observed: { nodeType: "codeBlock", count: 0 } }),
        expect.objectContaining({ status: "failed", observed: { nodeType: "proof", count: 0 } }),
        expect.objectContaining({ status: "failed", observed: { nodeType: "appendix", count: 0 } }),
      ]),
    );
  });

  it("fails missing sections and insufficient planned node counts", () => {
    const plan = structuredClone(reviewPlan());
    plan.sections[1] = {
      ...plan.sections[1]!,
      title: "結論",
      figureCount: 2,
      equationCount: 2,
    };

    const result = evaluateDeterministicAcceptance(
      acceptanceInput({ plan: ReviewPlanProjectionSchema.parse(plan) }),
    );

    expect(result.status).toBe("failed");
    expect(result.passed).toBe(false);
    expect(
      result.criteria.some(
        (criterion) =>
          criterion.kind === "required_section" &&
          criterion.status === "failed",
      ),
    ).toBe(true);
    expect(
      result.criteria.some(
        (criterion) =>
          criterion.kind === "text_length" &&
          criterion.status === "not_evaluable",
      ),
    ).toBe(true);
    expect(
      result.criteria.some(
        (criterion) =>
          criterion.kind === "figure_count" &&
          criterion.status === "failed",
      ),
    ).toBe(true);
  });

  it("does not count an alt-text placeholder as a completed figure", () => {
    const document = structuredClone(SAMPLE_DOCUMENT);
    const citation = document.nodes.find((node) => node.type === "citation");
    if (!citation || citation.type !== "citation") {
      throw new Error("Test fixture has no citation node.");
    }
    citation.sourceId = VERIFIED_SOURCE_ID;

    const result = evaluateDeterministicAcceptance(
      acceptanceInput({ document }),
    );

    expect(
      result.criteria.some(
        (criterion) =>
          criterion.kind === "figure_count" &&
          criterion.status === "failed" &&
          criterion.observed === 0,
      ),
    ).toBe(true);
  });

  it("fails closed when semantic document validation fails", () => {
    const document = structuredClone(SAMPLE_DOCUMENT);
    const citedParagraph = document.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.citedParagraph,
    );
    if (!citedParagraph || citedParagraph.type !== "paragraph") {
      throw new Error("Test fixture is missing its cited paragraph.");
    }
    const citation = citedParagraph.content.find(
      (inline) => inline.type === "citationRef",
    );
    if (!citation || citation.type !== "citationRef") {
      throw new Error("Test fixture is missing its citation reference.");
    }
    citation.citationId = UNKNOWN_NODE_ID;

    const result = evaluateDeterministicAcceptance(
      acceptanceInput({ document }),
    );

    expect(result.status).toBe("failed");
    expect(result.preconditions.documentValid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "document_invalid")).toBe(
      true,
    );
    expect(
      result.criteria.every(
        (criterion) => criterion.status === "not_evaluable",
      ),
    ).toBe(true);
  });

  it("detects an uncited source independently of model review", () => {
    const document = structuredClone(SAMPLE_DOCUMENT);
    const citedParagraph = document.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.citedParagraph,
    );
    if (!citedParagraph || citedParagraph.type !== "paragraph") {
      throw new Error("Test fixture is missing its cited paragraph.");
    }
    citedParagraph.content = citedParagraph.content.filter(
      (inline) => inline.type !== "citationRef",
    );

    const result = evaluateDeterministicAcceptance(
      acceptanceInput({ document }),
    );
    const referenceResult = result.criteria.find(
      (criterion) => criterion.kind === "reference_integrity",
    );

    expect(result.preconditions.documentValid).toBe(true);
    expect(referenceResult?.status).toBe("failed");
    expect(referenceResult?.observed).toMatchObject({ uncitedSourceCount: 1 });
    expect(result.status).toBe("failed");
  });

  it("rejects unstructured deterministic completion criteria", () => {
    const input = acceptanceInput();
    input.additionalCriteria = [];

    const result = evaluateDeterministicAcceptance(input);

    expect(result.status).toBe("failed");
    expect(result.preconditions.criteriaConfigured).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.code === "unmapped_plan_criterion",
      ),
    ).toBe(true);
  });

  it("materializes a supported plan evaluator without an external adapter", () => {
    const input = acceptanceInput();
    input.additionalCriteria = [];
    input.plan.completionCriteria[0]!.deterministicEvaluator = {
      kind: "source_count",
      minimum: 1,
    };

    const result = evaluateDeterministicAcceptance(input);

    expect(result.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unmapped_plan_criterion" }),
      ]),
    );
    expect(result.criteria).toContainEqual(
      expect.objectContaining({
        criterionId: `plan:criterion:${PLAN_CRITERION_ID}`,
        kind: "source_count",
        status: "passed",
      }),
    );
  });

  it("counts unique verified source identities instead of citation records", () => {
    const input = acceptanceInput();
    const document = structuredClone(input.document);
    const existingCitation = document.nodes.find(
      (node) => node.type === "citation",
    );
    const citedParagraph = document.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.citedParagraph,
    );
    const bibliography = document.nodes.find(
      (node) => node.type === "bibliography",
    );
    if (
      !existingCitation ||
      existingCitation.type !== "citation" ||
      !citedParagraph ||
      citedParagraph.type !== "paragraph" ||
      !bibliography ||
      bibliography.type !== "bibliography"
    ) {
      throw new Error("Citation fixture is incomplete.");
    }
    const duplicateCitationId = "20000000-0000-4000-8000-000000000097";
    document.nodes.push({
      ...structuredClone(existingCitation),
      id: duplicateCitationId,
      sourceId: VERIFIED_SOURCE_ID,
    });
    citedParagraph.content.push({
      type: "citationRef",
      citationId: duplicateCitationId,
    });
    bibliography.citationIds.push(duplicateCitationId);
    input.document = document;
    input.additionalCriteria = [
      {
        id: "unique-source-minimum",
        label: "Two distinct sources",
        severity: "required",
        provenance: { kind: "system", rule: "unique-source-minimum" },
        kind: "source_count",
        minimum: 2,
      },
    ];

    const result = evaluateDeterministicAcceptance(input);
    expect(result.criteria).toContainEqual(
      expect.objectContaining({
        criterionId: "unique-source-minimum",
        status: "failed",
        observed: expect.objectContaining({
          uniqueSourceCount: 1,
          citationRecordCount: 2,
        }),
      }),
    );
  });

  it("checks the confirmed citation style exactly", () => {
    const brief = reviewBrief();
    brief.sources.citationStyle = provided("IEEE");
    const document = structuredClone(acceptanceInput().document);
    document.schemaVersion = 2;
    document.metadata.citationStyle = { schemaVersion: 1, style: "apa7" };

    const result = evaluateDeterministicAcceptance(
      acceptanceInput({ brief, plan: reviewPlan(brief), document }),
    );
    expect(result.criteria).toContainEqual(
      expect.objectContaining({
        criterionId: "brief:sources.citationStyle",
        kind: "citation_style",
        status: "failed",
        expected: { style: "ieee" },
        observed: { style: "apa7" },
      }),
    );
    expect(result.status).toBe("failed");
  });

  it("blocks rather than self-declaring success while required external review remains", () => {
    const plan = structuredClone(reviewPlan());
    plan.completionCriteria.push({
      id: "20000000-0000-4000-8000-000000000015",
      statement: "論旨が一貫している",
      verification: "model_assessed",
      severity: "required",
      briefCriterionId: null,
      sectionId: null,
    });

    const result = evaluateDeterministicAcceptance(
      acceptanceInput({ plan: ReviewPlanProjectionSchema.parse(plan) }),
    );

    expect(result.summary.required.failed).toBe(0);
    expect(result.status).toBe("blocked");
    expect(result.passed).toBe(false);
    expect(result.pendingExternalCriteria).toHaveLength(1);
    expect(
      DeterministicAcceptanceResultSchema.safeParse({
        ...result,
        status: "passed",
        passed: true,
      }).success,
    ).toBe(false);
  });

  it("defers page-only length plans to render-stage evidence", () => {
    const plan = structuredClone(reviewPlan());
    plan.sections[0]!.expectedAmount = {
      unit: "pages",
      minimum: 1,
      target: 2,
      maximum: 3,
    };

    const result = evaluateDeterministicAcceptance(
      acceptanceInput({ plan: ReviewPlanProjectionSchema.parse(plan) }),
    );

    expect(result.status).toBe("passed");
    expect(
      result.issues.some((issue) => issue.code === "unsupported_page_length"),
    ).toBe(false);
    expect(
      result.criteria.some(
        (criterion) =>
          criterion.criterionId ===
          `plan:section:${PLAN_SECTION_INTRO_ID}:length`,
      ),
    ).toBe(false);
  });
});

describe("independent review contract", () => {
  it("requires all eight dimensions and validates artifact-bound evidence", () => {
    const plan = reviewPlan();
    const review = reviewResult({ plan });
    const validation = validateIndependentReviewResult({
      review,
      context: {
        plan,
        document: SAMPLE_DOCUMENT,
        documentRevision: 7,
      },
    });

    expect(review.dimensions.map((item) => item.dimension)).toEqual(
      ReviewDimensionSchema.options,
    );
    expect(validation).toEqual({ valid: true, issues: [] });
  });

  it("forbids the authoring run from reviewing its own output", () => {
    const review = reviewResult();
    const selfReview = {
      ...review,
      reviewer: {
        ...review.reviewer,
        reviewRunId: review.reviewer.authoringRunId,
      },
    };

    expect(IndependentReviewResultSchema.safeParse(selfReview).success).toBe(
      false,
    );
  });

  it("rejects missing dimensions and an injected overall pass declaration", () => {
    const review = reviewResult();

    expect(
      IndependentReviewResultSchema.safeParse({
        ...review,
        dimensions: review.dimensions.slice(1),
      }).success,
    ).toBe(false);
    expect(
      IndependentReviewResultSchema.safeParse({
        ...review,
        passed: true,
      }).success,
    ).toBe(false);
  });

  it("fails evidence validation for unknown document nodes", () => {
    const plan = reviewPlan();
    const validation = validateIndependentReviewResult({
      review: reviewResult({ plan, nodeId: UNKNOWN_NODE_ID }),
      context: {
        plan,
        document: SAMPLE_DOCUMENT,
        documentRevision: 7,
      },
    });

    expect(validation.valid).toBe(false);
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ code: "unknown_node_evidence" }),
    );
  });
});

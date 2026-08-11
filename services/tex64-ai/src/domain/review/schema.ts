import { z } from "zod";

import {
  DocumentBriefSchema,
  RequirementPathSchema,
} from "../brief/schema";
import { DocumentSchema, StableIdSchema } from "../document/schema";

const TimestampSchema = z.string().datetime({ offset: true });
const ShortTextSchema = z.string().trim().min(1).max(1_000);
const BoundedTextSchema = z.string().trim().min(1).max(12_000);
const IdentifierSchema = z.string().trim().min(1).max(300);

export const ArtifactDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type ArtifactDigest = z.infer<typeof ArtifactDigestSchema>;

export const ReviewDimensionSchema = z.enum([
  "requirement_fulfillment",
  "argumentation",
  "factual_grounding",
  "mathematics",
  "style",
  "structure",
  "references",
  "typesetting",
]);
export type ReviewDimension = z.infer<typeof ReviewDimensionSchema>;

export const ReviewSeveritySchema = z.enum([
  "blocker",
  "major",
  "minor",
  "suggestion",
]);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

export const ReviewEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("node"),
    nodeId: StableIdSchema,
    path: z.string().trim().min(1).max(500).optional(),
    excerpt: z.string().trim().min(1).max(2_000).optional(),
    observation: BoundedTextSchema,
  }),
  z.strictObject({
    kind: z.literal("criterion"),
    criterionId: IdentifierSchema,
    observation: BoundedTextSchema,
  }),
]);
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;

export const ReviewAutoFixSchema = z.discriminatedUnion("eligible", [
  z.strictObject({
    eligible: z.literal(true),
    strategy: z.enum([
      "replace_text",
      "insert_node",
      "update_node",
      "reorder_nodes",
      "reference_repair",
      "formatting",
    ]),
    requiresApproval: z.boolean(),
  }),
  z.strictObject({
    eligible: z.literal(false),
    reason: ShortTextSchema,
  }),
]);

export const ReviewFollowUpSchema = z.discriminatedUnion("required", [
  z.strictObject({
    required: z.literal(true),
    blocking: z.boolean(),
    target: z.union([
      RequirementPathSchema,
      z.literal("document_content"),
    ]),
    prompt: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    required: z.literal(false),
  }),
]);

export const ReviewFindingSchema = z.strictObject({
  id: StableIdSchema,
  dimension: ReviewDimensionSchema,
  severity: ReviewSeveritySchema,
  title: ShortTextSchema,
  detail: BoundedTextSchema,
  evidence: z.array(ReviewEvidenceSchema).min(1).max(50),
  autoFix: ReviewAutoFixSchema,
  followUp: ReviewFollowUpSchema,
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewDimensionAssessmentSchema = z.strictObject({
  dimension: ReviewDimensionSchema,
  status: z.enum(["reviewed", "needs_human_review", "not_applicable"]),
  summary: BoundedTextSchema,
  findingIds: z.array(StableIdSchema).max(500),
});

export const ReviewCriterionAssessmentSchema = z.strictObject({
  criterionId: IdentifierSchema,
  outcome: z.enum([
    "satisfied",
    "not_satisfied",
    "needs_user_input",
    "not_assessed",
  ]),
  rationale: BoundedTextSchema,
  evidence: z.array(ReviewEvidenceSchema).min(1).max(50),
});

export const IndependentReviewerSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("model"),
      provider: ShortTextSchema,
      model: ShortTextSchema,
      authoringRunId: StableIdSchema,
      reviewRunId: StableIdSchema,
    }),
    z.strictObject({
      kind: z.literal("human"),
      reviewerId: IdentifierSchema,
      authoringRunId: StableIdSchema,
      reviewRunId: StableIdSchema,
    }),
  ])
  .superRefine((reviewer, context) => {
    if (reviewer.authoringRunId === reviewer.reviewRunId) {
      context.addIssue({
        code: "custom",
        path: ["reviewRunId"],
        message: "The authoring run cannot review its own output.",
      });
    }
  });

export const IndependentReviewResultSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: StableIdSchema,
    target: z.strictObject({
      documentId: StableIdSchema,
      documentRevision: z.number().int().nonnegative(),
      documentDigest: ArtifactDigestSchema,
      briefVersion: z.number().int().positive(),
      briefDigest: ArtifactDigestSchema,
      planId: StableIdSchema,
      planVersion: z.number().int().positive(),
      planDigest: ArtifactDigestSchema,
    }),
    reviewer: IndependentReviewerSchema,
    dimensions: z
      .array(ReviewDimensionAssessmentSchema)
      .length(ReviewDimensionSchema.options.length),
    findings: z.array(ReviewFindingSchema).max(500),
    criterionAssessments: z
      .array(ReviewCriterionAssessmentSchema)
      .max(500)
      .default([]),
    generatedAt: TimestampSchema,
  })
  .superRefine((review, context) => {
    const dimensions = new Set<ReviewDimension>();
    for (const [index, assessment] of review.dimensions.entries()) {
      if (dimensions.has(assessment.dimension)) {
        context.addIssue({
          code: "custom",
          path: ["dimensions", index, "dimension"],
          message: `Duplicate review dimension: ${assessment.dimension}.`,
        });
      }
      dimensions.add(assessment.dimension);
    }
    for (const dimension of ReviewDimensionSchema.options) {
      if (!dimensions.has(dimension)) {
        context.addIssue({
          code: "custom",
          path: ["dimensions"],
          message: `Missing review dimension: ${dimension}.`,
        });
      }
    }

    const findingById = new Map<string, ReviewFinding>();
    for (const [index, finding] of review.findings.entries()) {
      if (findingById.has(finding.id)) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "id"],
          message: `Duplicate finding ID: ${finding.id}.`,
        });
      }
      findingById.set(finding.id, finding);
    }

    const assignedFindingIds = new Set<string>();
    for (const [dimensionIndex, assessment] of review.dimensions.entries()) {
      for (const [findingIndex, findingId] of assessment.findingIds.entries()) {
        const finding = findingById.get(findingId);
        if (!finding) {
          context.addIssue({
            code: "custom",
            path: ["dimensions", dimensionIndex, "findingIds", findingIndex],
            message: `Dimension references unknown finding ${findingId}.`,
          });
          continue;
        }
        if (finding.dimension !== assessment.dimension) {
          context.addIssue({
            code: "custom",
            path: ["dimensions", dimensionIndex, "findingIds", findingIndex],
            message: `Finding ${findingId} belongs to ${finding.dimension}.`,
          });
        }
        if (assignedFindingIds.has(findingId)) {
          context.addIssue({
            code: "custom",
            path: ["dimensions", dimensionIndex, "findingIds", findingIndex],
            message: `Finding ${findingId} is assigned more than once.`,
          });
        }
        assignedFindingIds.add(findingId);
      }
    }
    for (const finding of review.findings) {
      if (!assignedFindingIds.has(finding.id)) {
        context.addIssue({
          code: "custom",
          path: ["dimensions"],
          message: `Finding ${finding.id} is not assigned to its dimension.`,
        });
      }
    }

    const assessedCriterionIds = new Set<string>();
    for (const [index, assessment] of review.criterionAssessments.entries()) {
      if (assessedCriterionIds.has(assessment.criterionId)) {
        context.addIssue({
          code: "custom",
          path: ["criterionAssessments", index, "criterionId"],
          message: `Criterion ${assessment.criterionId} is assessed more than once.`,
        });
      }
      assessedCriterionIds.add(assessment.criterionId);
    }
  });
export type IndependentReviewResult = z.infer<
  typeof IndependentReviewResultSchema
>;

const ReviewEvaluatorCountRange = {
  minimum: z.number().int().nonnegative(),
  maximum: z.number().int().nonnegative().optional(),
} as const;

export const ReviewPlanDeterministicEvaluatorSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("derived"),
      rules: z
        .array(z.enum(["section_order", "reference_integrity"]))
        .min(1)
        .max(2),
    }),
    z.strictObject({
      kind: z.literal("required_section"),
      title: ShortTextSchema,
      match: z.enum(["exact_normalized", "contains_normalized"]),
    }),
    z.strictObject({
      kind: z.literal("section_order"),
      titles: z.array(ShortTextSchema).min(1).max(200),
    }),
    z.strictObject({
      kind: z.literal("text_length"),
      scope: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("document") }),
        z.strictObject({
          kind: z.literal("section"),
          title: ShortTextSchema,
          match: z.enum(["exact_normalized", "contains_normalized"]),
        }),
      ]),
      unit: z.enum(["characters", "words", "paragraphs"]),
      ...ReviewEvaluatorCountRange,
    }),
    z.strictObject({
      kind: z.literal("visual_count"),
      ...ReviewEvaluatorCountRange,
    }),
    z.strictObject({
      kind: z.literal("figure_count"),
      ...ReviewEvaluatorCountRange,
    }),
    z.strictObject({
      kind: z.literal("table_count"),
      ...ReviewEvaluatorCountRange,
    }),
    z.strictObject({
      kind: z.literal("equation_count"),
      ...ReviewEvaluatorCountRange,
    }),
    z.strictObject({
      kind: z.literal("source_count"),
      ...ReviewEvaluatorCountRange,
    }),
    z.strictObject({
      kind: z.literal("reference_integrity"),
      requireBibliography: z.boolean(),
      requireEverySourceCited: z.boolean(),
    }),
  ])
  .superRefine((evaluator, context) => {
    if (evaluator.kind === "derived") {
      const seen = new Set<string>();
      for (const [index, rule] of evaluator.rules.entries()) {
        if (seen.has(rule)) {
          context.addIssue({
            code: "custom",
            path: ["rules", index],
            message: `Duplicate derived acceptance rule: ${rule}.`,
          });
        }
        seen.add(rule);
      }
      return;
    }
    if (
      "maximum" in evaluator &&
      evaluator.maximum !== undefined &&
      evaluator.minimum > evaluator.maximum
    ) {
      context.addIssue({
        code: "custom",
        path: ["maximum"],
        message: "Evaluator maximum cannot be less than minimum.",
      });
    }
  });
export type ReviewPlanDeterministicEvaluator = z.infer<
  typeof ReviewPlanDeterministicEvaluatorSchema
>;

export const ReviewPlanCompletionCriterionSchema = z.strictObject({
  id: StableIdSchema,
  statement: BoundedTextSchema,
  verification: z.enum(["deterministic", "model_assessed", "user_review"]),
  severity: z.enum(["required", "preferred"]),
  briefCriterionId: StableIdSchema.nullable(),
  sectionId: StableIdSchema.nullable(),
  deterministicEvaluator:
    ReviewPlanDeterministicEvaluatorSchema.nullable().optional(),
});
export type ReviewPlanCompletionCriterion = z.infer<
  typeof ReviewPlanCompletionCriterionSchema
>;

export const ReviewPlanSectionProjectionSchema = z.strictObject({
  id: StableIdSchema,
  title: ShortTextSchema,
  expectedAmount: z
    .strictObject({
      unit: z.enum(["words", "characters", "pages", "paragraphs"]),
      minimum: z.number().int().positive(),
      target: z.number().int().positive(),
      maximum: z.number().int().positive(),
    })
    .superRefine((amount, context) => {
      if (amount.minimum > amount.target || amount.target > amount.maximum) {
        context.addIssue({
          code: "custom",
          path: ["target"],
          message: "Expected amount must satisfy minimum <= target <= maximum.",
        });
      }
    }),
  figureCount: z.number().int().nonnegative(),
  tableCount: z.number().int().nonnegative(),
  equationCount: z.number().int().nonnegative(),
  minimumSourceCount: z.number().int().nonnegative(),
  mathItems: z
    .array(
      z.strictObject({
        id: StableIdSchema,
        minimumExpressionSteps: z.number().int().positive().max(512),
        numbered: z.boolean(),
      }),
    )
    .max(100)
    .default([]),
  visuals: z
    .array(
      z.strictObject({
        id: StableIdSchema,
        kind: z.enum(["figure", "diagram", "chart", "table"]),
      }),
    )
    .max(100)
    .default([]),
});
export type ReviewPlanSectionProjection = z.infer<
  typeof ReviewPlanSectionProjectionSchema
>;

export const ReviewPlanProjectionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: StableIdSchema,
    documentId: StableIdSchema,
    briefVersion: z.number().int().positive(),
    briefDigest: ArtifactDigestSchema,
    status: z.enum(["draft", "ready", "executing", "completed", "superseded"]),
    version: z.number().int().positive(),
    sections: z.array(ReviewPlanSectionProjectionSchema).min(1).max(200),
    completionCriteria: z
      .array(ReviewPlanCompletionCriterionSchema)
      .min(1)
      .max(20_000),
  })
  .superRefine((plan, context) => {
    const ids = new Set<string>();
    for (const [index, criterion] of plan.completionCriteria.entries()) {
      if (ids.has(criterion.id)) {
        context.addIssue({
          code: "custom",
          path: ["completionCriteria", index, "id"],
          message: `Duplicate completion criterion ${criterion.id}.`,
        });
      }
      ids.add(criterion.id);
    }
  });
export type ReviewPlanProjection = z.infer<typeof ReviewPlanProjectionSchema>;

export const AcceptanceCriterionProvenanceSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("brief_requirement"),
      path: RequirementPathSchema,
    }),
    z.strictObject({
      kind: z.literal("brief_criterion"),
      criterionId: StableIdSchema,
    }),
    z.strictObject({
      kind: z.literal("plan_section"),
      sectionId: StableIdSchema,
    }),
    z.strictObject({
      kind: z.literal("plan_criterion"),
      criterionId: StableIdSchema,
    }),
    z.strictObject({
      kind: z.literal("system"),
      rule: IdentifierSchema,
    }),
  ],
);

const AcceptanceCriterionBase = {
  id: IdentifierSchema,
  label: ShortTextSchema,
  severity: z.enum(["required", "preferred"]),
  provenance: AcceptanceCriterionProvenanceSchema,
} as const;

const CountRange = {
  minimum: z.number().int().nonnegative(),
  maximum: z.number().int().nonnegative().optional(),
} as const;

export const AcceptanceCriterionKindSchema = z.enum([
  "required_section",
  "section_order",
  "text_length",
  "visual_count",
  "figure_count",
  "table_count",
  "equation_count",
  "planned_math",
  "planned_visual",
  "source_count",
  "citation_style",
  "document_type",
  "document_language",
  "document_layout",
  "writing_style",
  "node_type_count",
  "reference_integrity",
]);

export const DeterministicAcceptanceCriterionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("required_section"),
      title: ShortTextSchema,
      match: z.enum(["exact_normalized", "contains_normalized"]),
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("section_order"),
      titles: z.array(ShortTextSchema).min(1).max(200),
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("text_length"),
      scope: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("document") }),
        z.strictObject({
          kind: z.literal("section"),
          title: ShortTextSchema,
          match: z.enum(["exact_normalized", "contains_normalized"]),
        }),
      ]),
      unit: z.enum(["characters", "words", "paragraphs"]),
      ...CountRange,
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("visual_count"),
      ...CountRange,
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("figure_count"),
      ...CountRange,
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("table_count"),
      ...CountRange,
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("equation_count"),
      ...CountRange,
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("planned_math"),
      planItemId: StableIdSchema,
      minimumExpressionSteps: z.number().int().positive().max(512),
      numbered: z.boolean(),
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("planned_visual"),
      planItemId: StableIdSchema,
      visualKind: z.enum(["figure", "diagram", "chart", "table"]),
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("source_count"),
      ...CountRange,
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("citation_style"),
      style: z.enum(["author-year", "apa7", "ieee", "numeric"]),
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("document_type"),
      documentType: z.enum([
        "article",
        "proposal",
        "report",
        "paper",
        "letter",
        "notes",
      ]),
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("document_language"),
      language: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("document_layout"),
      layout: z.strictObject({
        preset: z.enum(["standard", "academic", "business", "compact"]),
        pageSize: z.enum(["A3", "A4", "A5", "B4", "B5", "letter"]),
        columns: z.union([z.literal(1), z.literal(2)]),
      }),
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("writing_style"),
      style: z.strictObject({
        register: z.enum(["plain", "professional", "academic", "formal"]),
        voice: z.enum(["neutral", "assertive", "analytical", "persuasive"]),
        jargonLevel: z.enum(["low", "moderate", "high"]),
        sentenceStyle: z.enum(["concise", "balanced", "detailed"]),
      }),
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("node_type_count"),
      nodeType: z.enum([
        "theorem",
        "proof",
        "algorithm",
        "codeBlock",
        "appendix",
      ]),
      ...CountRange,
    }),
    z.strictObject({
      ...AcceptanceCriterionBase,
      kind: z.literal("reference_integrity"),
      requireBibliography: z.boolean(),
      requireEverySourceCited: z.boolean(),
    }),
  ])
  .superRefine((criterion, context) => {
    if (
      "maximum" in criterion &&
      criterion.maximum !== undefined &&
      criterion.minimum > criterion.maximum
    ) {
      context.addIssue({
        code: "custom",
        path: ["maximum"],
        message: "Criterion maximum cannot be less than minimum.",
      });
    }
  });
export type DeterministicAcceptanceCriterion = z.infer<
  typeof DeterministicAcceptanceCriterionSchema
>;

export const AcceptanceEvaluationInputSchema = z.strictObject({
  brief: DocumentBriefSchema,
  briefVersion: z.number().int().positive(),
  plan: ReviewPlanProjectionSchema,
  document: DocumentSchema,
  documentRevision: z.number().int().nonnegative(),
  additionalCriteria: z
    .array(DeterministicAcceptanceCriterionSchema)
    .max(1_000)
    .default([]),
});
export type AcceptanceEvaluationInput = z.infer<
  typeof AcceptanceEvaluationInputSchema
>;

export const AcceptanceGateIssueSchema = z.strictObject({
  code: z.enum([
    "context_mismatch",
    "plan_not_reviewable",
    "brief_digest_mismatch",
    "document_invalid",
    "unsupported_target_length",
    "unsupported_page_length",
    "unsupported_citation_style",
    "unsupported_language",
    "unmapped_plan_criterion",
    "unmapped_brief_criterion",
    "duplicate_criterion",
    "no_required_criteria",
  ]),
  path: z.string().max(500),
  message: BoundedTextSchema,
});
export type AcceptanceGateIssue = z.infer<typeof AcceptanceGateIssueSchema>;

export const AcceptanceCriterionResultSchema = z.strictObject({
  criterionId: IdentifierSchema,
  kind: AcceptanceCriterionKindSchema,
  severity: z.enum(["required", "preferred"]),
  status: z.enum(["passed", "failed", "not_evaluable"]),
  expected: z.json(),
  observed: z.json(),
  evidenceNodeIds: z.array(StableIdSchema).max(20_000),
  message: BoundedTextSchema,
});
export type AcceptanceCriterionResult = z.infer<
  typeof AcceptanceCriterionResultSchema
>;

export const PendingExternalCriterionSchema = z.strictObject({
  criterionId: StableIdSchema,
  verification: z.enum(["model_assessed", "user_review"]),
  severity: z.enum(["required", "preferred"]),
  statement: BoundedTextSchema,
});

export const DeterministicAcceptanceResultSchema = z
  .strictObject({
    status: z.enum(["passed", "failed", "blocked"]),
    passed: z.boolean(),
    target: z.strictObject({
      documentId: StableIdSchema,
      documentRevision: z.number().int().nonnegative(),
      documentDigest: ArtifactDigestSchema,
      briefVersion: z.number().int().positive(),
      briefDigest: ArtifactDigestSchema,
      planId: StableIdSchema,
      planVersion: z.number().int().positive(),
      planDigest: ArtifactDigestSchema,
    }),
    preconditions: z.strictObject({
      contextMatches: z.boolean(),
      planReviewable: z.boolean(),
      documentValid: z.boolean(),
      criteriaConfigured: z.boolean(),
    }),
    criteria: z.array(AcceptanceCriterionResultSchema).max(10_000),
    pendingExternalCriteria: z
      .array(PendingExternalCriterionSchema)
      .max(20_000),
    issues: z.array(AcceptanceGateIssueSchema).max(20_000),
    summary: z.strictObject({
      required: z.strictObject({
        total: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        notEvaluable: z.number().int().nonnegative(),
      }),
      preferred: z.strictObject({
        total: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        notEvaluable: z.number().int().nonnegative(),
      }),
    }),
  })
  .superRefine((result, context) => {
    for (const severity of ["required", "preferred"] as const) {
      const selected = result.criteria.filter(
        (criterion) => criterion.severity === severity,
      );
      const expectedSummary = {
        total: selected.length,
        passed: selected.filter((criterion) => criterion.status === "passed")
          .length,
        failed: selected.filter((criterion) => criterion.status === "failed")
          .length,
        notEvaluable: selected.filter(
          (criterion) => criterion.status === "not_evaluable",
        ).length,
      };
      if (
        Object.entries(expectedSummary).some(
          ([key, value]) =>
            result.summary[severity][
              key as keyof typeof expectedSummary
            ] !== value,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["summary", severity],
          message: `${severity} summary must be derived from criterion results.`,
        });
      }
    }

    const preconditionsPass = Object.values(result.preconditions).every(Boolean);
    const deterministicPass =
      preconditionsPass &&
      result.issues.length === 0 &&
      result.summary.required.failed === 0 &&
      result.summary.required.notEvaluable === 0;
    const hasRequiredExternalCriteria = result.pendingExternalCriteria.some(
      (criterion) => criterion.severity === "required",
    );
    const expectedStatus = !deterministicPass
      ? "failed"
      : hasRequiredExternalCriteria
        ? "blocked"
        : "passed";

    if (result.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Acceptance status must be ${expectedStatus}.`,
      });
    }
    if (result.passed !== (result.status === "passed")) {
      context.addIssue({
        code: "custom",
        path: ["passed"],
        message: "passed must be true only for a passed acceptance status.",
      });
    }
  });
export type DeterministicAcceptanceResult = z.infer<
  typeof DeterministicAcceptanceResultSchema
>;

export const IndependentReviewValidationIssueSchema = z.strictObject({
  code: z.enum([
    "target_mismatch",
    "unknown_node_evidence",
    "node_excerpt_mismatch",
    "unknown_criterion_evidence",
  ]),
  path: z.string().max(500),
  message: BoundedTextSchema,
});
export type IndependentReviewValidationIssue = z.infer<
  typeof IndependentReviewValidationIssueSchema
>;

export const IndependentReviewValidationResultSchema = z.strictObject({
  valid: z.boolean(),
  issues: z.array(IndependentReviewValidationIssueSchema).max(20_000),
});
export type IndependentReviewValidationResult = z.infer<
  typeof IndependentReviewValidationResultSchema
>;

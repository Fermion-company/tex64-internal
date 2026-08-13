import { z } from "zod";

import {
  DerivationDetailSchema,
  DocumentBriefSchema,
  EquationPolicySchema,
  ProofRigorSchema,
} from "@/domain/brief/schema";

const TimestampSchema = z.string().datetime({ offset: true });
const ShortTextSchema = z.string().trim().min(1).max(1_000);
const BoundedTextSchema = z.string().trim().min(1).max(12_000);
const StableIdSchema = z.string().uuid();

export const DocumentBriefDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type DocumentBriefDigest = z.infer<typeof DocumentBriefDigestSchema>;

export const DocumentPlanStatusSchema = z.enum([
  "draft",
  "ready",
  "executing",
  "completed",
  "superseded",
]);
export type DocumentPlanStatus = z.infer<typeof DocumentPlanStatusSchema>;

export const PlannedAmountSchema = z
  .strictObject({
    unit: z.enum(["words", "characters", "pages", "paragraphs"]),
    minimum: z.number().int().positive().max(1_000_000),
    target: z.number().int().positive().max(1_000_000),
    maximum: z.number().int().positive().max(1_000_000),
  })
  .superRefine((amount, context) => {
    if (amount.minimum > amount.target || amount.target > amount.maximum) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "Planned amount must satisfy minimum <= target <= maximum.",
      });
    }
  });
export type PlannedAmount = z.infer<typeof PlannedAmountSchema>;

export const SourceKindRequirementSchema = z.enum([
  "primary_research",
  "peer_reviewed",
  "official",
  "standard",
  "dataset",
  "authoritative_secondary",
  "user_provided",
]);

export const PlanSourceRequirementSchema = z.strictObject({
  id: StableIdSchema,
  purpose: BoundedTextSchema,
  minimumCount: z.number().int().positive().max(100),
  sourceKinds: z
    .array(SourceKindRequirementSchema)
    .min(1)
    .max(SourceKindRequirementSchema.options.length)
    .superRefine((kinds, context) => {
      const seen = new Set<string>();
      for (const [index, kind] of kinds.entries()) {
        if (seen.has(kind)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: `Duplicate source kind: ${kind}.`,
          });
        }
        seen.add(kind);
      }
    }),
  dateRange: ShortTextSchema.nullable(),
  requiredLocators: z.array(z.string().trim().min(1).max(4_096)).max(100),
});
export type PlanSourceRequirement = z.infer<
  typeof PlanSourceRequirementSchema
>;

export const PlanResearchClaimSchema = z.strictObject({
  id: StableIdSchema,
  statement: BoundedTextSchema,
  researchPurpose: BoundedTextSchema,
  priority: z.enum(["required", "recommended"]),
  sourceRequirementIds: z.array(StableIdSchema).max(30),
});
export type PlanResearchClaim = z.infer<typeof PlanResearchClaimSchema>;

export const PlanMathItemSchema = z
  .strictObject({
    id: StableIdSchema,
    /** Exact mathematical objective from the confirmed brief; null only for an agent-added item. */
    briefItem: ShortTextSchema.nullable(),
    purpose: BoundedTextSchema,
    resultToEstablish: BoundedTextSchema,
    derivationDetail: DerivationDetailSchema,
    proofRigor: ProofRigorSchema.nullable(),
    notationRequirements: z.array(ShortTextSchema).max(100),
    intermediateSteps: z.array(BoundedTextSchema).max(100),
    dependsOnClaimIds: z.array(StableIdSchema).max(30),
    numbered: z.boolean(),
    completionCriterion: BoundedTextSchema,
  })
  .superRefine((item, context) => {
    const requiredSteps =
      item.derivationDetail === "result_only"
        ? 0
        : item.derivationDetail === "key_steps"
          ? 1
          : 2;
    if (item.intermediateSteps.length < requiredSteps) {
      context.addIssue({
        code: "custom",
        path: ["intermediateSteps"],
        message: `${item.derivationDetail} requires at least ${requiredSteps} planned intermediate steps.`,
      });
    }
  });
export type PlanMathItem = z.infer<typeof PlanMathItemSchema>;

export const SectionMathematicsPlanSchema = z
  .strictObject({
    policy: EquationPolicySchema,
    items: z.array(PlanMathItemSchema).max(100),
  })
  .superRefine((mathematics, context) => {
    if (mathematics.policy === "none" && mathematics.items.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "A section with no mathematics cannot contain math items.",
      });
    }
    if (mathematics.policy === "required" && mathematics.items.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Required section mathematics needs at least one math item.",
      });
    }
  });
export type SectionMathematicsPlan = z.infer<
  typeof SectionMathematicsPlanSchema
>;

export const PlanVisualSchema = z
  .strictObject({
    id: StableIdSchema,
    kind: z.enum(["figure", "diagram", "chart", "table"]),
    briefItem: ShortTextSchema.nullable(),
    purpose: BoundedTextSchema,
    intendedMessage: BoundedTextSchema,
    source: z.enum(["provided_asset", "agent_generated", "derived_from_data"]),
    dataRequirements: z.array(ShortTextSchema).max(100),
    accessibilityDescription: BoundedTextSchema,
    completionCriterion: BoundedTextSchema,
  })
  .superRefine((visual, context) => {
    if (
      visual.source === "derived_from_data" &&
      visual.dataRequirements.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["dataRequirements"],
        message: "A data-derived visual must identify its required data.",
      });
    }
  });
export type PlanVisual = z.infer<typeof PlanVisualSchema>;

const PlanCountRange = {
  minimum: z.number().int().nonnegative(),
  maximum: z.number().int().nonnegative().optional(),
} as const;

export const PlanDerivedAcceptanceRuleSchema = z.enum([
  "section_order",
  "reference_integrity",
]);

/**
 * A machine-readable evaluator supported by deterministic acceptance. The
 * `derived` variant binds a completion promise to checks already generated
 * from the plan, avoiding duplicate criteria for the same invariant.
 */
export const PlanDeterministicEvaluatorSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("derived"),
      rules: z
        .array(PlanDerivedAcceptanceRuleSchema)
        .min(1)
        .max(PlanDerivedAcceptanceRuleSchema.options.length),
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
      ...PlanCountRange,
    }),
    z.strictObject({ kind: z.literal("visual_count"), ...PlanCountRange }),
    z.strictObject({ kind: z.literal("figure_count"), ...PlanCountRange }),
    z.strictObject({ kind: z.literal("table_count"), ...PlanCountRange }),
    z.strictObject({ kind: z.literal("equation_count"), ...PlanCountRange }),
    z.strictObject({ kind: z.literal("source_count"), ...PlanCountRange }),
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
export type PlanDeterministicEvaluator = z.infer<
  typeof PlanDeterministicEvaluatorSchema
>;

export const PlanCompletionCriterionSchema = z
  .strictObject({
    id: StableIdSchema,
    statement: BoundedTextSchema,
    verification: z.enum(["deterministic", "model_assessed", "user_review"]),
    severity: z.enum(["required", "preferred"]),
    briefCriterionId: StableIdSchema.nullable(),
    deterministicEvaluator: PlanDeterministicEvaluatorSchema.nullable().optional(),
  })
  .superRefine((criterion, context) => {
    if (
      criterion.verification !== "deterministic" &&
      criterion.deterministicEvaluator != null
    ) {
      context.addIssue({
        code: "custom",
        path: ["deterministicEvaluator"],
        message: "Only deterministic completion criteria can define an evaluator.",
      });
    }
  });
export type PlanCompletionCriterion = z.infer<
  typeof PlanCompletionCriterionSchema
>;

export const DocumentPlanSectionSchema = z.strictObject({
  id: StableIdSchema,
  title: ShortTextSchema,
  objective: BoundedTextSchema,
  expectedAmount: PlannedAmountSchema,
  researchClaims: z.array(PlanResearchClaimSchema).max(100),
  sourceRequirements: z.array(PlanSourceRequirementSchema).max(100),
  mathematics: SectionMathematicsPlanSchema,
  visuals: z.array(PlanVisualSchema).max(100),
  completionCriteria: z.array(PlanCompletionCriterionSchema).min(1).max(100),
});
export type DocumentPlanSection = z.infer<typeof DocumentPlanSectionSchema>;

export const DocumentPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: StableIdSchema,
    documentId: StableIdSchema,
    briefVersion: z.number().int().positive(),
    briefDigest: DocumentBriefDigestSchema,
    status: DocumentPlanStatusSchema,
    version: z.number().int().positive(),
    objective: BoundedTextSchema,
    sections: z.array(DocumentPlanSectionSchema).min(1).max(200),
    completionCriteria: z
      .array(PlanCompletionCriterionSchema)
      .min(1)
      .max(200),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .superRefine((plan, context) => {
    if (Date.parse(plan.updatedAt) < Date.parse(plan.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Plan updatedAt cannot precede createdAt.",
      });
    }

    const idOwners = new Map<string, string>();
    const registerId = (id: string, path: (string | number)[]) => {
      const renderedPath = path.join(".");
      const previous = idOwners.get(id);
      if (previous) {
        context.addIssue({
          code: "custom",
          path,
          message: `Plan ID ${id} is already used at ${previous}.`,
        });
        return;
      }
      idOwners.set(id, renderedPath);
    };
    registerId(plan.id, ["id"]);

    for (const [sectionIndex, section] of plan.sections.entries()) {
      const sectionPath = ["sections", sectionIndex] as const;
      registerId(section.id, [...sectionPath, "id"]);
      const sourceRequirementIds = new Set(
        section.sourceRequirements.map((requirement) => requirement.id),
      );
      const claimIds = new Set(section.researchClaims.map((claim) => claim.id));

      for (const [claimIndex, claim] of section.researchClaims.entries()) {
        registerId(claim.id, [...sectionPath, "researchClaims", claimIndex, "id"]);
        const linked = new Set<string>();
        for (const [referenceIndex, requirementId] of
          claim.sourceRequirementIds.entries()) {
          const referencePath = [
            ...sectionPath,
            "researchClaims",
            claimIndex,
            "sourceRequirementIds",
            referenceIndex,
          ];
          if (linked.has(requirementId)) {
            context.addIssue({
              code: "custom",
              path: referencePath,
              message: "A claim cannot repeat a source requirement.",
            });
          }
          if (!sourceRequirementIds.has(requirementId)) {
            context.addIssue({
              code: "custom",
              path: referencePath,
              message: "Claim references a missing section source requirement.",
            });
          }
          linked.add(requirementId);
        }
        if (claim.priority === "required" && linked.size === 0) {
          context.addIssue({
            code: "custom",
            path: [
              ...sectionPath,
              "researchClaims",
              claimIndex,
              "sourceRequirementIds",
            ],
            message: "A required research claim needs a source requirement.",
          });
        }
      }

      for (const [sourceIndex, source] of section.sourceRequirements.entries()) {
        registerId(source.id, [
          ...sectionPath,
          "sourceRequirements",
          sourceIndex,
          "id",
        ]);
      }

      for (const [mathIndex, math] of section.mathematics.items.entries()) {
        registerId(math.id, [
          ...sectionPath,
          "mathematics",
          "items",
          mathIndex,
          "id",
        ]);
        const dependencies = new Set<string>();
        for (const [claimIndex, claimId] of math.dependsOnClaimIds.entries()) {
          const dependencyPath = [
            ...sectionPath,
            "mathematics",
            "items",
            mathIndex,
            "dependsOnClaimIds",
            claimIndex,
          ];
          if (dependencies.has(claimId)) {
            context.addIssue({
              code: "custom",
              path: dependencyPath,
              message: "A math item cannot repeat a claim dependency.",
            });
          }
          if (!claimIds.has(claimId)) {
            context.addIssue({
              code: "custom",
              path: dependencyPath,
              message: "Math item depends on a missing section research claim.",
            });
          }
          dependencies.add(claimId);
        }
      }

      section.visuals.forEach((visual, visualIndex) =>
        registerId(visual.id, [...sectionPath, "visuals", visualIndex, "id"]),
      );
      section.completionCriteria.forEach((criterion, criterionIndex) =>
        registerId(criterion.id, [
          ...sectionPath,
          "completionCriteria",
          criterionIndex,
          "id",
        ]),
      );
    }

    plan.completionCriteria.forEach((criterion, criterionIndex) =>
      registerId(criterion.id, [
        "completionCriteria",
        criterionIndex,
        "id",
      ]),
    );
  });
export type DocumentPlan = z.infer<typeof DocumentPlanSchema>;

export const ConfirmedDocumentBriefContextSchema = z
  .strictObject({
    brief: DocumentBriefSchema,
    briefVersion: z.number().int().positive(),
    confirmedBriefVersion: z.number().int().positive().nullable(),
  })
  .superRefine((contextValue, context) => {
    if (contextValue.confirmedBriefVersion !== contextValue.briefVersion) {
      context.addIssue({
        code: "custom",
        path: ["confirmedBriefVersion"],
        message: "The current brief version must be confirmed before planning.",
      });
    }
  });
export type ConfirmedDocumentBriefContext = z.infer<
  typeof ConfirmedDocumentBriefContextSchema
>;

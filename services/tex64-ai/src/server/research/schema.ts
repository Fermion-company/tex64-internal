import { z } from "zod";

import { SourceKindRequirementSchema } from "@/domain/plan";

const StableIdSchema = z.string().uuid();
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const BoundedTextSchema = z.string().trim().min(1).max(12_000);

export const ResearchEntailmentOutcomeSchema = z.enum([
  "supports",
  "contradicts",
  "insufficient",
]);
export type ResearchEntailmentOutcome = z.infer<
  typeof ResearchEntailmentOutcomeSchema
>;

export const ResearchEvidenceLocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text_offset"),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("page"),
    page: z.number().int().positive(),
    start: z.number().int().nonnegative().nullable(),
    end: z.number().int().positive().nullable(),
  }),
]);

export const ResearchEvidenceBindingSchema = z
  .strictObject({
    id: StableIdSchema,
    claimId: StableIdSchema,
    sourceId: StableIdSchema,
    canonicalLocator: z.string().url().max(2_048),
    contentSha256: DigestSchema,
    excerpt: z.string().trim().min(1).max(4_000),
    excerptSha256: DigestSchema,
    location: ResearchEvidenceLocationSchema,
    sourceKinds: z
      .array(SourceKindRequirementSchema)
      .max(SourceKindRequirementSchema.options.length),
    kindAssessmentBasis: z.enum([
      "provider_metadata",
      "required_locator",
      "independent_review",
    ]),
    entailment: z.strictObject({
      outcome: ResearchEntailmentOutcomeSchema,
      rationale: BoundedTextSchema,
    }),
  })
  .superRefine((binding, context) => {
    if (
      binding.location.kind === "text_offset" &&
      binding.location.end <= binding.location.start
    ) {
      context.addIssue({
        code: "custom",
        path: ["location", "end"],
        message: "Evidence text offsets must define a non-empty range.",
      });
    }
    if (
      binding.location.kind === "page" &&
      ((binding.location.start === null) !== (binding.location.end === null) ||
        (binding.location.start !== null &&
          binding.location.end !== null &&
          binding.location.end <= binding.location.start))
    ) {
      context.addIssue({
        code: "custom",
        path: ["location"],
        message: "Page evidence offsets must be absent together or form a non-empty range.",
      });
    }
    const kinds = new Set(binding.sourceKinds);
    if (kinds.size !== binding.sourceKinds.length) {
      context.addIssue({
        code: "custom",
        path: ["sourceKinds"],
        message: "Evidence source kinds must be unique.",
      });
    }
  });
export type ResearchEvidenceBinding = z.infer<
  typeof ResearchEvidenceBindingSchema
>;

export const ResearchClaimRealizationSchema = z
  .strictObject({
    nodeId: StableIdSchema,
    nodeType: z.string().trim().min(1).max(100),
    excerpt: z.string().trim().min(1).max(4_000),
    excerptSha256: DigestSchema,
    location: z.strictObject({
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
    }),
    citedSourceIds: z.array(StableIdSchema).max(1_000),
    alignment: z.strictObject({
      outcome: z.enum(["matches", "does_not_match", "uncertain"]),
      rationale: BoundedTextSchema,
    }),
  })
  .superRefine((realization, context) => {
    if (realization.location.end <= realization.location.start) {
      context.addIssue({
        code: "custom",
        path: ["location", "end"],
        message: "Claim text offsets must define a non-empty range.",
      });
    }
    if (
      new Set(realization.citedSourceIds).size !==
      realization.citedSourceIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["citedSourceIds"],
        message: "Claim citation source identifiers must be unique.",
      });
    }
  });
export type ResearchClaimRealization = z.infer<
  typeof ResearchClaimRealizationSchema
>;

const RequirementCheckStatusSchema = z.enum([
  "passed",
  "failed",
  "not_evaluable",
  "not_applicable",
]);

export const ResearchSourceRequirementAssessmentSchema = z.strictObject({
  requirementId: StableIdSchema,
  minimumCount: z.number().int().positive().max(100),
  uniqueSupportingSourceIds: z.array(StableIdSchema).max(100),
  countStatus: z.enum(["passed", "failed"]),
  kindStatus: RequirementCheckStatusSchema,
  dateStatus: RequirementCheckStatusSchema,
  locatorStatus: RequirementCheckStatusSchema,
  requiredLocators: z.array(z.string().trim().min(1).max(4_096)).max(100),
  matchedLocators: z.array(z.string().url().max(2_048)).max(100),
  status: z.enum(["passed", "failed", "not_evaluable"]),
  detail: BoundedTextSchema,
});
export type ResearchSourceRequirementAssessment = z.infer<
  typeof ResearchSourceRequirementAssessmentSchema
>;

export const ResearchClaimAssessmentSchema = z
  .strictObject({
    claimId: StableIdSchema,
    priority: z.enum(["required", "recommended"]),
    sourceRequirementIds: z.array(StableIdSchema).max(30),
    realization: ResearchClaimRealizationSchema.nullable(),
    bindings: z.array(ResearchEvidenceBindingSchema).max(100),
    outcome: z.enum(["supported", "not_supported", "uncertain", "not_evaluable"]),
    rationale: BoundedTextSchema,
  })
  .superRefine((claim, context) => {
    const supported = claim.bindings.some(
      (binding) => binding.entailment.outcome === "supports",
    );
    if (
      claim.outcome === "supported" &&
      (!claim.realization ||
        claim.realization.alignment.outcome !== "matches" ||
        !supported)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "A supported claim requires matched manuscript text and supporting evidence.",
      });
    }
    if (
      claim.realization &&
      claim.bindings.some(
        (binding) => !claim.realization!.citedSourceIds.includes(binding.sourceId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["bindings"],
        message: "Evidence must be cited by the manuscript text that realizes the claim.",
      });
    }
  });
export type ResearchClaimAssessment = z.infer<
  typeof ResearchClaimAssessmentSchema
>;

export const ResearchLedgerSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: StableIdSchema,
    userId: StableIdSchema,
    documentId: StableIdSchema,
    authoringRunId: StableIdSchema,
    target: z.strictObject({
      documentRevision: z.number().int().positive(),
      documentDigest: DigestSchema,
      briefVersion: z.number().int().positive(),
      briefDigest: DigestSchema,
      planId: StableIdSchema,
      planVersion: z.number().int().positive(),
      planDigest: DigestSchema,
      sourceSnapshotDigest: DigestSchema,
    }),
    reviewer: z.strictObject({
      provider: z.string().trim().min(1).max(1_000),
      model: z.string().trim().min(1).max(1_000),
      reviewRunId: StableIdSchema,
    }),
    sourceSnapshot: z.strictObject({
      status: z.enum(["complete", "blocked"]),
      citedSourceIds: z.array(StableIdSchema).max(10_000),
      unavailableSourceIds: z.array(StableIdSchema).max(10_000),
      nonEvidenceSourceIds: z.array(StableIdSchema).max(10_000),
    }),
    claims: z.array(ResearchClaimAssessmentSchema).max(20_000),
    requirements: z
      .array(ResearchSourceRequirementAssessmentSchema)
      .max(20_000),
    status: z.enum(["passed", "blocked"]),
    ledgerDigest: DigestSchema,
    createdAt: TimestampSchema,
  })
  .superRefine((ledger, context) => {
    if (ledger.reviewer.reviewRunId === ledger.authoringRunId) {
      context.addIssue({
        code: "custom",
        path: ["reviewer", "reviewRunId"],
        message: "The authoring run cannot assess its own research evidence.",
      });
    }

    const citedSourceIds = new Set(ledger.sourceSnapshot.citedSourceIds);
    for (const field of ["unavailableSourceIds", "nonEvidenceSourceIds"] as const) {
      const values = ledger.sourceSnapshot[field];
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: ["sourceSnapshot", field],
          message: "Source snapshot identifiers must be unique.",
        });
      }
      for (const [index, sourceId] of values.entries()) {
        if (!citedSourceIds.has(sourceId)) {
          context.addIssue({
            code: "custom",
            path: ["sourceSnapshot", field, index],
            message: "Unavailable sources must belong to the reviewed document.",
          });
        }
      }
    }
    const sourceSnapshotBlocked =
      ledger.sourceSnapshot.unavailableSourceIds.length > 0 ||
      ledger.sourceSnapshot.nonEvidenceSourceIds.length > 0;
    if (
      (ledger.sourceSnapshot.status === "blocked") !== sourceSnapshotBlocked
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceSnapshot", "status"],
        message: "Source snapshot status must reflect unavailable evidence.",
      });
    }
    const expectedBlocked =
      sourceSnapshotBlocked ||
      ledger.claims.some(
        (claim) =>
          claim.priority === "required" && claim.outcome !== "supported",
      ) ||
      ledger.requirements.some((requirement) => requirement.status !== "passed");
    if ((ledger.status === "blocked") !== expectedBlocked) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Research review status must be derived from its required evidence.",
      });
    }

    const claimIds = new Set<string>();
    const bindingIds = new Set<string>();
    for (const [claimIndex, claim] of ledger.claims.entries()) {
      if (claimIds.has(claim.claimId)) {
        context.addIssue({
          code: "custom",
          path: ["claims", claimIndex, "claimId"],
          message: "A research claim can be assessed only once.",
        });
      }
      claimIds.add(claim.claimId);
      const sourceIds = new Set<string>();
      for (const [bindingIndex, binding] of claim.bindings.entries()) {
        if (binding.claimId !== claim.claimId) {
          context.addIssue({
            code: "custom",
            path: ["claims", claimIndex, "bindings", bindingIndex, "claimId"],
            message: "Evidence must belong to its containing research claim.",
          });
        }
        if (bindingIds.has(binding.id)) {
          context.addIssue({
            code: "custom",
            path: ["claims", claimIndex, "bindings", bindingIndex, "id"],
            message: "Research evidence identifiers must be unique.",
          });
        }
        bindingIds.add(binding.id);
        if (sourceIds.has(binding.sourceId)) {
          context.addIssue({
            code: "custom",
            path: ["claims", claimIndex, "bindings", bindingIndex, "sourceId"],
            message: "One source can count only once for a research claim.",
          });
        }
        sourceIds.add(binding.sourceId);
      }
    }

    const requirementIds = new Set<string>();
    for (const [index, requirement] of ledger.requirements.entries()) {
      if (requirementIds.has(requirement.requirementId)) {
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "requirementId"],
          message: "A source requirement can be assessed only once.",
        });
      }
      requirementIds.add(requirement.requirementId);
      if (
        new Set(requirement.uniqueSupportingSourceIds).size !==
        requirement.uniqueSupportingSourceIds.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "uniqueSupportingSourceIds"],
          message: "Supporting source counts must use unique source identifiers.",
        });
      }
    }
  });
export type ResearchLedger = z.infer<typeof ResearchLedgerSchema>;

export const FrozenResearchSourceSchema = z.strictObject({
  sourceId: StableIdSchema,
  canonicalLocator: z.string().url().max(2_048),
  contentSha256: DigestSchema,
  evidenceScope: z.enum(["full_text", "abstract"]),
  excerpt: z.string().min(1).max(12_000),
  excerptStart: z.number().int().nonnegative(),
  metadata: z.strictObject({
    provider: z.enum(["origin", "crossref"]),
    title: z.string().min(1).max(10_000).nullable(),
    publication: z.string().min(1).max(2_000).nullable(),
    publisher: z.string().min(1).max(2_000).nullable(),
    volume: z.string().min(1).max(1_000).nullable(),
    issue: z.string().min(1).max(1_000).nullable(),
    pages: z.string().min(1).max(1_000).nullable(),
    publishedAt: z.string().max(64).nullable(),
    workType: z.string().min(1).max(200).nullable(),
  }),
});
export type FrozenResearchSource = z.infer<
  typeof FrozenResearchSourceSchema
>;

export const FrozenResearchDocumentNodeSchema = z.strictObject({
  nodeId: StableIdSchema,
  nodeType: z.string().trim().min(1).max(100),
  text: z.string().trim().min(1).max(12_000),
  textSha256: DigestSchema,
  citedSourceIds: z.array(StableIdSchema).max(1_000),
});
export type FrozenResearchDocumentNode = z.infer<
  typeof FrozenResearchDocumentNodeSchema
>;

export const ResearchEvidenceDraftSchema = z.strictObject({
  claims: z.array(
    z.strictObject({
      claimId: StableIdSchema,
      rationale: BoundedTextSchema,
      realization: z
        .strictObject({
          nodeId: StableIdSchema,
          excerpt: z.string().trim().min(1).max(4_000),
          alignment: z.enum(["matches", "does_not_match", "uncertain"]),
          rationale: BoundedTextSchema,
        })
        .nullable(),
      evidence: z.array(
        z.strictObject({
          sourceId: StableIdSchema,
          excerpt: z.string().trim().min(1).max(4_000),
          outcome: ResearchEntailmentOutcomeSchema,
          rationale: BoundedTextSchema,
          sourceKinds: z
            .array(SourceKindRequirementSchema)
            .max(SourceKindRequirementSchema.options.length),
        }),
      ).max(100),
    }),
  ).max(20_000),
});
export type ResearchEvidenceDraft = z.infer<
  typeof ResearchEvidenceDraftSchema
>;

import { resolvePlanDeterministicEvaluator } from "../plan/deterministic-evaluator";
import type {
  DocumentPlan,
  PlanCompletionCriterion,
} from "../plan/schema";
import {
  ReviewPlanProjectionSchema,
  type ReviewPlanProjection,
} from "./schema";

/**
 * Keeps the acceptance evaluator independent from the executable plan model.
 * The adapter intentionally projects only immutable review inputs.
 */
export function createReviewPlanProjection(
  plan: DocumentPlan,
): ReviewPlanProjection {
  return ReviewPlanProjectionSchema.parse({
    schemaVersion: 1,
    id: plan.id,
    documentId: plan.documentId,
    briefVersion: plan.briefVersion,
    briefDigest: plan.briefDigest,
    status: plan.status,
    version: plan.version,
    sections: plan.sections.map((section) => ({
      id: section.id,
      title: section.title,
      expectedAmount: section.expectedAmount,
      figureCount: section.visuals.filter(
        (visual) => visual.kind !== "table",
      ).length,
      tableCount: section.visuals.filter(
        (visual) => visual.kind === "table",
      ).length,
      equationCount: section.mathematics.items.length,
      minimumSourceCount: section.sourceRequirements.reduce(
        (total, requirement) => total + requirement.minimumCount,
        0,
      ),
      mathItems: section.mathematics.items.map((item) => ({
        id: item.id,
        minimumExpressionSteps: Math.max(1, item.intermediateSteps.length + 1),
        numbered: item.numbered,
      })),
      visuals: section.visuals.map((visual) => ({
        id: visual.id,
        kind: visual.kind,
      })),
    })),
    completionCriteria: [
      ...plan.completionCriteria.map((criterion) => ({
        ...criterion,
        severity: projectedSeverity(criterion),
        deterministicEvaluator:
          resolvePlanDeterministicEvaluator(criterion),
        sectionId: null,
      })),
      ...plan.sections.flatMap((section) =>
        section.completionCriteria.map((criterion) => ({
          ...criterion,
          severity: projectedSeverity(criterion),
          deterministicEvaluator:
            resolvePlanDeterministicEvaluator(criterion),
          sectionId: section.id,
        })),
      ),
    ],
  });
}

function projectedSeverity(
  criterion: PlanCompletionCriterion,
): PlanCompletionCriterion["severity"] {
  return criterion.verification === "user_review" &&
    criterion.briefCriterionId === null
    ? "preferred"
    : criterion.severity;
}

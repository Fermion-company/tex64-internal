import { DocumentSchema, type DocumentModel } from "../document/schema";
import {
  createReviewDocumentDigest,
  createReviewPlanDigest,
} from "./digest";
import {
  IndependentReviewResultSchema,
  IndependentReviewValidationResultSchema,
  ReviewPlanProjectionSchema,
  type IndependentReviewResult,
  type IndependentReviewValidationIssue,
  type IndependentReviewValidationResult,
  type ReviewEvidence,
  type ReviewPlanProjection,
} from "./schema";
import { nodeContainsExactExcerpt } from "./node-evidence";

export type IndependentReviewEvidenceContext = {
  plan: ReviewPlanProjection;
  document: DocumentModel;
  documentRevision: number;
  criterionIds?: readonly string[];
};

function allEvidence(review: IndependentReviewResult): ReviewEvidence[] {
  return [
    ...review.findings.flatMap((finding) => finding.evidence),
    ...review.criterionAssessments.flatMap(
      (assessment) => assessment.evidence,
    ),
  ];
}

export function validateIndependentReviewResult(input: {
  review: IndependentReviewResult | unknown;
  context: IndependentReviewEvidenceContext;
}): IndependentReviewValidationResult {
  const review = IndependentReviewResultSchema.parse(input.review);
  const plan = ReviewPlanProjectionSchema.parse(input.context.plan);
  const document = DocumentSchema.parse(input.context.document);
  const issues: IndependentReviewValidationIssue[] = [];
  const expectedPlanDigest = createReviewPlanDigest(plan);
  const expectedDocumentDigest = createReviewDocumentDigest(document);

  if (
    review.target.documentId !== document.id ||
    review.target.documentId !== plan.documentId ||
    review.target.documentRevision !== input.context.documentRevision ||
    review.target.documentDigest !== expectedDocumentDigest ||
    review.target.briefVersion !== plan.briefVersion ||
    review.target.briefDigest !== plan.briefDigest ||
    review.target.planId !== plan.id ||
    review.target.planVersion !== plan.version ||
    review.target.planDigest !== expectedPlanDigest
  ) {
    issues.push({
      code: "target_mismatch",
      path: "target",
      message:
        "Review target hashes or versions do not match the supplied artifacts.",
    });
  }

  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  const nodeIds = new Set(nodeById.keys());
  const criterionIds = new Set([
    ...plan.completionCriteria.map((criterion) => criterion.id),
    ...(input.context.criterionIds ?? []),
  ]);

  allEvidence(review).forEach((evidence, index) => {
    if (evidence.kind === "node" && !nodeIds.has(evidence.nodeId)) {
      issues.push({
        code: "unknown_node_evidence",
        path: `evidence.${index}.nodeId`,
        message: `Review evidence references unknown node ${evidence.nodeId}.`,
      });
    }
    if (evidence.kind === "node" && nodeIds.has(evidence.nodeId)) {
      const node = nodeById.get(evidence.nodeId);
      if (
        !evidence.excerpt ||
        !node ||
        !nodeContainsExactExcerpt(node, evidence.excerpt)
      ) {
        issues.push({
          code: "node_excerpt_mismatch",
          path: `evidence.${index}.excerpt`,
          message: `Review evidence does not quote node ${evidence.nodeId} exactly.`,
        });
      }
    }
    if (
      evidence.kind === "criterion" &&
      !criterionIds.has(evidence.criterionId)
    ) {
      issues.push({
        code: "unknown_criterion_evidence",
        path: `evidence.${index}.criterionId`,
        message: `Review evidence references unknown criterion ${evidence.criterionId}.`,
      });
    }
  });

  review.criterionAssessments.forEach((assessment, index) => {
    if (!criterionIds.has(assessment.criterionId)) {
      issues.push({
        code: "unknown_criterion_evidence",
        path: `criterionAssessments.${index}.criterionId`,
        message: `Review assesses unknown criterion ${assessment.criterionId}.`,
      });
    }
  });

  return IndependentReviewValidationResultSchema.parse({
    valid: issues.length === 0,
    issues,
  });
}

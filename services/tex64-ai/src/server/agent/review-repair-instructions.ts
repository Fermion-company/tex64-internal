type RepairableReviewFinding = {
  severity: "blocker" | "major" | "minor" | "suggestion";
  dimension: string;
  title: string;
  detail: string;
  evidence: readonly unknown[];
  autoFix: { eligible: boolean };
};

/**
 * Builds the serializable repair payload used by the durable orchestrator.
 * Keep this module free of server-only imports: review generation and digest
 * verification happen in Node.js step functions, while the workflow bundle
 * only filters already-verified review data for the next durable model turn.
 */
export function buildReviewRepairInstructions(review: {
  findings: readonly RepairableReviewFinding[];
}): string {
  const actionable = review.findings.filter(
    (finding) =>
      (finding.severity === "blocker" || finding.severity === "major") &&
      finding.autoFix.eligible,
  );
  return JSON.stringify(
    actionable.map((finding) => ({
      dimension: finding.dimension,
      title: finding.title,
      detail: finding.detail,
      evidence: finding.evidence,
    })),
  );
}

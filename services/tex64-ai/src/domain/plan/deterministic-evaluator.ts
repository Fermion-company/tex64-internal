import {
  PlanDeterministicEvaluatorSchema,
  type PlanCompletionCriterion,
  type PlanDeterministicEvaluator,
} from "./schema";

const STRUCTURAL_CRITERION_RULES = new Map<
  string,
  PlanDeterministicEvaluator
>([
  [
    normalizeCriterionStatement(
      "最新版の文書構造、相互参照、引用と参考文献の対応に問題がない。",
    ),
    { kind: "derived", rules: ["section_order", "reference_integrity"] },
  ],
  [
    normalizeCriterionStatement("文書の構造と参照関係に問題がない"),
    { kind: "derived", rules: ["section_order", "reference_integrity"] },
  ],
]);

/**
 * Resolves the machine-readable evaluator for a deterministic plan promise.
 * Exact legacy statements are supported so the deterministic fallback remains
 * reviewable while all other free-form promises fail closed.
 */
export function resolvePlanDeterministicEvaluator(
  criterion: PlanCompletionCriterion,
): PlanDeterministicEvaluator | null {
  if (criterion.verification !== "deterministic") return null;
  if (criterion.deterministicEvaluator != null) {
    return PlanDeterministicEvaluatorSchema.parse(
      criterion.deterministicEvaluator,
    );
  }

  const legacyEvaluator = STRUCTURAL_CRITERION_RULES.get(
    normalizeCriterionStatement(criterion.statement),
  );
  return legacyEvaluator
    ? PlanDeterministicEvaluatorSchema.parse(legacyEvaluator)
    : null;
}

function normalizeCriterionStatement(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/[。.!！?？]+$/gu, "");
}

import {
  AutonomyEvaluationResultSchema,
  AutonomyScenarioSchema,
  AutonomySuiteResultSchema,
  type AutonomyEvaluationResult,
  type AutonomyMetric,
  type AutonomyScenario,
  type AutonomySuiteResult,
  type AutonomyViolation,
  type BriefExpectation,
  type BriefFieldValue,
} from "./types";

const IMPORTANCE_WEIGHT = {
  critical: 3,
  important: 2,
  optional: 1,
} as const;

function normalizeString(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function normalizeComparable(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map(normalizeComparable);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeComparable(child)]),
    );
  }

  return value;
}

function comparableJson(value: unknown): string {
  return JSON.stringify(normalizeComparable(value));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return comparableJson(left) === comparableJson(right);
}

function normalizeQuestionKey(value: string): string {
  return normalizeString(value).toLocaleLowerCase("en-US");
}

function expectationMatches(
  expectation: BriefExpectation,
  actual: BriefFieldValue,
): boolean {
  if (actual.state !== expectation.expectedState) {
    return false;
  }

  if (!expectation.match) {
    return true;
  }

  if (!("value" in actual)) {
    return false;
  }

  switch (expectation.match.kind) {
    case "equals":
      return valuesEqual(actual.value, expectation.match.value);
    case "one_of":
      return expectation.match.values.some((candidate) =>
        valuesEqual(actual.value, candidate),
      );
    case "contains_all":
      const actualValue = actual.value;
      if (!Array.isArray(actualValue)) {
        return false;
      }
      return expectation.match.values.every((expectedItem) =>
        actualValue.some((actualItem) =>
          valuesEqual(actualItem, expectedItem),
        ),
      );
  }
}

function violationCount(
  violations: readonly AutonomyViolation[],
  metric: AutonomyMetric,
): number {
  return violations.filter((violation) => violation.metric === metric).length;
}

function pushViolation(
  violations: AutonomyViolation[],
  violation: AutonomyViolation,
): void {
  violations.push(violation);
}

export function evaluateAutonomyScenario(
  input: AutonomyScenario,
): AutonomyEvaluationResult;
export function evaluateAutonomyScenario(input: unknown): AutonomyEvaluationResult;
export function evaluateAutonomyScenario(
  input: unknown,
): AutonomyEvaluationResult {
  const scenario = AutonomyScenarioSchema.parse(input);
  const violations: AutonomyViolation[] = [];
  const allowedDefaults = new Set(scenario.allowedDefaultFields);
  const resolvedFields = new Set<string>();
  const userResolvedFields = new Set<string>();
  const delegatedFields = new Set<string>();
  const askedFields = new Set<string>();
  const questionFieldsByKey = new Map<string, Set<string>>();
  const proposedPlans = new Map<string, string>();
  const confirmedPlans = new Map<string, string>();
  let finalBriefSnapshot:
    | Extract<
        (typeof scenario.trace)[number],
        { type: "brief_snapshot" }
      >
    | undefined;

  scenario.trace.forEach((event, eventIndex) => {
    switch (event.type) {
      case "request": {
        for (const field of Object.keys(event.providedFields)) {
          resolvedFields.add(field);
          userResolvedFields.add(field);
          delegatedFields.delete(field);
        }
        break;
      }

      case "question": {
        const normalizedKey = normalizeQuestionKey(event.questionKey);
        const priorQuestionFields = questionFieldsByKey.get(normalizedKey);
        const repeatedOpenFields = event.fieldKeys.filter((field) =>
          askedFields.has(field),
        );

        if (priorQuestionFields || repeatedOpenFields.length > 0) {
          const repeatedFields = new Set([
            ...(priorQuestionFields ?? []),
            ...repeatedOpenFields,
          ]);
          pushViolation(violations, {
            code: "duplicate_question",
            metric: "duplicate_questions",
            eventIndex,
            message: `Question repeats an unresolved or previously asked topic: ${[
              ...repeatedFields,
            ].join(", ")}.`,
          });
        }

        const alreadyResolved = event.fieldKeys.filter((field) =>
          resolvedFields.has(field),
        );
        if (alreadyResolved.length > 0) {
          pushViolation(violations, {
            code: "question_for_resolved_field",
            metric: "duplicate_questions",
            eventIndex,
            field: alreadyResolved[0],
            message: `Question asks for already resolved fields: ${alreadyResolved.join(", ")}.`,
          });
        }

        if (!priorQuestionFields) {
          questionFieldsByKey.set(normalizedKey, new Set(event.fieldKeys));
        }
        for (const field of event.fieldKeys) {
          askedFields.add(field);
        }
        break;
      }

      case "answer": {
        for (const field of Object.keys(event.resolvedFields)) {
          resolvedFields.add(field);
          userResolvedFields.add(field);
          delegatedFields.delete(field);
        }
        for (const field of event.delegatedFields) {
          resolvedFields.add(field);
          delegatedFields.add(field);
          userResolvedFields.delete(field);
        }
        break;
      }

      case "invalidate": {
        const invalidatedFields = new Set(event.fieldKeys);
        for (const field of invalidatedFields) {
          resolvedFields.delete(field);
          userResolvedFields.delete(field);
          delegatedFields.delete(field);
          askedFields.delete(field);
        }

        for (const [questionKey, fields] of questionFieldsByKey) {
          if ([...fields].some((field) => invalidatedFields.has(field))) {
            questionFieldsByKey.delete(questionKey);
          }
        }

        confirmedPlans.clear();
        break;
      }

      case "assumption": {
        let isAuthorized = false;
        let reason: string;

        switch (event.basis) {
          case "explicit_user_value":
            isAuthorized = userResolvedFields.has(event.field);
            reason = isAuthorized
              ? ""
              : "the trace contains no explicit user value for this field";
            break;
          case "explicit_delegation":
            isAuthorized = delegatedFields.has(event.field);
            reason = isAuthorized
              ? ""
              : "the trace contains no explicit delegation for this field";
            break;
          case "system_default":
            isAuthorized = allowedDefaults.has(event.field);
            reason = isAuthorized
              ? ""
              : "the field is not allowlisted for system defaults";
            break;
          case "inferred":
            reason = "inferred values require user confirmation or delegation";
            break;
        }

        if (!isAuthorized) {
          pushViolation(violations, {
            code: "unauthorized_assumption",
            metric: "unauthorized_assumptions",
            eventIndex,
            field: event.field,
            message: `Unauthorized assumption for ${event.field}: ${reason}.`,
          });
        }
        resolvedFields.add(event.field);
        break;
      }

      case "brief_snapshot":
        finalBriefSnapshot = event;
        break;

      case "plan_proposed":
        proposedPlans.set(event.planId, event.planHash);
        confirmedPlans.delete(event.planId);
        break;

      case "plan_confirmed": {
        if (proposedPlans.get(event.planId) !== event.planHash) {
          pushViolation(violations, {
            code: "invalid_plan_confirmation",
            metric: "pre_confirmation_drafts",
            eventIndex,
            message: `Confirmation does not match the current proposal for plan ${event.planId}.`,
          });
          break;
        }
        confirmedPlans.set(event.planId, event.planHash);
        break;
      }

      case "document_mutation": {
        if (event.intent === "workspace_init") {
          break;
        }

        if (!event.planId || !event.planHash) {
          pushViolation(violations, {
            code: "mutation_without_plan_binding",
            metric: "pre_confirmation_drafts",
            eventIndex,
            message: `Document ${event.intent} at revision ${event.revision} is not bound to a plan.`,
          });
          break;
        }

        const proposalMatches =
          proposedPlans.get(event.planId) === event.planHash;
        const confirmationMatches =
          confirmedPlans.get(event.planId) === event.planHash;
        if (!proposalMatches || !confirmationMatches) {
          pushViolation(violations, {
            code: "mutation_before_plan_confirmation",
            metric: "pre_confirmation_drafts",
            eventIndex,
            message: `Document ${event.intent} at revision ${event.revision} occurred before exact plan confirmation.`,
          });
        }
        break;
      }
    }
  });

  const totalWeight = scenario.briefExpectations.reduce(
    (total, expectation) => total + IMPORTANCE_WEIGHT[expectation.importance],
    0,
  );
  let matchedWeight = 0;

  if (!finalBriefSnapshot) {
    pushViolation(violations, {
      code: "brief_snapshot_missing",
      metric: "brief_fidelity",
      message: "The trace has no brief snapshot to evaluate.",
    });
  } else {
    for (const expectation of scenario.briefExpectations) {
      const actual = finalBriefSnapshot.fields[expectation.field];
      if (!actual) {
        pushViolation(violations, {
          code: "brief_expectation_missing",
          metric: "brief_fidelity",
          field: expectation.field,
          message: `The final brief does not contain ${expectation.field}.`,
        });
        continue;
      }

      if (!expectationMatches(expectation, actual)) {
        pushViolation(violations, {
          code: "brief_expectation_mismatch",
          metric: "brief_fidelity",
          field: expectation.field,
          message: `The final brief does not satisfy the expectation for ${expectation.field}.`,
        });
        continue;
      }

      matchedWeight += IMPORTANCE_WEIGHT[expectation.importance];
    }
  }

  const briefIsMeasurable = finalBriefSnapshot !== undefined;
  const briefScore = briefIsMeasurable ? matchedWeight / totalWeight : null;
  const unauthorizedAssumptionCount = violationCount(
    violations,
    "unauthorized_assumptions",
  );
  const duplicateQuestionCount = violationCount(
    violations,
    "duplicate_questions",
  );
  const preConfirmationDraftCount = violationCount(
    violations,
    "pre_confirmation_drafts",
  );
  const briefFidelityPassed =
    briefScore !== null && briefScore >= scenario.minimumBriefFidelity;

  const result: AutonomyEvaluationResult = {
    scenarioId: scenario.id,
    passed:
      unauthorizedAssumptionCount === 0 &&
      duplicateQuestionCount === 0 &&
      preConfirmationDraftCount === 0 &&
      briefFidelityPassed,
    metrics: {
      unauthorizedAssumptions: {
        passed: unauthorizedAssumptionCount === 0,
        count: unauthorizedAssumptionCount,
      },
      duplicateQuestions: {
        passed: duplicateQuestionCount === 0,
        count: duplicateQuestionCount,
      },
      preConfirmationDrafts: {
        passed: preConfirmationDraftCount === 0,
        count: preConfirmationDraftCount,
      },
      briefFidelity: {
        passed: briefFidelityPassed,
        measurable: briefIsMeasurable,
        score: briefScore,
        matchedWeight,
        totalWeight,
        threshold: scenario.minimumBriefFidelity,
      },
    },
    violations,
  };

  return AutonomyEvaluationResultSchema.parse(result);
}

export function evaluateAutonomySuite(
  inputs: readonly AutonomyScenario[],
): AutonomySuiteResult;
export function evaluateAutonomySuite(
  inputs: readonly unknown[],
): AutonomySuiteResult;
export function evaluateAutonomySuite(
  inputs: readonly unknown[],
): AutonomySuiteResult {
  const results = inputs.map(evaluateAutonomyScenario);
  const measurableBriefScores = results.flatMap((result) =>
    result.metrics.briefFidelity.score === null
      ? []
      : [result.metrics.briefFidelity.score],
  );
  const passed = results.filter((result) => result.passed).length;
  const meanBriefFidelity =
    measurableBriefScores.length === 0
      ? null
      : measurableBriefScores.reduce((total, score) => total + score, 0) /
        measurableBriefScores.length;

  return AutonomySuiteResultSchema.parse({
    passed: results.every((result) => result.passed),
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      violations: results.reduce(
        (total, result) => total + result.violations.length,
        0,
      ),
      meanBriefFidelity,
    },
  });
}

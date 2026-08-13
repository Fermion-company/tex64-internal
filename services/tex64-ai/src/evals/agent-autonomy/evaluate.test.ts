import { describe, expect, it } from "vitest";

import {
  ACADEMIC_PAPER_GUIDED_INTAKE_FIXTURE,
  AGENT_AUTONOMY_FIXTURES,
  DUPLICATE_QUESTION_AFTER_ANSWER_FIXTURE,
  PREMATURE_GENERIC_DRAFT_FIXTURE,
} from "./fixtures";
import { evaluateAutonomyScenario, evaluateAutonomySuite } from "./evaluate";
import { AutonomyScenarioSchema, type AutonomyScenario } from "./types";

function scenarioWithTrace(
  id: string,
  trace: AutonomyScenario["trace"],
): AutonomyScenario {
  return AutonomyScenarioSchema.parse({
    id,
    name: id,
    allowedDefaultFields: [],
    briefExpectations: [
      {
        field: "goal.subject",
        importance: "critical",
        expectedState: "known",
        match: { kind: "equals", value: "確率過程" },
      },
      {
        field: "goal.audience",
        importance: "important",
        expectedState: "known",
        match: { kind: "equals", value: "専門家" },
      },
    ],
    minimumBriefFidelity: 1,
    trace,
  });
}

describe("evaluateAutonomyScenario", () => {
  it("passes a multi-turn intake that preserves provenance and waits for confirmation", () => {
    const result = evaluateAutonomyScenario(
      ACADEMIC_PAPER_GUIDED_INTAKE_FIXTURE,
    );

    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.metrics).toEqual({
      unauthorizedAssumptions: { passed: true, count: 0 },
      duplicateQuestions: { passed: true, count: 0 },
      preConfirmationDrafts: { passed: true, count: 0 },
      briefFidelity: {
        passed: true,
        measurable: true,
        score: 1,
        matchedWeight: 29,
        totalWeight: 29,
        threshold: 1,
      },
    });
  });

  it("detects silent assumptions, premature drafting, and brief drift", () => {
    const result = evaluateAutonomyScenario(PREMATURE_GENERIC_DRAFT_FIXTURE);
    const codes = result.violations.map((violation) => violation.code);

    expect(result.passed).toBe(false);
    expect(result.metrics.unauthorizedAssumptions.count).toBe(5);
    expect(result.metrics.preConfirmationDrafts.count).toBe(1);
    expect(result.metrics.briefFidelity).toMatchObject({
      passed: false,
      measurable: true,
      score: 0.2,
      matchedWeight: 3,
      totalWeight: 15,
    });
    expect(codes).toContain("unauthorized_assumption");
    expect(codes).toContain("mutation_before_plan_confirmation");
    expect(codes).toContain("brief_expectation_mismatch");
  });

  it("detects a repeated question even when its wording changes", () => {
    const result = evaluateAutonomyScenario(
      DUPLICATE_QUESTION_AFTER_ANSWER_FIXTURE,
    );

    expect(result.passed).toBe(false);
    expect(result.metrics.duplicateQuestions).toEqual({
      passed: false,
      count: 2,
    });
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "duplicate_question",
      "question_for_resolved_field",
    ]);
  });

  it("allows a question to be asked again after explicit invalidation", () => {
    const scenario = scenarioWithTrace("valid-requestion-after-invalidation", [
      {
        type: "request",
        text: "確率過程について書きたい",
        providedFields: { "goal.subject": "確率過程" },
      },
      {
        type: "question",
        questionId: "audience-1",
        questionKey: "audience",
        fieldKeys: ["goal.audience"],
        text: "読者は誰ですか？",
      },
      {
        type: "answer",
        questionId: "audience-1",
        resolvedFields: { "goal.audience": "学部生" },
        delegatedFields: [],
      },
      {
        type: "invalidate",
        fieldKeys: ["goal.audience"],
        reason: "文書の用途が研究会発表へ変わった",
      },
      {
        type: "question",
        questionId: "audience-2",
        questionKey: "audience",
        fieldKeys: ["goal.audience"],
        text: "変更後の読者は誰ですか？",
      },
      {
        type: "answer",
        questionId: "audience-2",
        resolvedFields: { "goal.audience": "専門家" },
        delegatedFields: [],
      },
      {
        type: "brief_snapshot",
        version: 2,
        fields: {
          "goal.subject": {
            state: "known",
            value: "確率過程",
            source: "user",
          },
          "goal.audience": {
            state: "known",
            value: "専門家",
            source: "user",
          },
        },
      },
      {
        type: "plan_proposed",
        planId: "plan-2",
        planHash: "plan-2-hash",
        briefVersion: 2,
      },
      {
        type: "plan_confirmed",
        planId: "plan-2",
        planHash: "plan-2-hash",
      },
      {
        type: "document_mutation",
        intent: "draft",
        planId: "plan-2",
        planHash: "plan-2-hash",
        revision: 1,
      },
    ]);

    const result = evaluateAutonomyScenario(scenario);

    expect(result.passed).toBe(true);
    expect(result.metrics.duplicateQuestions.count).toBe(0);
  });

  it("requires confirmation of the exact current plan hash", () => {
    const scenario = scenarioWithTrace("stale-plan-confirmation", [
      {
        type: "request",
        text: "確率過程を専門家向けに書きたい",
        providedFields: {
          "goal.subject": "確率過程",
          "goal.audience": "専門家",
        },
      },
      {
        type: "brief_snapshot",
        version: 1,
        fields: {
          "goal.subject": {
            state: "known",
            value: "確率過程",
            source: "user",
          },
          "goal.audience": {
            state: "known",
            value: "専門家",
            source: "user",
          },
        },
      },
      {
        type: "plan_proposed",
        planId: "plan-1",
        planHash: "current-hash",
        briefVersion: 1,
      },
      {
        type: "plan_confirmed",
        planId: "plan-1",
        planHash: "stale-hash",
      },
      {
        type: "document_mutation",
        intent: "draft",
        planId: "plan-1",
        planHash: "current-hash",
        revision: 1,
      },
    ]);

    const result = evaluateAutonomyScenario(scenario);

    expect(result.metrics.preConfirmationDrafts.count).toBe(2);
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "invalid_plan_confirmation",
      "mutation_before_plan_confirmation",
    ]);
  });

  it("fails closed when no final brief is available", () => {
    const scenario = scenarioWithTrace("missing-final-brief", [
      {
        type: "request",
        text: "確率過程を専門家向けに書きたい",
        providedFields: {
          "goal.subject": "確率過程",
          "goal.audience": "専門家",
        },
      },
    ]);

    const result = evaluateAutonomyScenario(scenario);

    expect(result.passed).toBe(false);
    expect(result.metrics.briefFidelity).toMatchObject({
      passed: false,
      measurable: false,
      score: null,
      matchedWeight: 0,
    });
    expect(result.violations).toEqual([
      {
        code: "brief_snapshot_missing",
        metric: "brief_fidelity",
        message: "The trace has no brief snapshot to evaluate.",
      },
    ]);
  });

  it("is deterministic and does not mutate the supplied trace", () => {
    const before = structuredClone(ACADEMIC_PAPER_GUIDED_INTAKE_FIXTURE);

    const first = evaluateAutonomyScenario(
      ACADEMIC_PAPER_GUIDED_INTAKE_FIXTURE,
    );
    const second = evaluateAutonomyScenario(
      ACADEMIC_PAPER_GUIDED_INTAKE_FIXTURE,
    );

    expect(second).toEqual(first);
    expect(ACADEMIC_PAPER_GUIDED_INTAKE_FIXTURE).toEqual(before);
  });

  it("rejects malformed trace contracts before scoring", () => {
    const malformed = {
      ...ACADEMIC_PAPER_GUIDED_INTAKE_FIXTURE,
      trace: [
        {
          type: "question",
          questionId: "broken",
          questionKey: "broken",
          fieldKeys: [],
          text: "不足した質問",
        },
      ],
    };

    expect(AutonomyScenarioSchema.safeParse(malformed).success).toBe(false);
    expect(() => evaluateAutonomyScenario(malformed)).toThrow();
  });
});

describe("evaluateAutonomySuite", () => {
  it("returns a stable aggregate suitable for a CI quality gate", () => {
    const suite = evaluateAutonomySuite(AGENT_AUTONOMY_FIXTURES);

    expect(suite.passed).toBe(false);
    expect(suite.summary).toMatchObject({
      total: 3,
      passed: 1,
      failed: 2,
    });
    expect(suite.summary.violations).toBeGreaterThan(0);
    expect(suite.summary.meanBriefFidelity).not.toBeNull();
    expect(suite.results.map((result) => result.scenarioId)).toEqual([
      "academic-paper-guided-intake",
      "premature-generic-draft",
      "duplicate-question-after-answer",
    ]);
  });
});

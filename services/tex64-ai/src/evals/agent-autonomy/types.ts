import { z } from "zod";

export const FieldPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/);

const IdentifierSchema = z.string().trim().min(1).max(200);
const NonEmptyFieldPathsSchema = z
  .array(FieldPathSchema)
  .min(1)
  .max(100)
  .refine((paths) => new Set(paths).size === paths.length, {
    message: "Field paths must be unique.",
  });
const FieldValueRecordSchema = z.record(FieldPathSchema, z.json());

export const BriefFieldValueSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("known"),
    value: z.json(),
    source: z.enum(["user", "default", "agent"]),
  }),
  z.strictObject({
    state: z.literal("delegated"),
    value: z.json(),
    source: z.literal("delegation"),
  }),
  z.strictObject({
    state: z.literal("unknown"),
  }),
  z.strictObject({
    state: z.literal("not_applicable"),
  }),
]);
export type BriefFieldValue = z.infer<typeof BriefFieldValueSchema>;

export const BriefExpectationMatchSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("equals"),
    value: z.json(),
  }),
  z.strictObject({
    kind: z.literal("contains_all"),
    values: z.array(z.json()).min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("one_of"),
    values: z.array(z.json()).min(1).max(100),
  }),
]);

export const BriefExpectationSchema = z.strictObject({
  field: FieldPathSchema,
  importance: z.enum(["critical", "important", "optional"]),
  expectedState: z.enum([
    "known",
    "delegated",
    "unknown",
    "not_applicable",
  ]),
  match: BriefExpectationMatchSchema.optional(),
});
export type BriefExpectation = z.infer<typeof BriefExpectationSchema>;

export const AutonomyTraceEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("request"),
    text: z.string().trim().min(1).max(20_000),
    providedFields: FieldValueRecordSchema.default({}),
  }),
  z.strictObject({
    type: z.literal("question"),
    questionId: IdentifierSchema,
    questionKey: IdentifierSchema,
    fieldKeys: NonEmptyFieldPathsSchema,
    text: z.string().trim().min(1).max(2_000),
  }),
  z.strictObject({
    type: z.literal("answer"),
    questionId: IdentifierSchema,
    resolvedFields: FieldValueRecordSchema.default({}),
    delegatedFields: z
      .array(FieldPathSchema)
      .max(100)
      .refine((paths) => new Set(paths).size === paths.length, {
        message: "Delegated field paths must be unique.",
      })
      .default([]),
  }),
  z.strictObject({
    type: z.literal("invalidate"),
    fieldKeys: NonEmptyFieldPathsSchema,
    reason: z.string().trim().min(1).max(1_000),
  }),
  z.strictObject({
    type: z.literal("assumption"),
    field: FieldPathSchema,
    value: z.json(),
    basis: z.enum([
      "explicit_user_value",
      "explicit_delegation",
      "system_default",
      "inferred",
    ]),
  }),
  z.strictObject({
    type: z.literal("brief_snapshot"),
    version: z.number().int().positive(),
    fields: z.record(FieldPathSchema, BriefFieldValueSchema),
  }),
  z.strictObject({
    type: z.literal("plan_proposed"),
    planId: IdentifierSchema,
    planHash: IdentifierSchema,
    briefVersion: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal("plan_confirmed"),
    planId: IdentifierSchema,
    planHash: IdentifierSchema,
  }),
  z.strictObject({
    type: z.literal("document_mutation"),
    intent: z.enum(["workspace_init", "draft", "revise", "format"]),
    planId: IdentifierSchema.optional(),
    planHash: IdentifierSchema.optional(),
    revision: z.number().int().nonnegative(),
  }),
]);
export type AutonomyTraceEvent = z.infer<typeof AutonomyTraceEventSchema>;

export const AutonomyScenarioSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(200),
  allowedDefaultFields: z
    .array(FieldPathSchema)
    .max(100)
    .refine((paths) => new Set(paths).size === paths.length, {
      message: "Allowed default fields must be unique.",
    })
    .default([]),
  briefExpectations: z.array(BriefExpectationSchema).min(1).max(200),
  minimumBriefFidelity: z.number().min(0).max(1).default(1),
  trace: z.array(AutonomyTraceEventSchema).min(1).max(1_000),
});
export type AutonomyScenario = z.infer<typeof AutonomyScenarioSchema>;

export const AutonomyMetricSchema = z.enum([
  "unauthorized_assumptions",
  "duplicate_questions",
  "pre_confirmation_drafts",
  "brief_fidelity",
]);
export type AutonomyMetric = z.infer<typeof AutonomyMetricSchema>;

export const AutonomyViolationCodeSchema = z.enum([
  "unauthorized_assumption",
  "duplicate_question",
  "question_for_resolved_field",
  "invalid_plan_confirmation",
  "mutation_without_plan_binding",
  "mutation_before_plan_confirmation",
  "brief_snapshot_missing",
  "brief_expectation_missing",
  "brief_expectation_mismatch",
]);
export type AutonomyViolationCode = z.infer<
  typeof AutonomyViolationCodeSchema
>;

export const AutonomyViolationSchema = z.strictObject({
  code: AutonomyViolationCodeSchema,
  metric: AutonomyMetricSchema,
  message: z.string().min(1),
  eventIndex: z.number().int().nonnegative().optional(),
  field: FieldPathSchema.optional(),
});
export type AutonomyViolation = z.infer<typeof AutonomyViolationSchema>;

const CountMetricResultSchema = z.strictObject({
  passed: z.boolean(),
  count: z.number().int().nonnegative(),
});

export const BriefFidelityMetricResultSchema = z.strictObject({
  passed: z.boolean(),
  measurable: z.boolean(),
  score: z.number().min(0).max(1).nullable(),
  matchedWeight: z.number().int().nonnegative(),
  totalWeight: z.number().int().positive(),
  threshold: z.number().min(0).max(1),
});

export const AutonomyEvaluationResultSchema = z.strictObject({
  scenarioId: z.string().min(1),
  passed: z.boolean(),
  metrics: z.strictObject({
    unauthorizedAssumptions: CountMetricResultSchema,
    duplicateQuestions: CountMetricResultSchema,
    preConfirmationDrafts: CountMetricResultSchema,
    briefFidelity: BriefFidelityMetricResultSchema,
  }),
  violations: z.array(AutonomyViolationSchema),
});
export type AutonomyEvaluationResult = z.infer<
  typeof AutonomyEvaluationResultSchema
>;

export const AutonomySuiteResultSchema = z.strictObject({
  passed: z.boolean(),
  results: z.array(AutonomyEvaluationResultSchema),
  summary: z.strictObject({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    violations: z.number().int().nonnegative(),
    meanBriefFidelity: z.number().min(0).max(1).nullable(),
  }),
});
export type AutonomySuiteResult = z.infer<typeof AutonomySuiteResultSchema>;

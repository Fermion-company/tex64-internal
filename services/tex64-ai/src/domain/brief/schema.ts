import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: true });
const BoundedTextSchema = z.string().trim().min(1).max(12_000);
const ShortTextSchema = z.string().trim().min(1).max(1_000);

export const RequirementStatusSchema = z.enum([
  "unknown",
  "provided",
  "delegated",
  "not_applicable",
]);
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>;

export const RequirementSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    runId: z.string().uuid(),
  }),
  z.strictObject({
    kind: z.literal("selected_document_type"),
  }),
  z.strictObject({
    kind: z.literal("existing_document"),
    revision: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("agent_default"),
    runId: z.string().uuid(),
  }),
]);
export type RequirementSource = z.infer<typeof RequirementSourceSchema>;

function requirementSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .strictObject({
      status: RequirementStatusSchema,
      value: valueSchema.nullable(),
      source: RequirementSourceSchema.nullable(),
      updatedAt: TimestampSchema,
    })
    .superRefine((requirement, context) => {
      const candidate = requirement as unknown as {
        status: RequirementStatus;
        value: unknown | null;
        source: RequirementSource | null;
      };
      const expectsValue =
        candidate.status === "provided" || candidate.status === "delegated";
      if (expectsValue !== (candidate.value !== null)) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "Requirement status and value must agree.",
        });
      }
      if (expectsValue !== (candidate.source !== null)) {
        context.addIssue({
          code: "custom",
          path: ["source"],
          message: "Answered requirements require provenance.",
        });
      }
      if (
        candidate.status === "delegated" &&
        candidate.source?.kind !== "agent_default"
      ) {
        context.addIssue({
          code: "custom",
          path: ["source"],
          message: "Delegated requirements must identify the accepted agent default.",
        });
      }
      if (
        candidate.status === "provided" &&
        candidate.source?.kind === "agent_default"
      ) {
        context.addIssue({
          code: "custom",
          path: ["source"],
          message: "Agent defaults cannot be presented as user-provided requirements.",
        });
      }
    });
}

export const DeliverableSchema = z.enum([
  "article",
  "proposal",
  "report",
  "paper",
  "letter",
  "notes",
]);
export type Deliverable = z.infer<typeof DeliverableSchema>;

export const DepthSchema = z.enum([
  "overview",
  "explanatory",
  "technical",
  "exhaustive",
]);

export const TemplateFamilySchema = z.enum([
  "general",
  "academic",
  "business",
  "compact",
  "letter",
  "notes",
  "custom",
]);

export const PageSizeSchema = z.enum([
  "A3",
  "A4",
  "A5",
  "B4",
  "B5",
  "letter",
]);
export type PageSize = z.infer<typeof PageSizeSchema>;

export const FigurePolicySchema = z.enum([
  "none",
  "agent_proposes",
  "required",
  "provided_only",
]);

export const EquationPolicySchema = z.enum([
  "none",
  "as_needed",
  "required",
]);

export const DerivationDetailSchema = z.enum([
  "result_only",
  "key_steps",
  "full_derivation",
]);

export const ProofRigorSchema = z.enum([
  "intuitive",
  "standard",
  "formal",
]);

export const EquationNumberingSchema = z.enum([
  "none",
  "important_only",
  "all",
]);

export const SourcePolicySchema = z.enum([
  "none",
  "user_only",
  "agent_research",
  "mixed",
]);

export const CitationStyleSchema = z.enum([
  "author-year",
  "apa7",
  "ieee",
  "numeric",
]);
export type CitationStyle = z.infer<typeof CitationStyleSchema>;

export const ToneRegisterSchema = z.enum([
  "plain",
  "professional",
  "academic",
  "formal",
]);

export const ToneVoiceSchema = z.enum([
  "neutral",
  "assertive",
  "analytical",
  "persuasive",
]);

export const JargonLevelSchema = z.enum(["low", "moderate", "high"]);
export const SentenceStyleSchema = z.enum([
  "concise",
  "balanced",
  "detailed",
]);

export const FactualUncertaintyPolicySchema = z.enum([
  "mark_uncertainty",
  "omit_unverified",
  "ask_user",
]);

const StringRequirementSchema = requirementSchema(BoundedTextSchema);
const StringListRequirementSchema = requirementSchema(
  z.array(ShortTextSchema).max(100),
);
const NumberRequirementSchema = requirementSchema(
  z.number().int().nonnegative().max(10_000),
);

export const DocumentBriefSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentId: z.string().uuid(),
  goal: z.strictObject({
    deliverable: requirementSchema(DeliverableSchema),
    subject: StringRequirementSchema,
    purpose: StringRequirementSchema,
    audience: StringRequirementSchema,
    intendedOutcome: StringRequirementSchema,
  }),
  scope: z.strictObject({
    includedTopics: StringListRequirementSchema,
    excludedTopics: StringListRequirementSchema,
    depth: requirementSchema(DepthSchema),
    targetLength: StringRequirementSchema,
    language: StringRequirementSchema,
  }),
  template: z.strictObject({
    family: requirementSchema(TemplateFamilySchema),
    customTemplate: StringRequirementSchema,
    sectionOrder: StringListRequirementSchema,
    pageSize: requirementSchema(PageSizeSchema),
    columns: requirementSchema(z.union([z.literal(1), z.literal(2)])),
  }),
  figures: z.strictObject({
    policy: requirementSchema(FigurePolicySchema),
    items: StringListRequirementSchema,
  }),
  equations: z.strictObject({
    policy: requirementSchema(EquationPolicySchema),
    // Default keeps schema-v1 sessions written before mathematical objectives
    // readable; coverage safely reopens them before any further drafting.
    items: StringListRequirementSchema.default({
      status: "unknown",
      value: null,
      source: null,
      updatedAt: "1970-01-01T00:00:00.000Z",
    }),
    derivationDetail: requirementSchema(DerivationDetailSchema),
    proofRigor: requirementSchema(ProofRigorSchema),
    notationConvention: StringRequirementSchema,
    numbering: requirementSchema(EquationNumberingSchema),
  }),
  sources: z.strictObject({
    policy: requirementSchema(SourcePolicySchema),
    citationStyle: StringRequirementSchema,
    minimumCount: NumberRequirementSchema,
    dateRange: StringRequirementSchema,
    requiredLocators: StringListRequirementSchema,
  }),
  tone: z.strictObject({
    register: requirementSchema(ToneRegisterSchema),
    voice: requirementSchema(ToneVoiceSchema),
    jargonLevel: requirementSchema(JargonLevelSchema),
    sentenceStyle: requirementSchema(SentenceStyleSchema),
  }),
  constraints: z.strictObject({
    mustInclude: StringListRequirementSchema,
    mustExclude: StringListRequirementSchema,
    factualUncertaintyPolicy: requirementSchema(
      FactualUncertaintyPolicySchema,
    ),
    additional: StringListRequirementSchema,
  }),
  acceptanceCriteria: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        statement: ShortTextSchema,
        kind: z.enum(["deterministic", "model_assessed", "user_review"]),
        severity: z.enum(["required", "preferred"]),
      }),
    )
    .max(100),
  assumptions: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        path: z.string().min(1).max(200),
        statement: ShortTextSchema,
        risk: z.enum(["low", "medium", "high"]),
        acceptedByRunId: z.string().uuid(),
      }),
    )
    .max(100),
  updatedAt: TimestampSchema,
});
export type DocumentBrief = z.infer<typeof DocumentBriefSchema>;

export const RequirementGroupSchema = z.enum([
  "subject",
  "purpose_audience",
  "scope_structure",
  "sources_evidence",
  "mathematics",
  "visuals",
  "presentation",
  "acceptance",
]);
export type RequirementGroup = z.infer<typeof RequirementGroupSchema>;

export const RequirementPathSchema = z.enum([
  "goal.subject",
  "goal.purpose",
  "goal.audience",
  "goal.intendedOutcome",
  "scope.includedTopics",
  "scope.excludedTopics",
  "scope.depth",
  "scope.targetLength",
  "scope.language",
  "template.family",
  "template.customTemplate",
  "template.sectionOrder",
  "template.pageSize",
  "template.columns",
  "figures.policy",
  "figures.items",
  "equations.policy",
  "equations.items",
  "equations.derivationDetail",
  "equations.proofRigor",
  "equations.notationConvention",
  "equations.numbering",
  "sources.policy",
  "sources.citationStyle",
  "sources.minimumCount",
  "sources.dateRange",
  "sources.requiredLocators",
  "tone.register",
  "tone.voice",
  "tone.jargonLevel",
  "tone.sentenceStyle",
  "constraints.mustInclude",
  "constraints.mustExclude",
  "constraints.factualUncertaintyPolicy",
  "constraints.additional",
  "acceptanceCriteria",
]);
export type RequirementPath = z.infer<typeof RequirementPathSchema>;

export const ElicitationTargetSchema = z.union([
  RequirementGroupSchema,
  z.literal("delegation_offer"),
  z.literal("brief_revision"),
  z.literal("brief_confirmation"),
]);
export type ElicitationTarget = z.infer<typeof ElicitationTargetSchema>;

export const ElicitationQuestionSchema = z.strictObject({
  id: z.string().uuid(),
  kind: z.enum(["free_text", "single_choice", "multi_select", "confirm"]),
  target: ElicitationTargetSchema,
  targetPaths: z.array(RequirementPathSchema).max(35),
  prompt: z.string().trim().min(1).max(500),
  options: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(100),
        label: z.string().min(1).max(200),
        recommended: z.boolean(),
      }),
    )
    .max(8),
  allowsFreeText: z.boolean(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["pending", "answered", "skipped", "cancelled"]),
  sourceRunId: z.string().uuid(),
  briefVersion: z.number().int().positive().default(1),
  answeredByRunId: z.string().uuid().nullable(),
  createdAt: TimestampSchema,
});
export type ElicitationQuestion = z.infer<typeof ElicitationQuestionSchema>;

export const AgentSessionPhaseSchema = z.enum([
  "intake",
  "eliciting",
  "awaiting_answer",
  "awaiting_brief_confirmation",
  "planning",
  "researching",
  "drafting",
  "reviewing",
  "formatting",
  "ready",
  "failed",
]);
export type AgentSessionPhase = z.infer<typeof AgentSessionPhaseSchema>;

export const DocumentAgentSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  rootRunId: z.string().uuid(),
  phase: AgentSessionPhaseSchema,
  brief: DocumentBriefSchema,
  briefVersion: z.number().int().positive(),
  confirmedBriefVersion: z.number().int().positive().nullable(),
  activeQuestionId: z.string().uuid().nullable(),
  questions: z.array(ElicitationQuestionSchema).max(100),
  questionCount: z.number().int().nonnegative().max(100),
  consecutiveQuestionCount: z.number().int().nonnegative().max(100),
  lastProcessedRunId: z.string().uuid().nullable(),
  stateVersion: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).superRefine((session, context) => {
  if (session.brief.documentId !== session.documentId) {
    context.addIssue({
      code: "custom",
      path: ["brief", "documentId"],
      message: "The brief must belong to the session document.",
    });
  }
  if (session.questionCount !== session.questions.length) {
    context.addIssue({
      code: "custom",
      path: ["questionCount"],
      message: "Question count must match persisted questions.",
    });
  }
  const activeQuestion = session.activeQuestionId
    ? session.questions.find((question) => question.id === session.activeQuestionId)
    : null;
  const awaiting =
    session.phase === "awaiting_answer" ||
    session.phase === "awaiting_brief_confirmation";
  if (awaiting !== Boolean(activeQuestion)) {
    context.addIssue({
      code: "custom",
      path: ["activeQuestionId"],
      message: "Awaiting sessions require one active question.",
    });
  }
  if (activeQuestion && activeQuestion.status !== "pending") {
    context.addIssue({
      code: "custom",
      path: ["activeQuestionId"],
      message: "The active question must still be pending.",
    });
  }
  if (activeQuestion && activeQuestion.briefVersion !== session.briefVersion) {
    context.addIssue({
      code: "custom",
      path: ["activeQuestionId"],
      message: "The active question must describe the current brief version.",
    });
  }
  if (
    session.phase === "awaiting_brief_confirmation" &&
    activeQuestion?.target !== "brief_confirmation"
  ) {
    context.addIssue({
      code: "custom",
      path: ["phase"],
      message: "Brief confirmation must target the current brief.",
    });
  }
  if (
    session.confirmedBriefVersion !== null &&
    session.confirmedBriefVersion > session.briefVersion
  ) {
    context.addIssue({
      code: "custom",
      path: ["confirmedBriefVersion"],
      message: "A future brief version cannot be confirmed.",
    });
  }
  if (
    ["planning", "researching", "drafting", "reviewing", "formatting", "ready"].includes(
      session.phase,
    ) &&
    session.confirmedBriefVersion !== session.briefVersion
  ) {
    context.addIssue({
      code: "custom",
      path: ["confirmedBriefVersion"],
      message: "Execution requires confirmation of the current brief.",
    });
  }
});
export type DocumentAgentSession = z.infer<
  typeof DocumentAgentSessionSchema
>;

export const StoredDocumentAgentSessionSchema = z.strictObject({
  userId: z.string().uuid(),
  documentId: z.string().uuid(),
  session: DocumentAgentSessionSchema,
  stateVersion: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
});
export type StoredDocumentAgentSession = z.infer<
  typeof StoredDocumentAgentSessionSchema
>;

export const BriefExtractionSchema = z.strictObject({
  subject: z.string().trim().min(1).max(1_000).nullable(),
  purpose: z.string().trim().min(1).max(2_000).nullable(),
  audience: z.string().trim().min(1).max(2_000).nullable(),
  intendedOutcome: z.string().trim().min(1).max(2_000).nullable(),
  includedTopics: z.array(ShortTextSchema).max(30),
  excludedTopics: z.array(ShortTextSchema).max(30),
  depth: DepthSchema.nullable(),
  targetLength: z.string().trim().min(1).max(1_000).nullable(),
  language: z.string().trim().min(1).max(200).nullable().default(null),
  templateFamily: TemplateFamilySchema.nullable(),
  customTemplate: z.string().trim().min(1).max(2_000).nullable(),
  sectionOrder: z.array(ShortTextSchema).max(30),
  pageSize: PageSizeSchema.nullable(),
  columns: z.union([z.literal(1), z.literal(2)]).nullable(),
  figurePolicy: FigurePolicySchema.nullable(),
  figureItems: z.array(ShortTextSchema).max(30),
  equationPolicy: EquationPolicySchema.nullable(),
  equationItems: z.array(ShortTextSchema).max(30),
  derivationDetail: DerivationDetailSchema.nullable(),
  proofRigor: ProofRigorSchema.nullable(),
  notationConvention: z.string().trim().min(1).max(2_000).nullable(),
  equationNumbering: EquationNumberingSchema.nullable(),
  sourcePolicy: SourcePolicySchema.nullable(),
  citationStyle: CitationStyleSchema.nullable(),
  minimumSourceCount: z.number().int().nonnegative().max(10_000).nullable(),
  sourceDateRange: z.string().trim().min(1).max(500).nullable(),
  requiredLocators: z.array(z.string().trim().min(1).max(4_096)).max(30),
  toneRegister: ToneRegisterSchema.nullable(),
  toneVoice: ToneVoiceSchema.nullable(),
  jargonLevel: JargonLevelSchema.nullable(),
  sentenceStyle: SentenceStyleSchema.nullable(),
  mustInclude: z.array(ShortTextSchema).max(50),
  mustExclude: z.array(ShortTextSchema).max(50),
  factualUncertaintyPolicy: FactualUncertaintyPolicySchema.nullable(),
  additionalConstraints: z.array(ShortTextSchema).max(50),
  acceptanceCriteria: z.array(ShortTextSchema).max(30),
  delegatedGroups: z.array(RequirementGroupSchema).max(8),
  confirmsBrief: z.boolean(),
  evidence: z
    .array(
      z.strictObject({
        path: RequirementPathSchema,
        quote: z.string().trim().min(1).max(2_000),
      }),
    )
    .max(100)
    .default([]),
});
export type BriefExtraction = z.infer<typeof BriefExtractionSchema>;

export type RequirementValue<T> = {
  status: RequirementStatus;
  value: T | null;
  source: RequirementSource | null;
  updatedAt: string;
};

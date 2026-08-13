import { describe, expect, it } from "vitest";

import { initializeDocumentBrief } from "@/domain/brief/initialize";
import {
  DocumentBriefSchema,
  type DocumentBrief,
  type RequirementValue,
} from "@/domain/brief/schema";
import { createDocumentBriefDigest } from "./digest";
import { DocumentPlanSchema, type DocumentPlan } from "./schema";
import {
  DocumentPlanValidationError,
  validateDocumentPlan,
} from "./validate";

const DOCUMENT_ID = "30000000-0000-4000-8000-000000000001";
const RUN_ID = "40000000-0000-4000-8000-000000000001";
const PLAN_ID = "50000000-0000-4000-8000-000000000001";
const INTRODUCTION_ID = "50000000-0000-4000-8000-000000000002";
const ANALYSIS_ID = "50000000-0000-4000-8000-000000000003";
const CLAIM_ID = "50000000-0000-4000-8000-000000000004";
const SOURCE_REQUIREMENT_ID = "50000000-0000-4000-8000-000000000005";
const MATH_ID = "50000000-0000-4000-8000-000000000006";
const VISUAL_ID = "50000000-0000-4000-8000-000000000007";
const INTRODUCTION_CRITERION_ID = "50000000-0000-4000-8000-000000000008";
const ANALYSIS_CRITERION_ID = "50000000-0000-4000-8000-000000000009";
const PLAN_CRITERION_ID = "50000000-0000-4000-8000-000000000010";
const BRIEF_CRITERION_ID = "60000000-0000-4000-8000-000000000001";
const NOW = "2026-08-08T00:00:00.000Z";

function provided<T>(value: T): RequirementValue<T> {
  return {
    status: "provided",
    value,
    source: { kind: "user", runId: RUN_ID },
    updatedAt: NOW,
  };
}

function completeBrief(): DocumentBrief {
  const brief = initializeDocumentBrief({
    documentId: DOCUMENT_ID,
    deliverable: "paper",
    now: NOW,
  });
  brief.goal.subject = provided("Adaptive control systems");
  brief.goal.purpose = provided("Explain and evaluate the method");
  brief.goal.audience = provided("Control engineering researchers");
  brief.goal.intendedOutcome = provided("Support a reproducible comparison");
  brief.scope.includedTopics = provided(["stability", "tracking error"]);
  brief.scope.excludedTopics = provided(["hardware implementation"]);
  brief.scope.depth = provided("technical");
  brief.scope.targetLength = provided("4,000 words");
  brief.scope.language = provided("English");
  brief.template.family = provided("academic");
  brief.template.sectionOrder = provided(["Introduction", "Analysis"]);
  brief.template.pageSize = provided("A4");
  brief.template.columns = provided(1);
  brief.figures.policy = provided("required");
  brief.figures.items = provided(["Tracking error comparison"]);
  brief.equations.policy = provided("required");
  brief.equations.items = provided(["Establish the tracking-error bound"]);
  brief.equations.derivationDetail = provided("full_derivation");
  brief.equations.proofRigor = provided("standard");
  brief.equations.notationConvention = provided("Bold lowercase state vectors");
  brief.equations.numbering = provided("all");
  brief.sources.policy = provided("agent_research");
  brief.sources.citationStyle = provided("ieee");
  brief.sources.minimumCount = provided(3);
  brief.sources.dateRange = provided("2015-2026");
  brief.sources.requiredLocators = provided([
    "https://example.org/required-paper",
  ]);
  brief.tone.register = provided("academic");
  brief.tone.voice = provided("analytical");
  brief.tone.jargonLevel = provided("high");
  brief.tone.sentenceStyle = provided("balanced");
  brief.constraints.mustInclude = provided(["Limitations"]);
  brief.constraints.mustExclude = provided(["Unsupported causal claims"]);
  brief.constraints.factualUncertaintyPolicy = provided("mark_uncertainty");
  brief.acceptanceCriteria = [
    {
      id: BRIEF_CRITERION_ID,
      statement: "All empirical claims are cited",
      kind: "deterministic",
      severity: "required",
    },
  ];
  return DocumentBriefSchema.parse(brief);
}

function validPlan(brief = completeBrief()): DocumentPlan {
  return DocumentPlanSchema.parse({
    schemaVersion: 1,
    id: PLAN_ID,
    documentId: DOCUMENT_ID,
    briefVersion: 3,
    briefDigest: createDocumentBriefDigest(brief),
    status: "ready",
    version: 1,
    objective: "Produce a source-grounded technical comparison.",
    sections: [
      {
        id: INTRODUCTION_ID,
        title: "Introduction",
        objective: "Define the problem and establish the evidence base.",
        expectedAmount: {
          unit: "words",
          minimum: 700,
          target: 900,
          maximum: 1_100,
        },
        researchClaims: [
          {
            id: CLAIM_ID,
            statement: "Adaptive control improves tracking under uncertainty.",
            researchPurpose: "Bound the claim and identify applicable conditions.",
            priority: "required",
            sourceRequirementIds: [SOURCE_REQUIREMENT_ID],
          },
        ],
        sourceRequirements: [
          {
            id: SOURCE_REQUIREMENT_ID,
            purpose: "Support the central empirical comparison.",
            minimumCount: 3,
            sourceKinds: ["primary_research", "peer_reviewed"],
            dateRange: "2015-2026",
            requiredLocators: ["https://example.org/required-paper"],
          },
        ],
        mathematics: { policy: "none", items: [] },
        visuals: [],
        completionCriteria: [
          {
            id: INTRODUCTION_CRITERION_ID,
            statement: "The research question and scope are explicit.",
            verification: "model_assessed",
            severity: "required",
            briefCriterionId: null,
          },
        ],
      },
      {
        id: ANALYSIS_ID,
        title: "Analysis",
        objective: "Derive the result and compare tracking performance.",
        expectedAmount: {
          unit: "words",
          minimum: 1_500,
          target: 2_000,
          maximum: 2_500,
        },
        researchClaims: [],
        sourceRequirements: [],
        mathematics: {
          policy: "required",
          items: [
            {
              id: MATH_ID,
              briefItem: "Establish the tracking-error bound",
              purpose: "Establish the tracking-error bound.",
              resultToEstablish: "The error converges to a bounded set.",
              derivationDetail: "full_derivation",
              proofRigor: "standard",
              notationRequirements: [
                "Bold lowercase state vectors",
                "Define every state variable",
              ],
              intermediateSteps: [
                "Construct the Lyapunov function.",
                "Bound its time derivative.",
              ],
              dependsOnClaimIds: [],
              numbered: true,
              completionCriterion: "Every inequality follows from a named assumption.",
            },
          ],
        },
        visuals: [
          {
            id: VISUAL_ID,
            kind: "chart",
            briefItem: "Tracking error comparison",
            purpose: "Compare tracking error over time.",
            intendedMessage: "The proposed method reduces steady-state error.",
            source: "derived_from_data",
            dataRequirements: ["Time-series error for both controllers"],
            accessibilityDescription: "Describe axes, series, and the principal difference.",
            completionCriterion: "Values and units match the underlying dataset.",
          },
        ],
        completionCriteria: [
          {
            id: ANALYSIS_CRITERION_ID,
            statement: "The derivation and chart support the stated conclusion.",
            verification: "model_assessed",
            severity: "required",
            briefCriterionId: null,
          },
        ],
      },
    ],
    completionCriteria: [
      {
        id: PLAN_CRITERION_ID,
        statement: "Every empirical claim has a verified citation.",
        verification: "deterministic",
        severity: "required",
        briefCriterionId: BRIEF_CRITERION_ID,
        deterministicEvaluator: {
          kind: "reference_integrity",
          requireBibliography: true,
          requireEverySourceCited: true,
        },
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function context(brief: DocumentBrief) {
  return {
    brief,
    briefVersion: 3,
    confirmedBriefVersion: 3,
  };
}

describe("document plan domain", () => {
  it("validates a typed plan against its confirmed brief", () => {
    const brief = completeBrief();
    const plan = validPlan(brief);
    expect(validateDocumentPlan(plan, context(brief))).toEqual(plan);
  });

  it("does not weaken confirmed rigor, notation, or important equation numbering", () => {
    const brief = completeBrief();
    brief.equations.numbering = provided("important_only");
    const plan = structuredClone(validPlan(brief));
    const item = plan.sections[1]!.mathematics.items[0]!;
    item.proofRigor = "intuitive";
    item.notationRequirements = ["Use convenient notation"];
    item.numbered = false;

    expect(() => validateDocumentPlan(plan, context(brief))).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringContaining("proofRigor"),
          }),
          expect.objectContaining({
            path: expect.stringContaining("notationRequirements"),
          }),
          expect.objectContaining({
            message: expect.stringContaining("important planned equations"),
          }),
        ]),
      }),
    );
  });

  it("rejects a fabricated mathematical-objective binding", () => {
    const brief = completeBrief();
    const plan = structuredClone(validPlan(brief));
    plan.sections[1]!.mathematics.items[0]!.briefItem =
      "A different objective invented during planning";

    expect(() => validateDocumentPlan(plan, context(brief))).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringContaining("briefItem"),
            message: expect.stringContaining("unknown brief objective"),
          }),
          expect.objectContaining({
            message: expect.stringContaining(
              "requested mathematical objective is missing",
            ),
          }),
        ]),
      }),
    );
  });

  it("rejects unsupported free-form deterministic completion criteria", () => {
    const brief = completeBrief();
    const plan = structuredClone(validPlan(brief));
    plan.completionCriteria[0]!.statement =
      "The argument is unquestionably persuasive.";
    delete plan.completionCriteria[0]!.deterministicEvaluator;

    expect(() => validateDocumentPlan(plan, context(brief))).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "unsupported_deterministic_criterion",
          }),
        ]),
      }),
    );
  });

  it("creates a deterministic digest independent of object key order", () => {
    const brief = completeBrief();
    const reordered = reverseObjectKeys(brief);
    expect(createDocumentBriefDigest(reordered)).toBe(
      createDocumentBriefDigest(brief),
    );

    const changed = structuredClone(brief);
    changed.goal.subject = provided("A different subject");
    expect(createDocumentBriefDigest(changed)).not.toBe(
      createDocumentBriefDigest(brief),
    );
  });

  it("rejects an unconfirmed or blocking-incomplete brief", () => {
    const complete = completeBrief();
    expect(() =>
      validateDocumentPlan(validPlan(complete), {
        ...context(complete),
        confirmedBriefVersion: null,
      }),
    ).toThrow(DocumentPlanValidationError);

    const incomplete = structuredClone(complete);
    incomplete.goal.subject = {
      status: "unknown",
      value: null,
      source: null,
      updatedAt: NOW,
    };
    const parsedIncomplete = DocumentBriefSchema.parse(incomplete);
    const plan = {
      ...validPlan(complete),
      briefDigest: createDocumentBriefDigest(parsedIncomplete),
    };
    expect(() =>
      validateDocumentPlan(plan, context(parsedIncomplete)),
    ).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "brief_unresolved" }),
        ]),
      }),
    );
  });

  it("rejects duplicate section IDs and dangling source references", () => {
    const brief = completeBrief();
    const duplicate = structuredClone(validPlan(brief));
    duplicate.sections[1]!.id = duplicate.sections[0]!.id;
    expect(DocumentPlanSchema.safeParse(duplicate).success).toBe(false);

    const dangling = structuredClone(validPlan(brief));
    dangling.sections[0]!.researchClaims[0]!.sourceRequirementIds = [
      "70000000-0000-4000-8000-000000000099",
    ];
    expect(DocumentPlanSchema.safeParse(dangling).success).toBe(false);
  });

  it("rejects stale brief identity, version, and digest", () => {
    const brief = completeBrief();
    const plan = validPlan(brief);
    for (const candidate of [
      { ...plan, briefVersion: 2 },
      { ...plan, briefDigest: "a".repeat(64) },
      {
        ...plan,
        documentId: "30000000-0000-4000-8000-000000000099",
      },
    ]) {
      expect(() => validateDocumentPlan(candidate, context(brief))).toThrowError(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "brief_mismatch" }),
          ]),
        }),
      );
    }
  });

  it("enforces section order and math, visual, source, and completion promises", () => {
    const brief = completeBrief();
    const invalid = structuredClone(validPlan(brief));
    invalid.sections.reverse();
    invalid.sections[0]!.mathematics.items = [];
    invalid.sections[0]!.mathematics.policy = "none";
    invalid.sections[0]!.visuals = [];
    invalid.sections[1]!.sourceRequirements[0]!.minimumCount = 1;
    invalid.completionCriteria[0]!.briefCriterionId = null;

    expect(() => validateDocumentPlan(invalid, context(brief))).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "brief_requirement" }),
        ]),
      }),
    );
  });

  it("binds every explicitly requested visual to a distinct plan item", () => {
    const brief = completeBrief();
    brief.figures.items = provided([
      "Tracking error comparison",
      "Controller architecture",
    ]);
    const invalid = structuredClone(validPlan(brief));

    expect(() => validateDocumentPlan(invalid, context(brief))).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "brief_requirement",
            path: "sections.visuals.1.purpose",
          }),
        ]),
      }),
    );

    invalid.sections[1]!.visuals.push({
      ...structuredClone(invalid.sections[1]!.visuals[0]!),
      id: "50000000-0000-4000-8000-000000000099",
      briefItem: "Controller architecture",
      purpose: "Show the controller architecture.",
    });
    expect(validateDocumentPlan(invalid, context(brief))).toEqual(invalid);
  });
});

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
  );
}

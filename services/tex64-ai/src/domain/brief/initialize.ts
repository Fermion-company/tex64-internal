import { requirementProfileFor } from "./applicability";
import {
  DocumentAgentSessionSchema,
  DocumentBriefSchema,
  type Deliverable,
  type DocumentAgentSession,
  type DocumentBrief,
  type RequirementValue,
} from "./schema";

function unknown<T>(updatedAt: string): RequirementValue<T> {
  return { status: "unknown", value: null, source: null, updatedAt };
}

function notApplicable<T>(updatedAt: string): RequirementValue<T> {
  return { status: "not_applicable", value: null, source: null, updatedAt };
}

function selected<T>(value: T, updatedAt: string): RequirementValue<T> {
  return {
    status: "provided",
    value,
    source: { kind: "selected_document_type" },
    updatedAt,
  };
}

export function initializeDocumentBrief(input: {
  documentId: string;
  deliverable: Deliverable;
  now: string;
}): DocumentBrief {
  const profile = requirementProfileFor(input.deliverable);
  const sources =
    profile.sources_evidence === "not_applicable"
      ? notApplicable
      : unknown;
  const mathematics =
    profile.mathematics === "not_applicable" ? notApplicable : unknown;
  const visuals =
    profile.visuals === "not_applicable" ? notApplicable : unknown;

  return DocumentBriefSchema.parse({
    schemaVersion: 1,
    documentId: input.documentId,
    goal: {
      deliverable: selected(input.deliverable, input.now),
      subject: unknown(input.now),
      purpose: unknown(input.now),
      audience: unknown(input.now),
      intendedOutcome: unknown(input.now),
    },
    scope: {
      includedTopics: unknown(input.now),
      excludedTopics: unknown(input.now),
      depth: unknown(input.now),
      targetLength: unknown(input.now),
      language: unknown(input.now),
    },
    template: {
      family: unknown(input.now),
      customTemplate: unknown(input.now),
      sectionOrder: unknown(input.now),
      pageSize: unknown(input.now),
      columns: unknown(input.now),
    },
    figures: {
      policy: visuals(input.now),
      items: visuals(input.now),
    },
    equations: {
      policy: mathematics(input.now),
      items: mathematics(input.now),
      derivationDetail: mathematics(input.now),
      proofRigor: mathematics(input.now),
      notationConvention: mathematics(input.now),
      numbering: mathematics(input.now),
    },
    sources: {
      policy: sources(input.now),
      citationStyle: sources(input.now),
      minimumCount: sources(input.now),
      dateRange: sources(input.now),
      requiredLocators: sources(input.now),
    },
    tone: {
      register: unknown(input.now),
      voice: unknown(input.now),
      jargonLevel: unknown(input.now),
      sentenceStyle: unknown(input.now),
    },
    constraints: {
      mustInclude: unknown(input.now),
      mustExclude: unknown(input.now),
      factualUncertaintyPolicy: unknown(input.now),
      additional: unknown(input.now),
    },
    acceptanceCriteria: [],
    assumptions: [],
    updatedAt: input.now,
  });
}

export function createDocumentAgentSession(input: {
  sessionId: string;
  documentId: string;
  rootRunId: string;
  deliverable: Deliverable;
  now: string;
}): DocumentAgentSession {
  return DocumentAgentSessionSchema.parse({
    schemaVersion: 1,
    id: input.sessionId,
    documentId: input.documentId,
    rootRunId: input.rootRunId,
    phase: "intake",
    brief: initializeDocumentBrief(input),
    briefVersion: 1,
    confirmedBriefVersion: null,
    activeQuestionId: null,
    questions: [],
    questionCount: 0,
    consecutiveQuestionCount: 0,
    lastProcessedRunId: null,
    stateVersion: 0,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

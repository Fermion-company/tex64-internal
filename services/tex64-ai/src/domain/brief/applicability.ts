import type {
  Deliverable,
  DocumentBrief,
  RequirementGroup,
  RequirementStatus,
} from "./schema";

export type RequirementApplicability =
  | "required"
  | "recommended"
  | "conditional"
  | "not_applicable";

export type DocumentRequirementProfile = Readonly<
  Record<RequirementGroup, RequirementApplicability>
>;

const COMMON_REQUIRED = {
  subject: "required",
  purpose_audience: "required",
  scope_structure: "required",
  presentation: "required",
} as const;

const DOCUMENT_REQUIREMENT_PROFILES: Readonly<
  Record<Deliverable, DocumentRequirementProfile>
> = {
  article: {
    ...COMMON_REQUIRED,
    sources_evidence: "recommended",
    mathematics: "recommended",
    visuals: "recommended",
    acceptance: "required",
  },
  proposal: {
    ...COMMON_REQUIRED,
    sources_evidence: "recommended",
    mathematics: "recommended",
    visuals: "recommended",
    acceptance: "required",
  },
  report: {
    ...COMMON_REQUIRED,
    sources_evidence: "recommended",
    mathematics: "recommended",
    visuals: "recommended",
    acceptance: "required",
  },
  paper: {
    ...COMMON_REQUIRED,
    sources_evidence: "required",
    mathematics: "recommended",
    visuals: "recommended",
    acceptance: "required",
  },
  letter: {
    ...COMMON_REQUIRED,
    sources_evidence: "not_applicable",
    mathematics: "not_applicable",
    visuals: "not_applicable",
    acceptance: "recommended",
  },
  notes: {
    ...COMMON_REQUIRED,
    sources_evidence: "recommended",
    mathematics: "recommended",
    visuals: "recommended",
    acceptance: "recommended",
  },
};

export function requirementProfileFor(
  deliverable: Deliverable,
): DocumentRequirementProfile {
  return DOCUMENT_REQUIREMENT_PROFILES[deliverable];
}

function answered(status: RequirementStatus): boolean {
  return status === "provided" || status === "delegated";
}

/**
 * A conditional group becomes applicable only after the user supplies a value
 * in that group. This keeps a memo from asking about equations merely because
 * the document model is capable of representing them.
 */
export function isRequirementGroupApplicable(
  brief: DocumentBrief,
  group: RequirementGroup,
): boolean {
  const base = requirementProfileFor(brief.goal.deliverable.value ?? "article")[
    group
  ];
  if (base !== "conditional" && base !== "not_applicable") {
    return true;
  }

  switch (group) {
    case "sources_evidence":
      return [
        brief.sources.policy,
        brief.sources.citationStyle,
        brief.sources.minimumCount,
        brief.sources.dateRange,
        brief.sources.requiredLocators,
      ].some((requirement) => answered(requirement.status));
    case "mathematics":
      return [
        brief.equations.policy,
        brief.equations.items,
        brief.equations.derivationDetail,
        brief.equations.proofRigor,
        brief.equations.notationConvention,
        brief.equations.numbering,
      ].some((requirement) => answered(requirement.status));
    case "visuals":
      return [brief.figures.policy, brief.figures.items].some((requirement) =>
        answered(requirement.status),
      );
    default:
      return base !== "not_applicable";
  }
}

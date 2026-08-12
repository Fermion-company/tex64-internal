import {
  isRequirementGroupApplicable,
  requirementProfileFor,
  type RequirementApplicability,
} from "./applicability";
import type {
  DocumentBrief,
  RequirementGroup,
  RequirementPath,
  RequirementStatus,
} from "./schema";
import { resolveSafeCustomTemplatePreset } from "./custom-template";

export type BriefGapImpact = "blocking" | "material";

export type BriefGap = {
  group: RequirementGroup;
  impact: BriefGapImpact;
  applicability: RequirementApplicability;
  missingPaths: RequirementPath[];
  canDelegate: boolean;
};

export type BriefCoverage = {
  complete: boolean;
  blockingGaps: BriefGap[];
  materialGaps: BriefGap[];
  gaps: BriefGap[];
};

function unresolved(status: RequirementStatus): boolean {
  return status === "unknown";
}

const SUPPORTED_CITATION_STYLES = new Set([
  "author-year",
  "apa7",
  "ieee",
  "numeric",
]);

function pathsForGroup(
  brief: DocumentBrief,
  group: RequirementGroup,
): RequirementPath[] {
  switch (group) {
    case "subject":
      return unresolved(brief.goal.subject.status) ? ["goal.subject"] : [];
    case "purpose_audience":
      return [
        unresolved(brief.goal.purpose.status) ? "goal.purpose" : null,
        unresolved(brief.goal.audience.status) ? "goal.audience" : null,
        unresolved(brief.goal.intendedOutcome.status)
          ? "goal.intendedOutcome"
          : null,
      ].filter((path): path is RequirementPath => path !== null);
    case "scope_structure":
      return [
        unresolved(brief.scope.includedTopics.status)
          ? "scope.includedTopics"
          : null,
        unresolved(brief.scope.excludedTopics.status)
          ? "scope.excludedTopics"
          : null,
        unresolved(brief.scope.depth.status) ? "scope.depth" : null,
        unresolved(brief.scope.targetLength.status)
          ? "scope.targetLength"
          : null,
        unresolved(brief.scope.language.status) ? "scope.language" : null,
        unresolved(brief.template.sectionOrder.status)
          ? "template.sectionOrder"
          : null,
      ].filter((path): path is RequirementPath => path !== null);
    case "sources_evidence": {
      if (unresolved(brief.sources.policy.status)) return ["sources.policy"];
      if (brief.sources.policy.value === "none") return [];
      return [
        unresolved(brief.sources.citationStyle.status) ||
        !SUPPORTED_CITATION_STYLES.has(
          brief.sources.citationStyle.value ?? "",
        )
          ? "sources.citationStyle"
          : null,
        unresolved(brief.sources.minimumCount.status)
          ? "sources.minimumCount"
          : null,
        unresolved(brief.sources.dateRange.status) ? "sources.dateRange" : null,
        (brief.sources.policy.value === "user_only" ||
          brief.sources.policy.value === "mixed") &&
        unresolved(brief.sources.requiredLocators.status)
          ? "sources.requiredLocators"
          : null,
      ].filter((path): path is RequirementPath => path !== null);
    }
    case "mathematics": {
      if (unresolved(brief.equations.policy.status)) return ["equations.policy"];
      if (brief.equations.policy.value === "none") return [];
      return [
        unresolved(brief.equations.items.status)
          ? "equations.items"
          : null,
        unresolved(brief.equations.derivationDetail.status)
          ? "equations.derivationDetail"
          : null,
        unresolved(brief.equations.proofRigor.status)
          ? "equations.proofRigor"
          : null,
        unresolved(brief.equations.notationConvention.status)
          ? "equations.notationConvention"
          : null,
        unresolved(brief.equations.numbering.status)
          ? "equations.numbering"
          : null,
      ].filter((path): path is RequirementPath => path !== null);
    }
    case "visuals": {
      if (unresolved(brief.figures.policy.status)) return ["figures.policy"];
      if (brief.figures.policy.value === "provided_only") {
        return ["figures.policy"];
      }
      if (brief.figures.policy.value === "required") {
        return unresolved(brief.figures.items.status) ? ["figures.items"] : [];
      }
      return [];
    }
    case "presentation":
      return [
        unresolved(brief.template.family.status) ||
        (brief.template.family.value === "custom" &&
          brief.template.customTemplate.status !== "unknown" &&
          resolveSafeCustomTemplatePreset(
            brief.template.customTemplate.value,
          ) === null)
          ? "template.family"
          : null,
        brief.template.family.value === "custom" &&
        unresolved(brief.template.customTemplate.status)
          ? "template.customTemplate"
          : null,
        unresolved(brief.template.pageSize.status) ? "template.pageSize" : null,
        unresolved(brief.template.columns.status) ? "template.columns" : null,
        unresolved(brief.tone.register.status) ? "tone.register" : null,
        unresolved(brief.tone.voice.status) ? "tone.voice" : null,
        unresolved(brief.tone.jargonLevel.status) ? "tone.jargonLevel" : null,
        unresolved(brief.tone.sentenceStyle.status)
          ? "tone.sentenceStyle"
          : null,
      ].filter((path): path is RequirementPath => path !== null);
    case "acceptance":
      return [
        brief.acceptanceCriteria.length === 0 ? "acceptanceCriteria" : null,
        unresolved(brief.constraints.mustInclude.status)
          ? "constraints.mustInclude"
          : null,
        unresolved(brief.constraints.mustExclude.status)
          ? "constraints.mustExclude"
          : null,
        unresolved(brief.constraints.factualUncertaintyPolicy.status)
          ? "constraints.factualUncertaintyPolicy"
          : null,
      ].filter((path): path is RequirementPath => path !== null);
  }
}

const GROUP_ORDER: readonly RequirementGroup[] = [
  "subject",
  "purpose_audience",
  "scope_structure",
  "sources_evidence",
  "mathematics",
  "visuals",
  "presentation",
  "acceptance",
];

export function evaluateBriefCoverage(brief: DocumentBrief): BriefCoverage {
  const deliverable = brief.goal.deliverable.value ?? "article";
  const profile = requirementProfileFor(deliverable);
  const gaps: BriefGap[] = [];

  for (const group of GROUP_ORDER) {
    const applicability = profile[group];
    if (!isRequirementGroupApplicable(brief, group)) continue;
    const missingPaths = pathsForGroup(brief, group);
    if (missingPaths.length === 0) continue;
    gaps.push({
      group,
      impact: applicability === "required" ? "blocking" : "material",
      applicability,
      missingPaths,
      canDelegate: group !== "subject",
    });
  }

  const blockingGaps = gaps.filter((gap) => gap.impact === "blocking");
  const materialGaps = gaps.filter((gap) => gap.impact === "material");
  return {
    complete: gaps.length === 0,
    blockingGaps,
    materialGaps,
    gaps,
  };
}

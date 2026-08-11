import type { z } from "zod";

import { evaluateBriefCoverage } from "@/domain/brief/coverage";
import type { DocumentBrief } from "@/domain/brief/schema";
import { createDocumentBriefDigest } from "./digest";
import { resolvePlanDeterministicEvaluator } from "./deterministic-evaluator";
import {
  ConfirmedDocumentBriefContextSchema,
  DocumentPlanSchema,
  type ConfirmedDocumentBriefContext,
  type DocumentPlan,
} from "./schema";

export type DocumentPlanValidationIssueCode =
  | "schema"
  | "brief_unconfirmed"
  | "brief_unresolved"
  | "brief_mismatch"
  | "brief_requirement"
  | "unsupported_deterministic_criterion";

export type DocumentPlanValidationIssue = {
  code: DocumentPlanValidationIssueCode;
  path: string;
  message: string;
};

export class DocumentPlanValidationError extends Error {
  readonly issues: DocumentPlanValidationIssue[];

  constructor(issues: DocumentPlanValidationIssue[]) {
    super(issues[0]?.message ?? "Document plan validation failed.");
    this.name = "DocumentPlanValidationError";
    this.issues = issues;
  }
}

export function validateDocumentPlan(
  planValue: unknown,
  contextValue: ConfirmedDocumentBriefContext | unknown,
): DocumentPlan {
  const contextResult =
    ConfirmedDocumentBriefContextSchema.safeParse(contextValue);
  const planResult = DocumentPlanSchema.safeParse(planValue);
  const issues: DocumentPlanValidationIssue[] = [];

  if (!contextResult.success) {
    issues.push(
      ...contextResult.error.issues.map((issue) => ({
        code: issue.path.includes("confirmedBriefVersion")
          ? ("brief_unconfirmed" as const)
          : ("schema" as const),
        path: pathOf(issue),
        message: issue.message,
      })),
    );
  }
  if (!planResult.success) {
    issues.push(
      ...planResult.error.issues.map((issue) => ({
        code: "schema" as const,
        path: pathOf(issue),
        message: issue.message,
      })),
    );
  }
  if (!contextResult.success || !planResult.success) {
    throw new DocumentPlanValidationError(issues);
  }

  const context = contextResult.data;
  const plan = planResult.data;
  const brief = context.brief;
  const coverage = evaluateBriefCoverage(brief);
  if (brief.goal.deliverable.value === null) {
    issues.push({
      code: "brief_unresolved",
      path: "brief.goal.deliverable",
      message: "A document deliverable is required before planning.",
    });
  }
  for (const gap of coverage.blockingGaps) {
    for (const path of gap.missingPaths) {
      issues.push({
        code: "brief_unresolved",
        path: `brief.${path}`,
        message: `Required brief condition ${path} is unresolved.`,
      });
    }
  }

  if (plan.documentId !== brief.documentId) {
    issues.push({
      code: "brief_mismatch",
      path: "documentId",
      message: "The plan and confirmed brief belong to different documents.",
    });
  }
  if (plan.briefVersion !== context.briefVersion) {
    issues.push({
      code: "brief_mismatch",
      path: "briefVersion",
      message: "The plan does not target the confirmed brief version.",
    });
  }
  if (plan.briefDigest !== createDocumentBriefDigest(brief)) {
    issues.push({
      code: "brief_mismatch",
      path: "briefDigest",
      message: "The plan brief digest does not match the confirmed brief.",
    });
  }

  validateSectionOrder(plan, brief, issues);
  validateSourceRequirements(plan, brief, issues);
  validateMathematics(plan, brief, issues);
  validateVisuals(plan, brief, issues);
  validateDeterministicEvaluators(plan, issues);
  validateCompletionCoverage(plan, brief, issues);

  if (issues.length > 0) throw new DocumentPlanValidationError(issues);
  return plan;
}

function validateDeterministicEvaluators(
  plan: DocumentPlan,
  issues: DocumentPlanValidationIssue[],
): void {
  const groups = [
    {
      criteria: plan.completionCriteria,
      path: "completionCriteria",
    },
    ...plan.sections.map((section, sectionIndex) => ({
      criteria: section.completionCriteria,
      path: `sections.${sectionIndex}.completionCriteria`,
    })),
  ];

  for (const group of groups) {
    for (const [criterionIndex, criterion] of group.criteria.entries()) {
      if (
        criterion.verification === "deterministic" &&
        resolvePlanDeterministicEvaluator(criterion) === null
      ) {
        issues.push({
          code: "unsupported_deterministic_criterion",
          path: `${group.path}.${criterionIndex}.deterministicEvaluator`,
          message:
            "A deterministic completion criterion requires a supported structured evaluator.",
        });
      }
    }
  }
}

function validateSectionOrder(
  plan: DocumentPlan,
  brief: DocumentBrief,
  issues: DocumentPlanValidationIssue[],
): void {
  const requiredOrder = brief.template.sectionOrder.value ?? [];
  if (requiredOrder.length === 0) return;
  const actualTitles = plan.sections.map((section) => normalize(section.title));
  let previousIndex = -1;
  for (const requiredTitle of requiredOrder) {
    const normalized = normalize(requiredTitle);
    const foundIndex = actualTitles.findIndex(
      (title, index) => index > previousIndex && title === normalized,
    );
    if (foundIndex < 0) {
      issues.push({
        code: "brief_requirement",
        path: "sections",
        message: `Required section is missing or out of order: ${requiredTitle}.`,
      });
      continue;
    }
    previousIndex = foundIndex;
  }
}

function validateSourceRequirements(
  plan: DocumentPlan,
  brief: DocumentBrief,
  issues: DocumentPlanValidationIssue[],
): void {
  const claims = plan.sections.flatMap((section) => section.researchClaims);
  const requirements = plan.sections.flatMap(
    (section) => section.sourceRequirements,
  );
  const policy = brief.sources.policy.value;
  if (policy === "none" && (claims.length > 0 || requirements.length > 0)) {
    issues.push({
      code: "brief_requirement",
      path: "sections",
      message: "The confirmed brief forbids external source research.",
    });
    return;
  }
  if (policy === null || policy === "none") return;

  const plannedMinimum = requirements.reduce(
    (sum, requirement) => sum + requirement.minimumCount,
    0,
  );
  const requiredMinimum = brief.sources.minimumCount.value ?? 0;
  if (plannedMinimum < requiredMinimum) {
    issues.push({
      code: "brief_requirement",
      path: "sections",
      message: `The plan covers ${plannedMinimum} sources but the brief requires ${requiredMinimum}.`,
    });
  }

  const plannedLocators = new Set(
    requirements.flatMap((requirement) => requirement.requiredLocators),
  );
  for (const locator of brief.sources.requiredLocators.value ?? []) {
    if (!plannedLocators.has(locator)) {
      issues.push({
        code: "brief_requirement",
        path: "sections",
        message: `Required source locator is missing from the plan: ${locator}.`,
      });
    }
  }
}

function validateMathematics(
  plan: DocumentPlan,
  brief: DocumentBrief,
  issues: DocumentPlanValidationIssue[],
): void {
  const items = plan.sections.flatMap(
    (section) => section.mathematics.items,
  );
  const policy = brief.equations.policy.value;
  if (policy === "none" && items.length > 0) {
    issues.push({
      code: "brief_requirement",
      path: "sections",
      message: "The confirmed brief excludes mathematical derivations.",
    });
    return;
  }
  if (policy === "required" && items.length === 0) {
    issues.push({
      code: "brief_requirement",
      path: "sections",
      message: "The confirmed brief requires at least one mathematical derivation.",
    });
  }

  const requestedItems = brief.equations.items.value ?? [];
  const requestedBindings = new Set(requestedItems.map(normalize));
  const plannedBindings = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    if (!item.briefItem) continue;
    const key = normalize(item.briefItem);
    if (!requestedBindings.has(key)) {
      issues.push({
        code: "brief_requirement",
        path: `sections.mathematics.items.${index}.briefItem`,
        message: `A math item binds to an unknown brief objective: ${item.briefItem}.`,
      });
    }
    plannedBindings.set(key, (plannedBindings.get(key) ?? 0) + 1);
  }
  for (const [index, requestedItem] of requestedItems.entries()) {
    const bindingCount = plannedBindings.get(normalize(requestedItem)) ?? 0;
    if (bindingCount === 1) continue;
    issues.push({
      code: "brief_requirement",
      path: `sections.mathematics.items.${index}.briefItem`,
      message:
        bindingCount === 0
          ? `A requested mathematical objective is missing from the plan: ${requestedItem}.`
          : `A requested mathematical objective is bound more than once: ${requestedItem}.`,
    });
  }

  const requestedDetail = brief.equations.derivationDetail.value;
  const detailRank = {
    result_only: 0,
    key_steps: 1,
    full_derivation: 2,
  } as const;
  if (requestedDetail) {
    for (const [index, item] of items.entries()) {
      if (detailRank[item.derivationDetail] < detailRank[requestedDetail]) {
        issues.push({
          code: "brief_requirement",
          path: `sections.mathematics.items.${index}.derivationDetail`,
          message: `A math item is less detailed than ${requestedDetail}.`,
        });
      }
    }
  }

  const requestedRigor = brief.equations.proofRigor.value;
  const rigorRank = {
    intuitive: 0,
    standard: 1,
    formal: 2,
  } as const;
  if (requestedRigor) {
    for (const [index, item] of items.entries()) {
      if (
        item.proofRigor === null ||
        rigorRank[item.proofRigor] < rigorRank[requestedRigor]
      ) {
        issues.push({
          code: "brief_requirement",
          path: `sections.mathematics.items.${index}.proofRigor`,
          message: `A math item is less rigorous than ${requestedRigor}.`,
        });
      }
    }
  }

  const notationConvention = brief.equations.notationConvention.value;
  if (notationConvention) {
    const expectedNotation = normalize(notationConvention);
    for (const [index, item] of items.entries()) {
      if (
        !item.notationRequirements.some(
          (requirement) => normalize(requirement) === expectedNotation,
        )
      ) {
        issues.push({
          code: "brief_requirement",
          path: `sections.mathematics.items.${index}.notationRequirements`,
          message: "A math item does not preserve the confirmed notation convention.",
        });
      }
    }
  }

  const numbering = brief.equations.numbering.value;
  if (numbering === "all" && items.some((item) => !item.numbered)) {
    issues.push({
      code: "brief_requirement",
      path: "sections",
      message: "The confirmed brief requires every planned equation to be numbered.",
    });
  }
  if (numbering === "none" && items.some((item) => item.numbered)) {
    issues.push({
      code: "brief_requirement",
      path: "sections",
      message: "The confirmed brief excludes equation numbering.",
    });
  }
  if (
    numbering === "important_only" &&
    items.length > 0 &&
    items.every((item) => !item.numbered)
  ) {
    issues.push({
      code: "brief_requirement",
      path: "sections",
      message: "The confirmed brief requires important planned equations to be numbered.",
    });
  }
}

function validateVisuals(
  plan: DocumentPlan,
  brief: DocumentBrief,
  issues: DocumentPlanValidationIssue[],
): void {
  const visuals = plan.sections.flatMap((section) => section.visuals);
  const policy = brief.figures.policy.value;
  if (policy === "none" && visuals.length > 0) {
    issues.push({
      code: "brief_requirement",
      path: "sections",
      message: "The confirmed brief excludes figures and tables.",
    });
  }
  if (
    (policy === "required" || policy === "provided_only") &&
    visuals.length === 0
  ) {
    issues.push({
      code: "brief_requirement",
      path: "sections",
      message: "The confirmed brief requires at least one visual or table.",
    });
  }
  if (
    policy === "provided_only" &&
    visuals.some((visual) => visual.source !== "provided_asset")
  ) {
    issues.push({
      code: "brief_requirement",
      path: "sections",
      message: "The confirmed brief permits only user-provided visual assets.",
    });
  }

  const plannedBriefItems = new Set(
    visuals.flatMap((visual) =>
      visual.briefItem ? [normalize(visual.briefItem)] : [],
    ),
  );
  for (const [index, requestedVisual] of (
    brief.figures.items.value ?? []
  ).entries()) {
    if (plannedBriefItems.has(normalize(requestedVisual))) continue;
    issues.push({
      code: "brief_requirement",
      path: `sections.visuals.${index}.purpose`,
      message: `A requested visual is missing from the plan: ${requestedVisual}.`,
    });
  }
}

function validateCompletionCoverage(
  plan: DocumentPlan,
  brief: DocumentBrief,
  issues: DocumentPlanValidationIssue[],
): void {
  const criteria = [
    ...plan.completionCriteria,
    ...plan.sections.flatMap((section) => section.completionCriteria),
  ];
  const briefIds = new Set(
    brief.acceptanceCriteria.map((criterion) => criterion.id),
  );
  for (const [index, criterion] of criteria.entries()) {
    if (
      criterion.briefCriterionId !== null &&
      !briefIds.has(criterion.briefCriterionId)
    ) {
      issues.push({
        code: "brief_requirement",
        path: `completionCriteria.${index}.briefCriterionId`,
        message: "A completion criterion references an unknown brief criterion.",
      });
    }
  }
  const covered = new Set(
    criteria.flatMap((criterion) =>
      criterion.briefCriterionId ? [criterion.briefCriterionId] : [],
    ),
  );
  for (const criterion of brief.acceptanceCriteria) {
    if (criterion.severity === "required" && !covered.has(criterion.id)) {
      issues.push({
        code: "brief_requirement",
        path: "completionCriteria",
        message: `Required brief acceptance criterion is not planned: ${criterion.statement}.`,
      });
    }
  }
}

function pathOf(issue: z.core.$ZodIssue): string {
  return issue.path.map(String).join(".");
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

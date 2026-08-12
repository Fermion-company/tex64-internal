import type { DocumentBrief } from "../brief/schema";
import {
  isContainerNode,
  isRenderableFigureNode,
  normalizeDocumentLanguage,
  safeValidateDocument,
  type AlgorithmStepModel,
  type DocumentModel,
  type DocumentNode,
  type InlineContent,
  type ListItemModel,
} from "../document";
import {
  createReviewBriefDigest,
  createReviewDocumentDigest,
  createReviewPlanDigest,
} from "./digest";
import {
  AcceptanceEvaluationInputSchema,
  DeterministicAcceptanceCriterionSchema,
  DeterministicAcceptanceResultSchema,
  type AcceptanceCriterionResult,
  type AcceptanceEvaluationInput,
  type AcceptanceGateIssue,
  type DeterministicAcceptanceCriterion,
  type DeterministicAcceptanceResult,
  type ReviewPlanCompletionCriterion,
  type ReviewPlanProjection,
} from "./schema";

type CriterionBuildResult = {
  criteria: DeterministicAcceptanceCriterion[];
  issues: AcceptanceGateIssue[];
};

type TextAmount = {
  unit: "characters" | "words";
  minimum: number;
  maximum?: number;
};

type CanonicalCitationStyle = "author-year" | "apa7" | "ieee" | "numeric";

function canonicalBriefLayout(
  brief: DocumentBrief,
): DocumentModel["metadata"]["layout"] | null {
  const family = acceptedValue(brief.template.family);
  const custom = acceptedValue(brief.template.customTemplate)
    ?.normalize("NFKC")
    .trim()
    .toLocaleLowerCase();
  const customPresets: Readonly<Record<string, "standard" | "academic" | "business" | "compact">> = {
    standard: "standard",
    general: "standard",
    標準: "standard",
    一般: "standard",
    academic: "academic",
    学術: "academic",
    business: "business",
    ビジネス: "business",
    compact: "compact",
    コンパクト: "compact",
  };
  const preset =
    family === "academic"
      ? "academic"
      : family === "business"
        ? "business"
        : family === "notes" || family === "compact"
          ? "compact"
          : family === "general" || family === "letter"
            ? "standard"
            : family === "custom" && custom
              ? customPresets[custom]
              : null;
  const pageSize = acceptedValue(brief.template.pageSize);
  const columns = acceptedValue(brief.template.columns);
  return preset && pageSize && (columns === 1 || columns === 2)
    ? { preset, pageSize, columns }
    : null;
}

type DocumentIndex = {
  nodeById: Map<string, DocumentNode>;
  structuralOrder: DocumentNode[];
  sectionNodes: Extract<DocumentNode, { type: "section" }>[];
};

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function matchesTitle(
  actual: string,
  expected: string,
  match: "exact_normalized" | "contains_normalized",
): boolean {
  const normalizedActual = normalize(actual);
  const normalizedExpected = normalize(expected);
  return match === "exact_normalized"
    ? normalizedActual === normalizedExpected
    : normalizedActual.includes(normalizedExpected);
}

function acceptedValue<T>(requirement: {
  status: string;
  value: T | null;
}): T | null {
  return requirement.status === "provided" || requirement.status === "delegated"
    ? requirement.value
    : null;
}

function parseTargetLength(value: string): TextAmount | null {
  const compact = value
    .normalize("NFKC")
    .replace(/,/gu, "")
    .replace(/\s+/gu, "")
    .toLocaleLowerCase();
  const unit = /(?:文字|字|characters|character)$/u.test(compact)
    ? "characters"
    : /(?:単語|語|words|word)$/u.test(compact)
      ? "words"
      : null;
  if (!unit) return null;

  const withoutUnit = compact.replace(
    /(?:文字|字|characters|character|単語|語|words|word)$/u,
    "",
  );
  const range = withoutUnit.match(/^(\d+)(?:-|–|—|~|〜|～|から)(\d+)$/u);
  if (range) {
    const minimum = Number(range[1]);
    const maximum = Number(range[2]);
    return minimum <= maximum ? { unit, minimum, maximum } : null;
  }

  const atLeast = withoutUnit.match(/^(\d+)(?:以上|over|ormore)$/u);
  if (atLeast) return { unit, minimum: Number(atLeast[1]) };

  const atMost = withoutUnit.match(/^(\d+)(?:以下|以内|under|orless)$/u);
  if (atMost) {
    return { unit, minimum: 0, maximum: Number(atMost[1]) };
  }

  const exact = withoutUnit.match(/^(\d+)$/u);
  if (!exact) return null;
  const amount = Number(exact[1]);
  return { unit, minimum: amount, maximum: amount };
}

function normalizeCitationStyle(value: string): CanonicalCitationStyle | null {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/gu, "-");
  if (
    ["author-year", "authoryear", "著者年", "著者年方式", "harvard", "ハーバード"].includes(
      normalized,
    )
  ) {
    return "author-year";
  }
  if (["apa", "apa7", "apa-7", "apa第7版", "apa-第7版"].includes(normalized)) {
    return "apa7";
  }
  if (normalized === "ieee") return "ieee";
  if (
    ["numeric", "numbered", "番号", "番号方式", "数値", "数値方式"].includes(
      normalized,
    )
  ) {
    return "numeric";
  }
  return null;
}

type RequiredStructuredNodeType =
  | "theorem"
  | "proof"
  | "algorithm"
  | "codeBlock"
  | "appendix";

function mentionedStructuredNodeTypes(value: string): RequiredStructuredNodeType[] {
  const normalized = normalize(value);
  const types: RequiredStructuredNodeType[] = [];
  if (/(?:^|\s)(?:appendix|appendices|supplement)(?:$|\s)|付録|補遺/iu.test(normalized)) {
    types.push("appendix");
  }
  if (/^(?:algorithm|アルゴリズム|pseudocode|pseudo-code|擬似コード|疑似コード)$|擬似コード|疑似コード|アルゴリズム(?:手順|記述|一覧)/iu.test(normalized)) {
    types.push("algorithm");
  }
  if (/source\s*code|code\s*(?:block|listing|example)|コード(?:ブロック|リスト|例|掲載)/iu.test(normalized)) {
    types.push("codeBlock");
  }
  if (/^(?:proof|証明)$|(?:mathematical\s*)?proof|証明(?:を|の|付き|本文|掲載|記載|提示)/iu.test(normalized)) {
    types.push("proof");
  }
  if (/^(?:theorem|定理)$|theorem|定理(?:を|の|付き|本文|掲載|記載|提示)/iu.test(normalized)) {
    types.push("theorem");
  }
  return types;
}

function planDerivedCriteria(
  plan: ReviewPlanProjection,
): DeterministicAcceptanceCriterion[] {
  const criteria: DeterministicAcceptanceCriterion[] = [];

  for (const section of plan.sections) {
    criteria.push({
      id: `plan:section:${section.id}:present`,
      label: `Required section: ${section.title}`,
      severity: "required",
      provenance: { kind: "plan_section", sectionId: section.id },
      kind: "required_section",
      title: section.title,
      match: "exact_normalized",
    });

    // Page targets remain in the plan projection and are checked against the
    // compiled PDF. They are intentionally not a pre-render acceptance error.
    if (section.expectedAmount.unit !== "pages") {
      criteria.push({
        id: `plan:section:${section.id}:length`,
        label: `Expected length for ${section.title}`,
        severity: "required",
        provenance: { kind: "plan_section", sectionId: section.id },
        kind: "text_length",
        scope: {
          kind: "section",
          title: section.title,
          match: "exact_normalized",
        },
        unit: section.expectedAmount.unit,
        minimum: section.expectedAmount.minimum,
        maximum: section.expectedAmount.maximum,
      });
    }

    for (const mathItem of section.mathItems) {
      criteria.push({
        id: `plan:math:${mathItem.id}`,
        label: `Planned mathematical derivation: ${mathItem.id}`,
        severity: "required",
        provenance: { kind: "plan_section", sectionId: section.id },
        kind: "planned_math",
        planItemId: mathItem.id,
        minimumExpressionSteps: mathItem.minimumExpressionSteps,
        numbered: mathItem.numbered,
      });
    }
    for (const visual of section.visuals) {
      criteria.push({
        id: `plan:visual:${visual.id}`,
        label: `Planned visual: ${visual.id}`,
        severity: "required",
        provenance: { kind: "plan_section", sectionId: section.id },
        kind: "planned_visual",
        planItemId: visual.id,
        visualKind: visual.kind,
      });
    }
  }

  criteria.push({
    id: `plan:${plan.id}:section-order`,
    label: "Planned section order",
    severity: "required",
    provenance: { kind: "system", rule: "plan-section-order" },
    kind: "section_order",
    titles: plan.sections.map((section) => section.title),
  });

  const figureCount = plan.sections.reduce(
    (total, section) => total + section.figureCount,
    0,
  );
  const tableCount = plan.sections.reduce(
    (total, section) => total + section.tableCount,
    0,
  );
  const equationCount = plan.sections.reduce(
    (total, section) => total + section.equationCount,
    0,
  );
  const minimumSourceCount = plan.sections.reduce(
    (total, section) => total + section.minimumSourceCount,
    0,
  );

  if (figureCount > 0) {
    criteria.push({
      id: `plan:${plan.id}:figures`,
      label: "Planned figures",
      severity: "required",
      provenance: { kind: "system", rule: "planned-figure-count" },
      kind: "figure_count",
      minimum: figureCount,
    });
  }
  if (tableCount > 0) {
    criteria.push({
      id: `plan:${plan.id}:tables`,
      label: "Planned tables",
      severity: "required",
      provenance: { kind: "system", rule: "planned-table-count" },
      kind: "table_count",
      minimum: tableCount,
    });
  }
  if (equationCount > 0) {
    criteria.push({
      id: `plan:${plan.id}:equations`,
      label: "Planned equations",
      severity: "required",
      provenance: { kind: "system", rule: "planned-equation-count" },
      kind: "equation_count",
      minimum: equationCount,
    });
  }
  if (minimumSourceCount > 0) {
    criteria.push({
      id: `plan:${plan.id}:sources`,
      label: "Planned source minimum",
      severity: "required",
      provenance: { kind: "system", rule: "planned-source-count" },
      kind: "source_count",
      minimum: minimumSourceCount,
    });
  }

  return criteria;
}

function briefDerivedCriteria(
  brief: DocumentBrief,
  plan: ReviewPlanProjection,
  issues: AcceptanceGateIssue[],
): DeterministicAcceptanceCriterion[] {
  const criteria: DeterministicAcceptanceCriterion[] = [];
  const documentType = acceptedValue(brief.goal.deliverable);
  if (documentType) {
    criteria.push({
      id: "brief:goal.deliverable",
      label: "Confirmed document type",
      severity: "required",
      provenance: { kind: "system", rule: "confirmed-document-type" },
      kind: "document_type",
      documentType,
    });
  }
  const languageValue = acceptedValue(brief.scope.language);
  const language = languageValue
    ? normalizeDocumentLanguage(languageValue)
    : null;
  if (language) {
    criteria.push({
      id: "brief:scope.language",
      label: "Confirmed document language",
      severity: "required",
      provenance: { kind: "brief_requirement", path: "scope.language" },
      kind: "document_language",
      language,
    });
  } else if (languageValue) {
    issues.push({
      code: "unsupported_language",
      path: "brief.scope.language",
      message: "The confirmed language cannot be checked exactly.",
    });
  }
  const layout = canonicalBriefLayout(brief);
  if (layout) {
    criteria.push({
      id: "brief:template.layout",
      label: "Confirmed page layout",
      severity: "required",
      provenance: { kind: "brief_requirement", path: "template.family" },
      kind: "document_layout",
      layout,
    });
  }
  const writingStyle = {
    register: acceptedValue(brief.tone.register),
    voice: acceptedValue(brief.tone.voice),
    jargonLevel: acceptedValue(brief.tone.jargonLevel),
    sentenceStyle: acceptedValue(brief.tone.sentenceStyle),
  };
  if (
    writingStyle.register &&
    writingStyle.voice &&
    writingStyle.jargonLevel &&
    writingStyle.sentenceStyle
  ) {
    criteria.push({
      id: "brief:tone",
      label: "Confirmed writing style",
      severity: "required",
      provenance: { kind: "brief_requirement", path: "tone.register" },
      kind: "writing_style",
      style: {
        register: writingStyle.register,
        voice: writingStyle.voice,
        jargonLevel: writingStyle.jargonLevel,
        sentenceStyle: writingStyle.sentenceStyle,
      },
    });
  }
  const sectionOrder = acceptedValue(brief.template.sectionOrder) ?? [];

  const requiredNodeTypePaths = new Map<
    RequiredStructuredNodeType,
    "template.sectionOrder" | "scope.includedTopics" | "constraints.mustInclude"
  >();
  for (const source of [
    { path: "template.sectionOrder" as const, values: sectionOrder },
    {
      path: "scope.includedTopics" as const,
      values: acceptedValue(brief.scope.includedTopics) ?? [],
    },
    {
      path: "constraints.mustInclude" as const,
      values: acceptedValue(brief.constraints.mustInclude) ?? [],
    },
  ]) {
    for (const nodeType of source.values.flatMap(mentionedStructuredNodeTypes)) {
      requiredNodeTypePaths.set(nodeType, source.path);
    }
  }
  const excludedNodeTypes = new Set<RequiredStructuredNodeType>(
    (acceptedValue(brief.constraints.mustExclude) ?? []).flatMap(
      mentionedStructuredNodeTypes,
    ),
  );
  for (const [nodeType, path] of requiredNodeTypePaths) {
    criteria.push({
      id: `brief:structured:${nodeType}:required`,
      label: `Required structured content: ${nodeType}`,
      severity: "required",
      provenance: { kind: "brief_requirement", path },
      kind: "node_type_count",
      nodeType,
      minimum: 1,
    });
  }
  for (const nodeType of excludedNodeTypes) {
    criteria.push({
      id: `brief:structured:${nodeType}:excluded`,
      label: `Excluded structured content: ${nodeType}`,
      severity: "required",
      provenance: { kind: "brief_requirement", path: "constraints.mustExclude" },
      kind: "node_type_count",
      nodeType,
      minimum: 0,
      maximum: 0,
    });
  }

  sectionOrder.forEach((title, index) => {
    criteria.push({
      id: `brief:template.sectionOrder:${index}`,
      label: `Brief-required section: ${title}`,
      severity: "required",
      provenance: {
        kind: "brief_requirement",
        path: "template.sectionOrder",
      },
      kind: "required_section",
      title,
      match: "exact_normalized",
    });
  });
  if (sectionOrder.length > 0) {
    criteria.push({
      id: "brief:template.sectionOrder:order",
      label: "Brief-required section order",
      severity: "required",
      provenance: {
        kind: "brief_requirement",
        path: "template.sectionOrder",
      },
      kind: "section_order",
      titles: sectionOrder,
    });
  }

  const targetLength = acceptedValue(brief.scope.targetLength);
  if (targetLength) {
    const parsed = parseTargetLength(targetLength);
    const renderedPageTarget = /(?:ページ|頁|pages?)/iu.test(targetLength);
    if (!parsed && !renderedPageTarget) {
      issues.push({
        code: "unsupported_target_length",
        path: "brief.scope.targetLength",
        message: `Target length cannot be deterministically parsed: ${targetLength}.`,
      });
    } else if (parsed) {
      criteria.push({
        id: "brief:scope.targetLength",
        label: "Brief target length",
        severity: "required",
        provenance: {
          kind: "brief_requirement",
          path: "scope.targetLength",
        },
        kind: "text_length",
        scope: { kind: "document" },
        unit: parsed.unit,
        minimum: parsed.minimum,
        ...(parsed.maximum === undefined
          ? {}
          : { maximum: parsed.maximum }),
      });
    }
  }

  const figurePolicy = acceptedValue(brief.figures.policy);
  const requestedVisuals = acceptedValue(brief.figures.items)?.length ?? 0;
  if (figurePolicy === "none") {
    criteria.push({
      id: "brief:figures.policy:none",
      label: "No figures or tables",
      severity: "required",
      provenance: { kind: "brief_requirement", path: "figures.policy" },
      kind: "visual_count",
      minimum: 0,
      maximum: 0,
    });
  } else if (figurePolicy === "required" || figurePolicy === "provided_only") {
    criteria.push({
      id: "brief:figures.policy:required",
      label: "Required figures or tables",
      severity: "required",
      provenance: { kind: "brief_requirement", path: "figures.policy" },
      kind: "visual_count",
      minimum: Math.max(1, requestedVisuals),
    });
  }

  const equationPolicy = acceptedValue(brief.equations.policy);
  const requestedEquationCount =
    acceptedValue(brief.equations.items)?.length ?? 0;
  if (equationPolicy === "none") {
    criteria.push({
      id: "brief:equations.policy:none",
      label: "No equations",
      severity: "required",
      provenance: { kind: "brief_requirement", path: "equations.policy" },
      kind: "equation_count",
      minimum: 0,
      maximum: 0,
    });
  } else if (equationPolicy === "required" || requestedEquationCount > 0) {
    criteria.push({
      id: "brief:equations.policy:required",
      label: "Required equations",
      severity: "required",
      provenance: { kind: "brief_requirement", path: "equations.policy" },
      kind: "equation_count",
      minimum: Math.max(1, requestedEquationCount),
    });
  }

  const sourcePolicy = acceptedValue(brief.sources.policy);
  const minimumSourceCount = acceptedValue(brief.sources.minimumCount) ?? 0;
  if (sourcePolicy === "none") {
    criteria.push({
      id: "brief:sources.policy:none",
      label: "No external sources",
      severity: "required",
      provenance: { kind: "brief_requirement", path: "sources.policy" },
      kind: "source_count",
      minimum: 0,
      maximum: 0,
    });
  } else if (minimumSourceCount > 0) {
    criteria.push({
      id: "brief:sources.minimumCount",
      label: "Minimum source count",
      severity: "required",
      provenance: {
        kind: "brief_requirement",
        path: "sources.minimumCount",
      },
      kind: "source_count",
      minimum: minimumSourceCount,
    });
  }

  const requestedCitationStyle = acceptedValue(brief.sources.citationStyle);
  if (sourcePolicy !== "none" && requestedCitationStyle) {
    const style = normalizeCitationStyle(requestedCitationStyle);
    if (!style) {
      issues.push({
        code: "unsupported_citation_style",
        path: "brief.sources.citationStyle",
        message: "The confirmed citation style cannot be checked exactly.",
      });
    } else {
      criteria.push({
        id: "brief:sources.citationStyle",
        label: "Confirmed citation style",
        severity: "required",
        provenance: {
          kind: "brief_requirement",
          path: "sources.citationStyle",
        },
        kind: "citation_style",
        style,
      });
    }
  }

  const plannedSourceCount = plan.sections.reduce(
    (total, section) => total + section.minimumSourceCount,
    0,
  );
  criteria.push({
    id: "system:reference-integrity",
    label: "Reference integrity",
    severity: "required",
    provenance: { kind: "system", rule: "reference-integrity" },
    kind: "reference_integrity",
    requireBibliography:
      plannedSourceCount > 0 ||
      (sourcePolicy !== null && sourcePolicy !== "none"),
    requireEverySourceCited: true,
  });

  return criteria;
}

export function buildDeterministicAcceptanceCriteria(input: {
  brief: DocumentBrief;
  plan: ReviewPlanProjection;
  additionalCriteria?: readonly DeterministicAcceptanceCriterion[];
}): CriterionBuildResult {
  const issues: AcceptanceGateIssue[] = [];
  const derivedCandidates = [
    ...planDerivedCriteria(input.plan),
    ...briefDerivedCriteria(input.brief, input.plan, issues),
  ];
  const intrinsicallyMappedPlanCriteria = new Set<string>();
  const evaluatorCandidates: DeterministicAcceptanceCriterion[] = [];

  for (const criterion of input.plan.completionCriteria) {
    if (criterion.verification !== "deterministic") continue;
    const evaluator = criterion.deterministicEvaluator;
    if (evaluator?.kind === "derived") {
      const allRulesPresent = evaluator.rules.every((rule) =>
        derivedRuleIsPresent(rule, input.plan, derivedCandidates),
      );
      if (allRulesPresent) intrinsicallyMappedPlanCriteria.add(criterion.id);
      continue;
    }
    const candidate = materializePlanEvaluator(criterion);
    if (candidate) evaluatorCandidates.push(candidate);
  }

  const candidates = [
    ...derivedCandidates,
    ...evaluatorCandidates,
    ...(input.additionalCriteria ?? []),
  ];
  const criteria: DeterministicAcceptanceCriterion[] = [];
  const criterionIds = new Set<string>();

  for (const candidate of candidates) {
    const criterion = DeterministicAcceptanceCriterionSchema.parse(candidate);
    if (criterionIds.has(criterion.id)) {
      issues.push({
        code: "duplicate_criterion",
        path: "additionalCriteria",
        message: `Acceptance criterion ID is duplicated: ${criterion.id}.`,
      });
      continue;
    }
    criterionIds.add(criterion.id);
    criteria.push(criterion);
  }

  const mappedPlanCriteria = new Set([
    ...intrinsicallyMappedPlanCriteria,
    ...criteria.flatMap((criterion) =>
      criterion.provenance.kind === "plan_criterion"
        ? [criterion.provenance.criterionId]
        : [],
    ),
  ]);
  const mappedBriefCriteria = new Set(
    criteria.flatMap((criterion) =>
      criterion.provenance.kind === "brief_criterion"
        ? [criterion.provenance.criterionId]
        : [],
    ),
  );

  for (const criterion of input.plan.completionCriteria) {
    if (
      criterion.verification === "deterministic" &&
      !mappedPlanCriteria.has(criterion.id)
    ) {
      issues.push({
        code: "unmapped_plan_criterion",
        path: `plan.completionCriteria.${criterion.id}`,
        message: `Deterministic plan criterion lacks a structured evaluator: ${criterion.statement}.`,
      });
    }
    if (
      criterion.briefCriterionId &&
      mappedPlanCriteria.has(criterion.id)
    ) {
      mappedBriefCriteria.add(criterion.briefCriterionId);
    }
  }

  const plannedBriefCriteria = new Set(
    input.plan.completionCriteria.flatMap((criterion) =>
      criterion.briefCriterionId ? [criterion.briefCriterionId] : [],
    ),
  );
  for (const criterion of input.brief.acceptanceCriteria) {
    if (
      criterion.severity === "required" &&
      !plannedBriefCriteria.has(criterion.id)
    ) {
      issues.push({
        code: "unmapped_brief_criterion",
        path: `brief.acceptanceCriteria.${criterion.id}`,
        message: `Required brief criterion is absent from the plan: ${criterion.statement}.`,
      });
    } else if (
      criterion.kind === "deterministic" &&
      !mappedBriefCriteria.has(criterion.id)
    ) {
      issues.push({
        code: "unmapped_brief_criterion",
        path: `brief.acceptanceCriteria.${criterion.id}`,
        message: `Deterministic brief criterion lacks a structured evaluator: ${criterion.statement}.`,
      });
    }
  }

  if (!criteria.some((criterion) => criterion.severity === "required")) {
    issues.push({
      code: "no_required_criteria",
      path: "criteria",
      message: "At least one required deterministic criterion is necessary.",
    });
  }

  return { criteria, issues };
}

function derivedRuleIsPresent(
  rule: "section_order" | "reference_integrity",
  plan: ReviewPlanProjection,
  criteria: readonly DeterministicAcceptanceCriterion[],
): boolean {
  const criterionId =
    rule === "section_order"
      ? `plan:${plan.id}:section-order`
      : "system:reference-integrity";
  return criteria.some((criterion) => criterion.id === criterionId);
}

function materializePlanEvaluator(
  criterion: ReviewPlanCompletionCriterion,
): DeterministicAcceptanceCriterion | null {
  const evaluator = criterion.deterministicEvaluator;
  if (!evaluator || evaluator.kind === "derived") return null;

  return DeterministicAcceptanceCriterionSchema.parse({
    id: `plan:criterion:${criterion.id}`,
    label: criterion.statement,
    severity: criterion.severity,
    provenance: {
      kind: "plan_criterion",
      criterionId: criterion.id,
    },
    ...evaluator,
  });
}

function inlineText(content: InlineContent): string {
  return content
    .map((inline) => {
      switch (inline.type) {
        case "text":
          return inline.text;
        case "hardBreak":
          return "\n";
        case "citationRef":
        case "footnoteRef":
        case "crossRef":
          return "";
      }
    })
    .join("");
}

function listText(items: ListItemModel[]): string {
  return items
    .flatMap((item) => [inlineText(item.content), listText(item.children)])
    .filter(Boolean)
    .join("\n");
}

function algorithmText(items: AlgorithmStepModel[]): string {
  return items
    .flatMap((item) => [inlineText(item.content), algorithmText(item.children)])
    .filter(Boolean)
    .join("\n");
}

function nodeText(node: DocumentNode): string {
  switch (node.type) {
    case "section":
      return inlineText(node.title);
    case "paragraph":
    case "heading":
      return inlineText(node.content);
    case "list":
      return listText(node.items);
    case "equation":
      return node.description ? inlineText(node.description) : "";
    case "figure":
      return inlineText(node.caption);
    case "table":
      return [
        ...(node.caption ? [inlineText(node.caption)] : []),
        ...node.columns.map((column) => inlineText(column.header)),
        ...node.rows.flatMap((row) =>
          row.cells.map((cell) => inlineText(cell.content)),
        ),
      ].join("\n");
    case "callout":
      return [
        ...(node.title ? [inlineText(node.title)] : []),
        inlineText(node.content),
      ].join("\n");
    case "theorem":
    case "proof":
      return node.title ? inlineText(node.title) : "";
    case "algorithm":
      return [
        inlineText(node.title),
        ...(node.description ? [inlineText(node.description)] : []),
        ...(node.inputs ? [inlineText(node.inputs)] : []),
        ...(node.outputs ? [inlineText(node.outputs)] : []),
        algorithmText(node.steps),
      ]
        .filter(Boolean)
        .join("\n");
    case "codeBlock":
      return [
        ...(node.caption ? [inlineText(node.caption)] : []),
        node.code,
      ]
        .filter(Boolean)
        .join("\n");
    case "appendix":
      return inlineText(node.title);
    case "bibliography":
      return node.title ? inlineText(node.title) : "";
    case "footnote":
      return inlineText(node.content);
    case "citation":
      return [
        node.authors.join(", "),
        node.title,
        node.publication ?? "",
        node.year,
      ]
        .filter(Boolean)
        .join(" ");
    case "pageBreak":
      return "";
  }
}

function buildDocumentIndex(document: DocumentModel): DocumentIndex {
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  const structuralOrder: DocumentNode[] = [];
  const visited = new Set<string>();

  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    const node = nodeById.get(nodeId);
    if (!node) return;
    visited.add(nodeId);
    structuralOrder.push(node);
    if (isContainerNode(node)) {
      node.children.forEach(visit);
    }
  };
  document.root.forEach(visit);

  return {
    nodeById,
    structuralOrder,
    sectionNodes: structuralOrder.filter(
      (node): node is Extract<DocumentNode, { type: "section" }> =>
        node.type === "section",
    ),
  };
}

function sectionSubtree(
  section: Extract<DocumentNode, { type: "section" }>,
  index: DocumentIndex,
): DocumentNode[] {
  const nodes: DocumentNode[] = [];
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    const node = index.nodeById.get(nodeId);
    if (!node) return;
    visited.add(nodeId);
    nodes.push(node);
    if (isContainerNode(node)) node.children.forEach(visit);
  };
  visit(section.id);
  return nodes;
}

function bodyNodes(index: DocumentIndex): DocumentNode[] {
  return index.structuralOrder.filter(
    (node) => node.type !== "bibliography" && node.type !== "pageBreak",
  );
}

function textAmount(
  nodes: readonly DocumentNode[],
  unit: "characters" | "words" | "paragraphs",
): number {
  if (unit === "paragraphs") {
    return nodes.filter((node) => node.type === "paragraph").length;
  }
  const text = nodes.map(nodeText).filter(Boolean).join("\n").trim();
  if (unit === "characters") {
    return Array.from(text.replace(/\s/gu, "")).length;
  }
  return text.length === 0 ? 0 : text.split(/\s+/gu).filter(Boolean).length;
}

function isInRange(
  observed: number,
  minimum: number,
  maximum?: number,
): boolean {
  return observed >= minimum && (maximum === undefined || observed <= maximum);
}

function countExpected(criterion: {
  minimum: number;
  maximum?: number;
}): { minimum: number; maximum: number | null } {
  return {
    minimum: criterion.minimum,
    maximum: criterion.maximum ?? null,
  };
}

function inlineGroups(node: DocumentNode): InlineContent[] {
  switch (node.type) {
    case "section":
      return [node.title];
    case "paragraph":
    case "heading":
      return [node.content];
    case "list": {
      const groups: InlineContent[] = [];
      const visit = (items: ListItemModel[]) => {
        for (const item of items) {
          groups.push(item.content);
          visit(item.children);
        }
      };
      visit(node.items);
      return groups;
    }
    case "equation":
      return node.description ? [node.description] : [];
    case "figure":
      return [node.caption];
    case "table":
      return [
        ...(node.caption ? [node.caption] : []),
        ...node.columns.map((column) => column.header),
        ...node.rows.flatMap((row) => row.cells.map((cell) => cell.content)),
      ];
    case "callout":
      return [...(node.title ? [node.title] : []), node.content];
    case "theorem":
    case "proof":
      return node.title ? [node.title] : [];
    case "algorithm": {
      const groups: InlineContent[] = [node.title];
      if (node.description) groups.push(node.description);
      if (node.inputs) groups.push(node.inputs);
      if (node.outputs) groups.push(node.outputs);
      const visit = (steps: AlgorithmStepModel[]): void => {
        for (const step of steps) {
          groups.push(step.content);
          visit(step.children);
        }
      };
      visit(node.steps);
      return groups;
    }
    case "codeBlock":
      return node.caption ? [node.caption] : [];
    case "appendix":
      return [node.title];
    case "bibliography":
      return node.title ? [node.title] : [];
    case "footnote":
      return [node.content];
    case "pageBreak":
    case "citation":
      return [];
  }
}

function evaluateReferenceIntegrity(
  criterion: Extract<
    DeterministicAcceptanceCriterion,
    { kind: "reference_integrity" }
  >,
  document: DocumentModel,
  index: DocumentIndex,
): AcceptanceCriterionResult {
  const citationIds = new Set(
    document.nodes.flatMap((node) => (node.type === "citation" ? [node.id] : [])),
  );
  const citationNodes = document.nodes.filter(
    (node): node is Extract<DocumentNode, { type: "citation" }> =>
      node.type === "citation",
  );
  const missingSourceIdCount = citationNodes.filter(
    (node) => !node.sourceId,
  ).length;
  const citedIds = new Set<string>();
  const referenceNodeIds = new Set<string>();
  let invalidReferenceCount = 0;

  for (const node of document.nodes) {
    for (const group of inlineGroups(node)) {
      for (const inline of group) {
        if (inline.type !== "citationRef") continue;
        citedIds.add(inline.citationId);
        referenceNodeIds.add(node.id);
        if (!citationIds.has(inline.citationId)) invalidReferenceCount += 1;
      }
    }
  }

  const bibliographyNodes = document.nodes.filter(
    (node): node is Extract<DocumentNode, { type: "bibliography" }> =>
      node.type === "bibliography",
  );
  const listedIds = new Set(
    bibliographyNodes.flatMap((node) => node.citationIds),
  );
  const unlistedCitationCount = [...citedIds].filter(
    (citationId) => !listedIds.has(citationId),
  ).length;
  const uncitedSourceCount = [...citationIds].filter(
    (citationId) => !citedIds.has(citationId),
  ).length;
  const missingBibliography =
    criterion.requireBibliography && bibliographyNodes.length === 0;
  const passed =
    invalidReferenceCount === 0 &&
    unlistedCitationCount === 0 &&
    !missingBibliography &&
    missingSourceIdCount === 0 &&
    (!criterion.requireEverySourceCited || uncitedSourceCount === 0);

  return {
    criterionId: criterion.id,
    kind: criterion.kind,
    severity: criterion.severity,
    status: passed ? "passed" : "failed",
    expected: {
      requireBibliography: criterion.requireBibliography,
      requireEverySourceCited: criterion.requireEverySourceCited,
      invalidReferenceCount: 0,
      unlistedCitationCount: 0,
    },
    observed: {
      sourceCount: citationIds.size,
      citationReferenceCount: citedIds.size,
      bibliographyCount: bibliographyNodes.length,
      invalidReferenceCount,
      unlistedCitationCount,
      uncitedSourceCount,
      missingSourceIdCount,
    },
    evidenceNodeIds: [
      ...new Set([
        ...referenceNodeIds,
        ...bibliographyNodes.map((node) => node.id),
        ...[...citationIds].filter((id) => index.nodeById.has(id)),
      ]),
    ],
    message: passed
      ? "All source references satisfy the configured integrity policy."
      : "Source references do not satisfy the configured integrity policy.",
  };
}

function notEvaluableResult(
  criterion: DeterministicAcceptanceCriterion,
  message: string,
): AcceptanceCriterionResult {
  return {
    criterionId: criterion.id,
    kind: criterion.kind,
    severity: criterion.severity,
    status: "not_evaluable",
    expected:
      "minimum" in criterion
        ? countExpected(criterion)
        : criterion.kind === "required_section"
          ? { title: criterion.title, match: criterion.match }
        : criterion.kind === "section_order"
            ? criterion.titles
            : criterion.kind === "citation_style"
              ? { style: criterion.style }
            : criterion.kind === "document_type"
              ? { documentType: criterion.documentType }
            : criterion.kind === "document_language"
              ? { language: criterion.language }
            : criterion.kind === "document_layout"
              ? criterion.layout
            : criterion.kind === "writing_style"
              ? criterion.style
            : criterion.kind === "planned_math"
              ? {
                  planItemId: criterion.planItemId,
                  minimumExpressionSteps: criterion.minimumExpressionSteps,
                  numbered: criterion.numbered,
                }
            : criterion.kind === "planned_visual"
              ? {
                  planItemId: criterion.planItemId,
                  visualKind: criterion.visualKind,
                }
            : {
                requireBibliography: criterion.requireBibliography,
                requireEverySourceCited: criterion.requireEverySourceCited,
              },
    observed: null,
    evidenceNodeIds: [],
    message,
  };
}

function evaluateCriterion(
  criterion: DeterministicAcceptanceCriterion,
  document: DocumentModel,
  index: DocumentIndex,
): AcceptanceCriterionResult {
  switch (criterion.kind) {
    case "required_section": {
      const matches = index.sectionNodes.filter((section) =>
        matchesTitle(nodeText(section), criterion.title, criterion.match),
      );
      const passed = matches.length > 0;
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        severity: criterion.severity,
        status: passed ? "passed" : "failed",
        expected: { title: criterion.title, match: criterion.match },
        observed: matches.map((section) => nodeText(section)),
        evidenceNodeIds: matches.map((section) => section.id),
        message: passed
          ? `Required section is present: ${criterion.title}.`
          : `Required section is missing: ${criterion.title}.`,
      };
    }

    case "section_order": {
      const actualTitles = index.sectionNodes.map(nodeText);
      const matchedIds: string[] = [];
      let previousIndex = -1;
      let passed = true;
      for (const expectedTitle of criterion.titles) {
        const foundIndex = actualTitles.findIndex(
          (title, indexValue) =>
            indexValue > previousIndex &&
            matchesTitle(title, expectedTitle, "exact_normalized"),
        );
        if (foundIndex < 0) {
          passed = false;
          break;
        }
        previousIndex = foundIndex;
        const section = index.sectionNodes[foundIndex];
        if (section) matchedIds.push(section.id);
      }
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        severity: criterion.severity,
        status: passed ? "passed" : "failed",
        expected: criterion.titles,
        observed: actualTitles,
        evidenceNodeIds: matchedIds,
        message: passed
          ? "Required sections appear in order."
          : "Required sections are missing or out of order.",
      };
    }

    case "text_length": {
      let nodes: DocumentNode[];
      if (criterion.scope.kind === "document") {
        nodes = bodyNodes(index);
      } else {
        const sectionScope = criterion.scope;
        const section = index.sectionNodes.find((candidate) =>
          matchesTitle(
            nodeText(candidate),
            sectionScope.title,
            sectionScope.match,
          ),
        );
        if (!section) {
          return notEvaluableResult(
            criterion,
            `Cannot measure a missing section: ${sectionScope.title}.`,
          );
        }
        nodes = sectionSubtree(section, index).filter(
          (node) => node.type !== "bibliography" && node.type !== "pageBreak",
        );
      }
      const observed = textAmount(nodes, criterion.unit);
      const passed = isInRange(
        observed,
        criterion.minimum,
        criterion.maximum,
      );
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        severity: criterion.severity,
        status: passed ? "passed" : "failed",
        expected: { ...countExpected(criterion), unit: criterion.unit },
        observed,
        evidenceNodeIds: nodes.map((node) => node.id),
        message: passed
          ? `Text length is ${observed} ${criterion.unit}.`
          : `Text length ${observed} ${criterion.unit} is outside the required range.`,
      };
    }

    case "visual_count":
    case "figure_count":
    case "table_count":
    case "equation_count":
    case "source_count": {
      const nodeTypes =
        criterion.kind === "visual_count"
          ? new Set(["figure", "table"])
          : criterion.kind === "figure_count"
            ? new Set(["figure"])
            : criterion.kind === "table_count"
              ? new Set(["table"])
              : criterion.kind === "equation_count"
                ? new Set(["equation"])
                : new Set(["citation"]);
      const nodes = document.nodes.filter(
        (node) =>
          nodeTypes.has(node.type) &&
          (node.type !== "figure" || isRenderableFigureNode(node)),
      );
      const citationNodes = nodes.filter(
        (node): node is Extract<DocumentNode, { type: "citation" }> =>
          node.type === "citation",
      );
      const sourceIds = new Set(
        citationNodes.flatMap((node) => (node.sourceId ? [node.sourceId] : [])),
      );
      const missingSourceIdCount = citationNodes.filter(
        (node) => !node.sourceId,
      ).length;
      const observed =
        criterion.kind === "source_count" ? sourceIds.size : nodes.length;
      const passed =
        missingSourceIdCount === 0 &&
        isInRange(observed, criterion.minimum, criterion.maximum);
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        severity: criterion.severity,
        status: passed ? "passed" : "failed",
        expected: countExpected(criterion),
        observed:
          criterion.kind === "source_count"
            ? {
                uniqueSourceCount: observed,
                citationRecordCount: citationNodes.length,
                missingSourceIdCount,
              }
            : observed,
        evidenceNodeIds: nodes.map((node) => node.id),
        message: passed
          ? `${criterion.kind} is ${observed}.`
          : `${criterion.kind} count ${observed} is outside the required range or lacks verified source identity.`,
      };
    }

    case "citation_style": {
      const observed = document.metadata.citationStyle?.style ?? null;
      const passed = observed === criterion.style;
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        severity: criterion.severity,
        status: passed ? "passed" : "failed",
        expected: { style: criterion.style },
        observed: { style: observed },
        evidenceNodeIds: [],
        message: passed
          ? "The document uses the confirmed citation style."
          : "The document citation style does not match the confirmed choice.",
      };
    }

    case "document_type": {
      const observed = document.metadata.documentType;
      const passed = observed === criterion.documentType;
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        severity: criterion.severity,
        status: passed ? "passed" : "failed",
        expected: { documentType: criterion.documentType },
        observed: { documentType: observed },
        evidenceNodeIds: [],
        message: passed
          ? "The document type matches the confirmed brief."
          : "The document type does not match the confirmed brief.",
      };
    }

    case "document_language": {
      const observed = normalizeDocumentLanguage(document.metadata.language);
      const passed = observed === criterion.language;
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        severity: criterion.severity,
        status: passed ? "passed" : "failed",
        expected: { language: criterion.language },
        observed: { language: observed },
        evidenceNodeIds: [],
        message: passed
          ? "The document language matches the confirmed brief."
          : "The document language does not match the confirmed brief.",
      };
    }

    case "document_layout": {
      const observed = document.metadata.layout ?? null;
      const passed = JSON.stringify(observed) === JSON.stringify(criterion.layout);
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        severity: criterion.severity,
        status: passed ? "passed" : "failed",
        expected: criterion.layout,
        observed,
        evidenceNodeIds: [],
        message: passed
          ? "The page layout matches the confirmed brief."
          : "The page layout does not match the confirmed brief.",
      };
    }

    case "writing_style": {
      const observed = document.metadata.writingStyle ?? null;
      const passed = JSON.stringify(observed) === JSON.stringify(criterion.style);
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        severity: criterion.severity,
        status: passed ? "passed" : "failed",
        expected: criterion.style,
        observed,
        evidenceNodeIds: [],
        message: passed
          ? "The writing style contract matches the confirmed brief."
          : "The writing style contract does not match the confirmed brief.",
      };
    }

    case "node_type_count": {
      const nodes = document.nodes.filter(
        (node) => node.type === criterion.nodeType,
      );
      const passed = isInRange(
        nodes.length,
        criterion.minimum,
        criterion.maximum,
      );
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        severity: criterion.severity,
        status: passed ? "passed" : "failed",
        expected: {
          nodeType: criterion.nodeType,
          ...countExpected(criterion),
        },
        observed: { nodeType: criterion.nodeType, count: nodes.length },
        evidenceNodeIds: nodes.map((node) => node.id),
        message: passed
          ? `The structured ${criterion.nodeType} requirement is satisfied.`
          : `The structured ${criterion.nodeType} requirement is not satisfied.`,
      };
    }

    case "planned_math": {
      const matches = document.nodes.filter(
        (node): node is Extract<DocumentNode, { type: "equation" }> =>
          node.type === "equation" && node.planItemId === criterion.planItemId,
      );
      const equation = matches.length === 1 ? (matches[0] ?? null) : null;
      const observedSteps = equation
        ? equation.expression.kind === "aligned"
          ? equation.expression.lines.length
          : 1
        : 0;
      const passed =
        equation !== null &&
        observedSteps >= criterion.minimumExpressionSteps &&
        equation.numbered === criterion.numbered;
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        severity: criterion.severity,
        status: passed ? "passed" : "failed",
        expected: {
          planItemId: criterion.planItemId,
          minimumExpressionSteps: criterion.minimumExpressionSteps,
          numbered: criterion.numbered,
          exactlyOneRealization: true,
        },
        observed: {
          realizationCount: matches.length,
          expressionSteps: observedSteps,
          numbered: equation?.numbered ?? null,
        },
        evidenceNodeIds: matches.map((node) => node.id),
        message: passed
          ? "The planned mathematical derivation has one traceable realization."
          : "The planned mathematical derivation is missing, duplicated, too abbreviated, or numbered incorrectly.",
      };
    }

    case "planned_visual": {
      const matches = document.nodes.filter(
        (node): node is Extract<DocumentNode, { type: "figure" | "table" }> =>
          (node.type === "figure" || node.type === "table") &&
          node.planItemId === criterion.planItemId,
      );
      const compatible = matches.filter((node) => {
        if (criterion.visualKind === "table") return node.type === "table";
        if (node.type !== "figure" || !isRenderableFigureNode(node)) return false;
        if (criterion.visualKind === "chart") {
          return node.content?.kind === "chart";
        }
        if (criterion.visualKind === "diagram") {
          return node.content?.kind === "flowDiagram";
        }
        return true;
      });
      const passed = matches.length === 1 && compatible.length === 1;
      return {
        criterionId: criterion.id,
        kind: criterion.kind,
        severity: criterion.severity,
        status: passed ? "passed" : "failed",
        expected: {
          planItemId: criterion.planItemId,
          visualKind: criterion.visualKind,
          exactlyOneRealization: true,
        },
        observed: {
          realizationCount: matches.length,
          compatibleCount: compatible.length,
        },
        evidenceNodeIds: matches.map((node) => node.id),
        message: passed
          ? "The planned visual has one traceable renderable realization."
          : "The planned visual is missing, duplicated, or represented by an incompatible or non-renderable node.",
      };
    }

    case "reference_integrity":
      return evaluateReferenceIntegrity(criterion, document, index);
  }
}

function summaryFor(
  criteria: readonly AcceptanceCriterionResult[],
  severity: "required" | "preferred",
) {
  const selected = criteria.filter((criterion) => criterion.severity === severity);
  return {
    total: selected.length,
    passed: selected.filter((criterion) => criterion.status === "passed").length,
    failed: selected.filter((criterion) => criterion.status === "failed").length,
    notEvaluable: selected.filter(
      (criterion) => criterion.status === "not_evaluable",
    ).length,
  };
}

export function evaluateDeterministicAcceptance(
  input: AcceptanceEvaluationInput,
): DeterministicAcceptanceResult;
export function evaluateDeterministicAcceptance(
  input: unknown,
): DeterministicAcceptanceResult;
export function evaluateDeterministicAcceptance(
  input: unknown,
): DeterministicAcceptanceResult {
  const parsed = AcceptanceEvaluationInputSchema.parse(input);
  const briefDigest = createReviewBriefDigest(parsed.brief);
  const planDigest = createReviewPlanDigest(parsed.plan);
  const documentDigest = createReviewDocumentDigest(parsed.document);
  const issues: AcceptanceGateIssue[] = [];

  const contextMatches =
    parsed.brief.documentId === parsed.plan.documentId &&
    parsed.plan.documentId === parsed.document.id &&
    parsed.plan.briefVersion === parsed.briefVersion;
  if (!contextMatches) {
    issues.push({
      code: "context_mismatch",
      path: "target",
      message:
        "Brief, plan, document, or brief version do not identify the same review target.",
    });
  }

  const digestMatches = parsed.plan.briefDigest === briefDigest;
  if (!digestMatches) {
    issues.push({
      code: "brief_digest_mismatch",
      path: "plan.briefDigest",
      message: "The plan is not bound to the supplied brief snapshot.",
    });
  }

  const planReviewable = ["ready", "executing", "completed"].includes(
    parsed.plan.status,
  );
  if (!planReviewable) {
    issues.push({
      code: "plan_not_reviewable",
      path: "plan.status",
      message: `Plan status ${parsed.plan.status} cannot be accepted.`,
    });
  }

  const documentValidation = safeValidateDocument(parsed.document);
  if (!documentValidation.success) {
    issues.push(
      ...documentValidation.error.issues.map((issue) => ({
        code: "document_invalid" as const,
        path: issue.path,
        message: issue.message,
      })),
    );
  }

  const built = buildDeterministicAcceptanceCriteria({
    brief: parsed.brief,
    plan: parsed.plan,
    additionalCriteria: parsed.additionalCriteria,
  });
  issues.push(...built.issues);
  const criteriaConfigured = built.issues.length === 0;
  let criterionResults: AcceptanceCriterionResult[];
  if (documentValidation.success) {
    const documentIndex = buildDocumentIndex(documentValidation.data);
    criterionResults = built.criteria.map((criterion) =>
      evaluateCriterion(criterion, documentValidation.data, documentIndex),
    );
  } else {
    criterionResults = built.criteria.map((criterion) =>
      notEvaluableResult(
        criterion,
        "The document failed semantic validation.",
      ),
    );
  }

  const pendingExternalCriteria = parsed.plan.completionCriteria.flatMap(
    (criterion) =>
      criterion.verification === "deterministic"
        ? []
        : [
            {
              criterionId: criterion.id,
              verification: criterion.verification,
              severity: criterion.severity,
              statement: criterion.statement,
            },
          ],
  );
  const requiredSummary = summaryFor(criterionResults, "required");
  const deterministicFailure =
    requiredSummary.failed > 0 || requiredSummary.notEvaluable > 0;
  const preconditionsPass =
    contextMatches &&
    digestMatches &&
    planReviewable &&
    documentValidation.success &&
    criteriaConfigured;
  const hasRequiredExternalCriteria = pendingExternalCriteria.some(
    (criterion) => criterion.severity === "required",
  );
  const status =
    !preconditionsPass || deterministicFailure
      ? "failed"
      : hasRequiredExternalCriteria
        ? "blocked"
        : "passed";

  return DeterministicAcceptanceResultSchema.parse({
    status,
    passed: status === "passed",
    target: {
      documentId: parsed.document.id,
      documentRevision: parsed.documentRevision,
      documentDigest,
      briefVersion: parsed.briefVersion,
      briefDigest,
      planId: parsed.plan.id,
      planVersion: parsed.plan.version,
      planDigest,
    },
    preconditions: {
      contextMatches: contextMatches && digestMatches,
      planReviewable,
      documentValid: documentValidation.success,
      criteriaConfigured,
    },
    criteria: criterionResults,
    pendingExternalCriteria,
    issues,
    summary: {
      required: requiredSummary,
      preferred: summaryFor(criterionResults, "preferred"),
    },
  });
}

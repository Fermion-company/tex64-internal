import { NoObjectGeneratedError, Output, generateText } from "ai";

import {
  createDocumentBriefDigest,
  DocumentPlanSchema,
  PlanDeterministicEvaluatorSchema,
  validateDocumentPlan,
  type DocumentPlan,
  type DocumentPlanSection,
} from "@/domain/plan";
import type { DocumentBrief } from "@/domain/brief";
import { deterministicBriefId } from "@/domain/brief";

import type { BriefExtractionRuntime } from "./brief-extractor";
import { agentLanguageModel, agentOutputJson, agentProviderOptions, structuredAgentModel } from "./language-model";

function sectionAmount(
  targetLength: string | null,
  sectionCount: number,
): DocumentPlanSection["expectedAmount"] {
  const pageMatch = targetLength?.match(/(\d+)\s*(?:ページ|頁)/u);
  if (pageMatch?.[1]) {
    const total = Number.parseInt(pageMatch[1], 10);
    const target = Math.max(1, Math.round(total / sectionCount));
    return {
      unit: "pages",
      minimum: Math.max(1, target - 1),
      target,
      maximum: target + 1,
    };
  }
  const characterMatch = targetLength?.match(/(\d+)\s*(?:字|文字)/u);
  if (characterMatch?.[1]) {
    const total = Number.parseInt(characterMatch[1], 10);
    const target = Math.max(100, Math.round(total / sectionCount));
    return {
      unit: "characters",
      minimum: Math.max(50, Math.round(target * 0.8)),
      target,
      maximum: Math.max(target, Math.round(target * 1.2)),
    };
  }
  return { unit: "paragraphs", minimum: 1, target: 3, maximum: 6 };
}

function sourceKinds(
  policy: NonNullable<DocumentBrief["sources"]["policy"]["value"]>,
): DocumentPlanSection["sourceRequirements"][number]["sourceKinds"] {
  switch (policy) {
    case "user_only":
      return ["user_provided"];
    case "mixed":
      return ["user_provided", "peer_reviewed", "official"];
    case "agent_research":
      return ["primary_research", "peer_reviewed", "official"];
    case "none":
      return ["authoritative_secondary"];
  }
}

function deterministicDocumentPlan(input: {
  brief: DocumentBrief;
  briefVersion: number;
  now: string;
}): DocumentPlan {
  const { brief } = input;
  const subject = brief.goal.subject.value ?? "確定した主題";
  const sectionTitles = brief.template.sectionOrder.value?.length
    ? brief.template.sectionOrder.value
    : ["概要", "本文", "まとめ"];
  const sourcePolicy = brief.sources.policy.value ?? "none";
  const equationPolicy = brief.equations.policy.value ?? "none";
  const requestedEquationItems = brief.equations.items.value ?? [];
  const figurePolicy = brief.figures.policy.value ?? "none";
  const planId = deterministicBriefId(
    `${brief.documentId}:plan:${input.briefVersion}`,
  );
  const sourceSectionIndex = Math.min(1, sectionTitles.length - 1);
  const mathSectionIndex = Math.min(1, sectionTitles.length - 1);
  const visualSectionIndex = Math.min(1, sectionTitles.length - 1);

  const sections = sectionTitles.map((title, index) => {
    const seed = `${planId}:section:${index}:${title}`;
    const sectionId = deterministicBriefId(seed);
    const needsSources = sourcePolicy !== "none" && index === sourceSectionIndex;
    const sourceRequirementId = deterministicBriefId(`${seed}:source`);
    const claimId = deterministicBriefId(`${seed}:claim`);
    const needsMath =
      equationPolicy !== "none" &&
      requestedEquationItems.length > 0 &&
      index === mathSectionIndex;
    const derivationDetail =
      brief.equations.derivationDetail.value ?? "key_steps";
    const intermediateSteps =
      derivationDetail === "result_only"
        ? []
        : derivationDetail === "key_steps"
          ? ["前提と記号を定義し、結論へ至る主要な変形を示す"]
          : [
              "前提と記号を一つずつ定義する",
              "各変形の根拠を示して結論まで省略せず導く",
            ];
    const needsVisual =
      (figurePolicy === "required" || figurePolicy === "provided_only") &&
      index === visualSectionIndex;
    const requestedVisuals = brief.figures.items.value?.length
      ? brief.figures.items.value
      : [`${subject}の主要な関係を視覚的に整理する`];

    return {
      id: sectionId,
      title,
      objective: `${subject}について、${title}で担う論点を明確にし、前後の章へ論理的につなげる。`,
      expectedAmount: sectionAmount(
        brief.scope.targetLength.value,
        sectionTitles.length,
      ),
      researchClaims: needsSources
        ? [
            {
              id: claimId,
              statement: `${subject}に関する主要な主張を、確認済みの根拠に基づいて説明する。`,
              researchPurpose:
                "本文の中心的な説明が、取得・確認した資料の範囲を超えないようにする。",
              priority: "required" as const,
              sourceRequirementIds: [sourceRequirementId],
            },
          ]
        : [],
      sourceRequirements: needsSources
        ? [
            {
              id: sourceRequirementId,
              purpose: `${subject}の主要な主張と背景を裏付ける。`,
              minimumCount: Math.max(1, brief.sources.minimumCount.value ?? 1),
              sourceKinds: sourceKinds(sourcePolicy),
              dateRange: brief.sources.dateRange.value,
              requiredLocators: brief.sources.requiredLocators.value ?? [],
            },
          ]
        : [],
      mathematics: {
        policy: needsMath ? ("required" as const) : equationPolicy === "none" ? ("none" as const) : ("as_needed" as const),
        items: needsMath
          ? requestedEquationItems.map((requestedEquation, mathIndex) =>
              ({
                id: deterministicBriefId(`${seed}:math:${mathIndex}`),
                briefItem: requestedEquation,
                purpose: `「${requestedEquation}」を本文の論旨に沿って説明する。`,
                resultToEstablish: requestedEquation,
                derivationDetail,
                proofRigor: brief.equations.proofRigor.value,
                notationRequirements: [
                  brief.equations.notationConvention.value ??
                    "記号を初出時に定義し、文書全体で統一する",
                ],
                intermediateSteps,
                dependsOnClaimIds: needsSources ? [claimId] : [],
                numbered: brief.equations.numbering.value !== "none",
                completionCriterion: `「${requestedEquation}」について、前提、途中の変形、結論の対応を追跡できる。`,
              }) satisfies DocumentPlanSection["mathematics"]["items"][number],
            )
          : [],
      },
      visuals: needsVisual
        ? requestedVisuals.map((requestedVisual, visualIndex) => ({
            id: deterministicBriefId(`${seed}:visual:${visualIndex}`),
            kind: "diagram" as const,
            briefItem:
              brief.figures.items.value?.length ? requestedVisual : null,
            purpose: requestedVisual,
            intendedMessage:
              "本文だけでは把握しにくい要素の関係を一目で理解できるようにする。",
            source:
              figurePolicy === "provided_only"
                ? ("provided_asset" as const)
                : ("agent_generated" as const),
            dataRequirements: [],
            accessibilityDescription:
              "図を見なくても要点と要素間の関係が分かる説明を付ける。",
            completionCriterion:
              "本文から参照され、キャプションと説明が図の目的に一致する。",
          }))
        : [],
      completionCriteria: [
        {
          id: deterministicBriefId(`${seed}:criterion`),
          statement: `${title}の目的が本文で明示され、次の章へ論理的につながる。`,
          verification: "model_assessed" as const,
          severity: "required" as const,
          briefCriterionId: null,
        },
      ],
    } satisfies DocumentPlanSection;
  });

  const plan = DocumentPlanSchema.parse({
    schemaVersion: 1,
    id: planId,
    documentId: brief.documentId,
    briefVersion: input.briefVersion,
    briefDigest: createDocumentBriefDigest(brief),
    status: "ready",
    version: 1,
    objective:
      brief.goal.intendedOutcome.value ??
      `${subject}について、対象読者が主要な論点を説明できる文書を完成させる。`,
    sections,
    completionCriteria: [
      ...brief.acceptanceCriteria.map((criterion, index) => ({
        id: deterministicBriefId(`${planId}:brief-criterion:${index}`),
        statement: criterion.statement,
        verification: criterion.kind,
        severity: criterion.severity,
        briefCriterionId: criterion.id,
      })),
      {
        id: deterministicBriefId(`${planId}:structural-criterion`),
        statement:
          "最新版の文書構造、相互参照、引用と参考文献の対応に問題がない。",
        verification: "deterministic",
        severity: "required",
        briefCriterionId: null,
      },
    ],
    createdAt: input.now,
    updatedAt: input.now,
  });

  return validateDocumentPlan(plan, {
    brief,
    briefVersion: input.briefVersion,
    confirmedBriefVersion: input.briefVersion,
  });
}

const PLAN_INSTRUCTIONS = `確認済みの文書要件から、実行可能な執筆計画を作成してください。
各章の目的、必要な根拠、数式の途中段階、図表の役割、完成条件を具体化します。
指定された数式・証明・導出目標は一つずつ別のmathematics.itemsへ割り当て、briefItemに要件票の文言を一字も変えずに入れます。追加提案する数式のbriefItemはnullにします。
指定された図表は一つずつ別のvisualへ割り当て、briefItemに要件票の名称を一字も変えずに入れます。提案図表のbriefItemはnullにします。
要件にない事実や出典を捏造せず、ID、briefVersion、briefDigest、documentId、時刻は入力値を正確に使います。
TeXコードやパッケージ名は計画に含めません。`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Models must not be trusted to invent identifier formats: identity fields
 * are overwritten with the immutable inputs, plan status/version are pinned,
 * and every non-UUID id the model produced is replaced with a deterministic
 * UUID while its in-plan references are rewritten to match. Content fields
 * are left untouched; DocumentPlanSchema.parse remains the validation gate.
 */
function normalizeModelPlanDraft(
  raw: unknown,
  input: { brief: DocumentBrief; briefVersion: number; now: string },
): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const draft = structuredClone(raw) as Record<string, unknown>;
  const planId = deterministicBriefId(
    `${input.brief.documentId}:model-plan:${input.briefVersion}`,
  );
  Object.assign(draft, {
    schemaVersion: 1,
    id: planId,
    documentId: input.brief.documentId,
    briefVersion: input.briefVersion,
    briefDigest: createDocumentBriefDigest(input.brief),
    status: "ready",
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  });

  const idMap = new Map<string, string>();
  const fixId = (item: Record<string, unknown>, seed: string): void => {
    const original = typeof item.id === "string" ? item.id : seed;
    if (UUID_PATTERN.test(original)) {
      item.id = original;
      return;
    }
    const replacement = deterministicBriefId(`${planId}:${seed}:${original}`);
    idMap.set(original, replacement);
    item.id = replacement;
  };
  const items = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];

  const sections = items(draft.sections);
  if (!Array.isArray(draft.completionCriteria)) draft.completionCriteria = [];
  sections.forEach((section, sectionIndex) => {
    fixId(section, `section:${sectionIndex}`);
    // Non-strict transports let the model drop empty containers and nullable
    // leaves entirely; restore the schema's shape before validation reads it.
    for (const key of [
      "researchClaims",
      "sourceRequirements",
      "visuals",
      "completionCriteria",
    ] as const) {
      if (!Array.isArray(section[key])) section[key] = [];
    }
    if ((section.completionCriteria as unknown[]).length === 0) {
      const title =
        typeof section.title === "string" && section.title.trim()
          ? section.title.trim()
          : `第${sectionIndex + 1}章`;
      (section.completionCriteria as unknown[]).push({
        id: deterministicBriefId(
          `${planId}:criterion:${sectionIndex}:default`,
        ),
        statement: `${title}の目的が本文で明示され、前後の章へ論理的につながる。`,
        verification: "model_assessed",
        severity: "required",
        briefCriterionId: null,
      });
    }
    if (
      !section.mathematics ||
      typeof section.mathematics !== "object" ||
      Array.isArray(section.mathematics)
    ) {
      section.mathematics = { policy: "none", items: [] };
    } else if (
      !Array.isArray((section.mathematics as Record<string, unknown>).items)
    ) {
      (section.mathematics as Record<string, unknown>).items = [];
    }
    items(section.researchClaims).forEach((claim) => {
      if (!Array.isArray(claim.sourceRequirementIds)) {
        claim.sourceRequirementIds = [];
      }
    });
    items(section.sourceRequirements).forEach((requirement) => {
      if (!Array.isArray(requirement.requiredLocators)) {
        requirement.requiredLocators = [];
      }
      if (requirement.dateRange === undefined) requirement.dateRange = null;
    });
    items(section.visuals).forEach((visual) => {
      if (!Array.isArray(visual.dataRequirements)) visual.dataRequirements = [];
      if (visual.briefItem === undefined) visual.briefItem = null;
    });
    items(
      (section.mathematics as Record<string, unknown>).items,
    ).forEach((item) => {
      if (!Array.isArray(item.intermediateSteps)) item.intermediateSteps = [];
      if (!Array.isArray(item.dependsOnClaimIds)) item.dependsOnClaimIds = [];
      if (!Array.isArray(item.notationRequirements)) {
        item.notationRequirements = [];
      }
      if (item.briefItem === undefined) item.briefItem = null;
    });
    // Grammar-free transports may omit the bounds around a stated target.
    const amount =
      section.expectedAmount && typeof section.expectedAmount === "object"
        ? (section.expectedAmount as Record<string, unknown>)
        : null;
    if (amount && typeof amount.target === "number") {
      if (typeof amount.minimum !== "number") {
        amount.minimum = Math.max(1, Math.floor(amount.target * 0.8));
      }
      if (typeof amount.maximum !== "number") {
        amount.maximum = Math.max(
          Math.ceil(amount.target * 1.2),
          amount.target as number,
        );
      }
    }
    for (const [key, seed] of [
      ["researchClaims", "claim"],
      ["sourceRequirements", "source"],
      ["visuals", "visual"],
      ["completionCriteria", "criterion"],
    ] as const) {
      items(section[key]).forEach((item, index) =>
        fixId(item, `${seed}:${sectionIndex}:${index}`),
      );
    }
    const mathematics =
      section.mathematics && typeof section.mathematics === "object"
        ? (section.mathematics as Record<string, unknown>)
        : null;
    items(mathematics?.items).forEach((item, index) =>
      fixId(item, `math:${sectionIndex}:${index}`),
    );
  });
  if ((draft.completionCriteria as unknown[]).length === 0) {
    (draft.completionCriteria as unknown[]).push({
      id: deterministicBriefId(`${planId}:plan-criterion:default`),
      statement:
        "文書全体が確定条件の主題・構成・分量を満たし、章立てが論理的に完結している。",
      verification: "model_assessed",
      severity: "required",
      briefCriterionId: null,
    });
  }
  items(draft.completionCriteria).forEach((item, index) =>
    fixId(item, `plan-criterion:${index}`),
  );

  // The confirmed brief sets hard floors for math items; raising a weaker
  // model draft to those floors is exactly what the reviewer would demand.
  const requestedDetail = input.brief.equations.derivationDetail.value;
  const requestedRigor = input.brief.equations.proofRigor.value;
  const notationConvention = input.brief.equations.notationConvention.value;
  const detailRank = { result_only: 0, key_steps: 1, full_derivation: 2 } as const;
  const rigorRank = { intuitive: 0, standard: 1, formal: 2 } as const;
  sections.forEach((section) => {
    const mathematics =
      section.mathematics && typeof section.mathematics === "object"
        ? (section.mathematics as Record<string, unknown>)
        : null;
    items(mathematics?.items).forEach((item) => {
      if (
        requestedDetail &&
        (typeof item.derivationDetail !== "string" ||
          (detailRank[item.derivationDetail as keyof typeof detailRank] ?? -1) <
            detailRank[requestedDetail])
      ) {
        item.derivationDetail = requestedDetail;
      }
      if (
        requestedRigor &&
        (typeof item.proofRigor !== "string" ||
          (rigorRank[item.proofRigor as keyof typeof rigorRank] ?? -1) <
            rigorRank[requestedRigor])
      ) {
        item.proofRigor = requestedRigor;
      }
      if (notationConvention) {
        const requirements = Array.isArray(item.notationRequirements)
          ? item.notationRequirements
          : [];
        if (
          !requirements.some(
            (requirement) => String(requirement).trim() === notationConvention.trim(),
          )
        ) {
          item.notationRequirements = [notationConvention, ...requirements];
        }
      }
      // Raising derivationDetail can leave the draft with fewer planned
      // steps than the detail level's floor; pad instead of failing.
      const requiredSteps =
        item.derivationDetail === "full_derivation"
          ? 2
          : item.derivationDetail === "key_steps"
            ? 1
            : 0;
      const steps = Array.isArray(item.intermediateSteps)
        ? item.intermediateSteps
        : [];
      const stepPadding = [
        "前提と記号を定義し、結論へ至る主要な変形を示す",
        "各変形の根拠を示して結論まで省略せず導く",
      ];
      while (steps.length < requiredSteps) {
        steps.push(stepPadding[Math.min(steps.length, stepPadding.length - 1)]);
      }
      item.intermediateSteps = steps;
    });
  });

  // The brief's named objectives are contractual. Reconcile the draft's
  // bindings deterministically instead of failing on a weaker model's
  // paraphrase: unknown or duplicate bindings become agent-added items,
  // and missing objectives are injected exactly once.
  const normalizeBinding = (value: string): string =>
    value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  const requestedEquations = input.brief.equations.items.value ?? [];
  const requestedEquationKeys = new Set(requestedEquations.map(normalizeBinding));
  const boundEquations = new Set<string>();
  sections.forEach((section) => {
    const mathematics = section.mathematics as Record<string, unknown>;
    items(mathematics.items).forEach((item) => {
      if (typeof item.briefItem !== "string") return;
      const key = normalizeBinding(item.briefItem);
      if (!requestedEquationKeys.has(key) || boundEquations.has(key)) {
        item.briefItem = null;
      } else {
        boundEquations.add(key);
      }
    });
  });
  const missingEquations = requestedEquations.filter(
    (requested) => !boundEquations.has(normalizeBinding(requested)),
  );
  if (missingEquations.length > 0 && sections.length > 0) {
    const host =
      sections.find(
        (section) =>
          (section.mathematics as Record<string, unknown>).policy !== "none",
      ) ?? sections[Math.min(1, sections.length - 1)]!;
    const mathematics = host.mathematics as Record<string, unknown>;
    if (mathematics.policy === "none") mathematics.policy = "as_needed";
    const injectedDetail = requestedDetail ?? "key_steps";
    const injectedSteps =
      injectedDetail === "result_only"
        ? []
        : injectedDetail === "key_steps"
          ? ["前提と記号を定義し、結論へ至る主要な変形を示す"]
          : [
              "前提と記号を一つずつ定義する",
              "各変形の根拠を示して結論まで省略せず導く",
            ];
    missingEquations.forEach((requested, index) => {
      (mathematics.items as unknown[]).push({
        id: deterministicBriefId(`${planId}:inject-math:${index}:${requested}`),
        briefItem: requested,
        purpose: `「${requested}」を本文の論旨に沿って説明する。`,
        resultToEstablish: requested,
        derivationDetail: injectedDetail,
        proofRigor: requestedRigor ?? null,
        notationRequirements: notationConvention ? [notationConvention] : [],
        intermediateSteps: [...injectedSteps],
        dependsOnClaimIds: [],
        numbered: input.brief.equations.numbering.value !== "none",
        completionCriterion: `「${requested}」について、前提、途中の変形、結論の対応を追跡できる。`,
      });
    });
  }
  const requestedVisualItems = input.brief.figures.items.value ?? [];
  const requestedVisualKeys = new Set(requestedVisualItems.map(normalizeBinding));
  const boundVisuals = new Set<string>();
  sections.forEach((section) => {
    items(section.visuals).forEach((visual) => {
      if (typeof visual.briefItem !== "string") return;
      const key = normalizeBinding(visual.briefItem);
      if (!requestedVisualKeys.has(key) || boundVisuals.has(key)) {
        visual.briefItem = null;
      } else {
        boundVisuals.add(key);
      }
    });
  });
  const missingVisuals = requestedVisualItems.filter(
    (requested) => !boundVisuals.has(normalizeBinding(requested)),
  );
  if (missingVisuals.length > 0 && sections.length > 0) {
    const host =
      sections.find((section) => items(section.visuals).length > 0) ??
      sections[Math.min(1, sections.length - 1)]!;
    const figurePolicy = input.brief.figures.policy.value ?? "none";
    missingVisuals.forEach((requested, index) => {
      (host.visuals as unknown[]).push({
        id: deterministicBriefId(
          `${planId}:inject-visual:${index}:${requested}`,
        ),
        kind: "diagram",
        briefItem: requested,
        purpose: requested,
        intendedMessage:
          "本文だけでは把握しにくい要素の関係を一目で理解できるようにする。",
        source:
          figurePolicy === "provided_only"
            ? "provided_asset"
            : "agent_generated",
        dataRequirements: [],
        accessibilityDescription:
          "図を見なくても要点と要素間の関係が分かる説明を付ける。",
        completionCriterion:
          "本文から参照され、キャプションと説明が図の目的に一致する。",
      });
    });
  }

  // Evaluators belong to deterministic criteria only; models mix the pair up
  // in both directions, and either mismatch has one safe resolution.
  const reconcileCriteria = (value: unknown): void => {
    items(value).forEach((criterion) => {
      if (criterion.briefCriterionId === undefined) {
        criterion.briefCriterionId = null;
      }
      if (criterion.verification !== "deterministic") {
        if ("deterministicEvaluator" in criterion) {
          criterion.deterministicEvaluator = null;
        }
        return;
      }
      // A deterministic promise is only as good as its evaluator; a missing
      // or malformed one degrades to model assessment instead of failing.
      const evaluator = PlanDeterministicEvaluatorSchema.safeParse(
        criterion.deterministicEvaluator,
      );
      if (evaluator.success) {
        criterion.deterministicEvaluator = evaluator.data;
      } else {
        criterion.deterministicEvaluator = null;
        criterion.verification = "model_assessed";
      }
    });
  };
  reconcileCriteria(draft.completionCriteria);
  sections.forEach((section) => reconcileCriteria(section.completionCriteria));

  const remapReferences = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map((entry) => idMap.get(String(entry)) ?? entry)
      : value;
  sections.forEach((section) => {
    items(section.researchClaims).forEach((claim) => {
      claim.sourceRequirementIds = remapReferences(claim.sourceRequirementIds);
    });
    const mathematics =
      section.mathematics && typeof section.mathematics === "object"
        ? (section.mathematics as Record<string, unknown>)
        : null;
    items(mathematics?.items).forEach((item) => {
      item.dependsOnClaimIds = remapReferences(item.dependsOnClaimIds);
    });
  });

  // The validator scopes references per section, while models naturally share
  // one source requirement across sections. Clone foreign requirements into
  // the referencing section (preserving intent) and drop references that
  // resolve nowhere; claim dependencies outside the section are dropped.
  const requirementById = new Map<string, Record<string, unknown>>();
  sections.forEach((section) => {
    items(section.sourceRequirements).forEach((requirement) => {
      if (typeof requirement.id === "string") {
        requirementById.set(requirement.id, requirement);
      }
    });
  });
  sections.forEach((section, sectionIndex) => {
    const local = new Set(
      items(section.sourceRequirements).flatMap((requirement) =>
        typeof requirement.id === "string" ? [requirement.id] : [],
      ),
    );
    const localClaims = new Set(
      items(section.researchClaims).flatMap((claim) =>
        typeof claim.id === "string" ? [claim.id] : [],
      ),
    );
    items(section.researchClaims).forEach((claim) => {
      if (!Array.isArray(claim.sourceRequirementIds)) return;
      claim.sourceRequirementIds = claim.sourceRequirementIds.flatMap(
        (reference) => {
          const id = String(reference);
          if (local.has(id)) return [id];
          const foreign = requirementById.get(id);
          if (!foreign) return [];
          const cloneId = deterministicBriefId(
            `${draft.id as string}:clone:${sectionIndex}:${id}`,
          );
          if (!local.has(cloneId)) {
            const clone = structuredClone(foreign);
            clone.id = cloneId;
            (section.sourceRequirements as unknown[]).push(clone);
            local.add(cloneId);
          }
          return [cloneId];
        },
      );
      const uniqueReferences: string[] = [];
      const seenReferences = new Set<string>();
      for (const reference of claim.sourceRequirementIds as unknown[]) {
        const id = String(reference);
        if (seenReferences.has(id)) continue;
        seenReferences.add(id);
        uniqueReferences.push(id);
      }
      claim.sourceRequirementIds = uniqueReferences;
      // A required claim must cite a section source requirement; rebind or
      // synthesize one rather than failing, and only downgrade the claim
      // when the brief forbids sources altogether.
      if (claim.priority === "required" && uniqueReferences.length === 0) {
        const firstLocal = items(section.sourceRequirements)[0];
        const sourcePolicy = input.brief.sources.policy.value ?? "none";
        if (firstLocal && typeof firstLocal.id === "string") {
          claim.sourceRequirementIds = [firstLocal.id];
        } else if (sourcePolicy === "none") {
          claim.priority = "recommended";
        } else {
          const requirementId = deterministicBriefId(
            `${draft.id as string}:rescue-source:${sectionIndex}`,
          );
          (section.sourceRequirements as unknown[]).push({
            id: requirementId,
            purpose: "本文の必須主張を、確認済みの資料で裏付ける。",
            minimumCount: Math.max(
              1,
              input.brief.sources.minimumCount.value ?? 1,
            ),
            sourceKinds: sourceKinds(sourcePolicy),
            dateRange: input.brief.sources.dateRange.value ?? null,
            requiredLocators: [],
          });
          local.add(requirementId);
          claim.sourceRequirementIds = [requirementId];
        }
      }
    });
    items(
      section.mathematics && typeof section.mathematics === "object"
        ? (section.mathematics as Record<string, unknown>).items
        : [],
    ).forEach((item) => {
      if (!Array.isArray(item.dependsOnClaimIds)) return;
      item.dependsOnClaimIds = item.dependsOnClaimIds.filter((reference) =>
        localClaims.has(String(reference)),
      );
    });
  });

  // Brief policies are absolute: a "none" policy forbids the corresponding
  // plan machinery entirely, and provided_only restricts visual sources.
  if ((input.brief.sources.policy.value ?? "none") === "none") {
    sections.forEach((section) => {
      section.researchClaims = [];
      section.sourceRequirements = [];
    });
  }
  if ((input.brief.equations.policy.value ?? "none") === "none") {
    sections.forEach((section) => {
      section.mathematics = { policy: "none", items: [] };
    });
  }
  if (input.brief.figures.policy.value === "provided_only") {
    sections.forEach((section) => {
      items(section.visuals).forEach((visual) => {
        if (visual.source !== "provided_asset") {
          visual.source = "provided_asset";
          if (!Array.isArray(visual.dataRequirements)) {
            visual.dataRequirements = [];
          }
        }
      });
    });
  }

  // The brief's section order is validated as an exact-title subsequence.
  // Rebuild around that spine: matched sections keep their position in the
  // order, unmatched required titles become bridging sections, and the
  // model's own sections stay in their original relative order.
  const requiredOrder = input.brief.template.sectionOrder.value ?? [];
  let finalSections = sections;
  if (requiredOrder.length > 0 && sections.length > 0) {
    const matched = new Map<number, number>();
    const consumedSections = new Set<number>();
    requiredOrder.forEach((requiredTitle, requiredIndex) => {
      const key = normalizeBinding(requiredTitle);
      const found = sections.findIndex(
        (section, index) =>
          !consumedSections.has(index) &&
          typeof section.title === "string" &&
          normalizeBinding(section.title) === key,
      );
      if (found >= 0) {
        matched.set(requiredIndex, found);
        consumedSections.add(found);
      }
    });
    const inOrder =
      matched.size === requiredOrder.length &&
      [...matched.values()].every(
        (value, index, values) => index === 0 || value > values[index - 1]!,
      );
    if (!inOrder) {
      const bridgeSection = (title: string, requiredIndex: number) => {
        const seed = `${planId}:bridge:${requiredIndex}:${title}`;
        return {
          id: deterministicBriefId(seed),
          title,
          objective: `${title}として、周辺の章の内容を主題へ結び付け、文書全体の流れを保つ。`,
          expectedAmount: { unit: "paragraphs", minimum: 1, target: 2, maximum: 4 },
          researchClaims: [],
          sourceRequirements: [],
          mathematics: { policy: "none", items: [] },
          visuals: [],
          completionCriteria: [
            {
              id: deterministicBriefId(`${seed}:criterion`),
              statement: `${title}の役割が本文で明示され、前後の章と論理的につながる。`,
              verification: "model_assessed",
              severity: "required",
              briefCriterionId: null,
            },
          ],
        } satisfies Record<string, unknown>;
      };
      // anchor(r) = original index of the next matched spine section at or
      // after r; extras flush before that anchor to keep narrative order.
      const anchorAfter = (requiredIndex: number): number => {
        for (let next = requiredIndex + 1; next < requiredOrder.length; next += 1) {
          const index = matched.get(next);
          if (index !== undefined) return index;
        }
        return Number.POSITIVE_INFINITY;
      };
      const rebuilt: Record<string, unknown>[] = [];
      let flushed = 0;
      const flushExtrasBefore = (limit: number): void => {
        while (flushed < sections.length) {
          if (consumedSections.has(flushed)) {
            flushed += 1;
            continue;
          }
          if (flushed >= limit) return;
          rebuilt.push(sections[flushed]!);
          flushed += 1;
        }
      };
      requiredOrder.forEach((requiredTitle, requiredIndex) => {
        const index = matched.get(requiredIndex);
        if (index !== undefined) {
          flushExtrasBefore(index);
          rebuilt.push(sections[index]!);
          flushed = Math.max(flushed, index + 1);
        } else {
          rebuilt.push(bridgeSection(requiredTitle, requiredIndex));
        }
        flushExtrasBefore(anchorAfter(requiredIndex));
      });
      flushExtrasBefore(Number.POSITIVE_INFINITY);
      draft.sections = rebuilt;
      finalSections = rebuilt;
    }
  }

  // Aggregate source coverage: the plan's minimum counts and required
  // locators must add up to the brief's floor.
  const aggregatePolicy = input.brief.sources.policy.value ?? "none";
  if (aggregatePolicy !== "none") {
    const requirements = finalSections.flatMap((section) =>
      items(section.sourceRequirements),
    );
    const plannedMinimum = requirements.reduce(
      (sum, requirement) =>
        sum +
        (typeof requirement.minimumCount === "number" &&
        Number.isFinite(requirement.minimumCount)
          ? requirement.minimumCount
          : 0),
      0,
    );
    const requiredMinimum = input.brief.sources.minimumCount.value ?? 0;
    if (plannedMinimum < requiredMinimum) {
      const first = requirements[0];
      if (first) {
        first.minimumCount =
          (typeof first.minimumCount === "number" &&
          Number.isFinite(first.minimumCount)
            ? first.minimumCount
            : 0) +
          (requiredMinimum - plannedMinimum);
      } else if (finalSections.length > 0) {
        const host = finalSections[Math.min(1, finalSections.length - 1)]!;
        (host.sourceRequirements as unknown[]).push({
          id: deterministicBriefId(`${planId}:aggregate-source`),
          purpose: "文書全体の主張を、確認済みの資料で裏付ける。",
          minimumCount: requiredMinimum,
          sourceKinds: sourceKinds(aggregatePolicy),
          dateRange: input.brief.sources.dateRange.value ?? null,
          requiredLocators: [],
        });
      }
    }
    const allRequirements = finalSections.flatMap((section) =>
      items(section.sourceRequirements),
    );
    const plannedLocators = new Set(
      allRequirements.flatMap((requirement) =>
        Array.isArray(requirement.requiredLocators)
          ? requirement.requiredLocators.map(String)
          : [],
      ),
    );
    const firstRequirement = allRequirements[0];
    for (const locator of input.brief.sources.requiredLocators.value ?? []) {
      if (plannedLocators.has(locator) || !firstRequirement) continue;
      (firstRequirement.requiredLocators as unknown[]).push(locator);
    }
  }

  // Every required brief acceptance criterion must be bound by some plan
  // criterion; unknown bindings are cleared, missing ones injected.
  const briefCriterionIds = new Set(
    input.brief.acceptanceCriteria.map((criterion) => criterion.id),
  );
  const allCriteria = [
    ...items(draft.completionCriteria),
    ...finalSections.flatMap((section) => items(section.completionCriteria)),
  ];
  allCriteria.forEach((criterion) => {
    if (
      typeof criterion.briefCriterionId === "string" &&
      !briefCriterionIds.has(criterion.briefCriterionId)
    ) {
      criterion.briefCriterionId = null;
    }
  });
  const coveredCriteria = new Set(
    allCriteria.flatMap((criterion) =>
      typeof criterion.briefCriterionId === "string"
        ? [criterion.briefCriterionId]
        : [],
    ),
  );
  input.brief.acceptanceCriteria.forEach((criterion) => {
    if (criterion.severity !== "required" || coveredCriteria.has(criterion.id)) {
      return;
    }
    (draft.completionCriteria as unknown[]).push({
      id: deterministicBriefId(`${planId}:brief-criterion:${criterion.id}`),
      statement: criterion.statement,
      verification: "model_assessed",
      severity: "required",
      briefCriterionId: criterion.id,
    });
  });

  return draft;
}

export async function createDocumentPlan(input: {
  brief: DocumentBrief;
  briefVersion: number;
  now: string;
  runtime: BriefExtractionRuntime;
}): Promise<DocumentPlan> {
  if (input.runtime.provider !== "ai_gateway") {
    return deterministicDocumentPlan(input);
  }

  const finishPlan = (raw: unknown): DocumentPlan => {
    const normalized = parseDroppingUnknownKeys(
      normalizeModelPlanDraft(raw, input),
    );
    return validateDocumentPlan(normalized, {
      brief: input.brief,
      briefVersion: input.briefVersion,
      confirmedBriefVersion: input.briefVersion,
    });
  };
  const promptPayload = {
    immutable: {
      documentId: input.brief.documentId,
      briefVersion: input.briefVersion,
      briefDigest: createDocumentBriefDigest(input.brief),
      createdAt: input.now,
      updatedAt: input.now,
    },
    confirmedBrief: input.brief,
  };

  let rawDraft: unknown = null;
  try {
    try {
      const result = await generateText({
        model: agentLanguageModel(structuredAgentModel(input.runtime.model)),
        providerOptions: agentProviderOptions(),
        system: PLAN_INSTRUCTIONS,
        output: Output.object({ schema: DocumentPlanSchema }),
        maxOutputTokens: 12_000,
        prompt: JSON.stringify(promptPayload),
      });
      rawDraft = agentOutputJson(result);
      return finishPlan(rawDraft);
    } catch (error) {
      // Grammar-free transports (non-strict json_schema) can return drafts
      // that fail the SDK's own schema validation; the raw JSON is still the
      // best starting point for normalization and one repair round.
      if (NoObjectGeneratedError.isInstance(error) && error.text) {
        rawDraft = JSON.parse(error.text);
        try {
          return finishPlan(rawDraft);
        } catch (normalizeError) {
          return await repairPlanDraft({
            model: input.runtime.model ?? "",
            promptPayload,
            rawDraft,
            failure: normalizeError,
            finishPlan,
          });
        }
      }
      throw error;
    }
  } catch (error) {
    // Server-side observability only; never surfaces to users. The zod issue
    // list is the actionable part of an otherwise opaque fail-closed error.
    const cause = error as { issues?: unknown; message?: string };
    console.error(
      "[document-plan] generation failed:",
      cause.issues !== undefined
        ? JSON.stringify(cause.issues).slice(0, 2_000)
        : String(cause.message ?? error).slice(0, 500),
    );
    throw new DocumentPlanGenerationError({ cause: error });
  }
}

/**
 * Strict object schemas reject stray keys models sometimes add. Dropping an
 * unknown key can never corrupt recognized content, so those exact paths are
 * removed and parsing retried a few times before other issues fail closed.
 */
function parseDroppingUnknownKeys(raw: unknown): DocumentPlan {
  let candidate = raw;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parsed = DocumentPlanSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    const unknownKeyIssues = parsed.error.issues.filter(
      (issue): issue is typeof issue & { keys: string[] } =>
        issue.code === "unrecognized_keys",
    );
    if (unknownKeyIssues.length === 0) throw parsed.error;
    candidate = structuredClone(candidate);
    for (const issue of unknownKeyIssues) {
      let target: unknown = candidate;
      for (const segment of issue.path) {
        if (!target || typeof target !== "object") break;
        target = (target as Record<PropertyKey, unknown>)[segment as PropertyKey];
      }
      if (target && typeof target === "object" && !Array.isArray(target)) {
        for (const key of issue.keys) {
          delete (target as Record<string, unknown>)[key];
        }
      }
    }
  }
  return DocumentPlanSchema.parse(candidate);
}

/**
 * One feedback round: the invalid draft plus its concrete validation issues
 * go back to the model for correction. Small models fix omissions reliably
 * when told exactly what is missing; a second failure fails closed.
 */
async function repairPlanDraft(options: {
  model: string;
  promptPayload: unknown;
  rawDraft: unknown;
  failure: unknown;
  finishPlan: (raw: unknown) => DocumentPlan;
}): Promise<DocumentPlan> {
  const issues =
    options.failure && typeof options.failure === "object" && "issues" in options.failure
      ? (options.failure as { issues: unknown[] }).issues.slice(0, 30)
      : [String((options.failure as Error)?.message ?? options.failure).slice(0, 500)];
  try {
    const result = await generateText({
      model: agentLanguageModel(structuredAgentModel(options.model)),
      providerOptions: agentProviderOptions(),
      system: PLAN_INSTRUCTIONS,
      output: Output.object({ schema: DocumentPlanSchema }),
      maxOutputTokens: 12_000,
      prompt: JSON.stringify({
        ...(options.promptPayload as Record<string, unknown>),
        previousInvalidPlan: options.rawDraft,
        validationIssues: issues,
        instruction:
          "previousInvalidPlanを修正した完全な計画JSONを返してください。validationIssuesの各項目を解消し、内容は保ちながら不足フィールドを補ってください。",
      }),
    });
    return options.finishPlan(agentOutputJson(result));
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error) && error.text) {
      return options.finishPlan(JSON.parse(error.text));
    }
    throw error;
  }
}

/**
 * Production planning is a quality boundary. A provider/schema/validation
 * failure must be retried by the durable workflow or fail closed; silently
 * replacing it with a generic local plan would hide lost user requirements.
 */
export class DocumentPlanGenerationError extends Error {
  constructor(options?: ErrorOptions) {
    super("確認済みの条件から執筆計画を作成できませんでした。", options);
    this.name = "DocumentPlanGenerationError";
  }
}

export { deterministicDocumentPlan as createDocumentPlanDeterministically };

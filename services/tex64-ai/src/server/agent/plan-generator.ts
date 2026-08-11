import { generateText, Output } from "ai";

import {
  createDocumentBriefDigest,
  DocumentPlanSchema,
  validateDocumentPlan,
  type DocumentPlan,
  type DocumentPlanSection,
} from "@/domain/plan";
import type { DocumentBrief } from "@/domain/brief";
import { deterministicBriefId } from "@/domain/brief";

import type { BriefExtractionRuntime } from "./brief-extractor";

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

export async function createDocumentPlan(input: {
  brief: DocumentBrief;
  briefVersion: number;
  now: string;
  runtime: BriefExtractionRuntime;
}): Promise<DocumentPlan> {
  if (input.runtime.provider !== "ai_gateway") {
    return deterministicDocumentPlan(input);
  }

  try {
    const result = await generateText({
      model: input.runtime.model,
      system: PLAN_INSTRUCTIONS,
      output: Output.object({ schema: DocumentPlanSchema }),
      maxOutputTokens: 12_000,
      prompt: JSON.stringify({
        immutable: {
          documentId: input.brief.documentId,
          briefVersion: input.briefVersion,
          briefDigest: createDocumentBriefDigest(input.brief),
          createdAt: input.now,
          updatedAt: input.now,
        },
        confirmedBrief: input.brief,
      }),
    });
    return validateDocumentPlan(result.output, {
      brief: input.brief,
      briefVersion: input.briefVersion,
      confirmedBriefVersion: input.briefVersion,
    });
  } catch (error) {
    throw new DocumentPlanGenerationError({ cause: error });
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

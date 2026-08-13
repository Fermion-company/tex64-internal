import { evaluateBriefCoverage } from "./coverage";
import {
  extractBriefDeterministically,
  isExplicitBriefConfirmation,
  isExplicitDelegationAnswer,
} from "./extract";
import { deterministicBriefId } from "./fingerprint";
import { isRequirementGroupApplicable } from "./applicability";
import {
  isRawTemplateRequest,
  resolveSafeCustomTemplatePreset,
} from "./custom-template";
import {
  DocumentAgentSessionSchema,
  DocumentBriefSchema,
  type BriefExtraction,
  type DocumentAgentSession,
  type DocumentBrief,
  type ElicitationQuestion,
  type RequirementGroup,
  type RequirementPath,
  type RequirementValue,
} from "./schema";

export class BriefDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefDomainError";
  }
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function provided<T>(
  value: T,
  runId: string,
  now: string,
): RequirementValue<T> {
  return {
    status: "provided",
    value,
    source: { kind: "user", runId },
    updatedAt: now,
  };
}

function delegated<T>(
  value: T,
  runId: string,
  now: string,
): RequirementValue<T> {
  return {
    status: "delegated",
    value,
    source: { kind: "agent_default", runId },
    updatedAt: now,
  };
}

function delegateUnknown<T>(
  requirement: RequirementValue<T>,
  value: T,
  runId: string,
  now: string,
): RequirementValue<T> {
  return requirement.status === "unknown"
    ? delegated(value, runId, now)
    : requirement;
}

function unknown<T>(now: string): RequirementValue<T> {
  return { status: "unknown", value: null, source: null, updatedAt: now };
}

function notApplicable<T>(now: string): RequirementValue<T> {
  return {
    status: "not_applicable",
    value: null,
    source: null,
    updatedAt: now,
  };
}

function keepOrMarkNotApplicable<T>(
  requirement: RequirementValue<T>,
  now: string,
): RequirementValue<T> {
  return requirement.status === "not_applicable"
    ? requirement
    : notApplicable<T>(now);
}

function evidencePaths(
  extraction: BriefExtraction,
  answerText: string,
  question: ElicitationQuestion | null,
): Set<RequirementPath> {
  const answer = normalized(answerText);
  const conservative = extractBriefDeterministically({
    text: answerText,
    target: question?.target ?? null,
    targetPaths: question?.targetPaths ?? [],
  });
  const conservativePaths = new Set(
    conservative.evidence.map((item) => item.path),
  );
  const strictlyParsedPaths = new Set<RequirementPath>([
    "scope.targetLength",
  ]);

  const extractedValue = (
    candidate: BriefExtraction,
    path: RequirementPath,
  ): unknown => {
    const values = {
      "goal.subject": candidate.subject,
      "goal.purpose": candidate.purpose,
      "goal.audience": candidate.audience,
      "goal.intendedOutcome": candidate.intendedOutcome,
      "scope.includedTopics": candidate.includedTopics,
      "scope.excludedTopics": candidate.excludedTopics,
      "scope.depth": candidate.depth,
      "scope.targetLength": candidate.targetLength,
      "scope.language": candidate.language,
      "template.family": candidate.templateFamily,
      "template.customTemplate": candidate.customTemplate,
      "template.sectionOrder": candidate.sectionOrder,
      "template.pageSize": candidate.pageSize,
      "template.columns": candidate.columns,
      "figures.policy": candidate.figurePolicy,
      "figures.items": candidate.figureItems,
      "equations.policy": candidate.equationPolicy,
      "equations.items": candidate.equationItems,
      "equations.derivationDetail": candidate.derivationDetail,
      "equations.proofRigor": candidate.proofRigor,
      "equations.notationConvention": candidate.notationConvention,
      "equations.numbering": candidate.equationNumbering,
      "sources.policy": candidate.sourcePolicy,
      "sources.citationStyle": candidate.citationStyle,
      "sources.minimumCount": candidate.minimumSourceCount,
      "sources.dateRange": candidate.sourceDateRange,
      "sources.requiredLocators": candidate.requiredLocators,
      "tone.register": candidate.toneRegister,
      "tone.voice": candidate.toneVoice,
      "tone.jargonLevel": candidate.jargonLevel,
      "tone.sentenceStyle": candidate.sentenceStyle,
      "constraints.mustInclude": candidate.mustInclude,
      "constraints.mustExclude": candidate.mustExclude,
      "constraints.factualUncertaintyPolicy":
        candidate.factualUncertaintyPolicy,
      "constraints.additional": candidate.additionalConstraints,
      acceptanceCriteria: candidate.acceptanceCriteria,
    } satisfies Record<RequirementPath, unknown>;
    return values[path];
  };

  const groundedInQuote = (value: unknown, quote: string): boolean => {
    if (typeof value === "string") {
      const expected = normalized(value).toLocaleLowerCase();
      return expected.length > 0 && normalized(quote).toLocaleLowerCase().includes(expected);
    }
    if (typeof value === "number") {
      return new RegExp(`(?:^|\\D)${value}(?:\\D|$)`, "u").test(
        quote.normalize("NFKC"),
      );
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return /^(?:特に)?(?:なし|ありません|ないです|不要です?)[。.!！\s]*$/u.test(
          quote.normalize("NFKC").trim(),
        );
      }
      return value.every((item) => groundedInQuote(item, quote));
    }
    return false;
  };

  return new Set(
    extraction.evidence
      .filter((item) => {
        if (!answer.includes(normalized(item.quote))) return false;
        const modelValue = extractedValue(extraction, item.path);
        const conservativeValue = extractedValue(conservative, item.path);
        if (
          conservativePaths.has(item.path) &&
          JSON.stringify(modelValue) === JSON.stringify(conservativeValue)
        ) {
          return true;
        }
        if (strictlyParsedPaths.has(item.path)) return false;
        return groundedInQuote(modelValue, item.quote);
      })
      .map((item) => item.path),
  );
}

function applyProvidedExtraction(input: {
  brief: DocumentBrief;
  extraction: BriefExtraction;
  answerText: string;
  runId: string;
  now: string;
  question: ElicitationQuestion | null;
}): DocumentBrief {
  const brief = structuredClone(input.brief);
  const before = JSON.stringify(brief);
  const explicit = evidencePaths(
    input.extraction,
    input.answerText,
    input.question,
  );
  const set = <T>(
    path: RequirementPath,
    value: T | null,
    assign: (requirement: RequirementValue<T>) => void,
  ) => {
    if (!explicit.has(path) || value === null) return;
    assign(provided(value, input.runId, input.now));
  };
  const setList = (
    path: RequirementPath,
    value: string[],
    assign: (requirement: RequirementValue<string[]>) => void,
  ) => {
    if (!explicit.has(path)) return;
    assign(provided(value, input.runId, input.now));
  };

  set("goal.subject", input.extraction.subject, (value) => {
    brief.goal.subject = value;
  });
  set("goal.purpose", input.extraction.purpose, (value) => {
    brief.goal.purpose = value;
  });
  set("goal.audience", input.extraction.audience, (value) => {
    brief.goal.audience = value;
  });
  set("goal.intendedOutcome", input.extraction.intendedOutcome, (value) => {
    brief.goal.intendedOutcome = value;
  });
  setList("scope.includedTopics", input.extraction.includedTopics, (value) => {
    brief.scope.includedTopics = value;
  });
  setList("scope.excludedTopics", input.extraction.excludedTopics, (value) => {
    brief.scope.excludedTopics = value;
  });
  set("scope.depth", input.extraction.depth, (value) => {
    brief.scope.depth = value;
  });
  set("scope.targetLength", input.extraction.targetLength, (value) => {
    brief.scope.targetLength = value;
  });
  set("scope.language", input.extraction.language, (value) => {
    brief.scope.language = value;
  });
  set("template.family", input.extraction.templateFamily, (value) => {
    brief.template.family = value;
  });
  set("template.customTemplate", input.extraction.customTemplate, (value) => {
    if (value.value !== null && !isRawTemplateRequest(value.value)) {
      brief.template.customTemplate = value;
    }
  });
  setList("template.sectionOrder", input.extraction.sectionOrder, (value) => {
    brief.template.sectionOrder = value;
  });
  set("template.pageSize", input.extraction.pageSize, (value) => {
    brief.template.pageSize = value;
  });
  set("template.columns", input.extraction.columns, (value) => {
    brief.template.columns = value;
  });
  set("figures.policy", input.extraction.figurePolicy, (value) => {
    brief.figures.policy = value;
  });
  setList("figures.items", input.extraction.figureItems, (value) => {
    brief.figures.items = value;
  });
  set("equations.policy", input.extraction.equationPolicy, (value) => {
    brief.equations.policy = value;
  });
  setList("equations.items", input.extraction.equationItems, (value) => {
    brief.equations.items = value;
  });
  set(
    "equations.derivationDetail",
    input.extraction.derivationDetail,
    (value) => {
      brief.equations.derivationDetail = value;
    },
  );
  set("equations.proofRigor", input.extraction.proofRigor, (value) => {
    brief.equations.proofRigor = value;
  });
  set(
    "equations.notationConvention",
    input.extraction.notationConvention,
    (value) => {
      brief.equations.notationConvention = value;
    },
  );
  set(
    "equations.numbering",
    input.extraction.equationNumbering,
    (value) => {
      brief.equations.numbering = value;
    },
  );
  set("sources.policy", input.extraction.sourcePolicy, (value) => {
    brief.sources.policy = value;
  });
  set("sources.citationStyle", input.extraction.citationStyle, (value) => {
    brief.sources.citationStyle = value;
  });
  set("sources.minimumCount", input.extraction.minimumSourceCount, (value) => {
    brief.sources.minimumCount = value;
  });
  set("sources.dateRange", input.extraction.sourceDateRange, (value) => {
    brief.sources.dateRange = value;
  });
  setList(
    "sources.requiredLocators",
    input.extraction.requiredLocators,
    (value) => {
      brief.sources.requiredLocators = value;
    },
  );
  set("tone.register", input.extraction.toneRegister, (value) => {
    brief.tone.register = value;
  });
  set("tone.voice", input.extraction.toneVoice, (value) => {
    brief.tone.voice = value;
  });
  set("tone.jargonLevel", input.extraction.jargonLevel, (value) => {
    brief.tone.jargonLevel = value;
  });
  set("tone.sentenceStyle", input.extraction.sentenceStyle, (value) => {
    brief.tone.sentenceStyle = value;
  });
  setList("constraints.mustInclude", input.extraction.mustInclude, (value) => {
    brief.constraints.mustInclude = value;
  });
  setList("constraints.mustExclude", input.extraction.mustExclude, (value) => {
    brief.constraints.mustExclude = value;
  });
  set(
    "constraints.factualUncertaintyPolicy",
    input.extraction.factualUncertaintyPolicy,
    (value) => {
      brief.constraints.factualUncertaintyPolicy = value;
    },
  );
  setList(
    "constraints.additional",
    input.extraction.additionalConstraints,
    (value) => {
      brief.constraints.additional = value;
    },
  );

  if (explicit.has("acceptanceCriteria")) {
    brief.acceptanceCriteria = input.extraction.acceptanceCriteria.map(
      (statement, index) => ({
        id: deterministicBriefId(
          `${brief.documentId}:${input.runId}:acceptance:${index}:${statement}`,
        ),
        statement,
        kind: "user_review" as const,
        severity: "required" as const,
      }),
    );
  }

  normalizeDependentRequirements(brief, input.now);
  if (JSON.stringify(brief) !== before) {
    brief.updatedAt = input.now;
  }
  return DocumentBriefSchema.parse(brief);
}

function reopenIfNotApplicable<T>(
  requirement: RequirementValue<T>,
  now: string,
): RequirementValue<T> {
  return requirement.status === "not_applicable" ? unknown<T>(now) : requirement;
}

function normalizeDependentRequirements(brief: DocumentBrief, now: string) {
  if (brief.figures.policy.value === "none") {
    brief.figures.items = keepOrMarkNotApplicable(brief.figures.items, now);
  } else if (brief.figures.policy.value !== null) {
    brief.figures.items = reopenIfNotApplicable(brief.figures.items, now);
  }

  if (brief.equations.policy.value === "none") {
    brief.equations.items = keepOrMarkNotApplicable(
      brief.equations.items,
      now,
    );
    brief.equations.derivationDetail = keepOrMarkNotApplicable(
      brief.equations.derivationDetail,
      now,
    );
    brief.equations.proofRigor = keepOrMarkNotApplicable(
      brief.equations.proofRigor,
      now,
    );
    brief.equations.notationConvention = keepOrMarkNotApplicable(
      brief.equations.notationConvention,
      now,
    );
    brief.equations.numbering = keepOrMarkNotApplicable(
      brief.equations.numbering,
      now,
    );
  } else if (brief.equations.policy.value !== null) {
    brief.equations.items = reopenIfNotApplicable(
      brief.equations.items,
      now,
    );
    brief.equations.derivationDetail = reopenIfNotApplicable(
      brief.equations.derivationDetail,
      now,
    );
    brief.equations.proofRigor = reopenIfNotApplicable(
      brief.equations.proofRigor,
      now,
    );
    brief.equations.notationConvention = reopenIfNotApplicable(
      brief.equations.notationConvention,
      now,
    );
    brief.equations.numbering = reopenIfNotApplicable(
      brief.equations.numbering,
      now,
    );
  }

  if (brief.sources.policy.value === "none") {
    brief.sources.citationStyle = keepOrMarkNotApplicable(
      brief.sources.citationStyle,
      now,
    );
    brief.sources.minimumCount = keepOrMarkNotApplicable(
      brief.sources.minimumCount,
      now,
    );
    brief.sources.dateRange = keepOrMarkNotApplicable(
      brief.sources.dateRange,
      now,
    );
    brief.sources.requiredLocators = keepOrMarkNotApplicable(
      brief.sources.requiredLocators,
      now,
    );
  } else if (brief.sources.policy.value !== null) {
    brief.sources.citationStyle = reopenIfNotApplicable(
      brief.sources.citationStyle,
      now,
    );
    brief.sources.minimumCount = reopenIfNotApplicable(
      brief.sources.minimumCount,
      now,
    );
    brief.sources.dateRange = reopenIfNotApplicable(
      brief.sources.dateRange,
      now,
    );
    brief.sources.requiredLocators = reopenIfNotApplicable(
      brief.sources.requiredLocators,
      now,
    );
  }

  if (brief.template.family.value !== "custom") {
    brief.template.customTemplate = keepOrMarkNotApplicable(
      brief.template.customTemplate,
      now,
    );
  } else {
    brief.template.customTemplate = reopenIfNotApplicable(
      brief.template.customTemplate,
      now,
    );
  }
}

function addDelegationAssumption(
  brief: DocumentBrief,
  group: RequirementGroup,
  runId: string,
) {
  if (brief.assumptions.some((assumption) => assumption.path === group)) return;
  const labels: Record<RequirementGroup, string> = {
    subject: "主題",
    purpose_audience: "目的と読者",
    scope_structure: "範囲と構成",
    sources_evidence: "出典方針",
    mathematics: "数式の扱い",
    visuals: "図表の扱い",
    presentation: "体裁と語調",
    acceptance: "完成条件",
  };
  brief.assumptions.push({
    id: deterministicBriefId(`${brief.documentId}:${runId}:delegated:${group}`),
    path: group,
    statement: `${labels[group]}は推奨設定に委任されました。`,
    risk: group === "sources_evidence" ? "medium" : "low",
    acceptedByRunId: runId,
  });
}

function delegateGroup(
  brief: DocumentBrief,
  group: RequirementGroup,
  runId: string,
  now: string,
) {
  const deliverable = brief.goal.deliverable.value ?? "article";
  const subject = brief.goal.subject.value ?? "対象テーマ";
  switch (group) {
    case "subject":
      return;
    case "purpose_audience":
      brief.goal.purpose = delegateUnknown(
        brief.goal.purpose,
        deliverable === "proposal"
          ? `${subject}の課題に対する実行可能な提案と価値を示す`
          : `${subject}の主要な論点を整理し、根拠に基づいて説明する`,
        runId,
        now,
      );
      brief.goal.audience = delegateUnknown(
        brief.goal.audience,
        deliverable === "paper"
          ? "大学生以上の読者"
          : deliverable === "proposal"
            ? "提案を判断する意思決定者"
            : "対象分野の一般読者",
        runId,
        now,
      );
      brief.goal.intendedOutcome = delegateUnknown(
        brief.goal.intendedOutcome,
        deliverable === "proposal"
          ? `${subject}の提案価値と実行条件を判断できる`
          : `${subject}の要点と判断材料を説明できる`,
        runId,
        now,
      );
      break;
    case "scope_structure":
      brief.scope.includedTopics = delegateUnknown(
        brief.scope.includedTopics,
        deliverable === "proposal"
          ? [`${subject}の課題`, "提案内容", "期待効果", "実施計画"]
          : [`${subject}の背景`, "主要な論点", "結論"],
        runId,
        now,
      );
      brief.scope.excludedTopics = delegateUnknown(
        brief.scope.excludedTopics,
        [],
        runId,
        now,
      );
      brief.scope.depth = delegateUnknown(
        brief.scope.depth,
        deliverable === "paper" ? "technical" : "explanatory",
        runId,
        now,
      );
      brief.scope.targetLength = delegateUnknown(
        brief.scope.targetLength,
        deliverable === "paper" ? "6000〜10000文字" : "3000〜5000文字",
        runId,
        now,
      );
      brief.scope.language = delegateUnknown(
        brief.scope.language,
        "日本語",
        runId,
        now,
      );
      brief.template.sectionOrder = delegateUnknown(
        brief.template.sectionOrder,
        deliverable === "paper"
          ? ["要旨", "背景", "方法または理論", "考察", "結論", "参考文献"]
          : deliverable === "proposal"
            ? ["課題", "提案内容", "期待効果", "実施計画", "次のステップ"]
          : ["概要", "本文", "まとめ"],
        runId,
        now,
      );
      break;
    case "sources_evidence":
      brief.sources.policy = delegateUnknown(
        brief.sources.policy,
        deliverable === "paper" ? "agent_research" : "mixed",
        runId,
        now,
      );
      if (
        brief.sources.citationStyle.status === "unknown" ||
        !["author-year", "apa7", "ieee", "numeric"].includes(
          brief.sources.citationStyle.value ?? "",
        )
      ) {
        brief.sources.citationStyle = delegated(
          "author-year",
          runId,
          now,
        );
      }
      brief.sources.minimumCount = delegateUnknown(
        brief.sources.minimumCount,
        deliverable === "paper" ? 5 : 3,
        runId,
        now,
      );
      brief.sources.dateRange = delegateUnknown(
        brief.sources.dateRange,
        "基礎文献と直近5年の研究を優先",
        runId,
        now,
      );
      brief.sources.requiredLocators = delegateUnknown(
        brief.sources.requiredLocators,
        [],
        runId,
        now,
      );
      break;
    case "mathematics":
      brief.equations.policy = delegateUnknown(
        brief.equations.policy,
        "as_needed",
        runId,
        now,
      );
      brief.equations.items = delegateUnknown(
        brief.equations.items,
        [
          `${subject}で必要となる数式を特定し、前提と記号の定義から結論まで導出する`,
        ],
        runId,
        now,
      );
      brief.equations.derivationDetail = delegateUnknown(
        brief.equations.derivationDetail,
        "key_steps",
        runId,
        now,
      );
      brief.equations.proofRigor = delegateUnknown(
        brief.equations.proofRigor,
        "standard",
        runId,
        now,
      );
      brief.equations.notationConvention = delegateUnknown(
        brief.equations.notationConvention,
        "記号を初出時に定義し、本文内で統一する",
        runId,
        now,
      );
      brief.equations.numbering = delegateUnknown(
        brief.equations.numbering,
        "important_only",
        runId,
        now,
      );
      break;
    case "visuals":
      brief.figures.policy = delegateUnknown(
        brief.figures.policy,
        "agent_proposes",
        runId,
        now,
      );
      brief.figures.items = delegateUnknown(
        brief.figures.items,
        [],
        runId,
        now,
      );
      break;
    case "presentation":
      if (
        brief.template.family.status === "unknown" ||
        (brief.template.family.value === "custom" &&
          resolveSafeCustomTemplatePreset(
            brief.template.customTemplate.value,
          ) === null)
      ) {
        brief.template.family = delegated(
          deliverable === "paper"
            ? "academic"
            : deliverable === "proposal"
              ? "business"
            : deliverable === "letter"
              ? "general"
              : deliverable === "notes"
                ? "compact"
                : deliverable === "report"
                  ? "business"
                  : "general",
          runId,
          now,
        );
      }
      if (brief.template.family.value !== "custom") {
        brief.template.customTemplate = keepOrMarkNotApplicable(
          brief.template.customTemplate,
          now,
        );
      }
      brief.template.pageSize = delegateUnknown(
        brief.template.pageSize,
        "A4",
        runId,
        now,
      );
      brief.template.columns = delegateUnknown(
        brief.template.columns,
        1,
        runId,
        now,
      );
      brief.tone.register = delegateUnknown(
        brief.tone.register,
        deliverable === "paper"
          ? "academic"
          : deliverable === "letter"
            ? "formal"
            : deliverable === "notes"
              ? "plain"
              : "professional",
        runId,
        now,
      );
      brief.tone.voice = delegateUnknown(
        brief.tone.voice,
        deliverable === "proposal"
          ? "persuasive"
          : deliverable === "paper" || deliverable === "report"
            ? "analytical"
            : "neutral",
        runId,
        now,
      );
      brief.tone.jargonLevel = delegateUnknown(
        brief.tone.jargonLevel,
        deliverable === "paper" ? "high" : "moderate",
        runId,
        now,
      );
      brief.tone.sentenceStyle = delegateUnknown(
        brief.tone.sentenceStyle,
        "balanced",
        runId,
        now,
      );
      break;
    case "acceptance":
      brief.constraints.mustInclude = delegateUnknown(
        brief.constraints.mustInclude,
        [],
        runId,
        now,
      );
      brief.constraints.mustExclude = delegateUnknown(
        brief.constraints.mustExclude,
        [],
        runId,
        now,
      );
      brief.constraints.factualUncertaintyPolicy = delegateUnknown(
        brief.constraints.factualUncertaintyPolicy,
        "mark_uncertainty",
        runId,
        now,
      );
      brief.constraints.additional = delegateUnknown(
        brief.constraints.additional,
        [],
        runId,
        now,
      );
      if (brief.acceptanceCriteria.length > 0) break;
      brief.acceptanceCriteria = [
        {
          statement: "確定した範囲と章立てを満たす",
          kind: "model_assessed" as const,
          severity: "preferred" as const,
        },
        {
          statement: "指定した図表・数式・出典方針を満たす",
          kind: "model_assessed" as const,
          severity: "preferred" as const,
        },
        {
          statement: "文書の構造と参照関係に問題がない",
          kind: "deterministic" as const,
          severity: "required" as const,
        },
      ].map((criterion, index) => ({
        id: deterministicBriefId(
          `${brief.documentId}:${runId}:delegated-acceptance:${index}`,
        ),
        ...criterion,
      }));
      break;
  }
  addDelegationAssumption(brief, group, runId);
  normalizeDependentRequirements(brief, now);
}

export function applyExplicitDelegation(input: {
  session: DocumentAgentSession;
  groups: readonly RequirementGroup[];
  delegatedByRunId: string;
  now: string;
}): DocumentAgentSession {
  const session = structuredClone(DocumentAgentSessionSchema.parse(input.session));
  if (session.lastProcessedRunId === input.delegatedByRunId) return session;
  if (session.activeQuestionId) {
    throw new BriefDomainError(
      "Answer the pending question through applyBriefExtraction before delegating requirements.",
    );
  }
  const before = JSON.stringify(session.brief);
  for (const group of new Set(input.groups)) {
    if (group === "subject" || !isRequirementGroupApplicable(session.brief, group)) {
      continue;
    }
    delegateGroup(session.brief, group, input.delegatedByRunId, input.now);
  }
  if (JSON.stringify(session.brief) !== before) {
    session.briefVersion += 1;
    session.confirmedBriefVersion = null;
    session.brief.updatedAt = input.now;
  }
  session.lastProcessedRunId = input.delegatedByRunId;
  session.stateVersion += 1;
  session.updatedAt = input.now;
  session.phase = "eliciting";
  return DocumentAgentSessionSchema.parse(session);
}

/**
 * Build-first intake: once the writing subject is provided, every remaining
 * requirement is delegated with its concrete default and the brief confirms
 * itself — the user goes from prompt to draft without an interrogation.
 * Returns null when the normal one-question flow should run instead: no
 * subject yet, a question already pending, an undelegatable gap, or a
 * user-provided figures mode the runtime cannot execute.
 */
export function autopilotDocumentBrief(input: {
  session: DocumentAgentSession;
  runId: string;
  now: string;
}): DocumentAgentSession | null {
  const original = DocumentAgentSessionSchema.parse(input.session);
  if (original.activeQuestionId) return null;
  if (original.confirmedBriefVersion === original.briefVersion) return null;
  if (original.brief.goal.subject.status !== "provided") return null;

  const session = structuredClone(original);
  const coverage = evaluateBriefCoverage(session.brief);
  if (!coverage.complete) {
    if (coverage.gaps.some((gap) => !gap.canDelegate)) return null;
    if (
      coverage.gaps.some((gap) => gap.group === "visuals") &&
      session.brief.figures.policy.value === "provided_only"
    ) {
      // The user explicitly chose supplied figures; do not silently override.
      return null;
    }
    const before = JSON.stringify(session.brief);
    for (const gap of coverage.gaps) {
      delegateGroup(session.brief, gap.group, input.runId, input.now);
    }
    if (JSON.stringify(session.brief) !== before) {
      session.briefVersion += 1;
      session.confirmedBriefVersion = null;
      session.brief.updatedAt = input.now;
    }
    if (!evaluateBriefCoverage(session.brief).complete) return null;
    session.stateVersion += 1;
    session.updatedAt = input.now;
  }

  return confirmDocumentBrief({
    session: DocumentAgentSessionSchema.parse(session),
    confirmedByRunId: input.runId,
    now: input.now,
  });
}

function resolveQuestion(
  session: DocumentAgentSession,
  questionId: string | undefined,
  runId: string,
): ElicitationQuestion | null {
  if (!session.activeQuestionId) {
    if (questionId) throw new BriefDomainError("No question is awaiting an answer.");
    return null;
  }
  const effectiveQuestionId = questionId ?? session.activeQuestionId;
  if (effectiveQuestionId !== session.activeQuestionId) {
    throw new BriefDomainError("The answer targets a different question.");
  }
  const question = session.questions.find((item) => item.id === effectiveQuestionId);
  if (!question || question.status !== "pending") {
    throw new BriefDomainError("The target question is no longer pending.");
  }
  question.status = "answered";
  question.answeredByRunId = runId;
  session.activeQuestionId = null;
  return question;
}

export function applyBriefExtraction(input: {
  session: DocumentAgentSession;
  extraction: BriefExtraction;
  answerText: string;
  runId: string;
  now: string;
  questionId?: string;
}): DocumentAgentSession {
  const original = DocumentAgentSessionSchema.parse(input.session);
  if (original.lastProcessedRunId === input.runId) return original;
  const session = structuredClone(original);
  const question = resolveQuestion(session, input.questionId, input.runId);
  const previousBrief = JSON.stringify(session.brief);
  session.brief = applyProvidedExtraction({
    brief: session.brief,
    extraction: input.extraction,
    answerText: input.answerText,
    runId: input.runId,
    now: input.now,
    question,
  });

  const explicitlyDelegated = isExplicitDelegationAnswer(input.answerText);
  if (explicitlyDelegated) {
    const requestedGroups =
      question?.target === "delegation_offer"
        ? evaluateBriefCoverage(session.brief).gaps
            .filter((gap) => gap.canDelegate)
            .map((gap) => gap.group)
        : input.extraction.delegatedGroups;
    for (const group of new Set(requestedGroups)) {
      if (
        group !== "subject" &&
        isRequirementGroupApplicable(session.brief, group)
      ) {
        delegateGroup(session.brief, group, input.runId, input.now);
      }
    }
  }

  const changed = JSON.stringify(session.brief) !== previousBrief;
  if (changed) {
    session.briefVersion += 1;
    session.confirmedBriefVersion = null;
    session.brief.updatedAt = input.now;
  }
  session.phase = "eliciting";
  session.lastProcessedRunId = input.runId;
  session.stateVersion += 1;
  session.updatedAt = input.now;
  if (question?.target === "delegation_offer") {
    session.consecutiveQuestionCount = 0;
  }

  const parsed = DocumentAgentSessionSchema.parse(session);
  if (
    question?.target === "brief_confirmation" &&
    question.briefVersion === parsed.briefVersion &&
    input.extraction.confirmsBrief &&
    isExplicitBriefConfirmation(input.answerText)
  ) {
    return confirmDocumentBrief({
      session: parsed,
      confirmedByRunId: input.runId,
      now: input.now,
    });
  }
  return parsed;
}

export function confirmDocumentBrief(input: {
  session: DocumentAgentSession;
  confirmedByRunId: string;
  now: string;
  questionId?: string;
}): DocumentAgentSession {
  const original = DocumentAgentSessionSchema.parse(input.session);
  if (
    original.lastProcessedRunId === input.confirmedByRunId &&
    original.confirmedBriefVersion === original.briefVersion
  ) {
    return original;
  }
  if (!evaluateBriefCoverage(original.brief).complete) {
    throw new BriefDomainError("The brief still has unresolved requirements.");
  }
  const session = structuredClone(original);
  if (session.activeQuestionId) {
    const question = resolveQuestion(
      session,
      input.questionId,
      input.confirmedByRunId,
    );
    if (question?.target !== "brief_confirmation") {
      throw new BriefDomainError("The active question is not brief confirmation.");
    }
  } else if (input.questionId) {
    throw new BriefDomainError("No brief confirmation is pending.");
  }
  session.confirmedBriefVersion = session.briefVersion;
  session.phase = "planning";
  session.activeQuestionId = null;
  session.consecutiveQuestionCount = 0;
  session.lastProcessedRunId = input.confirmedByRunId;
  session.stateVersion += 1;
  session.updatedAt = input.now;
  return DocumentAgentSessionSchema.parse(session);
}

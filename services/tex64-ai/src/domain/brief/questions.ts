import { evaluateBriefCoverage, type BriefCoverage, type BriefGap } from "./coverage";
import { createQuestionFingerprint, deterministicBriefId } from "./fingerprint";
import {
  DocumentAgentSessionSchema,
  ElicitationQuestionSchema,
  type DocumentAgentSession,
  type DocumentBrief,
  type ElicitationQuestion,
  type ElicitationTarget,
  type RequirementGroup,
  type RequirementPath,
} from "./schema";

export const QUESTION_FATIGUE_CHECKPOINT = 3;
export const TOTAL_QUESTION_FATIGUE_CHECKPOINT = 5;

type QuestionDraft = Pick<
  ElicitationQuestion,
  "kind" | "target" | "targetPaths" | "prompt" | "options" | "allowsFreeText"
>;

const DELIVERABLE_LABELS = {
  article: "記事",
  proposal: "提案書",
  report: "報告書",
  paper: "論文",
  letter: "書簡",
  notes: "ノート",
} as const;

function recommendOption(
  options: QuestionDraft["options"],
  recommendedId: string,
): QuestionDraft["options"] {
  return options.map((option) => ({
    ...option,
    recommended: option.id === recommendedId,
  }));
}

function inlineChoices(
  prompt: string,
  options: QuestionDraft["options"],
): string {
  if (options.length === 0) return prompt;
  const choices = options
    .map((option) =>
      option.recommended ? `${option.label}（おすすめ）` : option.label,
    )
    .join(" / ");
  return `${prompt}（${choices}）`;
}

function questionForPath(
  brief: DocumentBrief,
  gap: BriefGap,
  path: RequirementPath,
  attempt: number,
): QuestionDraft {
  const retryPrefix =
    attempt > 0
      ? "この条件だけ、もう少し具体的に教えてください。"
      : "";
  const deliverableKind = brief.goal.deliverable.value ?? "article";
  const deliverable = DELIVERABLE_LABELS[deliverableKind];
  const purposePrompt = {
    paper: "この論文で答える研究問いと、確かめたい主張は何ですか？",
    report: "この報告書で、誰のどの意思決定を支えますか？",
    proposal: "この提案で解決する課題と、提案の核は何ですか？",
    article: "この記事の切り口と、伝えたい中心メッセージは何ですか？",
    letter: "この書簡で依頼・伝達し、相手に何をしてほしいですか？",
    notes: "何の元資料を、何のために整理するノートですか？",
  }[deliverableKind];
  const audiencePrompt = {
    paper: "想定する研究分野と読者の専門水準を教えてください。",
    report: "この報告書を使って意思決定する読み手は誰ですか？",
    proposal: "この提案を判断する相手と、その人が重視する点は何ですか？",
    article: "この記事を読む人と、その人の予備知識を教えてください。",
    letter: "宛先は誰で、あなたとの関係は何ですか？",
    notes: "このノートを後で使う人と、その人の予備知識を教えてください。",
  }[deliverableKind];
  const outcomePrompt = {
    paper: "読後に、研究上の何を判断・再現できる状態にしますか？",
    report: "読後に、読み手がどの意思決定や行動を取れる状態にしますか？",
    proposal: "読後に、相手からどの承認・判断・行動を得たいですか？",
    article: "読後に取ってほしい行動、または残したい理解は何ですか？",
    letter: "相手から必要な返答・判断・行動は何ですか？",
    notes: "このノートを見返したとき、何をすぐ確認・再利用できる状態にしますか？",
  }[deliverableKind];
  const includedTopicsPrompt = {
    paper:
      "研究問いに答えるため、方法・データ・結果・限界のどれを扱いますか？具体的に挙げてください。",
    report:
      "意思決定に必要な根拠・分析・提言を具体的に挙げてください。",
    proposal:
      "提案に必要な課題、解決策、期待効果、実施方法を具体的に挙げてください。",
    article:
      "その切り口を伝えるための論点・事例・具体例を挙げてください。",
    letter:
      "依頼・伝達に必要な背景、要件、期限、連絡事項を挙げてください。",
    notes:
      "元資料と、比較・時系列・論点などの整理軸を挙げてください。",
  }[deliverableKind];
  const draft = (
    kind: QuestionDraft["kind"],
    prompt: string,
    options: QuestionDraft["options"] = [],
  ): QuestionDraft => {
    return {
      kind,
      target: gap.group,
      targetPaths: [path],
      prompt: inlineChoices(`${retryPrefix}${prompt}`, options).slice(0, 500),
      options,
      allowsFreeText: true,
    };
  };

  switch (path) {
    case "goal.subject":
      return draft(
        "free_text",
        `${deliverable}の主題は何ですか？具体的な題材を教えてください。`,
      );
    case "goal.purpose":
      return draft("free_text", purposePrompt);
    case "goal.audience":
      return draft("free_text", audiencePrompt);
    case "goal.intendedOutcome":
      return draft("free_text", outcomePrompt);
    case "scope.includedTopics":
      return draft("free_text", includedTopicsPrompt);
    case "scope.excludedTopics":
      return draft(
        "free_text",
        "扱わない範囲はありますか？なければ「なし」と答えてください。",
      );
    case "scope.depth":
      return draft("single_choice", "説明の深さはどれにしますか？", [
        { id: "overview", label: "全体像を簡潔に", recommended: false },
        { id: "explanatory", label: "わかりやすく解説", recommended: true },
        { id: "technical", label: "専門的・技術的", recommended: false },
        { id: "exhaustive", label: "網羅的に詳しく", recommended: false },
      ]);
    case "scope.targetLength":
      return draft(
        "free_text",
        "おおよその長さは何ページ、または何文字にしますか？",
      );
    case "scope.language":
      return draft("single_choice", "本文は何語で書きますか？", [
        { id: "ja", label: "日本語", recommended: true },
        { id: "en", label: "英語", recommended: false },
      ]);
    case "template.sectionOrder":
      return draft(
        "free_text",
        "章や節をどの順番にしますか？見出しを順に挙げてください。",
      );
    case "sources.policy":
      return draft("single_choice", "根拠に使う資料はどうしますか？", [
        { id: "agent_research", label: "文献を調べる", recommended: true },
        { id: "mixed", label: "指定資料と調査の両方", recommended: false },
        { id: "user_only", label: "指定資料のみ", recommended: false },
        { id: "none", label: "出典なし", recommended: false },
      ]);
    case "sources.citationStyle":
      return draft("single_choice", "引用・参考文献の形式はどれにしますか？", [
        { id: "author-year", label: "著者年方式", recommended: true },
        { id: "numeric", label: "番号方式", recommended: false },
        { id: "apa7", label: "APA第7版", recommended: false },
        { id: "ieee", label: "IEEE", recommended: false },
      ]);
    case "sources.minimumCount":
      return draft(
        "free_text",
        "参考文献は最低何件必要ですか？件数を答えてください。",
      );
    case "sources.dateRange":
      return draft(
        "free_text",
        "文献の年代に条件はありますか？なければ「なし」と答えてください。",
      );
    case "sources.requiredLocators":
      return draft(
        "free_text",
        "必ず使う資料のURLまたはDOIを挙げてください。",
      );
    case "equations.policy":
      return draft("single_choice", "数式をどの程度使いますか？", [
        { id: "as_needed", label: "必要な箇所だけ", recommended: true },
        { id: "required", label: "主要部分に必ず入れる", recommended: false },
        { id: "none", label: "数式なし", recommended: false },
      ]);
    case "equations.items":
      return draft(
        "free_text",
        "扱う数式、証明、または導出したい結論を具体的に挙げてください。",
      );
    case "equations.derivationDetail":
      return draft("single_choice", "式変形はどこまで示しますか？", [
        { id: "key_steps", label: "主要な式変形まで", recommended: true },
        { id: "full_derivation", label: "前提から完全に導出", recommended: false },
        { id: "result_only", label: "結果だけ", recommended: false },
      ]);
    case "equations.proofRigor":
      return draft("single_choice", "証明や説明の厳密さはどれにしますか？", [
        { id: "standard", label: "標準的", recommended: true },
        { id: "formal", label: "厳密・形式的", recommended: false },
        { id: "intuitive", label: "直感を重視", recommended: false },
      ]);
    case "equations.notationConvention":
      return draft(
        "free_text",
        "従う記号・記法の決まりはありますか？なければ「なし」と答えてください。",
      );
    case "equations.numbering":
      return draft("single_choice", "式番号をどこに付けますか？", [
        { id: "important_only", label: "重要な式だけ", recommended: true },
        { id: "all", label: "すべての式", recommended: false },
        { id: "none", label: "付けない", recommended: false },
      ]);
    case "figures.policy":
      return brief.figures.policy.value === "provided_only"
        ? draft(
            "single_choice",
            "内容に合う図を作るか、図表を使わないかを選んでください。",
            [
              {
                id: "agent_proposes",
                label: "内容に合う図を作る",
                recommended: true,
              },
              { id: "none", label: "図表なし", recommended: false },
            ],
          )
        : draft("single_choice", "図表はどうしますか？", [
            {
              id: "agent_proposes",
              label: "必要に応じて提案",
              recommended: true,
            },
            {
              id: "required",
              label: "指定する図表を入れる",
              recommended: false,
            },
            { id: "none", label: "図表なし", recommended: false },
          ]);
    case "figures.items":
      return draft(
        "free_text",
        "入れる図・グラフ・表を具体的に挙げてください。",
      );
    case "template.family":
      return draft(
        "single_choice",
        brief.template.family.value === "custom"
          ? "仕上がりに近い形式を選んでください。"
          : "文書の形式はどれにしますか？",
        recommendOption([
          { id: "general", label: "標準", recommended: true },
          { id: "academic", label: "学術", recommended: false },
          { id: "business", label: "ビジネス", recommended: false },
          { id: "compact", label: "コンパクト", recommended: false },
        ], {
          paper: "academic",
          proposal: "business",
          report: "business",
          article: "general",
          letter: "general",
          notes: "compact",
        }[deliverableKind]),
      );
    case "template.customTemplate":
      return draft(
        "single_choice",
        "希望する仕上がりを言葉で指定するか、近い形式を選んでください。",
        recommendOption([
          { id: "general", label: "標準", recommended: true },
          { id: "academic", label: "学術", recommended: false },
          { id: "business", label: "ビジネス", recommended: false },
          { id: "compact", label: "コンパクト", recommended: false },
        ], {
          paper: "academic",
          proposal: "business",
          report: "business",
          article: "general",
          letter: "general",
          notes: "compact",
        }[deliverableKind]),
      );
    case "template.pageSize":
      return draft("single_choice", "用紙サイズはどれにしますか？", [
        { id: "A4", label: "A4", recommended: true },
        { id: "A3", label: "A3", recommended: false },
        { id: "A5", label: "A5", recommended: false },
        { id: "B4", label: "B4", recommended: false },
        { id: "B5", label: "B5", recommended: false },
        { id: "letter", label: "レター", recommended: false },
      ]);
    case "template.columns":
      return draft("single_choice", "段組みはどちらにしますか？", [
        { id: "1", label: "1段", recommended: true },
        { id: "2", label: "2段", recommended: false },
      ]);
    case "tone.register":
      return draft("single_choice", "文章の口調はどれにしますか？", recommendOption([
        { id: "plain", label: "平易", recommended: false },
        { id: "professional", label: "専門的", recommended: true },
        { id: "academic", label: "学術的", recommended: false },
        { id: "formal", label: "格式ある表現", recommended: false },
      ], {
        paper: "academic",
        proposal: "professional",
        report: "professional",
        article: "professional",
        letter: "formal",
        notes: "plain",
      }[deliverableKind]));
    case "tone.voice":
      return draft("single_choice", "文章の語り方はどれにしますか？", recommendOption([
        { id: "neutral", label: "中立・客観的", recommended: true },
        { id: "analytical", label: "分析的", recommended: false },
        { id: "assertive", label: "明確に言い切る", recommended: false },
        { id: "persuasive", label: "説得的", recommended: false },
      ], {
        paper: "analytical",
        proposal: "persuasive",
        report: "analytical",
        article: "neutral",
        letter: "neutral",
        notes: "neutral",
      }[deliverableKind]));
    case "tone.jargonLevel":
      return draft("single_choice", "専門用語の量はどれにしますか？", [
        { id: "low", label: "少なめ", recommended: false },
        { id: "moderate", label: "必要な範囲", recommended: true },
        { id: "high", label: "多め", recommended: false },
      ]);
    case "tone.sentenceStyle":
      return draft("single_choice", "文の詳しさはどれにしますか？", [
        { id: "concise", label: "簡潔", recommended: false },
        { id: "balanced", label: "簡潔さと詳しさの両方", recommended: true },
        { id: "detailed", label: "丁寧に詳しく", recommended: false },
      ]);
    case "constraints.mustInclude":
      return draft(
        "free_text",
        "必ず含める内容はありますか？なければ「なし」と答えてください。",
      );
    case "constraints.mustExclude":
      return draft(
        "free_text",
        "絶対に含めない内容はありますか？なければ「なし」と答えてください。",
      );
    case "constraints.factualUncertaintyPolicy":
      return draft("single_choice", "確認できない事実はどう扱いますか？", [
        { id: "mark_uncertainty", label: "不確実と明記", recommended: true },
        { id: "omit_unverified", label: "確認できない内容は省く", recommended: false },
        { id: "ask_user", label: "その都度確認する", recommended: false },
      ]);
    case "constraints.additional":
      return draft(
        "free_text",
        "ほかに守る条件はありますか？なければ「なし」と答えてください。",
      );
    case "acceptanceCriteria":
      return draft(
        "free_text",
        "どの状態になれば完成と判断できますか？確認できる条件を挙げてください。",
      );
    default: {
      const unreachable: never = path;
      return {
        kind: "free_text",
        target: gap.group,
        targetPaths: [unreachable],
        prompt: `${retryPrefix}希望する条件を教えてください。`,
        options: [],
        allowsFreeText: true,
      };
    }
  }
}

function delegationOffer(gaps: readonly BriefGap[]): QuestionDraft {
  const options = [
    { id: "delegate", label: "推奨設定で進める", recommended: true },
    { id: "continue", label: "さらに条件を決める", recommended: false },
  ];
  return {
    kind: "confirm",
    target: "delegation_offer",
    targetPaths: gaps.flatMap((gap) => gap.missingPaths),
    prompt: inlineChoices(
      "主な方向性は見えてきました。残りは推奨設定に任せて進めますか？ さらに詰めたい場合は、そのまま条件を教えてください。",
      options,
    ),
    options,
    allowsFreeText: true,
  };
}

function revisionQuestion(attempt: number): QuestionDraft {
  return {
    kind: "free_text",
    target: "brief_revision",
    targetPaths: [],
    prompt: `${attempt > 0 ? "変更内容をまだ特定できませんでした。" : ""}変更したい条件を1つ、具体的に教えてください。`.slice(0, 500),
    options: [],
    allowsFreeText: true,
  };
}

function confirmationQuestion(summary: string, attempt: number): QuestionDraft {
  const prefix = attempt > 0 ? "更新した条件です。" : "";
  const options = [
    { id: "confirm", label: "この条件で進める", recommended: true },
    { id: "revise", label: "条件を変更する", recommended: false },
  ];
  const prompt = inlineChoices(
    `${prefix}この条件で執筆を進めますか？ ${summary}`,
    options,
  ).slice(0, 500);
  return {
    kind: "confirm",
    target: "brief_confirmation",
    targetPaths: [],
    prompt,
    options,
    allowsFreeText: true,
  };
}

function activeQuestion(session: DocumentAgentSession): ElicitationQuestion | null {
  if (!session.activeQuestionId) return null;
  return (
    session.questions.find((question) => question.id === session.activeQuestionId) ??
    null
  );
}

function askedCount(
  session: DocumentAgentSession,
  group: RequirementGroup,
  path?: RequirementPath,
): number {
  return session.questions.filter(
    (question) =>
      question.target === group &&
      (path === undefined || question.targetPaths.includes(path)),
  ).length;
}

function hasAskedTarget(
  session: DocumentAgentSession,
  target: ElicitationTarget,
): boolean {
  return session.questions.some((question) => question.target === target);
}

function needsFatigueCheckpoint(
  session: DocumentAgentSession,
  coverage: BriefCoverage,
): boolean {
  if (!coverage.gaps.some((gap) => gap.canDelegate)) return false;
  if (hasAskedTarget(session, "delegation_offer")) return false;
  return (
    session.consecutiveQuestionCount >= QUESTION_FATIGUE_CHECKPOINT ||
    session.questionCount >= TOTAL_QUESTION_FATIGUE_CHECKPOINT ||
    coverage.gaps.every(
      (gap) =>
        !gap.canDelegate ||
        gap.missingPaths.every(
          (path) => askedCount(session, gap.group, path) > 0,
        ),
    )
  );
}

function questionFromDraft(input: {
  session: DocumentAgentSession;
  sourceRunId: string;
  now: string;
  draft: QuestionDraft;
}): ElicitationQuestion {
  const fingerprint = createQuestionFingerprint(input.draft);
  return ElicitationQuestionSchema.parse({
    ...input.draft,
    id: deterministicBriefId(
      `${input.session.id}:question:${input.session.questionCount}:${fingerprint}`,
    ),
    fingerprint,
    status: "pending",
    sourceRunId: input.sourceRunId,
    briefVersion: input.session.briefVersion,
    answeredByRunId: null,
    createdAt: input.now,
  });
}

function addQuestion(
  original: DocumentAgentSession,
  question: ElicitationQuestion,
  now: string,
): DocumentAgentSession {
  const session = structuredClone(original);
  session.questions.push(question);
  session.questionCount = session.questions.length;
  session.consecutiveQuestionCount += 1;
  session.activeQuestionId = question.id;
  session.phase =
    question.target === "brief_confirmation"
      ? "awaiting_brief_confirmation"
      : "awaiting_answer";
  session.stateVersion += 1;
  session.updatedAt = now;
  return DocumentAgentSessionSchema.parse(session);
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function fitSummaryParts(parts: readonly string[], maximum: number): string {
  const fitted = parts.map((part) => truncate(part, 140));
  const joined = () => fitted.join(" / ");
  while (joined().length > maximum) {
    let longestIndex = -1;
    for (let index = 0; index < fitted.length; index += 1) {
      const candidate = fitted[index];
      const longest = longestIndex >= 0 ? fitted[longestIndex] : undefined;
      if (
        candidate !== undefined &&
        candidate.length > 18 &&
        (longest === undefined || candidate.length > longest.length)
      ) {
        longestIndex = index;
      }
    }
    if (longestIndex < 0) return truncate(joined(), maximum);
    const current = fitted[longestIndex];
    if (current === undefined) return truncate(joined(), maximum);
    fitted[longestIndex] = truncate(current, current.length - 1);
  }
  return joined();
}

export function summarizeDocumentBrief(brief: DocumentBrief): string {
  const templateLabels = {
    general: "標準",
    academic: "論文",
    business: "業務文書",
    compact: "コンパクト",
    letter: "書簡",
    notes: "ノート",
    custom: "指定テンプレート",
  } as const;
  const sourceLabels = {
    none: "出典なし",
    user_only: "指定資料のみ",
    agent_research: "文献を調査",
    mixed: "指定資料と文献調査",
  } as const;
  const equationLabels = {
    none: "数式なし",
    as_needed: "必要な箇所に数式",
    required: "数式を含める",
  } as const;
  const derivationLabels = {
    result_only: "結果のみ",
    key_steps: "主要な式変形まで",
    full_derivation: "前提から完全に導出",
  } as const;
  const figureLabels = {
    none: "図表なし",
    agent_proposes: "必要に応じて図表を提案",
    required: "指定した図表を含める",
    provided_only: "提供された図表のみ",
  } as const;
  const registerLabels = {
    plain: "平易",
    professional: "専門的",
    academic: "学術的",
    formal: "格式ある表現",
  } as const;
  const depthLabels = {
    overview: "概要",
    explanatory: "解説",
    technical: "技術的",
    exhaustive: "網羅的",
  } as const;
  const proofLabels = {
    intuitive: "直感重視",
    standard: "標準",
    formal: "厳密",
  } as const;
  const numberingLabels = {
    none: "番号なし",
    important_only: "重要式に番号",
    all: "全式に番号",
  } as const;
  const voiceLabels = {
    neutral: "中立",
    assertive: "明確",
    analytical: "分析的",
    persuasive: "説得的",
  } as const;
  const jargonLabels = {
    low: "用語少なめ",
    moderate: "用語は必要な範囲",
    high: "用語多め",
  } as const;
  const sentenceLabels = {
    concise: "簡潔",
    balanced: "均衡",
    detailed: "詳しく",
  } as const;
  const uncertaintyLabels = {
    mark_uncertainty: "不確実と明記",
    omit_unverified: "未確認は省く",
    ask_user: "都度確認",
  } as const;
  const citationLabel = (value: string | null): string | null => {
    switch (value) {
      case "author-year":
        return "著者年方式";
      case "apa7":
        return "APA第7版";
      case "ieee":
        return "IEEE";
      case "numeric":
        return "番号方式";
      default:
        return value;
    }
  };
  const values = [
    brief.goal.subject.value ? `主題: ${brief.goal.subject.value}` : null,
    brief.goal.purpose.value ? `目的: ${brief.goal.purpose.value}` : null,
    brief.goal.audience.value ? `読者: ${brief.goal.audience.value}` : null,
    brief.goal.intendedOutcome.value
      ? `読後: ${brief.goal.intendedOutcome.value}`
      : null,
    brief.scope.includedTopics.value?.length
      ? `範囲: ${brief.scope.includedTopics.value.join("、")}`
      : null,
    brief.scope.excludedTopics.value?.length
      ? `除外: ${brief.scope.excludedTopics.value.join("、")}`
      : null,
    brief.scope.depth.value ||
    brief.scope.targetLength.value ||
    brief.scope.language.value
      ? `深さ・長さ: ${[
          brief.scope.depth.value
            ? depthLabels[brief.scope.depth.value]
            : null,
          brief.scope.targetLength.value,
          brief.scope.language.value,
        ]
          .filter((value) => value !== null)
          .join("・")}`
      : null,
    brief.template.family.value
      ? `形式: ${
          brief.template.family.value === "custom" &&
          brief.template.customTemplate.value
            ? brief.template.customTemplate.value
            : templateLabels[brief.template.family.value]
        }`
      : null,
    brief.template.sectionOrder.value?.length
      ? `構成: ${brief.template.sectionOrder.value.join("→")}`
      : null,
    brief.template.pageSize.value || brief.template.columns.value
      ? `版面: ${[
          brief.template.pageSize.value === "letter"
            ? "レター"
            : brief.template.pageSize.value,
          brief.template.columns.value
            ? `${brief.template.columns.value}段`
            : null,
        ]
          .filter((value) => value !== null)
          .join("・")}`
      : null,
    brief.sources.policy.value
      ? `出典: ${[
          sourceLabels[brief.sources.policy.value],
          citationLabel(brief.sources.citationStyle.value),
          brief.sources.minimumCount.value !== null
            ? `${brief.sources.minimumCount.value}件以上`
            : null,
          brief.sources.dateRange.value,
          brief.sources.requiredLocators.value?.length
            ? `指定資料${brief.sources.requiredLocators.value.length}件`
            : null,
        ]
          .filter((value) => value !== null)
          .join("・")}`
      : null,
    brief.equations.policy.value
      ? `数式: ${[
          equationLabels[brief.equations.policy.value],
          brief.equations.items.value?.length
            ? brief.equations.items.value.join("、")
            : null,
          brief.equations.derivationDetail.value
            ? derivationLabels[brief.equations.derivationDetail.value]
            : null,
          brief.equations.proofRigor.value
            ? proofLabels[brief.equations.proofRigor.value]
            : null,
          brief.equations.numbering.value
            ? numberingLabels[brief.equations.numbering.value]
            : null,
          brief.equations.notationConvention.value &&
          brief.equations.notationConvention.value !== "指定なし"
            ? brief.equations.notationConvention.value
            : null,
        ]
          .filter((value) => value !== null)
          .join("・")}`
      : null,
    brief.figures.policy.value
      ? `図表: ${[
          figureLabels[brief.figures.policy.value],
          brief.figures.items.value?.length
            ? brief.figures.items.value.join("、")
            : null,
        ]
          .filter((value): value is string => value !== null)
          .join("・")}`
      : null,
    brief.tone.register.value ||
    brief.tone.voice.value ||
    brief.tone.jargonLevel.value ||
    brief.tone.sentenceStyle.value
      ? `口調: ${[
          brief.tone.register.value
            ? registerLabels[brief.tone.register.value]
            : null,
          brief.tone.voice.value ? voiceLabels[brief.tone.voice.value] : null,
          brief.tone.jargonLevel.value
            ? jargonLabels[brief.tone.jargonLevel.value]
            : null,
          brief.tone.sentenceStyle.value
            ? sentenceLabels[brief.tone.sentenceStyle.value]
            : null,
        ]
          .filter((value) => value !== null)
          .join("・")}`
      : null,
    brief.constraints.mustInclude.value?.length
      ? `必須: ${brief.constraints.mustInclude.value.join("、")}`
      : null,
    brief.constraints.mustExclude.value?.length
      ? `禁止: ${brief.constraints.mustExclude.value.join("、")}`
      : null,
    brief.constraints.factualUncertaintyPolicy.value
      ? `未確認情報: ${
          uncertaintyLabels[
            brief.constraints.factualUncertaintyPolicy.value
          ]
        }`
      : null,
    brief.acceptanceCriteria.length
      ? `完成: ${brief.acceptanceCriteria
          .map((criterion) => criterion.statement)
          .join("、")}`
      : null,
  ].filter((value): value is string => value !== null);
  return fitSummaryParts(values, 430);
}

export type AdvanceElicitationResult = {
  session: DocumentAgentSession;
  question: ElicitationQuestion | null;
  ready: boolean;
  briefSummary: string;
  coverage: BriefCoverage;
};

export function advanceElicitation(input: {
  session: DocumentAgentSession;
  sourceRunId: string;
  now: string;
}): AdvanceElicitationResult {
  const original = DocumentAgentSessionSchema.parse(input.session);
  const summary = summarizeDocumentBrief(original.brief);
  const coverage = evaluateBriefCoverage(original.brief);
  const pending = activeQuestion(original);
  if (pending) {
    return {
      session: original,
      question: pending,
      ready: false,
      briefSummary: summary,
      coverage,
    };
  }

  const confirmed = original.confirmedBriefVersion === original.briefVersion;
  if (confirmed && !coverage.complete) {
    throw new Error("A confirmed brief cannot contain unresolved requirements.");
  }
  if (confirmed) {
    const session =
      original.phase === "intake" || original.phase === "eliciting"
        ? DocumentAgentSessionSchema.parse({ ...original, phase: "planning" })
        : original;
    return {
      session,
      question: null,
      ready: true,
      briefSummary: summary,
      coverage,
    };
  }

  let draft: QuestionDraft;
  const latestAnswered = [...original.questions]
    .reverse()
    .find((question) => question.status === "answered");
  const latestAnswerChangedBrief =
    latestAnswered !== undefined &&
    original.briefVersion > latestAnswered.briefVersion;
  if (coverage.complete) {
    if (
      (latestAnswered?.target === "brief_confirmation" ||
        latestAnswered?.target === "brief_revision") &&
      !latestAnswerChangedBrief
    ) {
      draft = revisionQuestion(
        original.questions.filter(
          (question) => question.target === "brief_revision",
        ).length,
      );
    } else {
      draft = confirmationQuestion(
        summary,
        original.questions.filter(
          (question) => question.target === "brief_confirmation",
        ).length,
      );
    }
  } else if (needsFatigueCheckpoint(original, coverage)) {
    draft = delegationOffer(coverage.gaps.filter((gap) => gap.canDelegate));
  } else {
    const candidates = coverage.gaps.flatMap((gap) =>
      gap.missingPaths.map((path) => ({
        gap,
        path,
        attempts: askedCount(original, gap.group, path),
      })),
    );
    const selected =
      candidates.find((candidate) => candidate.attempts === 0) ??
      candidates.sort((left, right) => left.attempts - right.attempts)[0];
    if (!selected) {
      throw new Error("Incomplete coverage must contain at least one gap.");
    }
    draft = questionForPath(
      original.brief,
      selected.gap,
      selected.path,
      selected.attempts,
    );
  }

  let question = questionFromDraft({ ...input, draft });
  if (original.questions.some((item) => item.fingerprint === question.fingerprint)) {
    if (draft.target === "brief_revision") {
      question = questionFromDraft({
        ...input,
        draft: revisionQuestion(
          original.questions.filter(
            (item) => item.target === "brief_revision",
          ).length + 1,
        ),
      });
    } else if (draft.target === "brief_confirmation") {
      question = questionFromDraft({
        ...input,
        draft: confirmationQuestion(
          summary,
          original.questions.filter(
            (item) => item.target === "brief_confirmation",
          ).length + 1,
        ),
      });
    } else {
      const path = draft.targetPaths[0];
      const unresolved = coverage.gaps.find(
        (gap) => path !== undefined && gap.missingPaths.includes(path),
      );
      if (!unresolved || path === undefined) {
        throw new Error("Duplicate question without a coverage gap.");
      }
      question = questionFromDraft({
        ...input,
        draft: questionForPath(
          original.brief,
          unresolved,
          path,
          askedCount(original, unresolved.group, path) + 1,
        ),
      });
    }
  }
  const session = addQuestion(original, question, input.now);
  return {
    session,
    question,
    ready: false,
    briefSummary: summary,
    coverage,
  };
}

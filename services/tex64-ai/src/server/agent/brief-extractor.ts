import { generateText, Output } from "ai";

import {
  BriefExtractionSchema,
  explicitlyDelegatedGroups,
  type BriefExtraction,
  type RequirementPath,
} from "@/domain/brief";
import { agentLanguageModel, agentOutputJson, agentProviderOptions, structuredAgentModel } from "./language-model";

export type BriefExtractionRuntime =
  | { provider: "ai_gateway"; model: string }
  | { provider: "deterministic_fallback"; model: null };

const EMPTY_EXTRACTION: BriefExtraction = BriefExtractionSchema.parse({
  subject: null,
  purpose: null,
  audience: null,
  intendedOutcome: null,
  includedTopics: [],
  excludedTopics: [],
  depth: null,
  targetLength: null,
  language: null,
  templateFamily: null,
  customTemplate: null,
  sectionOrder: [],
  pageSize: null,
  columns: null,
  figurePolicy: null,
  figureItems: [],
  equationPolicy: null,
  equationItems: [],
  derivationDetail: null,
  proofRigor: null,
  notationConvention: null,
  equationNumbering: null,
  sourcePolicy: null,
  citationStyle: null,
  minimumSourceCount: null,
  sourceDateRange: null,
  requiredLocators: [],
  toneRegister: null,
  toneVoice: null,
  jargonLevel: null,
  sentenceStyle: null,
  mustInclude: [],
  mustExclude: [],
  factualUncertaintyPolicy: null,
  additionalConstraints: [],
  acceptanceCriteria: [],
  delegatedGroups: [],
  confirmsBrief: false,
});

function mergeEvidenceBackedExtraction(
  primary: BriefExtraction,
  fallback: BriefExtraction,
): BriefExtraction {
  const primaryPaths = new Set(primary.evidence.map((item) => item.path));
  const scalar = <T>(
    path: RequirementPath,
    preferred: T | null,
    conservative: T | null,
  ): T | null =>
    primaryPaths.has(path) && preferred !== null ? preferred : conservative;
  const list = <T>(
    path: RequirementPath,
    preferred: T[],
    conservative: T[],
  ): T[] => (primaryPaths.has(path) ? preferred : conservative);
  const evidence = unique(
    [...primary.evidence, ...fallback.evidence].map((item) =>
      JSON.stringify(item),
    ),
  ).map((item) => JSON.parse(item) as BriefExtraction["evidence"][number]);

  return BriefExtractionSchema.parse({
    subject: scalar("goal.subject", primary.subject, fallback.subject),
    purpose: scalar("goal.purpose", primary.purpose, fallback.purpose),
    audience: scalar("goal.audience", primary.audience, fallback.audience),
    intendedOutcome: scalar(
      "goal.intendedOutcome",
      primary.intendedOutcome,
      fallback.intendedOutcome,
    ),
    includedTopics: list(
      "scope.includedTopics",
      primary.includedTopics,
      fallback.includedTopics,
    ),
    excludedTopics: list(
      "scope.excludedTopics",
      primary.excludedTopics,
      fallback.excludedTopics,
    ),
    depth: scalar("scope.depth", primary.depth, fallback.depth),
    targetLength: scalar(
      "scope.targetLength",
      primary.targetLength,
      fallback.targetLength,
    ),
    language: scalar("scope.language", primary.language, fallback.language),
    templateFamily: scalar(
      "template.family",
      primary.templateFamily,
      fallback.templateFamily,
    ),
    customTemplate: scalar(
      "template.customTemplate",
      primary.customTemplate,
      fallback.customTemplate,
    ),
    sectionOrder: list(
      "template.sectionOrder",
      primary.sectionOrder,
      fallback.sectionOrder,
    ),
    pageSize: scalar(
      "template.pageSize",
      primary.pageSize,
      fallback.pageSize,
    ),
    columns: scalar("template.columns", primary.columns, fallback.columns),
    figurePolicy: scalar(
      "figures.policy",
      primary.figurePolicy,
      fallback.figurePolicy,
    ),
    figureItems: list(
      "figures.items",
      primary.figureItems,
      fallback.figureItems,
    ),
    equationPolicy: scalar(
      "equations.policy",
      primary.equationPolicy,
      fallback.equationPolicy,
    ),
    equationItems: list(
      "equations.items",
      primary.equationItems,
      fallback.equationItems,
    ),
    derivationDetail: scalar(
      "equations.derivationDetail",
      primary.derivationDetail,
      fallback.derivationDetail,
    ),
    proofRigor: scalar(
      "equations.proofRigor",
      primary.proofRigor,
      fallback.proofRigor,
    ),
    notationConvention: scalar(
      "equations.notationConvention",
      primary.notationConvention,
      fallback.notationConvention,
    ),
    equationNumbering: scalar(
      "equations.numbering",
      primary.equationNumbering,
      fallback.equationNumbering,
    ),
    sourcePolicy: scalar(
      "sources.policy",
      primary.sourcePolicy,
      fallback.sourcePolicy,
    ),
    citationStyle: scalar(
      "sources.citationStyle",
      primary.citationStyle,
      fallback.citationStyle,
    ),
    minimumSourceCount: scalar(
      "sources.minimumCount",
      primary.minimumSourceCount,
      fallback.minimumSourceCount,
    ),
    sourceDateRange: scalar(
      "sources.dateRange",
      primary.sourceDateRange,
      fallback.sourceDateRange,
    ),
    requiredLocators: list(
      "sources.requiredLocators",
      primary.requiredLocators,
      fallback.requiredLocators,
    ),
    toneRegister: scalar(
      "tone.register",
      primary.toneRegister,
      fallback.toneRegister,
    ),
    toneVoice: scalar("tone.voice", primary.toneVoice, fallback.toneVoice),
    jargonLevel: scalar(
      "tone.jargonLevel",
      primary.jargonLevel,
      fallback.jargonLevel,
    ),
    sentenceStyle: scalar(
      "tone.sentenceStyle",
      primary.sentenceStyle,
      fallback.sentenceStyle,
    ),
    mustInclude: list(
      "constraints.mustInclude",
      primary.mustInclude,
      fallback.mustInclude,
    ),
    mustExclude: list(
      "constraints.mustExclude",
      primary.mustExclude,
      fallback.mustExclude,
    ),
    factualUncertaintyPolicy: scalar(
      "constraints.factualUncertaintyPolicy",
      primary.factualUncertaintyPolicy,
      fallback.factualUncertaintyPolicy,
    ),
    additionalConstraints: list(
      "constraints.additional",
      primary.additionalConstraints,
      fallback.additionalConstraints,
    ),
    acceptanceCriteria: list(
      "acceptanceCriteria",
      primary.acceptanceCriteria,
      fallback.acceptanceCriteria,
    ),
    delegatedGroups: fallback.delegatedGroups,
    confirmsBrief: fallback.confirmsBrief,
    evidence,
  });
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function capture(
  value: string,
  expression: RegExp,
): string | null {
  const match = expression.exec(value);
  return match?.[1]?.trim() || null;
}

function subjectFromRequest(prompt: string): string | null {
  const replacement = capture(
    prompt,
    /(?:題材|テーマ|主題)(?:を|は|:|：)?\s*([^。！？]{1,180}?)(?:に|へ)(?:変更|変え)/u,
  );
  if (replacement) return replacement;

  const explicit = capture(
    prompt,
    /(?:題材|テーマ|主題|トピック)(?:は|を|:|：)\s*([^。！？]{1,180})/u,
  );
  if (explicit) return explicit;

  const beforeDeliverable = capture(
    prompt,
    /^(.{1,180}?)(?:について|に関する).{0,120}?(?:論文|レポート|報告書|提案書|企画書|記事|文書|メモ|ノート)/u,
  );
  if (beforeDeliverable) return beforeDeliverable;

  const afterDeliverable = capture(
    prompt,
    /(?:論文|レポート|報告書|提案書|企画書|記事|文書|メモ|ノート)(?:を)?\s*([^。！？]{1,180}?)(?:について|に関して)/u,
  );
  return afterDeliverable;
}

function listFromDelimitedText(value: string): string[] {
  return unique(
    value
      .split(/[、,，／/;；\n]|(?:→|->|＞)|(?:および|及び|ならびに|と)/u)
      .map((item) =>
        item
          .trim()
          .replace(/(?:です|とします|を入れます|を含めます)[。.!！]?$/u, "")
          .trim(),
      )
      .filter((item) => item.length > 0 && item.length <= 1_000),
  ).slice(0, 30);
}

function isExplicitNone(value: string): boolean {
  return /^(?:特に)?(?:なし|ありません|ないです|不要です?)[。.!！\s]*$/u.test(
    value.trim(),
  );
}

function deterministicExtraction(input: {
  prompt: string;
}): BriefExtraction {
  const prompt = normalized(input.prompt);
  const delegatedGroups = explicitlyDelegatedGroups(prompt);
  const delegatesGroup = (candidate: string): boolean =>
    (delegatedGroups as readonly string[]).includes(candidate);

  const subject = subjectFromRequest(prompt);
  const audience =
    capture(prompt, /([^。！？]{1,160}?)(?:向け|を対象(?:に|とする)?)/u) ??
    capture(prompt, /(?:対象読者|読み手|読者)(?:は|:|：)\s*([^。！？]{1,160})/u);
  const purpose = capture(
    prompt,
    /(?:目的|狙い)(?:は|:|：)\s*([^。！？]{1,500})/u,
  );
  const intendedOutcome = capture(
    prompt,
    /(?:読後|最終的に|読み手に)(?:は|、)?\s*([^。！？]{1,500})/u,
  );
  const targetLength =
    capture(
      prompt,
      /((?:約|およそ)?\s*\d+(?:\.\d+)?(?:\s*[〜～-]\s*\d+(?:\.\d+)?)?\s*(?:ページ|頁|字|文字|語|ワード|words?)(?:程度|前後|以内|以上|以下)?)/iu,
    );
  const documentLanguage = prompt.match(/日本語|英語|中国語|韓国語/u)?.[0] ?? null;

  const sectionText = capture(
    prompt,
    /(?:構成|章立て|節)(?:は|を|:|：)\s*([^。！？]{1,500})/u,
  );
  const includedText = capture(
    prompt,
    /(?:含める|扱う|盛り込む)(?:内容|範囲|項目)?(?:は|を|:|：)\s*([^。！？]{1,500})/u,
  );
  const excludedText = capture(
    prompt,
    /(?:含めない|扱わない|除外する|省く)(?:内容|範囲|項目)?(?:は|を|:|：)?\s*([^。！？]{1,500})/u,
  );

  const equationNone =
    /(?:数式|式変形|計算)(?:は|を)?(?:なし|不要|入れない|省く)/u.test(prompt);
  const equationAsNeeded = /必要に応じて数式/u.test(prompt);
  const equationRequested =
    /(?:数式|式変形|導出|証明|計算過程|途中式)/u.test(prompt);
  const namedEquationItemsText = capture(
    prompt,
    /(?:扱う数式|数式の項目|導出する内容|証明する内容)(?:は|:|：)\s*([^。！？]{1,500})/u,
  );
  const standaloneEquationObjective = prompt.match(
    /([^。！？]{1,500}?(?:から|より)[^。！？]{1,300}?を(?:導出|証明)(?:する|して|したい)?)/u,
  )?.[1]?.trim() ?? null;
  const equationItems = namedEquationItemsText
    ? listFromDelimitedText(namedEquationItemsText)
    : standaloneEquationObjective
      ? [standaloneEquationObjective]
      : [];
  const figureNone =
    /(?:図|図表|グラフ|表)(?:は|を)?(?:なし|不要|入れない|省く)/u.test(prompt);
  const figureRequired =
    /(?:図|図表|グラフ|表)(?:を|は|に).*(?:入れ|含め|必須|必要)/u.test(prompt);
  const sourceNone =
    /(?:出典|引用|参考文献)(?:は|を)?(?:なし|不要|付けない)/u.test(prompt);
  const sourceMixed =
    /(?:指定資料|手元資料).*(?:調べ|検索)|指定資料と調査/u.test(prompt);
  const sourceUserOnly =
    /(?:渡した|添付|指定した|手元の?)(?:資料|文献|出典).*(?:だけ|のみ)/u.test(
      prompt,
    );
  const sourceRequested =
    /(?:出典|引用|参考文献|査読論文|文献調査|文献を調べ)/u.test(prompt);

  const rawPageSize =
    capture(prompt, /\b(A[345]|B[45]|letter)\b/iu) ??
    (/(?:レター(?:サイズ)?)/u.test(prompt) ? "letter" : null);
  const pageSize = rawPageSize
    ? /letter/iu.test(rawPageSize)
      ? "letter"
      : rawPageSize.toUpperCase()
    : null;
  const minimumSourceCountText = capture(
    prompt,
    /(?:参考文献|出典|引用)(?:を|は)?\s*(\d+)\s*(?:件|本|個|以上)/u,
  );
  const sourceDateRange = capture(
    prompt,
    /((?:直近|過去)\s*\d+\s*年|\d{4}\s*年(?:以降|から)|\d{4}\s*[-〜～]\s*\d{4}\s*年?)/u,
  );

  const depth = /網羅|徹底|詳細にすべて/u.test(prompt)
    ? "exhaustive"
    : /専門的|技術的/u.test(prompt)
      ? "technical"
      : /概説|概要|入門|全体像/u.test(prompt)
        ? "overview"
        : /丁寧に説明|解説|わかりやす/u.test(prompt)
          ? "explanatory"
          : null;

  const namedCustomTemplate =
    capture(
      prompt,
      /(?:テンプレート|フォーマット)(?:は|を|:|：)\s*([^。！？]{1,500})/u,
    ) ??
    prompt.match(/([^。！？]{1,120}(?:テンプレート|フォーマット))/u)?.[1] ??
    null;
  const templateFamily = /学術|論文形式/u.test(prompt)
      ? "academic"
      : /ビジネス|社内文書/u.test(prompt)
        ? "business"
        : /コンパクト/u.test(prompt)
          ? "compact"
          : !delegatesGroup("presentation") &&
              (/(?:独自|指定|添付).{0,12}(?:テンプレート|形式)/u.test(prompt) ||
                namedCustomTemplate !== null)
            ? "custom"
            : null;

  const derivationDetail = /(?:全て|すべて|完全な?|省略せず).{0,12}(?:途中式|式変形|導出)|(?:途中式|式変形|導出).{0,12}(?:全て|すべて|完全|省略しない|省略せず)/u.test(
    prompt,
  )
    ? "full_derivation"
    : /(?:要点|主要).{0,8}(?:途中式|式変形|導出)|途中式は要所/u.test(
          prompt,
        )
      ? "key_steps"
      : /結果だけ|結論だけ/u.test(prompt)
        ? "result_only"
        : null;

  const proofRigor = /厳密|形式的/u.test(prompt)
    ? "formal"
    : /直感的|直感を重視/u.test(prompt)
      ? "intuitive"
      : null;
  const notationConvention = capture(
    prompt,
    /(?:記法|記号)(?:は|を|:|：)\s*([^。！？]{1,500})/u,
  );
  const equationNumbering = /(?:全て|すべて|全式).{0,8}(?:番号|式番号)/u.test(
    prompt,
  )
    ? "all"
    : /重要な式.{0,8}(?:番号|式番号)|重要な式だけ/u.test(prompt)
      ? "important_only"
      : null;

  const rawCitationStyle = prompt.match(
    /APA(?:第?7版)?|IEEE|著者年(?:方式)?|author[- ]?year|番号方式|numeric/iu,
  )?.[0];
  const citationStyle = rawCitationStyle
    ? /APA/iu.test(rawCitationStyle)
      ? "apa7"
      : /IEEE/iu.test(rawCitationStyle)
        ? "ieee"
        : /番号|numeric/iu.test(rawCitationStyle)
          ? "numeric"
          : "author-year"
    : null;

  const toneContext =
    /文体|口調|文章|書き方|(?:学術的|分析的|説得的|簡潔|丁寧).{0,12}(?:書いて|まとめて)/u.test(
      prompt,
    );
  const toneRegister = toneContext && /学術的/u.test(prompt)
    ? "academic"
    : toneContext && /フォーマル|正式|厳格|格式/u.test(prompt)
      ? "formal"
      : toneContext && /平易|やさしく|わかりやす/u.test(prompt)
        ? "plain"
        : toneContext && /ビジネス|専門的/u.test(prompt)
          ? "professional"
          : null;
  const toneVoice = toneContext && /分析的/u.test(prompt)
    ? "analytical"
    : toneContext && /説得的/u.test(prompt)
      ? "persuasive"
      : toneContext && /断定的|自信を持|明確に言い切/u.test(prompt)
        ? "assertive"
        : null;
  const jargonLevel = /専門用語.{0,8}(?:多め|積極的)|高度な専門/u.test(prompt)
    ? "high"
    : /専門用語.{0,8}(?:少な|避け)|平易/u.test(prompt)
      ? "low"
      : null;
  const sentenceStyle = toneContext && /簡潔|短文/u.test(prompt)
    ? "concise"
    : toneContext && /詳しく|丁寧に/u.test(prompt)
      ? "detailed"
      : null;

  const mustIncludeText = capture(
    prompt,
    /(?:必ず|絶対に)(?:含める|入れる)(?:内容|項目)?(?:は|を|:|：)?\s*([^。！？]{1,500})/u,
  );
  const mustExcludeText = capture(
    prompt,
    /(?:絶対に|必ず)(?:含めない|入れない|省く)(?:内容|項目)?(?:は|を|:|：)?\s*([^。！？]{1,500})/u,
  );
  const mustInclude = mustIncludeText
    ? listFromDelimitedText(mustIncludeText)
    : [];
  const mustExclude = mustExcludeText
    ? listFromDelimitedText(mustExcludeText)
    : [];
  const factualUncertaintyPolicy = /不明(?:点|なこと).{0,8}(?:質問|聞いて)|その都度確認|確認して/u.test(
    prompt,
  )
    ? "ask_user"
    : /未確認|確認できない.{0,8}(?:省く|書かない|含めない)/u.test(prompt)
      ? "omit_unverified"
      : /不確実.{0,8}(?:明記|示す)|不確実と明記/u.test(prompt)
        ? "mark_uncertainty"
        : null;
  const acceptanceCriteriaText = capture(
    prompt,
    /(?:完成条件|合格条件)(?:は|を|:|：)?\s*([^。！？]{1,500})/u,
  );
  const acceptanceCriteria = acceptanceCriteriaText
    ? listFromDelimitedText(acceptanceCriteriaText)
    : [];

  const requiredLocators = unique(
    prompt.match(
      /https?:\/\/[^\s)\]】」』]+|10\.\d{4,9}\/[\-._;()/:A-Z0-9]+/giu,
    ) ?? [],
  );

  const extraction = BriefExtractionSchema.parse({
    ...EMPTY_EXTRACTION,
    subject,
    purpose,
    audience,
    intendedOutcome,
    includedTopics: includedText
      ? isExplicitNone(includedText)
        ? []
        : listFromDelimitedText(includedText)
      : [],
    excludedTopics: excludedText
      ? isExplicitNone(excludedText)
        ? []
        : listFromDelimitedText(excludedText)
      : [],
    depth,
    targetLength,
    language: documentLanguage,
    templateFamily,
    customTemplate:
      templateFamily === "custom" ? namedCustomTemplate : null,
    sectionOrder: sectionText ? listFromDelimitedText(sectionText) : [],
    pageSize,
    columns: /(?:2|二)段(?:組(?:み)?)?/u.test(prompt)
      ? 2
      : /(?:1|一)段(?:組(?:み)?)?/u.test(prompt)
        ? 1
        : null,
    figurePolicy: figureNone
      ? "none"
      : figureRequired
        ? "required"
        : null,
    figureItems: [],
    equationPolicy: equationNone
      ? "none"
      : equationAsNeeded
        ? "as_needed"
        : equationRequested
          ? "required"
          : null,
    equationItems,
    derivationDetail,
    proofRigor,
    notationConvention,
    equationNumbering,
    sourcePolicy: sourceNone
      ? "none"
      : sourceMixed
        ? "mixed"
        : sourceUserOnly
          ? "user_only"
          : sourceRequested
            ? "agent_research"
            : null,
    citationStyle,
    minimumSourceCount: minimumSourceCountText
      ? Number.parseInt(minimumSourceCountText, 10)
      : null,
    sourceDateRange,
    requiredLocators,
    toneRegister,
    toneVoice,
    jargonLevel,
    sentenceStyle,
    mustInclude,
    mustExclude,
    factualUncertaintyPolicy,
    additionalConstraints: [],
    acceptanceCriteria,
    delegatedGroups: unique(delegatedGroups),
    confirmsBrief: false,
  });

  const evidencePaths: RequirementPath[] = [];
  const addEvidence = (path: RequirementPath, present: boolean) => {
    if (present) evidencePaths.push(path);
  };
  addEvidence("goal.subject", extraction.subject !== null);
  addEvidence("goal.purpose", extraction.purpose !== null);
  addEvidence("goal.audience", extraction.audience !== null);
  addEvidence("goal.intendedOutcome", extraction.intendedOutcome !== null);
  addEvidence(
    "scope.includedTopics",
    extraction.includedTopics.length > 0 || includedText !== null,
  );
  addEvidence(
    "scope.excludedTopics",
    extraction.excludedTopics.length > 0 || excludedText !== null,
  );
  addEvidence("scope.depth", extraction.depth !== null);
  addEvidence("scope.targetLength", extraction.targetLength !== null);
  addEvidence("scope.language", extraction.language !== null);
  addEvidence("template.family", extraction.templateFamily !== null);
  addEvidence("template.customTemplate", extraction.customTemplate !== null);
  addEvidence("template.sectionOrder", extraction.sectionOrder.length > 0);
  addEvidence("template.pageSize", extraction.pageSize !== null);
  addEvidence("template.columns", extraction.columns !== null);
  addEvidence("figures.policy", extraction.figurePolicy !== null);
  addEvidence("figures.items", extraction.figureItems.length > 0);
  addEvidence("equations.policy", extraction.equationPolicy !== null);
  addEvidence("equations.items", extraction.equationItems.length > 0);
  addEvidence(
    "equations.derivationDetail",
    extraction.derivationDetail !== null,
  );
  addEvidence("equations.proofRigor", extraction.proofRigor !== null);
  addEvidence(
    "equations.notationConvention",
    extraction.notationConvention !== null,
  );
  addEvidence("equations.numbering", extraction.equationNumbering !== null);
  addEvidence("sources.policy", extraction.sourcePolicy !== null);
  addEvidence("sources.citationStyle", extraction.citationStyle !== null);
  addEvidence(
    "sources.minimumCount",
    extraction.minimumSourceCount !== null,
  );
  addEvidence("sources.dateRange", extraction.sourceDateRange !== null);
  addEvidence(
    "sources.requiredLocators",
    extraction.requiredLocators.length > 0,
  );
  addEvidence("tone.register", extraction.toneRegister !== null);
  addEvidence("tone.voice", extraction.toneVoice !== null);
  addEvidence("tone.jargonLevel", extraction.jargonLevel !== null);
  addEvidence("tone.sentenceStyle", extraction.sentenceStyle !== null);
  addEvidence("constraints.mustInclude", extraction.mustInclude.length > 0);
  addEvidence("constraints.mustExclude", extraction.mustExclude.length > 0);
  addEvidence(
    "constraints.factualUncertaintyPolicy",
    extraction.factualUncertaintyPolicy !== null,
  );
  addEvidence(
    "constraints.additional",
    extraction.additionalConstraints.length > 0,
  );
  addEvidence(
    "acceptanceCriteria",
    extraction.acceptanceCriteria.length > 0,
  );

  return BriefExtractionSchema.parse({
    ...extraction,
    evidence: unique(evidencePaths).map((path) => ({
      path,
      quote:
        path === "scope.language" && documentLanguage
          ? documentLanguage
          : prompt,
    })),
  });
}

const EXTRACTION_INSTRUCTIONS = `ユーザーの文書作成依頼から、明示された要件だけを抽出してください。
推測、一般的な既定値、常識による補完は禁止です。明示されていない値はnullまたは空配列にします。
抽出した各値には、その値を直接裏付けるユーザーメッセージの原文部分をevidenceへ入れます。quoteは原文に完全一致する連続部分だけを使います。
「任せる」「推奨で」のような明示的委任だけをdelegatedGroupsへ入れます。
pageSizeはA3/A4/A5/B4/B5/letterだけ、citationStyleはauthor-year/apa7/ieee/numericだけを使います。対応外の指定を別の値へ置き換えません。
一つの依頼に複数の要件が含まれる場合はすべて抽出します。パッケージ名やTeXコードを生成しません。`;

export async function extractBriefRequirements(input: {
  prompt: string;
  runtime: BriefExtractionRuntime;
}): Promise<BriefExtraction> {
  const fallback = deterministicExtraction({ prompt: input.prompt });
  if (input.runtime.provider !== "ai_gateway") return fallback;

  try {
    const result = await generateText({
      model: agentLanguageModel(structuredAgentModel(input.runtime.model)),
    providerOptions: agentProviderOptions(),
      system: EXTRACTION_INSTRUCTIONS,
      output: Output.object({ schema: BriefExtractionSchema }),
      maxOutputTokens: 4_000,
      prompt: JSON.stringify({ userMessage: input.prompt }),
    });
    return mergeEvidenceBackedExtraction(
      BriefExtractionSchema.parse(agentOutputJson(result)),
      fallback,
    );
  } catch {
    // Failing closed means keeping only the conservative deterministic
    // extraction, never silently inventing a missing requirement because
    // extraction failed. Autopilot fills the rest with typed defaults.
    return fallback;
  }
}

export { deterministicExtraction as extractBriefRequirementsDeterministically };

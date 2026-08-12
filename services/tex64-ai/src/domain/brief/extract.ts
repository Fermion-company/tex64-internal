import {
  BriefExtractionSchema,
  type BriefExtraction,
  type ElicitationTarget,
  type RequirementGroup,
  type RequirementPath,
} from "./schema";

const DELEGATION_PATTERN =
  /(?:お?任せ(?:します|する|で|しますので)?|推奨(?:設定)?で|おすすめ(?:の設定)?で|適切に決めて|良いように|そちらで決めて)/u;
const DELEGATION_NEGATION_PATTERN =
  /(?:お?任せ(?:しない|しません|ません|ない|にはしない|にはしません|ではなく|せず|したくない)|推奨(?:設定)?ではなく|おすすめ(?:の設定)?ではなく|そちらで決めてほしくない)/u;
const CONFIRMATION_PATTERN =
  /^(?:はい|その条件で|この条件で|それで|その内容で|進めて|問題ありません|大丈夫です|確定します)(?:お願いします|進めてください|大丈夫です)?[。.!！\s]*$/u;

const ALL_GROUPS: readonly RequirementGroup[] = [
  "purpose_audience",
  "scope_structure",
  "sources_evidence",
  "mathematics",
  "visuals",
  "presentation",
  "acceptance",
];

const GROUP_DELEGATION_TERMS: Readonly<
  Record<Exclude<RequirementGroup, "subject">, RegExp>
> = {
  purpose_audience: /(?:目的|狙い|研究問い|読者|読み手|対象読者|読後)/u,
  scope_structure:
    /(?:範囲|構成|章立て|節構成|深さ|長さ|ページ数|文字数|本文の言語|扱う内容|除外範囲)/u,
  sources_evidence: /(?:出典|引用|参考文献|文献|資料|根拠)/u,
  mathematics: /(?:数式|式変形|導出|証明|記号|式番号)/u,
  visuals: /(?:図表|図|グラフ|チャート|表の扱い)/u,
  presentation:
    /(?:文体|口調|語調|書き方|形式|テンプレート|フォーマット|用紙|段組)/u,
  acceptance: /(?:完成条件|合格条件|必須条件|不確実な事実の扱い)/u,
};

const DELEGATION_SCOPE_DISTANCE = 24;

function mentionsDelegationForGroup(
  text: string,
  terms: RegExp,
): boolean {
  const withinClause = `[^。！？、,;；]{0,${DELEGATION_SCOPE_DISTANCE}}`;
  const termBefore = new RegExp(
    `${terms.source}${withinClause}${DELEGATION_PATTERN.source}`,
    "u",
  );
  const delegationBefore = new RegExp(
    `${DELEGATION_PATTERN.source}(?:のは|対象は|項目は|範囲は)${withinClause}${terms.source}`,
    "u",
  );
  return termBefore.test(text) || delegationBefore.test(text);
}

/**
 * Binds an explicit delegation phrase to the requirement group it names. A
 * bare "そこは任せる" answers only the active group, while "残りは任せる"
 * deliberately delegates every non-subject group.
 */
export function explicitlyDelegatedGroups(
  textValue: string,
  activeTarget: ElicitationTarget | null = null,
): RequirementGroup[] {
  const text = textValue.normalize("NFKC").trim();
  if (!isExplicitDelegationAnswer(text)) return [];
  if (
    /(?:全部|すべて|全て|残り|ほか|他)(?:の条件)?[^。！？]{0,16}(?:任せる|おまかせ|お任せ|推奨(?:設定)?で|おすすめ(?:の設定)?で)|(?:質問は不要|もう質問しないで)/u.test(
      text,
    )
  ) {
    return [...ALL_GROUPS];
  }

  const named = (Object.entries(GROUP_DELEGATION_TERMS) as Array<
    [Exclude<RequirementGroup, "subject">, RegExp]
  >)
    .filter(([, terms]) => mentionsDelegationForGroup(text, terms))
    .map(([group]) => group);
  if (named.length > 0) return unique(named);

  return activeTarget &&
    activeTarget !== "subject" &&
    activeTarget !== "delegation_offer" &&
    activeTarget !== "brief_revision" &&
    activeTarget !== "brief_confirmation"
    ? [activeTarget]
    : [];
}

export function isExplicitDelegationAnswer(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  return (
    !DELEGATION_NEGATION_PATTERN.test(normalized) &&
    DELEGATION_PATTERN.test(normalized)
  );
}

export function isExplicitBriefConfirmation(text: string): boolean {
  return CONFIRMATION_PATTERN.test(text.normalize("NFKC").trim());
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function commaList(value: string): string[] {
  return unique(
    value
      .split(/[、,，／/;；\n]|(?:→|->|＞)|(?:および|及び|ならびに|と)/u)
      .map((item) =>
        item
          .trim()
          .replace(/(?:です|とします|を入れます|を含めます)[。.!！]?$/u, "")
          .trim(),
      )
      .filter(Boolean),
  ).slice(0, 30);
}

function isExplicitNone(value: string): boolean {
  return /^(?:特に)?(?:なし|ありません|ないです|不要です?)[。.!！\s]*$/u.test(
    value.trim(),
  );
}

/**
 * Conservative local extraction used when a model is unavailable. It only
 * emits fields backed by a verbatim quote from the current user message.
 */
export function extractBriefDeterministically(input: {
  text: string;
  target?: ElicitationTarget | null;
  targetPaths?: readonly RequirementPath[];
}): BriefExtraction {
  const text = input.text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const targetPath =
    input.target === "delegation_offer" ||
    input.target === "brief_revision" ||
    input.target === "brief_confirmation"
      ? null
      : input.targetPaths?.[0] ?? null;
  const evidence: Array<{ path: RequirementPath; quote: string }> = [];
  const addEvidence = (path: RequirementPath, quote: string) => {
    if (quote && text.includes(quote)) evidence.push({ path, quote });
  };

  let subject: string | null = null;
  const topical = text.match(
    /^(?:[「『]([^」』]{1,200})[」』]|(.{1,200}?))について(?:[、,，]|(?:の)?(?:論文|レポート|報告書|提案書|企画書|記事|文書))/u,
  );
  if (topical) {
    subject = (topical[1] ?? topical[2] ?? "").trim() || null;
    if (subject) addEvidence("goal.subject", `${subject}について`);
  } else if (input.target === "subject" || targetPath === "goal.subject") {
    const candidate = text
      .replace(/^(?:テーマ|題材|主題|内容)(?:は|:|：)?\s*/u, "")
      .replace(/(?:について)?(?:です|でお願いします)?[。.!！]?$/u, "")
      .trim();
    if (
      candidate &&
      candidate.length <= 1_000 &&
      !/^(?:任せる|お任せ|わからない|特にない)$/u.test(candidate)
    ) {
      subject = candidate;
      addEvidence("goal.subject", text);
    }
  }

  const purposeMatch = text.match(
    /(?:目的|狙い)(?:は|:|：)\s*([^。！？]{1,1000})/u,
  );
  const purpose =
    purposeMatch?.[1]?.trim() ??
    (targetPath === "goal.purpose" && !isExplicitNone(text) ? text : null);
  if (purpose && purposeMatch?.[0]) addEvidence("goal.purpose", purposeMatch[0]);
  else if (purpose && targetPath === "goal.purpose") {
    addEvidence("goal.purpose", text);
  }

  const audienceMatch = text.match(
    /(?:対象(?:読者)?|想定読者)(?:は|:|：)\s*([^、,。！？]{1,1000})|([^、,。！？]{1,200})(?:向け|を対象(?:に|と))/u,
  );
  const audience =
    (audienceMatch?.[1] ?? audienceMatch?.[2] ?? "").trim() ||
    (targetPath === "goal.audience" && !isExplicitNone(text) ? text : null);
  if (audience && audienceMatch?.[0]) {
    addEvidence("goal.audience", audienceMatch[0]);
  } else if (audience && targetPath === "goal.audience") {
    addEvidence("goal.audience", text);
  }

  const outcomeMatch = text.match(
    /(?:読後|読み終えた後)(?:に|は)?\s*([^。！？]{1,1000})|([^。！？]{1,1000}?)(?:できる|理解できる)ように/u,
  );
  const intendedOutcome =
    (outcomeMatch?.[1] ?? outcomeMatch?.[2] ?? "").trim() ||
    (targetPath === "goal.intendedOutcome" && !isExplicitNone(text)
      ? text
      : null);
  if (intendedOutcome && outcomeMatch?.[0]) {
    addEvidence("goal.intendedOutcome", outcomeMatch[0]);
  } else if (intendedOutcome && targetPath === "goal.intendedOutcome") {
    addEvidence("goal.intendedOutcome", text);
  }

  const includeMatch = text.match(
    /(?:含める|扱う)(?:内容|論点|範囲)?(?:は|:|：)\s*([^。！？]{1,1000})/u,
  );
  const includedTopics = includeMatch?.[1]
    ? commaList(includeMatch[1])
    : targetPath === "scope.includedTopics" && !isExplicitNone(text)
      ? commaList(text)
      : [];
  if (includeMatch?.[0]) addEvidence("scope.includedTopics", includeMatch[0]);
  else if (targetPath === "scope.includedTopics") {
    addEvidence("scope.includedTopics", text);
  }

  const excludeMatch = text.match(
    /(?:含めない|扱わない|除外する)(?:内容|論点|範囲)?(?:は|:|：)?\s*([^。！？]{0,1000})/u,
  );
  const explicitExcludedText = excludeMatch?.[1]?.trim() ?? null;
  const excludedTopics = excludeMatch
    ? isExplicitNone(explicitExcludedText ?? "なし")
      ? []
      : commaList(explicitExcludedText ?? "")
    : targetPath === "scope.excludedTopics"
      ? isExplicitNone(text)
        ? []
        : commaList(text)
      : [];
  if (excludeMatch?.[0]) addEvidence("scope.excludedTopics", excludeMatch[0]);
  else if (targetPath === "scope.excludedTopics") {
    addEvidence("scope.excludedTopics", text);
  }

  const depth = /網羅的|徹底的|網羅的に詳しく/u.test(text)
    ? "exhaustive"
    : /専門的|技術的/u.test(text)
      ? "technical"
      : /わかりやすく|解説/u.test(text)
        ? "explanatory"
        : /概要|概観|簡単に/u.test(text)
          ? "overview"
          : targetPath === "scope.depth" && /全体像|簡潔/u.test(text)
            ? "overview"
          : null;
  const depthQuote = text.match(/網羅的|徹底的|詳細に|専門的|技術的|わかりやすく|解説|概要|概観|簡単に|全体像|簡潔/u)?.[0];
  if (depth && depthQuote) addEvidence("scope.depth", depthQuote);

  const lengthMatch = text.match(
    /(?:約|およそ)?\s*\d{1,6}(?:\s*[〜～-]\s*\d{1,6})?\s*(?:ページ|頁|字|文字|語|words?)(?:程度|前後|以内|以上|以下)?/iu,
  );
  const targetLength = lengthMatch?.[0] ?? null;
  if (targetLength) addEvidence("scope.targetLength", targetLength);

  const languageMatch = text.match(/日本語|英語|中国語|韓国語/u);
  const language =
    languageMatch?.[0] ??
    (targetPath === "scope.language" && !isExplicitNone(text) ? text : null);
  if (language) addEvidence("scope.language", language);

  const templateMatch = text.match(/学術(?:論文)?(?:形式)?|ビジネス(?:形式)?|一般形式|標準|コンパクト|書簡形式|ノート形式/iu);
  const customTemplateMatch = text.match(
    /(?:テンプレート|フォーマット)(?:は|を|:|：)\s*([^。！？]{1,500})/u,
  );
  const customTemplate =
    customTemplateMatch?.[1]?.trim() ||
    (targetPath === "template.customTemplate" && !isExplicitNone(text)
      ? text
      : null);
  const templateFamily = templateMatch
    ? /学術/iu.test(templateMatch[0])
      ? "academic"
      : /ビジネス/u.test(templateMatch[0])
        ? "business"
        : /コンパクト/u.test(templateMatch[0])
          ? "compact"
        : /書簡/u.test(templateMatch[0])
          ? "letter"
          : /ノート/u.test(templateMatch[0])
            ? "notes"
            : "general"
    : customTemplate
      ? "custom"
      : null;
  if (templateMatch) addEvidence("template.family", templateMatch[0]);
  else if (customTemplateMatch?.[0]) {
    addEvidence("template.family", customTemplateMatch[0]);
  }
  if (customTemplate) {
    addEvidence(
      "template.customTemplate",
      customTemplateMatch?.[0] ?? text,
    );
  }

  const sectionMatch = text.match(
    /(?:章立て|構成|セクション)(?:は|:|：)\s*([^。！？]{1,1000})/u,
  );
  const sectionOrder = sectionMatch?.[1]
    ? commaList(sectionMatch[1])
    : targetPath === "template.sectionOrder" && !isExplicitNone(text)
      ? commaList(text)
      : [];
  if (sectionMatch?.[0]) addEvidence("template.sectionOrder", sectionMatch[0]);
  else if (targetPath === "template.sectionOrder") {
    addEvidence("template.sectionOrder", text);
  }

  const pageSizeMatch = text.match(/A3|A4|A5|B4|B5|letter|レター(?:サイズ)?/iu);
  const rawPageSize = pageSizeMatch?.[0] ?? null;
  const pageSize = rawPageSize
    ? /letter|レター/iu.test(rawPageSize)
      ? "letter"
      : rawPageSize.toUpperCase()
    : null;
  if (pageSize && rawPageSize) addEvidence("template.pageSize", rawPageSize);
  const columnsMatch = text.match(/([12一二])\s*段(?:組(?:み)?)?/u);
  const columns = columnsMatch
    ? /2|二/u.test(columnsMatch[1] ?? "")
      ? 2
      : 1
    : null;
  if (columns !== null && columnsMatch?.[0]) {
    addEvidence("template.columns", columnsMatch[0]);
  }

  const figurePolicy = /(?:図|図表|グラフ|チャート|模式図)(?:は|を)?(?:不要|入れない|なし)/u.test(text)
    ? "none"
    : /必要に応じて(?:図|図表|グラフ)|(?:図|図表|グラフ)は任せ/u.test(text) ||
        (targetPath === "figures.policy" &&
          /必要に応じて|提案|内容に合う図を作る/u.test(text))
      ? "agent_proposes"
      : /(?:図|図表|グラフ|チャート|模式図)(?:を)?(?:入れて|含めて|必須)/u.test(text) ||
          (targetPath === "figures.policy" && /指定.*(?:図|図表)|必ず/u.test(text))
        ? "required"
        : targetPath === "figures.policy" && /提供.*(?:だけ|のみ)/u.test(text)
          ? "provided_only"
        : null;
  const figureQuote = text.match(/(?:図|図表|グラフ|チャート|模式図)[^。！？]{0,80}/u)?.[0] ??
    (targetPath === "figures.policy" && figurePolicy ? text : undefined);
  if (figurePolicy && figureQuote) addEvidence("figures.policy", figureQuote);

  const equationPolicy = /数式(?:は|を)?(?:不要|入れない|なし)/u.test(text) ||
    (targetPath === "equations.policy" && /数式なし|入れない/u.test(text))
    ? "none"
    : /必要に応じて数式|数式は任せ/u.test(text) ||
        (targetPath === "equations.policy" && /必要な箇所だけ/u.test(text))
      ? "as_needed"
      : /数式(?:を)?[^。！？]{0,24}(?:入れて|入れ|含めて|含め|必須)|式変形/u.test(text) ||
          (targetPath === "equations.policy" && /主要部分|必ず入れる/u.test(text))
        ? "required"
        : null;
  const equationQuote = text.match(/(?:数式|式変形)[^。！？]{0,80}/u)?.[0] ??
    (targetPath === "equations.policy" && equationPolicy ? text : undefined);
  if (equationPolicy && equationQuote) {
    addEvidence("equations.policy", equationQuote);
  }
  const namedEquationItemsMatch = text.match(
    /(?:扱う数式|数式の項目|導出する内容|証明する内容)(?:は|:|：)\s*([^。！？]{1,1000})/u,
  );
  const standaloneEquationObjectiveMatch = text.match(
    /([^。！？]{1,500}?(?:から|より)[^。！？]{1,300}?を(?:導出|証明)(?:する|して|したい)?)/u,
  );
  const equationItems = namedEquationItemsMatch?.[1]
    ? commaList(namedEquationItemsMatch[1])
    : targetPath === "equations.items" && !isExplicitNone(text)
      ? commaList(text)
      : standaloneEquationObjectiveMatch?.[1]
        ? [standaloneEquationObjectiveMatch[1].trim()]
        : [];
  const equationItemsQuote =
    namedEquationItemsMatch?.[0] ?? standaloneEquationObjectiveMatch?.[0];
  if (equationItems.length > 0 && equationItemsQuote) {
    addEvidence("equations.items", equationItemsQuote);
  } else if (targetPath === "equations.items") {
    addEvidence("equations.items", text);
  }
  const derivationDetail = /完全(?:な|に)?(?:導出|式変形)|途中式をすべて/u.test(text)
    ? "full_derivation"
    : /主要(?:な)?(?:導出|途中式)|要点となる式変形/u.test(text)
      ? "key_steps"
      : /結果(?:だけ|のみ)|結論の式のみ/u.test(text)
        ? "result_only"
        : null;
  const derivationQuote = text.match(/完全(?:な|に)?(?:導出|式変形)|途中式をすべて|主要(?:な)?(?:導出|途中式)|要点となる式変形|結果(?:だけ|のみ)|結論の式のみ/u)?.[0];
  if (derivationDetail && derivationQuote) {
    addEvidence("equations.derivationDetail", derivationQuote);
  }
  const proofRigor = /厳密(?:な|に)|形式的(?:な|に)/u.test(text)
    ? "formal"
    : /直感的(?:な|に)|直感を重視/u.test(text)
      ? "intuitive"
      : /標準的(?:な|に)?/u.test(text)
        ? "standard"
        : null;
  const proofQuote = text.match(/厳密(?:な|に)|形式的(?:な|に)|直感的(?:な|に)|直感を重視|標準的(?:な|に)?/u)?.[0];
  if (proofRigor && proofQuote) addEvidence("equations.proofRigor", proofQuote);
  const notationConvention =
    targetPath === "equations.notationConvention"
      ? isExplicitNone(text)
        ? "指定なし"
        : text
      : null;
  if (notationConvention) {
    addEvidence("equations.notationConvention", text);
  }
  const equationNumbering =
    /(?:すべて|全て|全式).{0,8}(?:式番号|番号)/u.test(text)
      ? "all"
      : /重要な式.{0,8}(?:式番号|番号)|重要な式だけ/u.test(text)
        ? "important_only"
        : targetPath === "equations.numbering" && /付けない|番号なし/u.test(text)
          ? "none"
          : null;
  if (equationNumbering) {
    addEvidence("equations.numbering", text);
  }

  const sourcePolicy = /(?:出典|引用|参考文献)(?:は|を)?(?:不要|なし|付けない)/u.test(text)
    ? "none"
    : /(?:手元|指定)(?:の)?(?:資料|文献)(?:だけ|のみ)/u.test(text)
      ? "user_only"
      : /(?:文献|出典|査読論文)(?:を)?(?:調べて|調べる|探して|検索して)/u.test(text)
        ? "agent_research"
        : /(?:指定資料|手元資料).*(?:調べて|調べる|検索)|指定資料と調査/u.test(text)
          ? "mixed"
          : null;
  const sourceQuote = text.match(/(?:出典|引用|参考文献|文献|査読論文|指定資料)[^。！？]{0,100}/u)?.[0] ??
    (targetPath === "sources.policy" && sourcePolicy ? text : undefined);
  if (sourcePolicy && sourceQuote) addEvidence("sources.policy", sourceQuote);
  const citationMatch = text.match(/APA(?:第?7版)?|IEEE|著者年(?:方式)?|author[- ]?year|番号方式|numeric/iu);
  const rawCitationStyle = citationMatch?.[0] ?? null;
  const citationStyle = rawCitationStyle
    ? /APA/iu.test(rawCitationStyle)
      ? "apa7"
      : /IEEE/iu.test(rawCitationStyle)
        ? "ieee"
        : /番号|numeric/iu.test(rawCitationStyle)
          ? "numeric"
          : "author-year"
    : null;
  if (citationStyle && rawCitationStyle) {
    addEvidence("sources.citationStyle", rawCitationStyle);
  }
  const sourceCountMatch = text.match(/(?:最低|少なくとも)?\s*(\d{1,4})\s*(?:件|本|編)(?:以上)?(?:の)?(?:出典|文献|論文)/u);
  const targetSourceCountMatch =
    targetPath === "sources.minimumCount"
      ? text.match(/(\d{1,4})\s*(?:件|本|編)?/u)
      : null;
  const minimumSourceCount = sourceCountMatch?.[1]
    ? Number(sourceCountMatch[1])
    : targetSourceCountMatch?.[1]
      ? Number(targetSourceCountMatch[1])
      : null;
  if (minimumSourceCount !== null && sourceCountMatch?.[0]) {
    addEvidence("sources.minimumCount", sourceCountMatch[0]);
  } else if (minimumSourceCount !== null && targetSourceCountMatch?.[0]) {
    addEvidence("sources.minimumCount", targetSourceCountMatch[0]);
  }
  const dateRangeMatch = text.match(/(?:直近|過去)\s*\d{1,3}\s*年|20\d{2}年以降|最新(?:の)?\d{1,3}年/u);
  const sourceDateRange =
    dateRangeMatch?.[0] ??
    (targetPath === "sources.dateRange"
      ? isExplicitNone(text)
        ? "指定なし"
        : text
      : null);
  if (sourceDateRange) {
    addEvidence(
      "sources.dateRange",
      dateRangeMatch?.[0] ?? text,
    );
  }
  const requiredLocators = unique(
    text.match(/https:\/\/[^\s、。]+|10\.\d{4,9}\/[-._;()/:A-Z0-9]+/giu) ?? [],
  ).slice(0, 30);
  for (const locator of requiredLocators) {
    addEvidence("sources.requiredLocators", locator);
  }

  const toneContext =
    targetPath?.startsWith("tone.") === true ||
    /文体|口調|文章|書き方|(?:学術的|分析的|説得的|簡潔|丁寧).{0,12}(?:書いて|まとめて)/u.test(
      text,
    );
  const toneRegister = toneContext && /学術的/u.test(text)
    ? "academic"
    : toneContext && /フォーマル|格式/u.test(text)
      ? "formal"
      : (toneContext && /ビジネス|専門家向け/u.test(text)) ||
          (targetPath === "tone.register" && /専門的/u.test(text))
        ? "professional"
        : toneContext && /平易|やさしい|読みやすい/u.test(text)
          ? "plain"
          : null;
  const toneQuote = text.match(/学術的|フォーマル|格式|ビジネス|専門家向け|専門的|平易|やさしい|読みやすい/u)?.[0];
  if (toneRegister && toneQuote) addEvidence("tone.register", toneQuote);
  const toneVoice = toneContext && /分析的/u.test(text)
    ? "analytical"
    : toneContext && /説得的/u.test(text)
      ? "persuasive"
      : toneContext && /断定的|力強く|明確に言い切/u.test(text)
        ? "assertive"
        : /中立的|客観的/u.test(text)
          ? "neutral"
          : null;
  const voiceQuote = text.match(/分析的|説得的|断定的|力強く|中立的|客観的/u)?.[0];
  if (toneVoice && voiceQuote) addEvidence("tone.voice", voiceQuote);
  const jargonLevel = /専門用語(?:を)?多く|専門用語中心/u.test(text)
    ? "high"
    : targetPath === "tone.jargonLevel" && /多め/u.test(text)
      ? "high"
    : /専門用語(?:を)?控え|専門用語なし/u.test(text)
      ? "low"
      : targetPath === "tone.jargonLevel" && /少なめ/u.test(text)
        ? "low"
      : targetPath === "tone.jargonLevel" && /必要な範囲|ほどほど|適度/u.test(text)
        ? "moderate"
      : null;
  const jargonQuote = text.match(/専門用語(?:を)?多く|専門用語中心|専門用語(?:を)?控え|専門用語なし|必要な範囲|ほどほど|適度/u)?.[0];
  if (jargonLevel && jargonQuote) addEvidence("tone.jargonLevel", jargonQuote);
  const sentenceStyle = toneContext && /簡潔|短い文/u.test(text)
    ? "concise"
    : toneContext && /詳しく|丁寧に/u.test(text)
      ? "detailed"
      : targetPath === "tone.sentenceStyle" && /両方|バランス/u.test(text)
        ? "balanced"
      : null;
  const sentenceQuote = text.match(/簡潔|短い文|詳しく|丁寧に|両方|バランス/u)?.[0];
  if (sentenceStyle && sentenceQuote) {
    addEvidence("tone.sentenceStyle", sentenceQuote);
  }

  const acceptanceMatch = text.match(
    /(?:完成条件|必須条件|合格条件)(?:は|:|：)\s*([^。！？]{1,1000})/u,
  );
  const acceptanceCriteria = acceptanceMatch?.[1]
    ? commaList(acceptanceMatch[1])
    : targetPath === "acceptanceCriteria" && !isExplicitNone(text)
      ? commaList(text)
      : [];
  if (acceptanceMatch?.[0]) {
    addEvidence("acceptanceCriteria", acceptanceMatch[0]);
  } else if (targetPath === "acceptanceCriteria") {
    addEvidence("acceptanceCriteria", text);
  }

  const mustIncludeMatch = text.match(
    /(?:必ず|絶対に)(?:含める|入れる)(?:内容|項目)?(?:は|:|：)?\s*([^。！？]{1,1000})/u,
  );
  const mustInclude = mustIncludeMatch?.[1]
    ? commaList(mustIncludeMatch[1])
    : targetPath === "constraints.mustInclude"
      ? isExplicitNone(text)
        ? []
        : commaList(text)
      : [];
  if (mustIncludeMatch?.[0]) {
    addEvidence("constraints.mustInclude", mustIncludeMatch[0]);
  } else if (targetPath === "constraints.mustInclude") {
    addEvidence("constraints.mustInclude", text);
  }

  const mustExcludeMatch = text.match(
    /(?:絶対に|必ず)(?:含めない|入れない|省く)(?:内容|項目)?(?:は|:|：)?\s*([^。！？]{0,1000})/u,
  );
  const mustExclude = mustExcludeMatch?.[1]
    ? isExplicitNone(mustExcludeMatch[1])
      ? []
      : commaList(mustExcludeMatch[1])
    : targetPath === "constraints.mustExclude"
      ? isExplicitNone(text)
        ? []
        : commaList(text)
      : [];
  if (mustExcludeMatch?.[0]) {
    addEvidence("constraints.mustExclude", mustExcludeMatch[0]);
  } else if (targetPath === "constraints.mustExclude") {
    addEvidence("constraints.mustExclude", text);
  }

  const factualUncertaintyPolicy = /不確実.{0,12}(?:明記|示す)|不確実と明記/u.test(text)
    ? "mark_uncertainty"
    : /確認できない.{0,12}(?:省く|含めない)|未確認.{0,12}(?:省く|書かない)/u.test(text)
      ? "omit_unverified"
      : /その都度確認|確認できない.{0,12}(?:質問|確認)/u.test(text)
        ? "ask_user"
        : null;
  if (factualUncertaintyPolicy) {
    addEvidence("constraints.factualUncertaintyPolicy", text);
  }

  const additionalConstraints =
    targetPath === "constraints.additional"
      ? isExplicitNone(text)
        ? []
        : commaList(text)
      : [];
  if (targetPath === "constraints.additional") {
    addEvidence("constraints.additional", text);
  }

  const figureItems =
    targetPath === "figures.items" && !isExplicitNone(text)
      ? commaList(text)
      : [];
  if (targetPath === "figures.items") {
    addEvidence("figures.items", text);
  }

  const delegatedGroups = explicitlyDelegatedGroups(text, input.target ?? null);

  return BriefExtractionSchema.parse({
    subject,
    purpose,
    audience,
    intendedOutcome,
    includedTopics,
    excludedTopics,
    depth,
    targetLength,
    language,
    templateFamily,
    customTemplate,
    sectionOrder,
    pageSize,
    columns,
    figurePolicy,
    figureItems,
    equationPolicy,
    equationItems,
    derivationDetail,
    proofRigor,
    notationConvention,
    equationNumbering,
    sourcePolicy,
    citationStyle,
    minimumSourceCount,
    sourceDateRange,
    requiredLocators,
    toneRegister,
    toneVoice,
    jargonLevel,
    sentenceStyle,
    mustInclude,
    mustExclude,
    factualUncertaintyPolicy,
    additionalConstraints,
    acceptanceCriteria,
    delegatedGroups,
    confirmsBrief:
      input.target === "brief_confirmation" &&
      isExplicitBriefConfirmation(text),
    evidence,
  });
}

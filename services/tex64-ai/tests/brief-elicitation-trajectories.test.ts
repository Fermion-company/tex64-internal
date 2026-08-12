import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  advanceElicitation,
  applyBriefExtraction,
  createDocumentAgentSession,
  evaluateBriefCoverage,
  type Deliverable,
  type DocumentAgentSession,
  type ElicitationQuestion,
  type RequirementPath,
} from "@/domain/brief";
import { extractBriefRequirementsDeterministically } from "@/server/agent/brief-extractor";

const NOW = "2026-08-08T02:00:00.000+09:00";

function newSession(deliverable: Deliverable): DocumentAgentSession {
  return createDocumentAgentSession({
    sessionId: randomUUID(),
    documentId: randomUUID(),
    rootRunId: randomUUID(),
    deliverable,
    now: NOW,
  });
}

function answer(
  session: DocumentAgentSession,
  question: ElicitationQuestion | null,
  text: string,
): DocumentAgentSession {
  const runId = randomUUID();
  return applyBriefExtraction({
    session,
    extraction: extractBriefRequirementsDeterministically({
      prompt: text,
      activeQuestion: question,
    }),
    answerText: text,
    runId,
    now: NOW,
    ...(question ? { questionId: question.id } : {}),
  });
}

const ANSWERS: Record<RequirementPath, string> = {
  "goal.subject":
    "テーマは確率的勾配法の収束性。査読文献を調べて、数式を主要部分に必ず入れ、指定する図表を入れてください。",
  "goal.purpose":
    "目的は手法の仮定と限界を比較することです。対象読者は最適化を学ぶ大学院生です。読後は定理の適用条件を判断できるようにします。",
  "goal.audience": "最適化を学ぶ大学院生",
  "goal.intendedOutcome": "定理の適用条件を判断できる状態",
  "scope.includedTopics":
    "含める内容は前提、主要定理、導出、反例です。含めない内容は実装コードです。専門的・技術的に8ページ、日本語。構成は要旨、前提、定理、導出、反例、結論です。",
  "scope.excludedTopics": "実装コード",
  "scope.depth": "専門的・技術的",
  "scope.targetLength": "8ページ",
  "scope.language": "日本語",
  "template.family": "学術",
  "template.customTemplate": "学術",
  "template.sectionOrder": "要旨、前提、定理、導出、反例、結論",
  "template.pageSize": "A4",
  "template.columns": "1段",
  "figures.policy": "指定する図表を入れる",
  "figures.items": "仮定の関係図、収束率の比較グラフ",
  "equations.policy": "主要部分に必ず入れる",
  "equations.items": "収束率の上界を導出、学習率条件を証明",
  "equations.derivationDetail": "前提から完全に導出",
  "equations.proofRigor": "標準的",
  "equations.notationConvention": "なし",
  "equations.numbering": "重要な式だけ",
  "sources.policy": "文献を調べる",
  "sources.citationStyle": "IEEE",
  "sources.minimumCount": "8件",
  "sources.dateRange": "直近5年",
  "sources.requiredLocators": "https://example.org/source",
  "tone.register": "学術的",
  "tone.voice": "中立・客観的",
  "tone.jargonLevel": "必要な範囲",
  "tone.sentenceStyle": "簡潔さと詳しさの両方",
  "constraints.mustInclude": "なし",
  "constraints.mustExclude": "なし",
  "constraints.factualUncertaintyPolicy": "不確実と明記",
  "constraints.additional": "なし",
  acceptanceCriteria: "指定した構成、数式、図表、出典をすべて満たす",
};

const ADAPTIVE_PROMPT_MARKERS: Record<Deliverable, readonly string[]> = {
  paper: ["研究問い", "方法・データ・結果・限界"],
  report: ["意思決定", "根拠・分析・提言"],
  proposal: ["解決する課題", "課題、解決策、期待効果、実施方法"],
  article: ["切り口", "論点・事例・具体例"],
  letter: ["依頼・伝達", "背景、要件、期限、連絡事項"],
  notes: ["元資料", "整理軸"],
};

const PRESENTATION_RECOMMENDATIONS: Record<
  Deliverable,
  Readonly<Record<"template.family" | "tone.register" | "tone.voice", string>>
> = {
  paper: {
    "template.family": "academic",
    "tone.register": "academic",
    "tone.voice": "analytical",
  },
  report: {
    "template.family": "business",
    "tone.register": "professional",
    "tone.voice": "analytical",
  },
  proposal: {
    "template.family": "business",
    "tone.register": "professional",
    "tone.voice": "persuasive",
  },
  article: {
    "template.family": "general",
    "tone.register": "professional",
    "tone.voice": "neutral",
  },
  letter: {
    "template.family": "general",
    "tone.register": "formal",
    "tone.voice": "neutral",
  },
  notes: {
    "template.family": "compact",
    "tone.register": "plain",
    "tone.voice": "neutral",
  },
};

describe("realistic Japanese elicitation trajectories", () => {
  it.each<Deliverable>([
    "paper",
    "report",
    "proposal",
    "article",
    "letter",
    "notes",
  ])(
    "%s asks one unanswered decision at a time and reaches an explicit confirmation",
    (deliverable) => {
      let session = newSession(deliverable);
      session = answer(session, null, `${deliverable}を書いて`);

      const askedPaths = new Set<RequirementPath>();
      const askedPrompts: string[] = [];
      let confirmation: ElicitationQuestion | null = null;

      for (let turn = 0; turn < 50; turn += 1) {
        const advanced = advanceElicitation({
          session,
          sourceRunId: randomUUID(),
          now: NOW,
        });
        const question = advanced.question;
        session = advanced.session;
        expect(question).not.toBeNull();
        if (!question) break;

        if (question.target === "delegation_offer") {
          expect(question.prompt).toContain("推奨設定で進める（おすすめ）");
          session = answer(session, question, "さらに条件を決める");
          continue;
        }
        if (question.target === "brief_confirmation") {
          expect(question.prompt).toContain("この条件で進める（おすすめ）");
          confirmation = question;
          break;
        }

        expect(question.target).not.toBe("brief_revision");
        askedPrompts.push(question.prompt);
        for (const option of question.options) {
          expect(question.prompt).toContain(option.label);
        }
        const recommended = question.options.filter(
          (option) => option.recommended,
        );
        if (question.options.length > 0) {
          expect(recommended).toHaveLength(1);
          expect(question.prompt).toContain(
            `${recommended[0]?.label}（おすすめ）`,
          );
        }
        expect(question.targetPaths).toHaveLength(1);
        const path = question.targetPaths[0];
        if (!path) throw new Error("Question has no target path.");
        expect(
          askedPaths.has(path),
          `duplicate question for ${path}: ${JSON.stringify(session.brief.equations)}`,
        ).toBe(false);
        askedPaths.add(path);
        if (
          path === "template.family" ||
          path === "tone.register" ||
          path === "tone.voice"
        ) {
          expect(recommended[0]?.id).toBe(
            PRESENTATION_RECOMMENDATIONS[deliverable][path],
          );
        }
        session = answer(session, question, ANSWERS[path]);
      }

      expect(confirmation).not.toBeNull();
      for (const marker of ADAPTIVE_PROMPT_MARKERS[deliverable]) {
        expect(askedPrompts.join("\n")).toContain(marker);
      }
      expect(evaluateBriefCoverage(session.brief).complete).toBe(true);
      expect(confirmation?.prompt).toContain("この条件で執筆を進めますか");
      expect(confirmation?.prompt).toContain("主題:");
      expect(confirmation?.prompt).toContain("構成:");
      expect(confirmation?.prompt).toContain("出典:");
      expect(confirmation?.prompt).toContain("数式:");
      expect(confirmation?.prompt).toContain("図表:");
      expect(confirmation?.prompt).toContain("完成:");

      session = answer(session, confirmation, "この条件で進めてください");
      expect(session.confirmedBriefVersion).toBe(session.briefVersion);
      expect(session.phase).toBe("planning");
    },
  );

  it.each<{
    deliverable: Deliverable;
    audienceMarker: string;
    outcomeMarker: string;
  }>([
    {
      deliverable: "paper",
      audienceMarker: "研究分野",
      outcomeMarker: "研究上",
    },
    {
      deliverable: "report",
      audienceMarker: "意思決定する読み手",
      outcomeMarker: "意思決定や行動",
    },
    {
      deliverable: "proposal",
      audienceMarker: "提案を判断する相手",
      outcomeMarker: "承認・判断・行動",
    },
    {
      deliverable: "article",
      audienceMarker: "予備知識",
      outcomeMarker: "読後に取ってほしい行動",
    },
    {
      deliverable: "letter",
      audienceMarker: "あなたとの関係",
      outcomeMarker: "必要な返答",
    },
    {
      deliverable: "notes",
      audienceMarker: "後で使う人",
      outcomeMarker: "再利用",
    },
  ])(
    "$deliverable adapts reader and desired-result questions to the document",
    ({ deliverable, audienceMarker, outcomeMarker }) => {
      let session = newSession(deliverable);
      let advanced = advanceElicitation({
        session,
        sourceRunId: randomUUID(),
        now: NOW,
      });
      session = answer(
        advanced.session,
        advanced.question,
        "テーマは監査可能なAIシステム",
      );

      advanced = advanceElicitation({
        session,
        sourceRunId: randomUUID(),
        now: NOW,
      });
      session = answer(
        advanced.session,
        advanced.question,
        "目的は判断基準を明らかにすることです",
      );

      advanced = advanceElicitation({
        session,
        sourceRunId: randomUUID(),
        now: NOW,
      });
      expect(advanced.question?.prompt).toContain(audienceMarker);
      session = answer(
        advanced.session,
        advanced.question,
        "品質保証を担当する実務者",
      );

      advanced = advanceElicitation({
        session,
        sourceRunId: randomUUID(),
        now: NOW,
      });
      expect(advanced.question?.target).toBe("delegation_offer");
      session = answer(
        advanced.session,
        advanced.question,
        "さらに条件を決める",
      );

      advanced = advanceElicitation({
        session,
        sourceRunId: randomUUID(),
        now: NOW,
      });
      expect(advanced.question?.targetPaths).toEqual([
        "goal.intendedOutcome",
      ]);
      expect(advanced.question?.prompt).toContain(outcomeMarker);
    },
  );
});

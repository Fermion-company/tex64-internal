import { AutonomyScenarioSchema } from "./types";

export const ACADEMIC_PAPER_GUIDED_INTAKE_FIXTURE =
  AutonomyScenarioSchema.parse({
    id: "academic-paper-guided-intake",
    name: "Academic paper with multi-turn guided intake",
    allowedDefaultFields: ["scope.language"],
    minimumBriefFidelity: 1,
    briefExpectations: [
      {
        field: "goal.deliverable",
        importance: "critical",
        expectedState: "known",
        match: { kind: "equals", value: "paper" },
      },
      {
        field: "goal.subject",
        importance: "critical",
        expectedState: "known",
        match: {
          kind: "equals",
          value: "長文文脈におけるTransformerの検索性能",
        },
      },
      {
        field: "goal.purpose",
        importance: "critical",
        expectedState: "known",
        match: {
          kind: "equals",
          value: "位置符号化の違いが検索精度へ与える影響を比較する",
        },
      },
      {
        field: "goal.audience",
        importance: "important",
        expectedState: "known",
        match: { kind: "equals", value: "機械学習分野の大学院生と研究者" },
      },
      {
        field: "template.family",
        importance: "important",
        expectedState: "delegated",
        match: { kind: "one_of", values: ["academic", "custom"] },
      },
      {
        field: "figures.policy",
        importance: "important",
        expectedState: "known",
        match: { kind: "equals", value: "required" },
      },
      {
        field: "figures.items",
        importance: "important",
        expectedState: "known",
        match: {
          kind: "contains_all",
          values: ["モデル構成図", "評価手順図"],
        },
      },
      {
        field: "equations.derivationDetail",
        importance: "critical",
        expectedState: "known",
        match: { kind: "equals", value: "full_derivation" },
      },
      {
        field: "sources.policy",
        importance: "important",
        expectedState: "known",
        match: { kind: "equals", value: "agent_research" },
      },
      {
        field: "sources.citationStyle",
        importance: "important",
        expectedState: "known",
        match: { kind: "equals", value: "IEEE" },
      },
      {
        field: "tone.register",
        importance: "important",
        expectedState: "known",
        match: { kind: "equals", value: "academic" },
      },
      {
        field: "tone.sentenceStyle",
        importance: "optional",
        expectedState: "known",
        match: { kind: "equals", value: "concise" },
      },
      {
        field: "scope.language",
        importance: "important",
        expectedState: "known",
        match: { kind: "equals", value: "日本語" },
      },
    ],
    trace: [
      {
        type: "request",
        text: "Transformerの長文検索性能について論文を書きたい",
        providedFields: {
          "goal.deliverable": "paper",
          "goal.subject": "長文文脈におけるTransformerの検索性能",
        },
      },
      {
        type: "question",
        questionId: "purpose-1",
        questionKey: "research-purpose-and-outcome",
        fieldKeys: ["goal.purpose", "goal.intendedOutcome"],
        text: "何を比較し、読者にどんな結論を持ち帰ってほしいですか？",
      },
      {
        type: "answer",
        questionId: "purpose-1",
        resolvedFields: {
          "goal.purpose":
            "位置符号化の違いが検索精度へ与える影響を比較する",
          "goal.intendedOutcome": "再現実験に使える設計指針を示す",
        },
        delegatedFields: [],
      },
      {
        type: "question",
        questionId: "audience-template-1",
        questionKey: "audience-and-template",
        fieldKeys: ["goal.audience", "template.family"],
        text: "主な読者と、投稿先テンプレートの希望を教えてください。未定なら構成は任せられます。",
      },
      {
        type: "answer",
        questionId: "audience-template-1",
        resolvedFields: {
          "goal.audience": "機械学習分野の大学院生と研究者",
        },
        delegatedFields: ["template.family"],
      },
      {
        type: "assumption",
        field: "template.family",
        value: "academic",
        basis: "explicit_delegation",
      },
      {
        type: "question",
        questionId: "visuals-math-1",
        questionKey: "visuals-and-math-detail",
        fieldKeys: [
          "figures.policy",
          "figures.items",
          "equations.derivationDetail",
        ],
        text: "図は何を入れ、式変形はどこまで詳しく示しますか？",
      },
      {
        type: "answer",
        questionId: "visuals-math-1",
        resolvedFields: {
          "figures.policy": "required",
          "figures.items": ["モデル構成図", "評価手順図", "主要結果グラフ"],
          "equations.derivationDetail": "full_derivation",
        },
        delegatedFields: [],
      },
      {
        type: "question",
        questionId: "sources-tone-1",
        questionKey: "sources-and-tone",
        fieldKeys: [
          "sources.policy",
          "sources.citationStyle",
          "tone.register",
          "tone.sentenceStyle",
        ],
        text: "文献調査の範囲、引用形式、文章の調子を指定してください。",
      },
      {
        type: "answer",
        questionId: "sources-tone-1",
        resolvedFields: {
          "sources.policy": "agent_research",
          "sources.citationStyle": "IEEE",
          "tone.register": "academic",
          "tone.sentenceStyle": "concise",
        },
        delegatedFields: [],
      },
      {
        type: "assumption",
        field: "scope.language",
        value: "日本語",
        basis: "system_default",
      },
      {
        type: "brief_snapshot",
        version: 5,
        fields: {
          "goal.deliverable": {
            state: "known",
            value: "paper",
            source: "user",
          },
          "goal.subject": {
            state: "known",
            value: "長文文脈におけるTransformerの検索性能",
            source: "user",
          },
          "goal.purpose": {
            state: "known",
            value: "位置符号化の違いが検索精度へ与える影響を比較する",
            source: "user",
          },
          "goal.audience": {
            state: "known",
            value: "機械学習分野の大学院生と研究者",
            source: "user",
          },
          "template.family": {
            state: "delegated",
            value: "academic",
            source: "delegation",
          },
          "figures.policy": {
            state: "known",
            value: "required",
            source: "user",
          },
          "figures.items": {
            state: "known",
            value: ["主要結果グラフ", "評価手順図", "モデル構成図"],
            source: "user",
          },
          "equations.derivationDetail": {
            state: "known",
            value: "full_derivation",
            source: "user",
          },
          "sources.policy": {
            state: "known",
            value: "agent_research",
            source: "user",
          },
          "sources.citationStyle": {
            state: "known",
            value: "IEEE",
            source: "user",
          },
          "tone.register": {
            state: "known",
            value: "academic",
            source: "user",
          },
          "tone.sentenceStyle": {
            state: "known",
            value: "concise",
            source: "user",
          },
          "scope.language": {
            state: "known",
            value: "日本語",
            source: "default",
          },
        },
      },
      {
        type: "plan_proposed",
        planId: "academic-paper-plan-v1",
        planHash: "brief-v5-sections-sources-figures-math",
        briefVersion: 5,
      },
      {
        type: "plan_confirmed",
        planId: "academic-paper-plan-v1",
        planHash: "brief-v5-sections-sources-figures-math",
      },
      {
        type: "document_mutation",
        intent: "draft",
        planId: "academic-paper-plan-v1",
        planHash: "brief-v5-sections-sources-figures-math",
        revision: 1,
      },
    ],
  });

export const PREMATURE_GENERIC_DRAFT_FIXTURE = AutonomyScenarioSchema.parse({
  id: "premature-generic-draft",
  name: "Generic draft created from silent assumptions",
  allowedDefaultFields: [],
  minimumBriefFidelity: 1,
  briefExpectations: [
    {
      field: "goal.subject",
      importance: "critical",
      expectedState: "known",
      match: { kind: "equals", value: "量子計算" },
    },
    {
      field: "goal.audience",
      importance: "critical",
      expectedState: "known",
      match: { kind: "equals", value: "量子情報を専攻する大学院生" },
    },
    {
      field: "template.family",
      importance: "important",
      expectedState: "known",
      match: { kind: "equals", value: "academic" },
    },
    {
      field: "figures.policy",
      importance: "important",
      expectedState: "known",
      match: { kind: "equals", value: "agent_proposes" },
    },
    {
      field: "equations.derivationDetail",
      importance: "critical",
      expectedState: "known",
      match: { kind: "equals", value: "full_derivation" },
    },
    {
      field: "tone.register",
      importance: "important",
      expectedState: "known",
      match: { kind: "equals", value: "academic" },
    },
  ],
  trace: [
    {
      type: "request",
      text: "量子計算について論文を作って",
      providedFields: {
        "goal.deliverable": "paper",
        "goal.subject": "量子計算",
      },
    },
    {
      type: "assumption",
      field: "goal.audience",
      value: "一般読者",
      basis: "inferred",
    },
    {
      type: "assumption",
      field: "template.family",
      value: "general",
      basis: "inferred",
    },
    {
      type: "assumption",
      field: "figures.policy",
      value: "none",
      basis: "inferred",
    },
    {
      type: "assumption",
      field: "equations.derivationDetail",
      value: "result_only",
      basis: "inferred",
    },
    {
      type: "assumption",
      field: "tone.register",
      value: "plain",
      basis: "inferred",
    },
    {
      type: "brief_snapshot",
      version: 1,
      fields: {
        "goal.subject": {
          state: "known",
          value: "量子計算",
          source: "user",
        },
        "goal.audience": {
          state: "known",
          value: "一般読者",
          source: "agent",
        },
        "template.family": {
          state: "known",
          value: "general",
          source: "agent",
        },
        "figures.policy": {
          state: "known",
          value: "none",
          source: "agent",
        },
        "equations.derivationDetail": {
          state: "known",
          value: "result_only",
          source: "agent",
        },
        "tone.register": {
          state: "known",
          value: "plain",
          source: "agent",
        },
      },
    },
    {
      type: "plan_proposed",
      planId: "generic-plan-v1",
      planHash: "unconfirmed-generic-plan",
      briefVersion: 1,
    },
    {
      type: "document_mutation",
      intent: "draft",
      planId: "generic-plan-v1",
      planHash: "unconfirmed-generic-plan",
      revision: 1,
    },
    {
      type: "plan_confirmed",
      planId: "generic-plan-v1",
      planHash: "unconfirmed-generic-plan",
    },
  ],
});

export const DUPLICATE_QUESTION_AFTER_ANSWER_FIXTURE =
  AutonomyScenarioSchema.parse({
    id: "duplicate-question-after-answer",
    name: "Audience question repeated after it was answered",
    allowedDefaultFields: [],
    minimumBriefFidelity: 1,
    briefExpectations: [
      {
        field: "goal.subject",
        importance: "critical",
        expectedState: "known",
        match: { kind: "equals", value: "確率過程の講義ノート" },
      },
      {
        field: "goal.audience",
        importance: "critical",
        expectedState: "known",
        match: { kind: "equals", value: "学部3年生" },
      },
    ],
    trace: [
      {
        type: "request",
        text: "確率過程の講義ノートを作りたい",
        providedFields: {
          "goal.subject": "確率過程の講義ノート",
        },
      },
      {
        type: "question",
        questionId: "audience-1",
        questionKey: "target-audience",
        fieldKeys: ["goal.audience"],
        text: "想定する読者は誰ですか？",
      },
      {
        type: "answer",
        questionId: "audience-1",
        resolvedFields: {
          "goal.audience": "学部3年生",
        },
        delegatedFields: [],
      },
      {
        type: "question",
        questionId: "audience-2",
        questionKey: "target-audience",
        fieldKeys: ["goal.audience"],
        text: "対象読者を教えてください。",
      },
      {
        type: "brief_snapshot",
        version: 2,
        fields: {
          "goal.subject": {
            state: "known",
            value: "確率過程の講義ノート",
            source: "user",
          },
          "goal.audience": {
            state: "known",
            value: "学部3年生",
            source: "user",
          },
        },
      },
      {
        type: "plan_proposed",
        planId: "lecture-notes-plan-v1",
        planHash: "confirmed-lecture-notes-plan",
        briefVersion: 2,
      },
      {
        type: "plan_confirmed",
        planId: "lecture-notes-plan-v1",
        planHash: "confirmed-lecture-notes-plan",
      },
      {
        type: "document_mutation",
        intent: "draft",
        planId: "lecture-notes-plan-v1",
        planHash: "confirmed-lecture-notes-plan",
        revision: 1,
      },
    ],
  });

export const AGENT_AUTONOMY_FIXTURES = [
  ACADEMIC_PAPER_GUIDED_INTAKE_FIXTURE,
  PREMATURE_GENERIC_DRAFT_FIXTURE,
  DUPLICATE_QUESTION_AFTER_ANSWER_FIXTURE,
] as const;

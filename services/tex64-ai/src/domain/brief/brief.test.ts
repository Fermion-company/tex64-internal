import { describe, expect, it } from "vitest";

import {
  BriefDomainError,
  BriefExtractionSchema,
  DocumentBriefSchema,
  advanceElicitation,
  applyBriefExtraction,
  applyExplicitDelegation,
  confirmDocumentBrief,
  createDocumentAgentSession,
  createQuestionFingerprint,
  evaluateBriefCoverage,
  extractBriefDeterministically,
  isRequirementGroupApplicable,
  requirementProfileFor,
  resolveSafeCustomTemplatePreset,
  summarizeDocumentBrief,
} from "./index";

const NOW = "2026-08-08T00:00:00.000+09:00";
const LATER = "2026-08-08T00:01:00.000+09:00";
const DOCUMENT_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "20000000-0000-4000-8000-000000000001";
const ROOT_RUN_ID = "30000000-0000-4000-8000-000000000001";
const ANSWER_RUN_ID = "30000000-0000-4000-8000-000000000002";
const LATER_RUN_ID = "30000000-0000-4000-8000-000000000003";

function paperSession() {
  return createDocumentAgentSession({
    sessionId: SESSION_ID,
    documentId: DOCUMENT_ID,
    rootRunId: ROOT_RUN_ID,
    deliverable: "paper",
    now: NOW,
  });
}

describe("typed document brief", () => {
  it("initializes only the selected deliverable as provided", () => {
    const session = paperSession();
    expect(session.brief.goal.deliverable).toMatchObject({
      status: "provided",
      value: "paper",
      source: { kind: "selected_document_type" },
    });
    expect(session.brief.goal.subject).toMatchObject({
      status: "unknown",
      value: null,
      source: null,
    });
    expect(session.confirmedBriefVersion).toBeNull();
    expect(session.phase).toBe("intake");
  });

  it("does not allow agent defaults to masquerade as user-provided values", () => {
    const brief = structuredClone(paperSession().brief);
    brief.goal.subject = {
      status: "provided",
      value: "モデルが推測した主題",
      source: { kind: "agent_default", runId: ROOT_RUN_ID },
      updatedAt: NOW,
    };
    expect(() => DocumentBriefSchema.parse(brief)).toThrow(
      /Agent defaults cannot be presented as user-provided requirements/,
    );
  });

  it("uses document kind profiles without asking letters about math, figures, or sources", () => {
    const letter = createDocumentAgentSession({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      rootRunId: ROOT_RUN_ID,
      deliverable: "letter",
      now: NOW,
    });
    expect(requirementProfileFor("letter")).toMatchObject({
      mathematics: "not_applicable",
      visuals: "not_applicable",
      sources_evidence: "not_applicable",
    });
    expect(letter.brief.equations.policy.status).toBe("not_applicable");
    expect(letter.brief.figures.policy.status).toBe("not_applicable");
    expect(
      evaluateBriefCoverage(letter.brief).gaps.map((gap) => gap.group),
    ).not.toEqual(
      expect.arrayContaining(["mathematics", "visuals", "sources_evidence"]),
    );
  });

  it.each(["article", "proposal", "report", "notes"] as const)(
    "does not silently skip sources, equations, or figures for a sparse %s",
    (deliverable) => {
      const session = createDocumentAgentSession({
        sessionId: SESSION_ID,
        documentId: DOCUMENT_ID,
        rootRunId: ROOT_RUN_ID,
        deliverable,
        now: NOW,
      });
      expect(
        evaluateBriefCoverage(session.brief).gaps.map((gap) => gap.group),
      ).toEqual(
        expect.arrayContaining([
          "sources_evidence",
          "mathematics",
          "visuals",
        ]),
      );
    },
  );

  it("reopens a normally inapplicable group when the user explicitly requests it", () => {
    const original = createDocumentAgentSession({
      sessionId: SESSION_ID,
      documentId: DOCUMENT_ID,
      rootRunId: ROOT_RUN_ID,
      deliverable: "letter",
      now: NOW,
    });
    const answer = "数式を入れてください";
    const updated = applyBriefExtraction({
      session: original,
      extraction: extractBriefDeterministically({ text: answer }),
      answerText: answer,
      runId: ANSWER_RUN_ID,
      now: LATER,
    });
    expect(updated.brief.equations.policy).toMatchObject({
      status: "provided",
      value: "required",
    });
    expect(isRequirementGroupApplicable(updated.brief, "mathematics")).toBe(
      true,
    );
    expect(evaluateBriefCoverage(updated.brief).gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "mathematics" }),
      ]),
    );
  });
});

describe("coverage and adaptive questions", () => {
  it("treats the missing subject as the first blocking gap", () => {
    const coverage = evaluateBriefCoverage(paperSession().brief);
    expect(coverage.complete).toBe(false);
    expect(coverage.blockingGaps[0]).toMatchObject({
      group: "subject",
      impact: "blocking",
      canDelegate: false,
      missingPaths: ["goal.subject"],
    });
  });

  it("selects one stable question and returns it idempotently until answered", () => {
    const first = advanceElicitation({
      session: paperSession(),
      sourceRunId: ROOT_RUN_ID,
      now: NOW,
    });
    expect(first.question).toMatchObject({
      target: "subject",
      targetPaths: ["goal.subject"],
      status: "pending",
    });
    expect(first.session.phase).toBe("awaiting_answer");
    expect(first.session.questionCount).toBe(1);

    const replay = advanceElicitation({
      session: first.session,
      sourceRunId: ROOT_RUN_ID,
      now: LATER,
    });
    expect(replay.question).toEqual(first.question);
    expect(replay.session).toEqual(first.session);
  });

  it("creates stable fingerprints that change with the decision being asked", () => {
    const common = {
      prompt: "どの条件にしますか？",
      options: [{ id: "a", label: "A" }],
    };
    const first = createQuestionFingerprint({
      ...common,
      target: "subject",
      targetPaths: ["goal.subject"],
    });
    const replay = createQuestionFingerprint({
      ...common,
      target: "subject",
      targetPaths: ["goal.subject"],
    });
    const other = createQuestionFingerprint({
      ...common,
      target: "visuals",
      targetPaths: ["figures.policy"],
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(replay).toBe(first);
    expect(other).not.toBe(first);
  });

  it("offers recommended defaults after three consecutive questions", () => {
    const rootAnswer = "Transformerの注意機構について論文を書いて";
    let session = applyBriefExtraction({
      session: paperSession(),
      extraction: extractBriefDeterministically({ text: rootAnswer }),
      answerText: rootAnswer,
      runId: ROOT_RUN_ID,
      now: NOW,
    });

    for (const [index, runId] of [
      ANSWER_RUN_ID,
      LATER_RUN_ID,
      "30000000-0000-4000-8000-000000000004",
    ].entries()) {
      const advanced = advanceElicitation({
        session,
        sourceRunId: runId,
        now: LATER,
      });
      expect(advanced.question).not.toBeNull();
      session = applyBriefExtraction({
        session: advanced.session,
        extraction: extractBriefDeterministically({ text: "まだ決めていません" }),
        answerText: "まだ決めていません",
        runId,
        now: LATER,
        questionId: advanced.question?.id,
      });
      expect(session.questionCount).toBe(index + 1);
    }

    const checkpoint = advanceElicitation({
      session,
      sourceRunId: "30000000-0000-4000-8000-000000000005",
      now: LATER,
    });
    expect(checkpoint.question).toMatchObject({
      target: "delegation_offer",
      kind: "confirm",
    });
  });
});

describe("evidence-backed answer reducer", () => {
  it("extracts several explicit requirements without inventing unmentioned ones", () => {
    const text =
      "Transformerの注意機構について、学部生向けに、約8ページ、図を入れて、主要な導出まで、学術的かつ分析的に書いて";
    const extraction = extractBriefDeterministically({ text });
    expect(extraction).toMatchObject({
      subject: "Transformerの注意機構",
      audience: "学部生",
      targetLength: "約8ページ",
      figurePolicy: "required",
      derivationDetail: "key_steps",
      toneRegister: "academic",
      toneVoice: "analytical",
    });
    expect(extraction.purpose).toBeNull();
    expect(extraction.evidence.map((item) => item.path)).toEqual(
      expect.arrayContaining([
        "goal.subject",
        "goal.audience",
        "scope.targetLength",
        "figures.policy",
        "equations.derivationDetail",
        "tone.register",
        "tone.voice",
      ]),
    );
  });

  it("ignores model-extracted values whose evidence is absent from the answer", () => {
    const fabricated = BriefExtractionSchema.parse({
      ...extractBriefDeterministically({ text: "" }),
      subject: "モデルが勝手に決めた主題",
      evidence: [{ path: "goal.subject", quote: "存在しない引用" }],
    });
    const updated = applyBriefExtraction({
      session: paperSession(),
      extraction: fabricated,
      answerText: "まだ主題は決めていません",
      runId: ANSWER_RUN_ID,
      now: LATER,
    });
    expect(updated.brief.goal.subject.status).toBe("unknown");
    expect(updated.brief.goal.subject.value).toBeNull();
  });

  it("rejects a model value that is unrelated to an otherwise real quote", () => {
    const answer = "大学生向けに書いてください";
    const fabricated = BriefExtractionSchema.parse({
      ...extractBriefDeterministically({ text: answer }),
      subject: "モデルが勝手に決めた主題",
      evidence: [{ path: "goal.subject", quote: "大学生向け" }],
    });
    const updated = applyBriefExtraction({
      session: paperSession(),
      extraction: fabricated,
      answerText: answer,
      runId: ANSWER_RUN_ID,
      now: LATER,
    });

    expect(updated.brief.goal.subject).toMatchObject({
      status: "unknown",
      value: null,
    });
  });

  it("rejects an invented list item even when another item is quoted", () => {
    const answer = "含める内容は背景です";
    const fabricated = BriefExtractionSchema.parse({
      ...extractBriefDeterministically({ text: answer }),
      includedTopics: ["背景", "ユーザーが指定していない実験結果"],
      evidence: [{ path: "scope.includedTopics", quote: answer }],
    });
    const updated = applyBriefExtraction({
      session: paperSession(),
      extraction: fabricated,
      answerText: answer,
      runId: ANSWER_RUN_ID,
      now: LATER,
    });

    expect(updated.brief.scope.includedTopics).toMatchObject({
      status: "unknown",
      value: null,
    });
  });

  it("rejects an enum value that contradicts the quoted user answer", () => {
    const answer = "出典なし";
    const contradictory = BriefExtractionSchema.parse({
      ...extractBriefDeterministically({ text: answer }),
      sourcePolicy: "agent_research",
      evidence: [{ path: "sources.policy", quote: answer }],
    });
    const updated = applyBriefExtraction({
      session: paperSession(),
      extraction: contradictory,
      answerText: answer,
      runId: ANSWER_RUN_ID,
      now: LATER,
    });

    expect(updated.brief.sources.policy).toMatchObject({
      status: "unknown",
      value: null,
    });
  });

  it("rejects a non-measurable length even when a model attaches matching evidence", () => {
    const answer = "長め";
    const fabricated = BriefExtractionSchema.parse({
      ...extractBriefDeterministically({ text: answer }),
      targetLength: answer,
      evidence: [{ path: "scope.targetLength", quote: answer }],
    });
    const updated = applyBriefExtraction({
      session: paperSession(),
      extraction: fabricated,
      answerText: answer,
      runId: ANSWER_RUN_ID,
      now: LATER,
    });
    expect(updated.brief.scope.targetLength.status).toBe("unknown");
  });

  it("records an explicit empty list as answered", () => {
    const answer = "なし";
    const updated = applyBriefExtraction({
      session: paperSession(),
      extraction: extractBriefDeterministically({
        text: answer,
        target: "scope_structure",
        targetPaths: ["scope.excludedTopics"],
      }),
      answerText: answer,
      runId: ANSWER_RUN_ID,
      now: LATER,
    });

    expect(updated.brief.scope.excludedTopics).toMatchObject({
      status: "provided",
      value: [],
      source: { kind: "user", runId: ANSWER_RUN_ID },
    });
  });

  it("applies multiple evidence-backed values and preserves user provenance", () => {
    const answer = "量子誤り訂正について、対象読者は大学院生、約10ページ、日本語で書いて";
    const extraction = extractBriefDeterministically({ text: answer });
    const updated = applyBriefExtraction({
      session: paperSession(),
      extraction,
      answerText: answer,
      runId: ANSWER_RUN_ID,
      now: LATER,
    });
    expect(updated.brief.goal.subject).toMatchObject({
      status: "provided",
      value: "量子誤り訂正",
      source: { kind: "user", runId: ANSWER_RUN_ID },
    });
    expect(updated.brief.goal.audience.value).toBe("大学院生");
    expect(updated.brief.scope.targetLength.value).toBe("約10ページ");
    expect(updated.brief.scope.language.value).toBe("日本語");
    expect(updated.briefVersion).toBe(2);
  });

  it("is idempotent for the same answer run", () => {
    const answer = "強化学習について論文を書いて";
    const extraction = extractBriefDeterministically({ text: answer });
    const once = applyBriefExtraction({
      session: paperSession(),
      extraction,
      answerText: answer,
      runId: ANSWER_RUN_ID,
      now: LATER,
    });
    const twice = applyBriefExtraction({
      session: once,
      extraction,
      answerText: answer,
      runId: ANSWER_RUN_ID,
      now: LATER,
    });
    expect(twice).toEqual(once);
  });
});

describe("delegation and final confirmation", () => {
  it("does not delegate merely because a model listed delegated groups", () => {
    const extraction = BriefExtractionSchema.parse({
      ...extractBriefDeterministically({ text: "まだ決めていません" }),
      delegatedGroups: ["presentation"],
    });
    const updated = applyBriefExtraction({
      session: paperSession(),
      extraction,
      answerText: "まだ決めていません",
      runId: ANSWER_RUN_ID,
      now: LATER,
    });
    expect(updated.brief.template.family.status).toBe("unknown");

    const negatedAnswer = "お任せにはしません";
    const negated = applyBriefExtraction({
      session: paperSession(),
      extraction: BriefExtractionSchema.parse({
        ...extractBriefDeterministically({ text: negatedAnswer }),
        delegatedGroups: ["presentation"],
      }),
      answerText: negatedAnswer,
      runId: LATER_RUN_ID,
      now: LATER,
    });
    expect(negated.brief.template.family.status).toBe("unknown");
  });

  it("records explicitly accepted defaults as delegated, never provided", () => {
    const subjectAnswer = "注意機構について論文を書いて";
    const withSubject = applyBriefExtraction({
      session: paperSession(),
      extraction: extractBriefDeterministically({ text: subjectAnswer }),
      answerText: subjectAnswer,
      runId: ROOT_RUN_ID,
      now: NOW,
    });
    const delegated = applyExplicitDelegation({
      session: withSubject,
      groups: ["presentation", "sources_evidence"],
      delegatedByRunId: ANSWER_RUN_ID,
      now: LATER,
    });
    expect(delegated.brief.template.family).toMatchObject({
      status: "delegated",
      source: { kind: "agent_default", runId: ANSWER_RUN_ID },
    });
    expect(delegated.brief.sources.policy.status).toBe("delegated");
    expect(delegated.brief.assumptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "presentation" }),
        expect.objectContaining({ path: "sources_evidence" }),
      ]),
    );
  });

  it("fills only missing values when a partially answered group is delegated", () => {
    const answer = "目的は仮説を検証することです";
    const withPurpose = applyBriefExtraction({
      session: paperSession(),
      extraction: extractBriefDeterministically({ text: answer }),
      answerText: answer,
      runId: ANSWER_RUN_ID,
      now: LATER,
    });
    const delegated = applyExplicitDelegation({
      session: withPurpose,
      groups: ["purpose_audience"],
      delegatedByRunId: LATER_RUN_ID,
      now: LATER,
    });

    expect(delegated.brief.goal.purpose).toMatchObject({
      status: "provided",
      value: "仮説を検証することです",
      source: { kind: "user", runId: ANSWER_RUN_ID },
    });
    expect(delegated.brief.goal.audience.status).toBe("delegated");
    expect(delegated.brief.goal.intendedOutcome.status).toBe("delegated");
  });

  it("refuses direct delegation while a question is awaiting an answer", () => {
    const awaiting = advanceElicitation({
      session: paperSession(),
      sourceRunId: ROOT_RUN_ID,
      now: NOW,
    });
    expect(() =>
      applyExplicitDelegation({
        session: awaiting.session,
        groups: ["presentation"],
        delegatedByRunId: ANSWER_RUN_ID,
        now: LATER,
      }),
    ).toThrow(BriefDomainError);
  });

  it("renders confirmation summaries without internal enum names", () => {
    const subjectAnswer = "注意機構について論文を書いて";
    const withSubject = applyBriefExtraction({
      session: paperSession(),
      extraction: extractBriefDeterministically({ text: subjectAnswer }),
      answerText: subjectAnswer,
      runId: ROOT_RUN_ID,
      now: NOW,
    });
    const delegated = applyExplicitDelegation({
      session: withSubject,
      groups: ["sources_evidence", "mathematics", "visuals", "presentation"],
      delegatedByRunId: ANSWER_RUN_ID,
      now: LATER,
    });
    const summary = summarizeDocumentBrief(delegated.brief);
    expect(summary).toContain("出典: 文献を調査");
    expect(summary).toContain("数式: 必要な箇所に数式");
    expect(summary).toContain("口調: 学術的");
    expect(summary).toContain("形式: 論文");
    expect(summary).toContain("版面: A4・1段");
    expect(summary).not.toMatch(/agent_research|as_needed|academic/u);
  });

  it("asks for a supported format before confirming an unsupported custom template", () => {
    const subjectAnswer = "確率過程について論文を書いて";
    let session = applyBriefExtraction({
      session: paperSession(),
      extraction: extractBriefDeterministically({ text: subjectAnswer }),
      answerText: subjectAnswer,
      runId: ROOT_RUN_ID,
      now: NOW,
    });
    const customAnswer = "テンプレートは東大学位論文.cls";
    session = applyBriefExtraction({
      session,
      extraction: BriefExtractionSchema.parse({
        ...extractBriefDeterministically({ text: customAnswer }),
        templateFamily: "custom",
        customTemplate: "東大学位論文.cls",
        evidence: [
          { path: "template.family", quote: customAnswer },
          { path: "template.customTemplate", quote: customAnswer },
        ],
      }),
      answerText: customAnswer,
      runId: ANSWER_RUN_ID,
      now: LATER,
    });
    session = applyExplicitDelegation({
      session,
      groups: [
        "purpose_audience",
        "scope_structure",
        "sources_evidence",
        "mathematics",
        "visuals",
        "acceptance",
      ],
      delegatedByRunId: LATER_RUN_ID,
      now: LATER,
    });

    const chooseFormat = advanceElicitation({
      session,
      sourceRunId: "30000000-0000-4000-8000-000000000004",
      now: LATER,
    });
    expect(chooseFormat.question).toMatchObject({
      target: "presentation",
      targetPaths: ["template.customTemplate"],
      prompt: expect.stringContaining("希望する仕上がり"),
    });
    expect(chooseFormat.question?.prompt).not.toContain("対応していません");
    expect(chooseFormat.session.brief.template.customTemplate.status).toBe(
      "unknown",
    );
    expect(resolveSafeCustomTemplatePreset("東大学位論文.cls")).toBeNull();
    expect(
      resolveSafeCustomTemplatePreset("\\documentclass{article}"),
    ).toBeNull();
    expect(chooseFormat.question?.prompt).toContain("コンパクト");

    const formatAnswer = "コンパクト";
    session = applyBriefExtraction({
      session: chooseFormat.session,
      extraction: extractBriefDeterministically({
        text: formatAnswer,
        target: chooseFormat.question?.target,
        targetPaths: chooseFormat.question?.targetPaths,
      }),
      answerText: formatAnswer,
      runId: "30000000-0000-4000-8000-000000000005",
      now: LATER,
      questionId: chooseFormat.question?.id,
    });
    expect(session.brief.template.family.value).toBe("compact");
    expect(session.brief.template.customTemplate.status).toBe(
      "not_applicable",
    );

    session = applyExplicitDelegation({
      session,
      groups: ["presentation"],
      delegatedByRunId: "30000000-0000-4000-8000-000000000006",
      now: LATER,
    });
    const confirmation = advanceElicitation({
      session,
      sourceRunId: "30000000-0000-4000-8000-000000000007",
      now: LATER,
    });
    expect(confirmation.question?.target).toBe("brief_confirmation");
    expect(confirmation.question?.prompt).toContain("形式: コンパクト");
  });

  it("keeps a safely representable custom style through confirmation", () => {
    const subjectAnswer = "監査可能なAIについて提案書を書いて";
    let session = applyBriefExtraction({
      session: createDocumentAgentSession({
        sessionId: SESSION_ID,
        documentId: DOCUMENT_ID,
        rootRunId: ROOT_RUN_ID,
        deliverable: "proposal",
        now: NOW,
      }),
      extraction: extractBriefDeterministically({ text: subjectAnswer }),
      answerText: subjectAnswer,
      runId: ROOT_RUN_ID,
      now: NOW,
    });
    const styleAnswer = "テンプレートは経営会議向け";
    session = applyBriefExtraction({
      session,
      extraction: extractBriefDeterministically({ text: styleAnswer }),
      answerText: styleAnswer,
      runId: ANSWER_RUN_ID,
      now: LATER,
    });
    expect(session.brief.template.family.value).toBe("custom");
    expect(session.brief.template.customTemplate.value).toBe("経営会議向け");
    expect(resolveSafeCustomTemplatePreset("経営会議向け")).toBe("business");

    session = applyExplicitDelegation({
      session,
      groups: [
        "purpose_audience",
        "scope_structure",
        "sources_evidence",
        "mathematics",
        "visuals",
        "presentation",
        "acceptance",
      ],
      delegatedByRunId: LATER_RUN_ID,
      now: LATER,
    });
    expect(session.brief.template.family.value).toBe("custom");
    expect(session.brief.template.customTemplate.value).toBe("経営会議向け");

    const confirmation = advanceElicitation({
      session,
      sourceRunId: "30000000-0000-4000-8000-000000000009",
      now: LATER,
    });
    expect(confirmation.question?.target).toBe("brief_confirmation");
    expect(confirmation.question?.prompt).toContain("形式: 経営会議向け");
  });

  it("asks what to revise instead of repeating confirmation and reconfirms the new brief", () => {
    const subjectAnswer = "注意機構について論文を書いて";
    let session = applyBriefExtraction({
      session: paperSession(),
      extraction: extractBriefDeterministically({ text: subjectAnswer }),
      answerText: subjectAnswer,
      runId: ROOT_RUN_ID,
      now: NOW,
    });
    session = applyExplicitDelegation({
      session,
      groups: [
        "purpose_audience",
        "scope_structure",
        "sources_evidence",
        "mathematics",
        "visuals",
        "presentation",
        "acceptance",
      ],
      delegatedByRunId: ANSWER_RUN_ID,
      now: LATER,
    });
    const confirmation = advanceElicitation({
      session,
      sourceRunId: LATER_RUN_ID,
      now: LATER,
    });
    const revisionRequest = "条件を変更する";
    session = applyBriefExtraction({
      session: confirmation.session,
      extraction: extractBriefDeterministically({
        text: revisionRequest,
        target: confirmation.question?.target,
        targetPaths: confirmation.question?.targetPaths,
      }),
      answerText: revisionRequest,
      runId: LATER_RUN_ID,
      now: LATER,
      questionId: confirmation.question?.id,
    });

    const revision = advanceElicitation({
      session,
      sourceRunId: "30000000-0000-4000-8000-000000000004",
      now: LATER,
    });
    expect(revision.question).toMatchObject({
      target: "brief_revision",
      prompt: expect.stringContaining("変更したい条件を1つ"),
    });

    const change = "図表なしに変更";
    session = applyBriefExtraction({
      session: revision.session,
      extraction: extractBriefDeterministically({
        text: change,
        target: revision.question?.target,
        targetPaths: revision.question?.targetPaths,
      }),
      answerText: change,
      runId: "30000000-0000-4000-8000-000000000005",
      now: LATER,
      questionId: revision.question?.id,
    });
    expect(session.brief.figures.policy.value).toBe("none");

    const revisedConfirmation = advanceElicitation({
      session,
      sourceRunId: "30000000-0000-4000-8000-000000000006",
      now: LATER,
    });
    expect(revisedConfirmation.question?.target).toBe("brief_confirmation");
    expect(revisedConfirmation.question?.prompt).toContain("図表: 図表なし");
  });

  it("requires complete coverage and a separate final confirmation before planning", () => {
    const subjectAnswer = "注意機構について論文を書いて";
    const withSubject = applyBriefExtraction({
      session: paperSession(),
      extraction: extractBriefDeterministically({ text: subjectAnswer }),
      answerText: subjectAnswer,
      runId: ROOT_RUN_ID,
      now: NOW,
    });
    expect(() =>
      confirmDocumentBrief({
        session: withSubject,
        confirmedByRunId: ANSWER_RUN_ID,
        now: LATER,
      }),
    ).toThrow(BriefDomainError);

    const delegated = applyExplicitDelegation({
      session: withSubject,
      groups: [
        "purpose_audience",
        "scope_structure",
        "sources_evidence",
        "mathematics",
        "visuals",
        "presentation",
        "acceptance",
      ],
      delegatedByRunId: ANSWER_RUN_ID,
      now: LATER,
    });
    expect(evaluateBriefCoverage(delegated.brief).complete).toBe(true);
    expect(delegated.brief.scope.targetLength.value).toMatch(/文字$/u);
    expect(
      delegated.brief.acceptanceCriteria.some(
        (criterion) => criterion.kind === "user_review",
      ),
    ).toBe(false);
    expect(
      delegated.brief.acceptanceCriteria.filter(
        (criterion) => criterion.severity === "required",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "deterministic",
        statement: "文書の構造と参照関係に問題がない",
      }),
    ]);

    const awaitingConfirmation = advanceElicitation({
      session: delegated,
      sourceRunId: LATER_RUN_ID,
      now: LATER,
    });
    expect(awaitingConfirmation.ready).toBe(false);
    expect(awaitingConfirmation.question?.target).toBe("brief_confirmation");
    expect(awaitingConfirmation.session.phase).toBe(
      "awaiting_brief_confirmation",
    );

    const confirmed = confirmDocumentBrief({
      session: awaitingConfirmation.session,
      confirmedByRunId: LATER_RUN_ID,
      questionId: awaitingConfirmation.question?.id,
      now: LATER,
    });
    expect(confirmed.phase).toBe("planning");
    expect(confirmed.confirmedBriefVersion).toBe(confirmed.briefVersion);
    expect(
      advanceElicitation({
        session: confirmed,
        sourceRunId: LATER_RUN_ID,
        now: LATER,
      }).ready,
    ).toBe(true);
  });
});

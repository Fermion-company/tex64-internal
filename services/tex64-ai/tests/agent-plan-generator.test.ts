import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  advanceElicitation,
  applyBriefExtraction,
  applyExplicitDelegation,
  confirmDocumentBrief,
  createDocumentAgentSession,
} from "@/domain/brief";
import {
  createDocumentPlanDeterministically,
} from "@/server/agent/plan-generator";
import { extractBriefRequirementsDeterministically } from "@/server/agent/brief-extractor";
import { createReviewBriefDigest } from "@/domain/review";

describe("document plan generation", () => {
  it("turns a confirmed brief into a validated section-by-section plan", () => {
    const now = "2026-08-07T12:00:00.000+09:00";
    const subjectRunId = randomUUID();
    let session = createDocumentAgentSession({
      sessionId: randomUUID(),
      documentId: randomUUID(),
      rootRunId: subjectRunId,
      deliverable: "paper",
      now,
    });
    const answer =
      "注意機構について論文を書いて。対象読者は学部生です。目的は仕組みを説明することです。";
    session = applyBriefExtraction({
      session,
      extraction: extractBriefRequirementsDeterministically({
        prompt: answer,
        activeQuestion: null,
      }),
      answerText: answer,
      runId: subjectRunId,
      now,
    });
    const delegationRunId = randomUUID();
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
      delegatedByRunId: delegationRunId,
      now,
    });
    session = confirmDocumentBrief({
      session,
      confirmedByRunId: randomUUID(),
      now,
    });

    const plan = createDocumentPlanDeterministically({
      brief: session.brief,
      briefVersion: session.briefVersion,
      now,
    });

    expect(plan.documentId).toBe(session.documentId);
    expect(plan.briefVersion).toBe(session.briefVersion);
    expect(plan.briefDigest).toBe(createReviewBriefDigest(session.brief));
    expect(plan.sections.map((section) => section.title)).toEqual(
      session.brief.template.sectionOrder.value,
    );
    expect(
      plan.sections.flatMap((section) => section.sourceRequirements),
    ).not.toHaveLength(0);
    expect(plan.completionCriteria.some((criterion) =>
      criterion.statement.includes("構造"),
    )).toBe(true);
  });

  it("binds each requested Maxwell derivation to its own concrete math item", () => {
    const now = "2026-08-07T12:00:00.000+09:00";
    const rootRunId = randomUUID();
    let session = createDocumentAgentSession({
      sessionId: randomUUID(),
      documentId: randomUUID(),
      rootRunId,
      deliverable: "paper",
      now,
    });
    const request =
      "マクスウェル方程式について論文を書いて。数式を主要部分に必ず入れて。";
    session = applyBriefExtraction({
      session,
      extraction: extractBriefRequirementsDeterministically({
        prompt: request,
        activeQuestion: null,
      }),
      answerText: request,
      runId: rootRunId,
      now,
    });
    session = applyExplicitDelegation({
      session,
      groups: [
        "purpose_audience",
        "scope_structure",
        "sources_evidence",
        "visuals",
        "presentation",
        "acceptance",
      ],
      delegatedByRunId: randomUUID(),
      now,
    });

    const objectiveQuestion = advanceElicitation({
      session,
      sourceRunId: randomUUID(),
      now,
    });
    expect(objectiveQuestion.question?.targetPaths).toEqual([
      "equations.items",
    ]);
    const objectiveAnswer =
      "マクスウェル方程式から真空中の電磁波動方程式を導出、ポインティングの定理を証明";
    session = applyBriefExtraction({
      session: objectiveQuestion.session,
      extraction: extractBriefRequirementsDeterministically({
        prompt: objectiveAnswer,
        activeQuestion: objectiveQuestion.question,
      }),
      answerText: objectiveAnswer,
      runId: randomUUID(),
      now,
      questionId: objectiveQuestion.question?.id,
    });
    session = applyExplicitDelegation({
      session,
      groups: ["mathematics"],
      delegatedByRunId: randomUUID(),
      now,
    });
    session = confirmDocumentBrief({
      session,
      confirmedByRunId: randomUUID(),
      now,
    });

    const plan = createDocumentPlanDeterministically({
      brief: session.brief,
      briefVersion: session.briefVersion,
      now,
    });
    const mathItems = plan.sections.flatMap(
      (section) => section.mathematics.items,
    );
    expect(mathItems.map((item) => item.briefItem)).toEqual(
      session.brief.equations.items.value,
    );
    expect(new Set(mathItems.map((item) => item.id)).size).toBe(2);
    expect(JSON.stringify(mathItems)).not.toContain("中心的な関係");
  });
});

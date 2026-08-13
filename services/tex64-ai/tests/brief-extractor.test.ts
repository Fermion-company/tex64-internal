import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ElicitationQuestion } from "@/domain/brief";
import { extractBriefRequirementsDeterministically } from "@/server/agent/brief-extractor";

function question(
  target: ElicitationQuestion["target"],
  targetPaths: ElicitationQuestion["targetPaths"] = [],
): ElicitationQuestion {
  const sourceRunId = randomUUID();
  return {
    id: randomUUID(),
    kind: target === "brief_confirmation" ? "confirm" : "free_text",
    target,
    targetPaths,
    prompt: "希望する条件を教えてください。",
    options: [],
    allowsFreeText: true,
    fingerprint: createHash("sha256").update(target).digest("hex"),
    status: "pending",
    sourceRunId,
    briefVersion: 1,
    answeredByRunId: null,
    createdAt: new Date().toISOString(),
  };
}

describe("deterministic brief extraction", () => {
  it("does not invent a subject for a sparse request", () => {
    const extracted = extractBriefRequirementsDeterministically({
      prompt: "論文を書いて",
      activeQuestion: null,
    });

    expect(extracted.subject).toBeNull();
    expect(extracted.audience).toBeNull();
    expect(extracted.delegatedGroups).toEqual([]);
    expect(extracted.confirmsBrief).toBe(false);
  });

  it("extracts several explicit conditions from one request", () => {
    const extracted = extractBriefRequirementsDeterministically({
      prompt:
        "注意機構について学部生向けの論文を日本語で10ページ程度。査読論文を引用し、数式は途中式を省略せず、処理の流れを図に入れて、学術的な文体にして。",
      activeQuestion: null,
    });

    expect(extracted.subject).toBe("注意機構");
    expect(extracted.audience).toContain("学部生");
    expect(extracted.targetLength).toContain("10ページ");
    expect(extracted.sourcePolicy).toBe("agent_research");
    expect(extracted.equationPolicy).toBe("required");
    expect(extracted.derivationDetail).toBe("full_derivation");
    expect(extracted.figurePolicy).toBe("required");
    expect(extracted.toneRegister).toBe("academic");
  });

  it("uses a free answer as the subject only for the subject question", () => {
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "Transformerの注意機構",
        activeQuestion: question("subject"),
      }).subject,
    ).toBe("Transformerの注意機構");
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "Transformerの注意機構",
        activeQuestion: question("presentation"),
      }).subject,
    ).toBeNull();
  });

  it("records delegation only for the question being answered", () => {
    const extracted = extractBriefRequirementsDeterministically({
      prompt: "そこはおすすめに任せる",
      activeQuestion: question("visuals"),
    });

    expect(extracted.delegatedGroups).toEqual(["visuals"]);
    expect(extracted.figurePolicy).toBeNull();
  });

  it("keeps an explicit answer when a different requirement is delegated", () => {
    const extracted = extractBriefRequirementsDeterministically({
      prompt: "文体は任せるが、目的は仮説を検証することです",
      activeQuestion: question("purpose_audience", ["goal.purpose"]),
    });

    expect(extracted.delegatedGroups).toEqual(["presentation"]);
    expect(extracted.purpose).toContain("仮説を検証する");
  });

  it("understands the visible choice labels for one-decision questions", () => {
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "文献を調べる",
        activeQuestion: question("sources_evidence", ["sources.policy"]),
      }).sourcePolicy,
    ).toBe("agent_research");
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "必要な箇所だけ",
        activeQuestion: question("mathematics", ["equations.policy"]),
      }).equationPolicy,
    ).toBe("as_needed");
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "前提から完全に導出",
        activeQuestion: question("mathematics", [
          "equations.derivationDetail",
        ]),
      }).derivationDetail,
    ).toBe("full_derivation");
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "提供した図表だけ",
        activeQuestion: question("visuals", ["figures.policy"]),
      }).figurePolicy,
    ).toBe("provided_only");
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "内容に合う図を作る",
        activeQuestion: question("visuals", ["figures.policy"]),
      }).figurePolicy,
    ).toBe("agent_proposes");
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "コンパクト",
        activeQuestion: question("presentation", ["template.family"]),
      }).templateFamily,
    ).toBe("compact");
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "レターサイズ",
        activeQuestion: question("presentation", ["template.pageSize"]),
      }).pageSize,
    ).toBe("letter");
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "APA第7版",
        activeQuestion: question("sources_evidence", [
          "sources.citationStyle",
        ]),
      }).citationStyle,
    ).toBe("apa7");
  });

  it("preserves explicit empty answers and does not confuse depth with tone", () => {
    const empty = extractBriefRequirementsDeterministically({
      prompt: "なし",
      activeQuestion: question("scope_structure", [
        "scope.excludedTopics",
      ]),
    });
    expect(empty.excludedTopics).toEqual([]);
    expect(empty.evidence).toContainEqual({
      path: "scope.excludedTopics",
      quote: "なし",
    });

    const depth = extractBriefRequirementsDeterministically({
      prompt: "専門的・技術的",
      activeQuestion: question("scope_structure", ["scope.depth"]),
    });
    expect(depth.depth).toBe("technical");
    expect(depth.toneRegister).toBeNull();
  });

  it.each([
    ["10ページ", "10ページ"],
    ["8〜12ページ", "8〜12ページ"],
    ["5ページ以上", "5ページ以上"],
    ["約20ページ", "約20ページ"],
    ["12000文字程度", "12000文字程度"],
  ])("accepts a measurable target length: %s", (prompt, expected) => {
    const extracted = extractBriefRequirementsDeterministically({
      prompt,
      activeQuestion: question("scope_structure", ["scope.targetLength"]),
    });
    expect(extracted.targetLength).toBe(expected);
  });

  it.each(["長め", "ページ数は後で", "適切な長さ", "10くらい"])(
    "keeps an unmeasurable target length unresolved: %s",
    (prompt) => {
      const extracted = extractBriefRequirementsDeterministically({
        prompt,
        activeQuestion: question("scope_structure", [
          "scope.targetLength",
        ]),
      });
      expect(extracted.targetLength).toBeNull();
      expect(extracted.evidence).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "scope.targetLength" }),
        ]),
      );
    },
  );

  it("keeps unsupported custom templates unresolved instead of substituting one", () => {
    const extracted = extractBriefRequirementsDeterministically({
      prompt: "東大学位論文テンプレートで書いて",
      activeQuestion: null,
    });

    expect(extracted.templateFamily).toBe("custom");
    expect(extracted.customTemplate).toContain("東大学位論文テンプレート");
  });

  it("accepts confirmation only at the explicit confirmation question", () => {
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "この条件で進めてください",
        activeQuestion: question("brief_confirmation"),
      }).confirmsBrief,
    ).toBe(true);
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "この条件で進めてください",
        activeQuestion: question("scope_structure"),
      }).confirmsBrief,
    ).toBe(false);
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "この条件で進めてください。図表はなしに変更",
        activeQuestion: question("brief_confirmation"),
      }).confirmsBrief,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { extractBriefRequirementsDeterministically } from "@/server/agent/brief-extractor";

describe("deterministic brief extraction", () => {
  it("does not invent a subject for a sparse request", () => {
    const extracted = extractBriefRequirementsDeterministically({
      prompt: "論文を書いて",
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

  it("keeps an explicit value when a different requirement is delegated", () => {
    const extracted = extractBriefRequirementsDeterministically({
      prompt: "文体は任せるが、目的は仮説を検証することです",
    });

    expect(extracted.delegatedGroups).toEqual(["presentation"]);
    expect(extracted.purpose).toContain("仮説を検証する");
  });

  it.each([
    ["10ページでお願いします", "10ページ"],
    ["8〜12ページで書いて", "8〜12ページ"],
    ["5ページ以上にして", "5ページ以上"],
    ["約20ページで", "約20ページ"],
    ["12000文字程度でまとめて", "12000文字程度"],
  ])("accepts a measurable target length: %s", (prompt, expected) => {
    const extracted = extractBriefRequirementsDeterministically({ prompt });
    expect(extracted.targetLength).toBe(expected);
  });

  it.each(["長めにして", "ページ数は後で", "適切な長さで"])(
    "keeps an unmeasurable target length unresolved: %s",
    (prompt) => {
      const extracted = extractBriefRequirementsDeterministically({ prompt });
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
    });

    expect(extracted.templateFamily).toBe("custom");
    expect(extracted.customTemplate).toContain("東大学位論文テンプレート");
  });

  it("never reports a brief confirmation (the confirmation loop was removed)", () => {
    expect(
      extractBriefRequirementsDeterministically({
        prompt: "この条件で進めてください",
      }).confirmsBrief,
    ).toBe(false);
  });
});

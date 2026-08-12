import { describe, expect, it } from "vitest";

import { criterionAnchorBindsExcerpt } from "./node-evidence";

describe("criterion evidence lexical binding", () => {
  it.each([
    ["文書", "文書の構造に問題がない。", "この文書は別の話題を扱う。"],
    ["目的", "研究目的が本文に明示されている。", "目的"],
    ["この目的", "この目的が本文に明示されている。", "この目的"],
    ["文書について", "文書について要件を満たす。", "文書について説明する。"],
  ])("rejects the generic anchor %s", (anchor, statement, excerpt) => {
    expect(
      criterionAnchorBindsExcerpt({ statement, excerpt, anchor }),
    ).toBe(false);
  });

  it("rejects an arbitrary character slice crossing Japanese word boundaries", () => {
    expect(
      criterionAnchorBindsExcerpt({
        statement: "研究目的が本文に明示されている。",
        excerpt: "別の目的が本文に書かれている。",
        anchor: "的が本",
      }),
    ).toBe(false);
  });

  it.each([
    [
      "数式",
      "数式の各変形と根拠を示す。",
      "数式を三段階で変形し、各段階の根拠を記す。",
    ],
    [
      "証明",
      "定理には証明を付ける。",
      "証明は仮定の確認から始める。",
    ],
    [
      "構造化文書",
      "構造化文書の編集手順を説明する。",
      "構造化文書は型付きの要素として更新する。",
    ],
    ["図2", "図2で処理順を示す。", "図2は検証までの処理順を示す。"],
  ])("accepts the concrete Japanese anchor %s", (anchor, statement, excerpt) => {
    expect(
      criterionAnchorBindsExcerpt({ statement, excerpt, anchor }),
    ).toBe(true);
  });

  it("requires literal containment even when normalized forms look alike", () => {
    expect(
      criterionAnchorBindsExcerpt({
        statement: "ＡＩ評価を記録する。",
        excerpt: "AI評価の結果を記録した。",
        anchor: "AI評価",
      }),
    ).toBe(false);
  });
});

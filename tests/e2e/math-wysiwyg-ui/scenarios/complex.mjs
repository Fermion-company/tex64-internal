import assert from "node:assert/strict";

import { normalizeLatex } from "../runtime.mjs";
import {
  applySuggestionViaExplicitSession,
  assertRenderHealthy,
  clearMathField,
  getMathFieldLatex,
} from "../ui.mjs";
import { fillPlaceholderTemplateFromSuggestion } from "../actions.mjs";

export const COMPLEX_FORMULA_ENVIRONMENTS = ["pmatrix", "bmatrix", "vmatrix", "cases", "dcases"];

export const COMPLEX_FORMULA_PROFILES = [
  [
    { token: "frac", values: ["a", "b"], expect: "frac" },
    { token: "binom", values: ["c", "d"], expect: "binom" },
    { token: "frac", values: ["e", "f"], expect: "frac" },
    { token: "binom", values: ["g", "h"], expect: "binom" },
  ],
  [
    { token: "binom", values: ["i", "j"], expect: "binom" },
    { token: "frac", values: ["k", "l"], expect: "frac" },
    { token: "binom", values: ["m", "n"], expect: "binom" },
    { token: "frac", values: ["o", "p"], expect: "frac" },
  ],
  [
    { token: "frac", values: ["q", "r"], expect: "frac" },
    { token: "frac", values: ["s", "t"], expect: "frac" },
    { token: "binom", values: ["u", "v"], expect: "binom" },
    { token: "binom", values: ["w", "x"], expect: "binom" },
  ],
  [
    { token: "binom", values: ["y", "z"], expect: "binom" },
    { token: "binom", values: ["a", "c"], expect: "binom" },
    { token: "frac", values: ["d", "g"], expect: "frac" },
    { token: "frac", values: ["h", "i"], expect: "frac" },
  ],
  [
    { token: "frac", values: ["j", "k"], expect: "frac" },
    { token: "binom", values: ["l", "m"], expect: "binom" },
    { token: "binom", values: ["n", "o"], expect: "binom" },
    { token: "frac", values: ["p", "q"], expect: "frac" },
  ],
  [
    { token: "binom", values: ["r", "s"], expect: "binom" },
    { token: "frac", values: ["t", "u"], expect: "frac" },
    { token: "frac", values: ["v", "w"], expect: "frac" },
    { token: "binom", values: ["x", "y"], expect: "binom" },
  ],
  [
    { token: "frac", values: ["z", "a"], expect: "frac" },
    { token: "binom", values: ["b", "d"], expect: "binom" },
    { token: "frac", values: ["e", "h"], expect: "frac" },
    { token: "binom", values: ["i", "j"], expect: "binom" },
  ],
  [
    { token: "binom", values: ["k", "l"], expect: "binom" },
    { token: "frac", values: ["m", "n"], expect: "frac" },
    { token: "binom", values: ["o", "p"], expect: "binom" },
    { token: "frac", values: ["q", "r"], expect: "frac" },
  ],
  [
    { token: "frac", values: ["s", "t"], expect: "frac" },
    { token: "frac", values: ["u", "v"], expect: "frac" },
    { token: "binom", values: ["w", "x"], expect: "binom" },
    { token: "binom", values: ["y", "z"], expect: "binom" },
  ],
  [
    { token: "binom", values: ["a", "b"], expect: "binom" },
    { token: "binom", values: ["c", "d"], expect: "binom" },
    { token: "frac", values: ["e", "f"], expect: "frac" },
    { token: "frac", values: ["g", "h"], expect: "frac" },
  ],
];

export const runComplexPlaceholderFormula = async (page, entry, total) => {
  const { envToken, profile, index } = entry;
  const caseLabel = `complex ${index + 1}/${total} ${envToken}-p${entry.profileIndex + 1}`;
  await clearMathField(page);
  await applySuggestionViaExplicitSession(page, envToken, { expectedHint: envToken });
  for (let cellIndex = 0; cellIndex < profile.length; cellIndex += 1) {
    const step = profile[cellIndex];
    await fillPlaceholderTemplateFromSuggestion(page, step, {
      moveNext: cellIndex < profile.length - 1,
      caseLabel,
      cellIndex,
    });
  }

  const latex = normalizeLatex(await getMathFieldLatex(page));
  const beginTag = `\\begin{${envToken}}`;
  const endTag = `\\end{${envToken}}`;
  const beginPos = latex.indexOf(beginTag);
  const endPos = latex.indexOf(endTag);

  assert.ok(
    beginPos >= 0 && endPos > beginPos,
    `${caseLabel}: environment wrapper missing (${latex})`
  );
  const body = latex.slice(beginPos, endPos + endTag.length);
  assert.ok(body.includes("&"), `${caseLabel}: column separator missing (${latex})`);
  assert.ok(body.includes("\\\\"), `${caseLabel}: row separator missing (${latex})`);

  for (const step of profile) {
    if (!step.expect) continue;
    assert.ok(latex.includes(step.expect), `${caseLabel}: missing ${step.expect} (${latex})`);
  }
  await assertRenderHealthy(page, caseLabel, { allowPlaceholder: false });
};


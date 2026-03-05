import assert from "node:assert/strict";

import { normalizeLatex, pause } from "../runtime.mjs";
import {
  applySuggestionViaExplicitSession,
  assertRenderHealthy,
  clearMathField,
  getMathFieldLatex,
} from "../ui.mjs";
import {
  fillPlaceholderTemplateFromSuggestion,
  insertCommandSuggestion,
  moveToNextPlaceholder,
  typeMathText,
} from "../actions.mjs";

export const MULTILAYER_ENVIRONMENTS = [
  "aligned",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
  "cases",
  "dcases",
];

export const MULTILAYER_CELL_PROFILES = [
  [
    { mode: "command", token: "int", suffix: "_{i}^{n}", expect: "\\int" },
    { mode: "command", token: "lim", suffix: "_{j}", expect: "\\lim" },
    { mode: "template", token: "frac", values: ["a", "b"], expect: "\\frac" },
    { mode: "template", token: "sqrt", values: ["x"], expect: "\\sqrt" },
  ],
  [
    { mode: "command", token: "int", suffix: "_{0}^{1}", expect: "\\int" },
    { mode: "command", token: "pi", suffix: "_{k}^{r}", expect: "\\pi" },
    { mode: "template", token: "binom", values: ["n", "k"], expect: "\\binom" },
    { mode: "template", token: "frac", values: ["u", "v"], expect: "\\frac" },
  ],
  [
    { mode: "command", token: "lim", suffix: "_{n}", expect: "\\lim" },
    { mode: "command", token: "alpha", suffix: "_{i}", expect: "\\alpha" },
    { mode: "command", token: "beta", suffix: "^{2}", expect: "\\beta" },
    { mode: "command", token: "gamma", suffix: "_{t}", expect: "\\gamma" },
  ],
  [
    { mode: "command", token: "max", suffix: "_{x}", expect: "\\max" },
    { mode: "command", token: "min", suffix: "_{y}", expect: "\\min" },
    { mode: "command", token: "log", suffix: "_{b}", expect: "\\log" },
    { mode: "template", token: "frac", values: ["p", "q"], expect: "\\frac" },
  ],
  [
    { mode: "command", token: "alpha", suffix: "_{x}", expect: "\\alpha" },
    { mode: "command", token: "beta", suffix: "_{y}", expect: "\\beta" },
    { mode: "template", token: "sqrt", values: ["z"], expect: "\\sqrt" },
    { mode: "template", token: "binom", values: ["r", "s"], expect: "\\binom" },
  ],
];

export const applyMultilayerCellSpec = async (
  page,
  spec,
  options = /** @type {{ moveNext?: boolean; caseLabel?: string; cellIndex?: number }} */ ({})
) => {
  const moveNext = options.moveNext ?? true;
  if (spec.mode === "template") {
    await fillPlaceholderTemplateFromSuggestion(
      page,
      {
        token: spec.token,
        values: Array.isArray(spec.values) ? spec.values : [],
        expectedHint: spec.expectedHint,
        pickIndex: spec.pickIndex,
      },
      {
        moveNext,
        caseLabel: options.caseLabel,
        cellIndex: options.cellIndex,
      }
    );
    return;
  }
  if (spec.mode === "command") {
    await insertCommandSuggestion(page, spec.token, {
      expectedHint: spec.expectedHint ?? spec.token,
      pickIndex: spec.pickIndex,
    });
    if (spec.suffix) {
      await typeMathText(page, spec.suffix);
    }
    if (moveNext) {
      await moveToNextPlaceholder(page);
      await pause(30);
    }
    return;
  }
  if (spec.mode === "text") {
    await typeMathText(page, spec.text ?? "");
    if (moveNext) {
      await moveToNextPlaceholder(page);
      await pause(30);
    }
  }
};

export const runMultilayerVarietyScenario = async (page, scenario, index, total) => {
  const label = `variety ${index + 1}/${total} ${scenario.envToken}-p${scenario.profileIndex + 1}`;
  await clearMathField(page);
  await applySuggestionViaExplicitSession(page, scenario.envToken, {
    expectedHint: scenario.envToken,
  });
  const profile = scenario.profile;
  for (let i = 0; i < profile.length; i += 1) {
    await applyMultilayerCellSpec(page, profile[i], {
      moveNext: i < profile.length - 1,
      caseLabel: label,
      cellIndex: i,
    });
  }

  const latex = normalizeLatex(await getMathFieldLatex(page));
  const beginCandidates = [
    `\\begin{${scenario.envToken}}`,
    `\\begin{${scenario.envToken.toLowerCase()}}`,
  ];
  const endCandidates = [
    `\\end{${scenario.envToken}}`,
    `\\end{${scenario.envToken.toLowerCase()}}`,
  ];
  const beginTag = beginCandidates.find((candidate) => latex.includes(candidate)) ?? null;
  const endTag = endCandidates.find((candidate) => latex.includes(candidate)) ?? null;
  const beginPos = beginTag ? latex.indexOf(beginTag) : -1;
  const endPos = endTag ? latex.indexOf(endTag) : -1;
  assert.ok(beginPos >= 0 && endPos > beginPos, `${label}: wrapper missing (${latex})`);
  assert.ok(latex.includes("&"), `${label}: column separator missing (${latex})`);
  assert.ok(latex.includes("\\\\"), `${label}: row separator missing (${latex})`);

  profile.forEach((spec) => {
    const expected = spec.expect;
    if (!expected) return;
    assert.ok(
      latex.includes(normalizeLatex(expected)),
      `${label}: missing ${expected} (${latex})`
    );
  });
  await assertRenderHealthy(page, label, { allowPlaceholder: false });
};


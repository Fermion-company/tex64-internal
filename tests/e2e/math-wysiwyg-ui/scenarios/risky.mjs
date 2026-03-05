import assert from "node:assert/strict";

import { normalizeLatex, pause } from "../runtime.mjs";
import {
  assertRenderHealthy,
  clearMathField,
  focusMathField,
  getMathFieldLatex,
} from "../ui.mjs";
import {
  fillPlaceholderTemplateFromSuggestion,
  insertCommandSuggestion,
  moveCursorLeft,
  moveToNextPlaceholder,
  typeMathText,
} from "../actions.mjs";

export const RISKY_FORMULA_SCENARIOS = [
  {
    id: "matrix-sum-pi-frac-sqrt",
    expected: ["\\begin{pmatrix}", "\\sum", "\\pi", "\\frac", "\\sqrt"],
    build: async (page) => {
      await insertCommandSuggestion(page, "pmatrix");
      await insertCommandSuggestion(page, "sum");
      await typeMathText(page, "_{i}^{n}");
      await moveToNextPlaceholder(page);
      await pause(30);
      await insertCommandSuggestion(page, "pi");
      await typeMathText(page, "_{k}^{r}");
      await moveToNextPlaceholder(page);
      await pause(30);
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["a", "b"] },
        { moveNext: true }
      );
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "sqrt", values: ["x"] },
        { moveNext: false }
      );
    },
  },
  {
    id: "cases-frac-lim-derivative",
    expected: ["\\begin{cases}", "\\frac", "\\lim"],
    build: async (page) => {
      await insertCommandSuggestion(page, "cases");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["1", "x"] },
        { moveNext: true }
      );
      await typeMathText(page, "x!=0");
      await moveToNextPlaceholder(page);
      await pause(30);
      await insertCommandSuggestion(page, "lim");
      await typeMathText(page, "_h");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["f(x+h)-f(x)", "h"] },
        { moveNext: true }
      );
      await typeMathText(page, "x=0");
    },
  },
  {
    id: "frac-sum-binom-prod",
    expected: ["\\sum", "\\binom", "\\prod", "\\frac"],
    build: async (page) => {
      await insertCommandSuggestion(page, "sum");
      await typeMathText(page, "_{i=1}^{n}");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "binom", values: ["n", "i"] },
        { moveNext: false }
      );
      await typeMathText(page, "+");
      await insertCommandSuggestion(page, "prod");
      await typeMathText(page, "_{j=1}^{m}");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["1", "j"] },
        { moveNext: false }
      );
    },
  },
  {
    id: "sqrt-frac-sqrt",
    expected: ["\\sqrt", "\\frac"],
    build: async (page) => {
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "sqrt", values: ["1+x"] },
        { moveNext: false }
      );
      await typeMathText(page, "+");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["1+u", "1-v"] },
        { moveNext: false }
      );
      await typeMathText(page, "+");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "sqrt", values: ["1-y"] },
        { moveNext: false }
      );
    },
  },
  {
    id: "inner-frac-sqrt",
    expected: ["\\langle", "\\frac", "\\sqrt"],
    build: async (page) => {
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "inner", values: [] },
        { moveNext: false }
      );
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["a+b", "c+d"] },
        { moveNext: true }
      );
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "sqrt", values: ["x^2+y^2"] },
        { moveNext: false }
      );
    },
  },
  {
    id: "int-partial-derivative",
    expected: ["\\int", "\\frac", "\\partial"],
    build: async (page) => {
      await insertCommandSuggestion(page, "int");
      await typeMathText(page, "f");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: [] },
        { moveNext: false }
      );
      await insertCommandSuggestion(page, "partial");
      await typeMathText(page, "^2f");
      await moveToNextPlaceholder(page);
      await pause(30);
      await insertCommandSuggestion(page, "partial");
      await typeMathText(page, "x^2");
    },
  },
  {
    id: "lim-sum-frac",
    expected: ["\\lim", "\\sum", "\\frac", "\\infty"],
    build: async (page) => {
      await insertCommandSuggestion(page, "lim");
      await typeMathText(page, "_{n");
      await insertCommandSuggestion(page, "infty");
      await typeMathText(page, "}");
      await insertCommandSuggestion(page, "sum");
      await typeMathText(page, "_{k=1}^{n}");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["1", "k^2"] },
        { moveNext: false }
      );
    },
  },
  {
    id: "binom-script-chain",
    expected: ["\\binom"],
    build: async (page) => {
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "binom", values: ["n", "k"] },
        { moveNext: false }
      );
      await typeMathText(page, "_{i}^{j}");
    },
  },
  {
    id: "aligned-frac-sum",
    expected: ["\\begin{aligned}", "\\frac", "\\sum"],
    build: async (page) => {
      await insertCommandSuggestion(page, "aligned");
      await typeMathText(page, "a");
      await moveToNextPlaceholder(page);
      await pause(30);
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["1", "x"] },
        { moveNext: true }
      );
      await typeMathText(page, "b");
      await moveToNextPlaceholder(page);
      await pause(30);
      await insertCommandSuggestion(page, "sum");
      await typeMathText(page, "_{i}^{n}x_i");
    },
  },
  {
    id: "aligned-pi-frac-sqrt-sum",
    expected: ["\\begin{aligned}", "\\frac", "\\sqrt", "\\sum"],
    build: async (page) => {
      await insertCommandSuggestion(page, "aligned");
      await typeMathText(page, "p_{i}^{n}");
      await moveToNextPlaceholder(page);
      await pause(30);
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["a_i", "b_i"] },
        { moveNext: true }
      );
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "sqrt", values: ["x"] },
        { moveNext: true }
      );
      await insertCommandSuggestion(page, "sum");
      await typeMathText(page, "_{j}y_j");
    },
  },
  {
    id: "eval-and-derivative-frac",
    expected: ["\\left.", "\\right|", "\\frac"],
    build: async (page) => {
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "eval", values: ["f(x)", "x=0"] },
        { moveNext: false }
      );
      await typeMathText(page, "+");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["d", "dx"] },
        { moveNext: false }
      );
    },
  },
  {
    id: "sum-prod-frac-sqrt",
    expected: ["\\sum", "\\prod", "\\frac", "\\sqrt"],
    build: async (page) => {
      await insertCommandSuggestion(page, "sum");
      await typeMathText(page, "_{i}^{n}");
      await typeMathText(page, "+");
      await insertCommandSuggestion(page, "prod");
      await typeMathText(page, "_{j}^{m}");
      await typeMathText(page, "+");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["a", "b"] },
        { moveNext: false }
      );
      await typeMathText(page, "+");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "sqrt", values: ["x"] },
        { moveNext: false }
      );
    },
  },
];

export const runRiskyFormulaScenario = async (page, scenario, index, total) => {
  const prefix = `risky ${index + 1}/${total} ${scenario.id}`;
  await clearMathField(page);
  await scenario.build(page);
  const latex = normalizeLatex(await getMathFieldLatex(page));
  scenario.expected.forEach((snippet) => {
    assert.ok(
      latex.includes(normalizeLatex(snippet)),
      `${prefix} new-input missing ${snippet}: ${latex}`
    );
  });
  await assertRenderHealthy(page, `${prefix} new-input`, { allowPlaceholder: false });

  const moveCount = Math.max(10, Math.min(40, Math.floor(latex.length / 3)));
  await focusMathField(page);
  await moveCursorLeft(page, moveCount);
  await fillPlaceholderTemplateFromSuggestion(
    page,
    { token: "frac", values: ["u", "v"] },
    { moveNext: false, caseLabel: prefix }
  );

  const editedLatex = normalizeLatex(await getMathFieldLatex(page));
  scenario.expected.forEach((snippet) => {
    assert.ok(
      editedLatex.includes(normalizeLatex(snippet)),
      `${prefix} mid-edit missing ${snippet}: ${editedLatex}`
    );
  });
  assert.ok(
    editedLatex.includes("\\frac"),
    `${prefix} mid-edit missing inserted frac: ${editedLatex}`
  );
  await assertRenderHealthy(page, `${prefix} mid-edit`, { allowPlaceholder: false });
};

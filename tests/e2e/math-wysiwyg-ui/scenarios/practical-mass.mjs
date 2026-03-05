import assert from "node:assert/strict";

import { normalizeLatex } from "../runtime.mjs";
import {
  applySuggestionViaExplicitSession,
  assertRenderHealthy,
  clearMathField,
  focusMathField,
  getMathFieldLatex,
} from "../ui.mjs";
import { fillPlaceholderTemplateFromSuggestion, moveCursorLeft } from "../actions.mjs";
import { applyMultilayerCellSpec, MULTILAYER_ENVIRONMENTS } from "./multilayer.mjs";

export const PRACTICAL_MASS_ENVIRONMENTS = [...MULTILAYER_ENVIRONMENTS];

const PRACTICAL_COMMAND_LIBRARY = [
  { token: "alpha", expect: "\\alpha" },
  { token: "beta", expect: "\\beta" },
  { token: "gamma", expect: "\\gamma" },
  { token: "delta", expect: "\\delta" },
  { token: "theta", expect: "\\theta" },
  { token: "mu", expect: "\\mu" },
  { token: "rho", expect: "\\rho" },
  { token: "xi", expect: "\\xi" },
  { token: "lim", expect: "\\lim" },
  { token: "int", expect: "\\int" },
];

const PRACTICAL_SUFFIX_LIBRARY = ["_{i}", "^{2}", "_{k}^{m}", "_{t}", "_{n}"];

const PRACTICAL_SYMBOLS = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
];

const practicalSymbolAt = (index) =>
  PRACTICAL_SYMBOLS[
    ((index % PRACTICAL_SYMBOLS.length) + PRACTICAL_SYMBOLS.length) % PRACTICAL_SYMBOLS.length
  ];

const buildPracticalMassProfiles = () => {
  const profileCount = 20;
  const profiles = [];
  for (let profileIndex = 0; profileIndex < profileCount; profileIndex += 1) {
    const profile = [];
    for (let cellIndex = 0; cellIndex < 4; cellIndex += 1) {
      const seed = profileIndex * 11 + cellIndex * 7;
      const modePicker = (profileIndex + cellIndex) % 4;
      if (modePicker === 0) {
        const command =
          PRACTICAL_COMMAND_LIBRARY[
            (profileIndex * 3 + cellIndex) % PRACTICAL_COMMAND_LIBRARY.length
          ];
        const suffix =
          PRACTICAL_SUFFIX_LIBRARY[
            (profileIndex + cellIndex * 2) % PRACTICAL_SUFFIX_LIBRARY.length
          ];
        profile.push({
          mode: "command",
          token: command.token,
          suffix,
          expect: command.expect,
        });
        continue;
      }
      if (modePicker === 1) {
        profile.push({
          mode: "template",
          token: "frac",
          values: [
            `${practicalSymbolAt(seed)}+${practicalSymbolAt(seed + 1)}`,
            practicalSymbolAt(seed + 2),
          ],
          expect: "\\frac",
        });
        continue;
      }
      if (modePicker === 2) {
        profile.push({
          mode: "template",
          token: "binom",
          values: [practicalSymbolAt(seed + 3), practicalSymbolAt(seed + 4)],
          expect: "\\binom",
        });
        continue;
      }
      profile.push({
        mode: "template",
        token: "sqrt",
        values: [`${practicalSymbolAt(seed)}^2+${practicalSymbolAt(seed + 1)}^2`],
        expect: "\\sqrt",
      });
    }
    profiles.push(profile);
  }
  return profiles;
};

export const PRACTICAL_MASS_PROFILES = buildPracticalMassProfiles();

export const runPracticalMassScenario = async (page, scenario, index, total) => {
  const label = `practical ${index + 1}/${total} ${scenario.envToken}-p${scenario.profileIndex + 1}`;
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

  let latex = normalizeLatex(await getMathFieldLatex(page));
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
    if (!spec.expect) return;
    assert.ok(
      latex.includes(normalizeLatex(spec.expect)),
      `${label}: missing ${spec.expect} (${latex})`
    );
  });
  await assertRenderHealthy(page, `${label} new-input`, { allowPlaceholder: false });

  if (index % 5 === 0) {
    await focusMathField(page);
    await moveCursorLeft(page, Math.max(12, Math.min(50, Math.floor(latex.length / 4))));
    await fillPlaceholderTemplateFromSuggestion(
      page,
      { token: "frac", values: ["u", "v"] },
      { moveNext: false, caseLabel: label }
    );
    latex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(latex.includes("\\frac"), `${label}: mid-edit frac missing (${latex})`);
    const beginStill = beginTag
      ? latex.includes(beginTag)
      : beginCandidates.some((candidate) => latex.includes(candidate));
    const endStill = endTag
      ? latex.includes(endTag)
      : endCandidates.some((candidate) => latex.includes(candidate));
    assert.ok(beginStill && endStill, `${label}: wrapper lost after mid-edit (${latex})`);
    await assertRenderHealthy(page, `${label} mid-edit`, { allowPlaceholder: false });
  }
};


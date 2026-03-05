import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";

import {
  keepWorkspace,
  log,
  normalizeLatex,
  pause,
  repoRoot,
  slowMoMs,
  typeDelayMs,
  verboseDebug,
} from "./math-wysiwyg-ui/runtime.mjs";
import { moveToNextPlaceholder } from "./math-wysiwyg-ui/actions.mjs";
import {
  applySuggestionByTyping,
  applySuggestionViaExplicitSession,
  assertRenderHealthy,
  cleanupStaleElectron,
  clearMathField,
  createWorkspaceCopy,
  getActiveSuggestionState,
  getAudioFeedbackConfig,
  getMathFieldLatex,
  getMathFieldState,
  getSuggestionSnapshot,
  normalizeCandidateLabel,
  openSideTab,
  postToBridge,
  waitForMathFieldReady,
  waitForSuggestions,
  waitForSuggestionsClosed,
  waitForWorkspaceReady,
} from "./math-wysiwyg-ui/ui.mjs";
import {
  COMPLEX_FORMULA_ENVIRONMENTS,
  COMPLEX_FORMULA_PROFILES,
  runComplexPlaceholderFormula,
} from "./math-wysiwyg-ui/scenarios/complex.mjs";
import {
  RISKY_FORMULA_SCENARIOS,
  runRiskyFormulaScenario,
} from "./math-wysiwyg-ui/scenarios/risky.mjs";
import {
  MULTILAYER_CELL_PROFILES,
  MULTILAYER_ENVIRONMENTS,
  runMultilayerVarietyScenario,
} from "./math-wysiwyg-ui/scenarios/multilayer.mjs";
import {
  PRACTICAL_MASS_ENVIRONMENTS,
  PRACTICAL_MASS_PROFILES,
  runPracticalMassScenario,
} from "./math-wysiwyg-ui/scenarios/practical-mass.mjs";

const runCase = async (label, test) => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  /** @type {import('playwright').ElectronApplication | undefined} */
  let electronApp;

  try {
    await fs.mkdir(userDataPath, { recursive: true });
    cleanupStaleElectron();

    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: {
        ...process.env,
        TEX64_E2E: "1",
        TEX64_E2E_HEADLESS: "1",
        TEX64_E2E_USERDATA: userDataPath,
      },
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
      timeout: 20000,
    });
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
    await clearMathField(page);

    await test(page);
    log(`${label}: passed`);
  } finally {
    if (electronApp) {
      try {
        await electronApp.close();
      } catch {
        try {
          electronApp.process()?.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    cleanupStaleElectron();
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
};

const run = async () => {
  await runCase("[1/17] mathlive audio feedback is disabled", async (page) => {
    const config = await getAudioFeedbackConfig(page);
    assert.equal(config.global.soundsDirectory, "null", `soundsDirectory: ${JSON.stringify(config)}`);
    assert.equal(
      config.global.keypressVibration,
      "false",
      `keypressVibration: ${JSON.stringify(config)}`
    );
    assert.ok(
      ["null", "[object Object]"].includes(config.global.keypressSound),
      `keypressSound: ${JSON.stringify(config)}`
    );
    assert.ok(
      ["null", "undefined"].includes(config.global.plonkSound),
      `plonkSound: ${JSON.stringify(config)}`
    );
    if (config.virtualKeyboard.exists) {
      assert.equal(
        config.virtualKeyboard.keypressSound,
        "null",
        `vk.keypressSound: ${JSON.stringify(config)}`
      );
      assert.equal(
        config.virtualKeyboard.plonkSound,
        "null",
        `vk.plonkSound: ${JSON.stringify(config)}`
      );
      assert.equal(
        config.virtualKeyboard.keypressVibration,
        "false",
        `vk.keypressVibration: ${JSON.stringify(config)}`
      );
    }
  });

  await runCase("[2/17] typed token after existing command is isolated", async (page) => {
    await applySuggestionByTyping(page, "sin", { expectedHint: "sin" });
    await applySuggestionByTyping(page, "sum", { expectedHint: "sum", keepCursor: true });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(latex.includes("\\sin"), `sin should remain: ${latex}`);
    assert.ok(latex.includes("\\sum"), `sum should be inserted as command: ${latex}`);
    assert.ok(
      !latex.includes("\\sinsum"),
      `typed token must not merge with existing command: ${latex}`
    );
    await assertRenderHealthy(page, "isolated token after command render", { allowPlaceholder: true });
  });

  await runCase("[3/17] matrix cell accepts sigma suggestion", async (page) => {
    await applySuggestionByTyping(page, "pmatrix", { expectedHint: "pmatrix" });
    if (verboseDebug) {
      const afterPmatrix = await getMathFieldState(page);
      log(`[debug] after pmatrix: ${JSON.stringify(afterPmatrix)}`);
    }
    await applySuggestionByTyping(page, "sum", { expectedHint: "sum", keepCursor: true });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    const begin = latex.indexOf("\\begin{pmatrix}");
    const end = latex.indexOf("\\end{pmatrix}");
    const sum = latex.indexOf("\\sum");

    assert.ok(begin >= 0 && end > begin, `matrix wrapper missing: ${latex}`);
    assert.ok(sum > begin && sum < end, `sum should stay inside matrix cell: ${latex}`);
    await assertRenderHealthy(page, "matrix sum render", { allowPlaceholder: true });
  });

  await runCase("[4/17] matrix cell keeps sum placeholders stable", async (page) => {
    await applySuggestionByTyping(page, "pmatrix", { expectedHint: "pmatrix" });
    await applySuggestionByTyping(page, "sum", {
      expectedHint: "sum",
      pickIndex: 1,
      keepCursor: true,
    });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    const begin = latex.indexOf("\\begin{pmatrix}");
    const end = latex.indexOf("\\end{pmatrix}");
    const sum = latex.indexOf("\\sum_");
    assert.ok(begin >= 0 && end > begin, `matrix wrapper missing: ${latex}`);
    assert.ok(sum > begin && sum < end, `sum with placeholders must stay in matrix cell: ${latex}`);
    await assertRenderHealthy(page, "matrix sum placeholders render", { allowPlaceholder: true });
  });

  await runCase("[5/17] matrix cell keeps pi placeholders stable", async (page) => {
    await applySuggestionByTyping(page, "pmatrix", { expectedHint: "pmatrix" });
    await applySuggestionByTyping(page, "pi", {
      expectedHint: "pi",
      pickIndex: 1,
      keepCursor: true,
    });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    const begin = latex.indexOf("\\begin{pmatrix}");
    const end = latex.indexOf("\\end{pmatrix}");
    const pi = latex.indexOf("\\pi_");
    assert.ok(begin >= 0 && end > begin, `matrix wrapper missing: ${latex}`);
    assert.ok(pi > begin && pi < end, `pi with placeholders must stay in matrix cell: ${latex}`);
    await assertRenderHealthy(page, "matrix pi placeholders render", { allowPlaceholder: true });
  });

  await runCase("[6/17] //label in matrix hoists outside matrix", async (page) => {
    await applySuggestionByTyping(page, "pmatrix", { expectedHint: "pmatrix" });
    await page.keyboard.type("a", { delay: typeDelayMs });
    await pause(60);

    await applySuggestionByTyping(page, "//label", {
      expectedHint: "//label",
      keepCursor: true,
    });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    const matrixEnd = latex.indexOf("\\end{pmatrix}");
    const labelPos = latex.indexOf("\\label{");

    assert.ok(matrixEnd >= 0, `matrix end missing: ${latex}`);
    assert.ok(labelPos > matrixEnd, `label should be hoisted after matrix: ${latex}`);
    await assertRenderHealthy(page, "matrix label render", { allowPlaceholder: true });
  });

  await runCase("[7/17] fraction placeholders resolve via UI typing + placeholder command", async (page) => {
    await applySuggestionByTyping(page, "frac", { expectedHint: "frac" });
    await page.keyboard.type("a", { delay: typeDelayMs });
    await moveToNextPlaceholder(page);
    await pause(60);
    await page.keyboard.type("b", { delay: typeDelayMs });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(latex.includes("\\frac{a}{b}"), `fraction should resolve both placeholders: ${latex}`);
    await assertRenderHealthy(page, "fraction placeholder render", { allowPlaceholder: false });
  });

  await runCase("[8/17] alpha commit must not reopen stale alpha suggestion", async (page) => {
    await applySuggestionByTyping(page, "alpha", { expectedHint: "alpha" });
    await pause(220);
    const panelAfterCommit = await getSuggestionSnapshot(page);
    assert.equal(
      panelAfterCommit.visible,
      false,
      `suggestion panel reopened after commit: ${JSON.stringify(panelAfterCommit)}`
    );
    await assertRenderHealthy(page, "alpha commit render", { allowPlaceholder: true });
  });

  await runCase("[9/17] sum placeholder keeps \\sum when committing alpha", async (page) => {
    await applySuggestionByTyping(page, "sum", {
      expectedHint: "sum",
      pickIndex: 1,
      keepCursor: true,
    });
    await applySuggestionByTyping(page, "alpha", {
      expectedHint: "alpha",
      keepCursor: true,
    });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(latex.includes("\\sum"), `sum should remain after alpha commit: ${latex}`);
    assert.ok(latex.includes("\\alpha"), `alpha should be committed into placeholder: ${latex}`);
    await assertRenderHealthy(page, "sum placeholder alpha commit render", { allowPlaceholder: true });
  });

  await runCase(
    "[10/17] sum placeholder typing must suggest alpha from local edit buffer only",
    async (page) => {
      await applySuggestionByTyping(page, "sum", {
        expectedHint: "sum",
        pickIndex: 1,
        keepCursor: true,
      });
      await page.keyboard.type("i", { delay: typeDelayMs });
      await moveToNextPlaceholder(page);
      await pause(60);
      await page.keyboard.type("alph", { delay: typeDelayMs });

      await waitForSuggestions(page, "alpha");
      const snapshot = await getSuggestionSnapshot(page);
      const hints = snapshot.items.map((item) => normalizeCandidateLabel(item.hint));
      assert.ok(
        hints.includes("alpha"),
        `alpha hint missing in placeholder session: ${JSON.stringify(snapshot)}`
      );
      assert.ok(
        !hints.includes("sum"),
        `sum hint leaked from existing context: ${JSON.stringify(snapshot)}`
      );

      const activeState = await getActiveSuggestionState(page);
      const activeHint = activeState.activeIndex >= 0 ? hints[activeState.activeIndex] ?? "" : "";
      assert.notEqual(
        activeHint,
        "sum",
        `active candidate should not bind to existing sigma context: ${JSON.stringify({
          activeState,
          hints,
        })}`
      );

      await page.keyboard.press("Enter");
      await waitForSuggestionsClosed(page, 5000);
      const latex = normalizeLatex(await getMathFieldLatex(page));
      assert.ok(latex.includes("\\sum"), `sum should remain after local alpha commit: ${latex}`);
      assert.ok(latex.includes("\\alpha"), `alpha should commit into current placeholder: ${latex}`);
      await assertRenderHealthy(page, "sum local alpha suggestion render", {
        allowPlaceholder: true,
      });
    }
  );

  await runCase("[11/17] Tab is candidate-only and never moves placeholders", async (page) => {
    await page.keyboard.type("sum", { delay: typeDelayMs });
    await waitForSuggestions(page, "sum");

    const initial = await getActiveSuggestionState(page);
    assert.equal(initial.visible, true, `suggestions must be visible: ${JSON.stringify(initial)}`);
    assert.ok(initial.count > 1, `sum should expose multiple candidates: ${JSON.stringify(initial)}`);
    const initialIndex = initial.activeIndex < 0 ? 0 : initial.activeIndex;

    await page.keyboard.press("Tab");
    await pause(60);
    const afterTab = await getActiveSuggestionState(page);
    assert.equal(
      afterTab.activeIndex,
      (initialIndex + 1) % initial.count,
      `Tab should advance candidate index: before=${JSON.stringify(initial)} after=${JSON.stringify(afterTab)}`
    );

    await page.keyboard.press("Shift+Tab");
    await pause(60);
    const afterShiftTab = await getActiveSuggestionState(page);
    assert.equal(
      afterShiftTab.activeIndex,
      initialIndex,
      `Shift+Tab should reverse candidate index: before=${JSON.stringify(afterTab)} after=${JSON.stringify(afterShiftTab)}`
    );

    await page.keyboard.press("Enter");
    await waitForSuggestionsClosed(page, 5000);

    await clearMathField(page);
    await applySuggestionByTyping(page, "frac", { expectedHint: "frac" });
    await page.keyboard.type("a", { delay: typeDelayMs });
    await page.keyboard.press("Escape");
    await waitForSuggestionsClosed(page, 5000);

    const beforeTab = await getMathFieldState(page);
    await page.keyboard.press("Tab");
    await pause(80);
    const afterPlaceholderTab = await getMathFieldState(page);

    assert.ok(beforeTab, "math-field state missing before Tab");
    assert.ok(afterPlaceholderTab, "math-field state missing after Tab");
    assert.equal(
      normalizeLatex(afterPlaceholderTab?.latex ?? ""),
      normalizeLatex(beforeTab?.latex ?? ""),
      `Tab must not rewrite formula while no candidate is active`
    );
    assert.equal(
      afterPlaceholderTab?.position ?? null,
      beforeTab?.position ?? null,
      `Tab must not move placeholder focus when suggestion panel is closed`
    );
    assert.equal(
      JSON.stringify(afterPlaceholderTab?.selection ?? null),
      JSON.stringify(beforeTab?.selection ?? null),
      `Tab must keep selection stable when suggestion panel is closed`
    );

    await assertRenderHealthy(page, "tab candidate-only behavior render", { allowPlaceholder: true });
  });

  await runCase("[12/17] Enter adds matrix row without structure break", async (page) => {
    await applySuggestionByTyping(page, "pmatrix", { expectedHint: "pmatrix" });
    await page.keyboard.type("a", { delay: typeDelayMs });
    const stateBeforeEnter = verboseDebug ? await getMathFieldState(page) : null;
    const debugProbe =
      verboseDebug
        ? await page.evaluate(() => {
            const field = document.getElementById("block-math-input");
            if (!field || typeof field.getValue !== "function") {
              return null;
            }
            const api = /** @type {any} */ (field);
            const selection = api.selection;
            let endOffset = typeof api.position === "number" ? api.position : 0;
            if (selection && selection.ranges && Array.isArray(selection.ranges) && selection.ranges[0]) {
              endOffset = Number(selection.ranges[0][1]);
            } else if (Array.isArray(selection) && selection.length >= 2) {
              endOffset = Number(selection[1]);
            }
            let prefix = "";
            try {
              prefix = String(api.getValue(0, endOffset, "latex") ?? "");
            } catch {
              prefix = "";
            }
            let cmdResult = null;
            let after = "";
            let undone = "";
            try {
              const before = String(api.getValue("latex") ?? "");
              cmdResult = api.executeCommand?.("addRowAfter") ?? null;
              after = String(api.getValue("latex") ?? "");
              api.executeCommand?.("undo");
              undone = String(api.getValue("latex") ?? "");
              return { endOffset, prefix, cmdResult, before, after, undone };
            } catch (e) {
              return { endOffset, prefix, cmdResult, error: String(e) };
            }
          })
        : null;
    if (verboseDebug) {
      log(`[debug] matrix Enter probe: ${JSON.stringify(debugProbe)}`);
    }
    await page.keyboard.press("Enter");
    await pause(80);
    const stateAfterEnter = verboseDebug ? await getMathFieldState(page) : null;
    await page.keyboard.type("b", { delay: typeDelayMs });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    const begin = latex.indexOf("\\begin{pmatrix}");
    const end = latex.indexOf("\\end{pmatrix}");
    const rowBreak = latex.indexOf("\\\\");
    const matrixBodyStart = begin >= 0 ? begin + "\\begin{pmatrix}".length : 0;
    const aPos = latex.indexOf("a", matrixBodyStart);
    const bPos = rowBreak >= 0 ? latex.indexOf("b", rowBreak + 2) : -1;

    const debugSuffix =
      verboseDebug
        ? ` stateBeforeEnter=${JSON.stringify(stateBeforeEnter)} stateAfterEnter=${JSON.stringify(
            stateAfterEnter
          )}`
        : "";

    assert.ok(begin >= 0 && end > begin, `matrix wrapper missing: ${latex}${debugSuffix}`);
    assert.ok(rowBreak > begin && rowBreak < end, `matrix row break missing: ${latex}${debugSuffix}`);
    assert.ok(
      aPos > begin && aPos < rowBreak,
      `first row text should stay before row break: ${latex}${debugSuffix}`
    );
    assert.ok(
      bPos > rowBreak && bPos < end,
      `second row text should stay after row break: ${latex}${debugSuffix}`
    );
    await assertRenderHealthy(page, "matrix enter row render", { allowPlaceholder: true });
  });

  await runCase("[13/17] rapid explicit commits stay stable", async (page) => {
    await applySuggestionViaExplicitSession(page, "alpha", { expectedHint: "alpha" });
    await pause(40);
    await applySuggestionViaExplicitSession(page, "beta", {
      expectedHint: "beta",
      keepCursor: true,
    });
    await pause(220);

    const latex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(latex.includes("\\alpha"), `alpha missing after rapid commits: ${latex}`);
    assert.ok(latex.includes("\\beta"), `beta missing after rapid commits: ${latex}`);

    const panelAfter = await getSuggestionSnapshot(page);
    assert.equal(
      panelAfter.visible,
      false,
      `panel should stay closed after rapid commits: ${JSON.stringify(panelAfter)}`
    );
    await assertRenderHealthy(page, "rapid explicit commit render", { allowPlaceholder: true });
  });

  await runCase("[14/17] 50 complex placeholder-heavy formulas via UI flows", async (page) => {
    const scenarios = [];
    COMPLEX_FORMULA_ENVIRONMENTS.forEach((envToken) => {
      COMPLEX_FORMULA_PROFILES.forEach((profile, profileIndex) => {
        scenarios.push({
          envToken,
          profile,
          profileIndex,
          index: scenarios.length,
        });
      });
    });
    assert.equal(scenarios.length, 50, `expected 50 scenarios, got ${scenarios.length}`);

    for (let i = 0; i < scenarios.length; i += 1) {
      await runComplexPlaceholderFormula(page, scenarios[i], scenarios.length);
      if (verboseDebug && (i + 1) % 10 === 0) {
        log(`[debug] complex placeholder scenarios completed ${i + 1}/${scenarios.length}`);
      }
    }
  });

  await runCase("[15/17] 12 risky formulas: new input + mid-edit insertion", async (page) => {
    assert.equal(
      RISKY_FORMULA_SCENARIOS.length,
      12,
      `expected 12 risky scenarios, got ${RISKY_FORMULA_SCENARIOS.length}`
    );
    for (let i = 0; i < RISKY_FORMULA_SCENARIOS.length; i += 1) {
      await runRiskyFormulaScenario(
        page,
        RISKY_FORMULA_SCENARIOS[i],
        i,
        RISKY_FORMULA_SCENARIOS.length
      );
      if (verboseDebug) {
        log(`[debug] risky formulas completed ${i + 1}/${RISKY_FORMULA_SCENARIOS.length}`);
      }
    }
  });

  await runCase("[16/17] 50 multilayer variety formulas across many environments", async (page) => {
    const scenarios = [];
    MULTILAYER_ENVIRONMENTS.forEach((envToken) => {
      MULTILAYER_CELL_PROFILES.forEach((profile, profileIndex) => {
        scenarios.push({
          envToken,
          profile,
          profileIndex,
          index: scenarios.length,
        });
      });
    });
    assert.equal(scenarios.length, 50, `expected 50 variety scenarios, got ${scenarios.length}`);
    for (let i = 0; i < scenarios.length; i += 1) {
      await runMultilayerVarietyScenario(page, scenarios[i], i, scenarios.length);
      if (verboseDebug && (i + 1) % 10 === 0) {
        log(`[debug] multilayer variety scenarios completed ${i + 1}/${scenarios.length}`);
      }
    }
  });

  await runCase("[17/17] 200 practical mass formulas across wide environments", async (page) => {
    const scenarios = [];
    PRACTICAL_MASS_ENVIRONMENTS.forEach((envToken) => {
      PRACTICAL_MASS_PROFILES.forEach((profile, profileIndex) => {
        scenarios.push({
          envToken,
          profile,
          profileIndex,
          index: scenarios.length,
        });
      });
    });
    assert.equal(scenarios.length, 200, `expected 200 practical scenarios, got ${scenarios.length}`);
    for (let i = 0; i < scenarios.length; i += 1) {
      await runPracticalMassScenario(page, scenarios[i], i, scenarios.length);
      if (verboseDebug && (i + 1) % 20 === 0) {
        log(`[debug] practical mass scenarios completed ${i + 1}/${scenarios.length}`);
      }
    }
  });

  log("math-wysiwyg ui e2e passed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-ui-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});

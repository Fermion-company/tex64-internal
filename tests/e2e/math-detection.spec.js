import { test } from "@playwright/test";
import {
  openEditor,
  setEditorContent,
  moveCursorTo,
  waitForAutoDetected,
  waitForMathValueIncludes,
  setMathFieldValue,
} from "./helpers.js";

test("math detection covers patterns and skips raw/comment blocks", async () => {
  test.setTimeout(90000);
  const { electronApp, page } = await openEditor();
  try {
    const content = [
      "% COMMENT_MATH $ignored$",
      "Inline $inlineA$ test.",
      "Display $$dispA$$ test.",
      "Paren \\(parenA\\) test.",
      "Bracket \\[bracketA\\] test.",
      "",
      "\\begin{equation}",
      "  eqOne",
      "\\end{equation}",
      "",
      "\\begin{equation*}",
      "  eqTwo",
      "\\end{equation*}",
      "",
      "\\begin{multline}",
      "  mlOne + mlTwo \\\\",
      "  mlThree",
      "\\end{multline}",
      "",
      "\\begin{align}",
      "  alOne &= alTwo \\\\",
      "  \\intertext{note}",
      "  alThree &= alFour \\tag{A} \\notag",
      "\\end{align}",
      "",
      "\\begin{gather}",
      "  gaOne \\\\",
      "  gaTwo",
      "\\end{gather}",
      "",
      "\\begin{alignat}{2}",
      "  atOne &= atTwo \\\\",
      "  atThree &= atFour",
      "\\end{alignat}",
      "",
      "\\begin{flalign}",
      "  flOne &= flTwo &&",
      "\\end{flalign}",
      "",
      "\\begin{cases}",
      "  caseOne & x>0 \\\\",
      "  caseTwo & x\\le 0",
      "\\end{cases}",
      "",
      "\\begin{subequations}",
      "  \\begin{align}",
      "    subOne &= subTwo",
      "  \\end{align}",
      "\\end{subequations}",
      "",
      "\\begin{equation}",
      "  \\begin{split}",
      "    spOne &= spTwo \\\\",
      "    spThree &= spFour",
      "  \\end{split}",
      "\\end{equation}",
      "",
      "\\begin{matrix}",
      "  matOne & matTwo \\\\",
      "  matThree & matFour",
      "\\end{matrix}",
      "",
      "\\begin{pmatrix}",
      "  pmOne & pmTwo \\\\",
      "  pmThree & pmFour",
      "\\end{pmatrix}",
      "",
      "\\begin{bmatrix}",
      "  bmOne & bmTwo \\\\",
      "  bmThree & bmFour",
      "\\end{bmatrix}",
      "",
      "\\begin{Bmatrix}",
      "  BMOne & BMTwo \\\\",
      "  BMThree & BMFour",
      "\\end{Bmatrix}",
      "",
      "\\begin{vmatrix}",
      "  vmOne & vmTwo \\\\",
      "  vmThree & vmFour",
      "\\end{vmatrix}",
      "",
      "\\begin{Vmatrix}",
      "  VMOne & VMTwo \\\\",
      "  VMThree & VMFour",
      "\\end{Vmatrix}",
      "",
      "\\begin{smallmatrix}",
      "  smOne & smTwo \\\\",
      "  smThree & smFour",
      "\\end{smallmatrix}",
      "",
      "\\begin{verbatim}",
      "RAW_VERBATIM $raw$",
      "\\end{verbatim}",
      "",
      "\\begin{lstlisting}",
      "RAW_LISTING $raw2$",
      "\\end{lstlisting}",
      "",
      "\\begin{minted}{tex}",
      "RAW_MINTED $raw3$",
      "\\end{minted}",
      "",
    ].join("\n");
    await setEditorContent(page, content);

    const cases = [
      { needle: "inlineA", expected: "inlineA" },
      { needle: "dispA", expected: "dispA" },
      { needle: "parenA", expected: "parenA" },
      { needle: "bracketA", expected: "bracketA" },
      { needle: "eqOne", expected: "eqOne" },
      { needle: "eqTwo", expected: "eqTwo" },
      { needle: "mlOne", expected: "mlOne" },
      { needle: "alOne", expected: "alOne" },
      { needle: "gaOne", expected: "gaOne" },
      { needle: "atOne", expected: "atOne" },
      { needle: "flOne", expected: "flOne" },
      { needle: "caseOne", expected: "caseOne" },
      { needle: "subOne", expected: "subOne" },
      { needle: "spOne", expected: "spOne" },
      { needle: "matOne", expected: "matOne" },
      { needle: "pmOne", expected: "pmOne" },
      { needle: "bmOne", expected: "bmOne" },
      { needle: "BMOne", expected: "BMOne" },
      { needle: "vmOne", expected: "vmOne" },
      { needle: "VMOne", expected: "VMOne" },
      { needle: "smOne", expected: "smOne" },
    ];

    for (const entry of cases) {
      await moveCursorTo(page, entry.needle);
      await waitForAutoDetected(page, true, entry.needle);
      if (entry.needle === "inlineA") {
        await page.waitForSelector(".monaco-editor .detected-block-highlight");
      }
      await waitForMathValueIncludes(page, entry.expected, entry.needle);
    }

    const skipped = ["COMMENT_MATH", "RAW_VERBATIM", "RAW_LISTING", "RAW_MINTED"];
    for (const needle of skipped) {
      await moveCursorTo(page, needle);
      await waitForAutoDetected(page, false, needle);
    }

    await page.click('.block-toggle-button[data-block="math"]');
    await setMathFieldValue(page, "");
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    });
    await page.locator("#math-keyboard-fixed-grid .math-keyboard-key").first().click();
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
    });
    await waitForMathValueIncludes(page, "\\oplus", "math keyboard");
  } finally {
    await electronApp.close();
  }
});

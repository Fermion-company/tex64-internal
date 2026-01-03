import { test, expect } from "@playwright/test";
import {
  openEditor,
  setEditorContent,
  moveCursorTo,
  waitForAutoDetected,
  setMathFieldValue,
  getDiffEditorValues,
  applyMathEdit,
} from "./helpers.js";

test("diff preview and insertion preserve wrappers and handle mismatch/new insert", async () => {
  test.setTimeout(90000);
  const { electronApp, page } = await openEditor();
  try {
    const content = [
      "Inline $inlineA$ test.",
      "Display $$dispA$$ test.",
      "",
      "\\begin{equation}",
      "  eqOne",
      "\\end{equation}",
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
      "\\begin{alignat}{2}",
      "  atOne &= atTwo \\\\",
      "  atThree &= atFour",
      "\\end{alignat}",
      "",
      "\\begin{flalign}",
      "  flOne &= flTwo &&",
      "\\end{flalign}",
      "",
      "\\begin{gather}",
      "  gaOne \\\\",
      "  gaTwo",
      "\\end{gather}",
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
      "Plain line.",
      "",
    ].join("\n");
    await setEditorContent(page, content);

    await moveCursorTo(page, "inlineA");
    await waitForAutoDetected(page, true, "inlineA");
    await setMathFieldValue(page, "inlineA+z");

    const expectedLineOffset = await page.evaluate(() => {
      const editor = window.__tex180Editor;
      const text = editor.getValue();
      const index = text.indexOf("inlineA");
      return editor.getModel().getPositionAt(index + 1).lineNumber - 1;
    });

    await page.click("#block-insert-button");
    await page.waitForSelector("#diff-modal.is-open");
    await page.waitForFunction(
      () => window.__tex180LastDiff?.modified === "inlineA+z",
      { timeout: 8000 }
    );
    const lastDiff = await page.evaluate(() => window.__tex180LastDiff);
    expect(lastDiff.original).toBe("inlineA");
    expect(lastDiff.modified).toBe("inlineA+z");
    expect(lastDiff.original).not.toContain("$");
    expect(lastDiff.modified).not.toContain("$");
    expect(lastDiff.lineOffset).toBe(expectedLineOffset);
    const diffValues = await getDiffEditorValues(page);
    expect(diffValues?.modified ?? "").toContain("inlineA+z");
    expect(diffValues?.original ?? "").toContain("inlineA");
    await page.click("#diff-modal-submit");
    await page.waitForFunction(
      () => !document.getElementById("diff-modal")?.classList.contains("is-open")
    );

    await applyMathEdit(page, {
      needle: "dispA",
      replaceWith: "dispA+z",
      label: "display",
    });
    await applyMathEdit(page, {
      needle: "eqOne",
      replaceWith: "eqOne+z",
      label: "equation",
    });
    await applyMathEdit(page, {
      needle: "mlOne",
      replaceWith: "mlOne+z",
      label: "multline",
    });
    await applyMathEdit(page, {
      needle: "alOne",
      replaceWith: "alOne+z",
      label: "align",
      verify: ["\\intertext{note}", "\\tag{A}", "\\notag"],
    });
    await applyMathEdit(page, {
      needle: "atOne",
      replaceWith: "atOne+z",
      label: "alignat",
    });
    await applyMathEdit(page, {
      needle: "flOne",
      replaceWith: "flOne+z",
      label: "flalign",
    });
    await applyMathEdit(page, {
      needle: "gaOne",
      replaceWith: "gaOne+z",
      label: "gather",
    });
    await applyMathEdit(page, {
      needle: "caseOne",
      replaceWith: "caseOne+z",
      label: "cases",
    });
    await applyMathEdit(page, {
      needle: "subOne",
      replaceWith: "subOne+z",
      label: "subequations",
      verify: ["\\begin{subequations}", "\\end{subequations}"],
    });
    await applyMathEdit(page, {
      needle: "spOne",
      replaceWith: "spOne+z",
      label: "split",
      verify: ["\\begin{split}", "\\end{split}"],
    });
    await applyMathEdit(page, {
      needle: "pmOne",
      replaceWith: "pmOne+z",
      label: "pmatrix",
    });
    await applyMathEdit(page, {
      needle: "bmOne",
      replaceWith: "bmOne+z",
      label: "bmatrix",
    });
    await applyMathEdit(page, {
      needle: "BMOne",
      replaceWith: "BMOne+z",
      label: "Bmatrix",
    });
    await applyMathEdit(page, {
      needle: "vmOne",
      replaceWith: "vmOne+z",
      label: "vmatrix",
    });
    await applyMathEdit(page, {
      needle: "VMOne",
      replaceWith: "VMOne+z",
      label: "Vmatrix",
    });
    await applyMathEdit(page, {
      needle: "smOne",
      replaceWith: "smOne+z",
      label: "smallmatrix",
    });

    await moveCursorTo(page, "Plain line.");
    await waitForAutoDetected(page, false, "Plain line");
    await page.evaluate(() => {
      window.__tex180SetMathInputFallback?.("u+v");
    });
    const fallbackValue = await page.evaluate(() => window.__tex180GetMathInputFallback?.());
    expect(fallbackValue).toBe("u+v");
    const inputValue = await page.evaluate(() => window.__tex180GetMathInputValue?.());
    expect(inputValue).toBe("u+v");
    await page.click("#block-insert-button");
    await page.waitForSelector("#diff-modal.is-open");
    await page.click("#diff-modal-submit");
    await page.waitForFunction(
      () => !document.getElementById("diff-modal")?.classList.contains("is-open")
    );

    const updated = await page.evaluate(() => window.__tex180Editor.getValue());
    expect(updated).toContain("\\[");
    expect(updated).toContain("\\]");
    expect(updated).toContain("u+v");
    await page.evaluate(() => {
      window.__tex180SetMathInputFallback?.(null);
    });
  } finally {
    await electronApp.close();
  }
});

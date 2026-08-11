import { describe, expect, it } from "vitest";
import {
  CompileFailure,
  assertNoBlankPdfPages,
  assertNoBlockingTypesettingDiagnostics,
  assertSafeGeneratedLatex,
  parseLatexDiagnostics,
  parsePdfPageCount,
} from "@/server/compiler";

describe("LaTeX compiler safety", () => {
  it("accepts renderer-owned document source", () => {
    expect(() => assertSafeGeneratedLatex("\\documentclass{article}\\begin{document}安全\\end{document}"))
      .not.toThrow();
  });

  it("treats visible overflow, missing glyphs, and unresolved references as blocking", () => {
    const output = [
      "Overfull \\hbox (12.5pt too wide) in paragraph at lines 41--43",
      "Missing character: There is no 漢 (U+6F22) in font LatinModernRoman!",
      "LaTeX Warning: Reference `sec:missing' on page 1 undefined on input line 8.",
    ].join("\n");
    expect(parseLatexDiagnostics(output)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", code: "content_overflow" }),
        expect.objectContaining({ severity: "error", code: "missing_glyph" }),
        expect.objectContaining({ severity: "error", code: "undefined_reference" }),
      ]),
    );
    expect(() => assertNoBlockingTypesettingDiagnostics(output)).toThrow(
      CompileFailure,
    );
  });

  it("keeps minor spacing defects as warnings", () => {
    const diagnostics = assertNoBlockingTypesettingDiagnostics(
      "Overfull \\hbox (0.75pt too wide) in paragraph at lines 5--5\nUnderfull \\hbox (badness 1000) in paragraph",
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", code: "minor_overflow" }),
      expect.objectContaining({ severity: "warning", code: "loose_typesetting" }),
    ]);
  });

  it("accepts only a bounded positive page count from PDF inspection", () => {
    expect(parsePdfPageCount("Title: Example\nPages:          12\nEncrypted: no")).toBe(12);
    expect(() => parsePdfPageCount("Pages: 0")).toThrow(CompileFailure);
    expect(() => parsePdfPageCount("Pages: unknown")).toThrow(CompileFailure);
  });

  it("accepts non-empty text for every rendered page", () => {
    expect(() =>
      assertNoBlankPdfPages("First page body\fSecond page body\f", 2),
    ).not.toThrow();
  });

  it("rejects a rendered page containing only a running page number", () => {
    expect(() =>
      assertNoBlankPdfPages("First page body\f  2  \f", 2),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({ code: "blank_pdf_page" }),
        ],
      }),
    );
  });

  it("fails closed when extracted page boundaries disagree with pdfinfo", () => {
    expect(() => assertNoBlankPdfPages("Only one page", 2)).toThrowError(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({ code: "pdf_text_inspection_failed" }),
        ],
      }),
    );
  });

  it.each(["\\write18{curl example.com}", "\\directlua{os.execute('id')}", "\\input{/etc/passwd}"])(
    "rejects unsafe source: %s",
    (source) => {
      expect(() => assertSafeGeneratedLatex(source)).toThrow(CompileFailure);
    },
  );

  it("turns raw engine output into bounded, user-safe diagnostics", () => {
    const diagnostics = parseLatexDiagnostics("/private/tmp/job/main.tex:17: Undefined control sequence.\n! Missing $ inserted.\nl.22 text");
    expect(diagnostics).toEqual([
      expect.objectContaining({ line: 17, severity: "error" }),
      expect.objectContaining({ line: 22, severity: "error" }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("/private/tmp");
  });

  it("does not mistake LuaTeX memory statistics for source errors", () => {
    expect(
      parseLatexDiagnostics(
        "1:11,2:14555,3:188,4:202,5:58,6:42,7:1674,8:38,9:774,10:15,11:2",
      ),
    ).toEqual([]);
  });
});

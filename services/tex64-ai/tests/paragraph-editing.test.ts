import { describe, expect, it } from "vitest";

import {
  escapeParagraphText,
  findParagraphRange,
  segmentParagraph,
  serializeSegments,
  type ParagraphSegment,
} from "@/domain/source/paragraph-editing";

/** Concatenating segments must reproduce the source byte for byte. */
function expectRoundTrip(paragraph: string) {
  const segments = segmentParagraph(paragraph);
  expect(segments.map((segment) => segment.latex).join("")).toBe(paragraph);
  // Untouched segments serialize back to the same paragraph too: escaping
  // is the identity on text that came out of the segmenter.
  expect(serializeSegments(segments)).toBe(paragraph);
  return segments;
}

describe("findParagraphRange", () => {
  const lines = [
    "\\section{Attention}", // 10
    "", // 11
    "Attention lets a model weigh context.", // 12
    "It is the core of the Transformer.", // 13
    "", // 14
    "\\begin{equation}", // 15
    "y = f(x)", // 16
    "\\end{equation}", // 17
  ];

  it("expands to blank-line boundaries", () => {
    const range = findParagraphRange(lines, 10, 13);
    expect(range).toEqual({
      startLine: 12,
      endLine: 13,
      text: "Attention lets a model weigh context.\nIt is the core of the Transformer.",
    });
  });

  it("stops at structural lines", () => {
    const range = findParagraphRange(lines, 10, 16);
    expect(range).toEqual({ startLine: 16, endLine: 16, text: "y = f(x)" });
  });

  it("offers nothing on blank or structural lines", () => {
    expect(findParagraphRange(lines, 10, 10)).toBeNull(); // \section
    expect(findParagraphRange(lines, 10, 11)).toBeNull(); // blank
    expect(findParagraphRange(lines, 10, 15)).toBeNull(); // \begin
    expect(findParagraphRange(lines, 10, 99)).toBeNull(); // outside excerpt
  });
});

describe("segmentParagraph", () => {
  it("keeps plain prose as one editable run", () => {
    const segments = expectRoundTrip("The weights are content dependent.");
    expect(segments).toEqual([
      { kind: "text", latex: "The weights are content dependent." },
    ]);
  });

  it("chips commands, math, and citations around editable text", () => {
    const source =
      "Attention \\emph{selects} inputs $q k^\\top$ as shown by \\cite{vaswani2017}.";
    const segments = expectRoundTrip(source);
    const chips = segments.filter((segment) => segment.kind === "chip");
    expect(chips.map((chip) => [chip.label, chip.latex])).toEqual([
      ["強調", "\\emph{selects}"],
      ["数式", "$q k^\\top$"],
      ["引用", "\\cite{vaswani2017}"],
    ]);
    const text = segments
      .filter((segment) => segment.kind === "text")
      .map((segment) => segment.latex)
      .join("");
    expect(text).toBe("Attention  inputs  as shown by .");
  });

  it("keeps nested braces inside one chip", () => {
    const segments = expectRoundTrip("A \\footnote{see \\emph{here} too} B");
    expect(segments).toEqual([
      { kind: "text", latex: "A " },
      { kind: "chip", latex: "\\footnote{see \\emph{here} too}", label: "脚注" },
      { kind: "text", latex: " B" },
    ]);
  });

  it("consumes optional and repeated arguments", () => {
    const segments = expectRoundTrip("\\includegraphics[width=3cm]{fig.pdf} caption");
    expect(segments[0]).toEqual({
      kind: "chip",
      latex: "\\includegraphics[width=3cm]{fig.pdf}",
      label: "画像",
    });
  });

  it("chips every special character so text stays escapable", () => {
    const source = "50\\% of $x$~always, \\LaTeX\\ and {\\bfseries bold} % note";
    const segments = expectRoundTrip(source);
    for (const segment of segments) {
      if (segment.kind !== "text") continue;
      expect(segment.latex).not.toMatch(/[\\%$&#_^~{}]/);
    }
  });

  it("treats display math and \\( \\) spans as chips", () => {
    expectRoundTrip("before \\(a+b\\) middle $$c$$ after");
    const segments = segmentParagraph("before \\(a+b\\) middle $$c$$ after");
    const chips = segments.filter((segment) => segment.kind === "chip");
    expect(chips.map((chip) => chip.latex)).toEqual(["\\(a+b\\)", "$$c$$"]);
  });

  it("chips an \\item marker but leaves its prose editable", () => {
    const segments = expectRoundTrip("\\item First point about attention");
    expect(segments[0]).toEqual({ kind: "chip", latex: "\\item", label: "箇条書き" });
    expect(segments[1]).toEqual({ kind: "text", latex: " First point about attention" });
  });

  it("survives malformed input verbatim", () => {
    expectRoundTrip("an unmatched } brace and a lone \\");
    expectRoundTrip("unclosed $math to the end");
    expectRoundTrip("unclosed \\emph{group to the end");
  });

  it("keeps a \\verb span opaque to its closing delimiter", () => {
    const segments = expectRoundTrip("run \\verb|latexmk -pdf| here");
    expect(segments[1]).toEqual({ kind: "chip", latex: "\\verb|latexmk -pdf|", label: "コード" });
  });
});

describe("escapeParagraphText / serializeSegments", () => {
  it("escapes what the reader typed", () => {
    expect(escapeParagraphText("costs $5 & 10% more")).toBe(
      "costs \\$5 \\& 10\\% more",
    );
    expect(escapeParagraphText("a\\b")).toBe("a\\textbackslash{}b");
    expect(escapeParagraphText("x^2 ~ y_1")).toBe(
      "x\\textasciicircum{}2 \\textasciitilde{} y\\_1",
    );
  });

  it("writes edited prose back around untouched chips", () => {
    const segments: ParagraphSegment[] = [
      { kind: "text", latex: "Attention is 100% essential " },
      { kind: "chip", latex: "\\cite{vaswani2017}", label: "引用" },
      { kind: "text", latex: "." },
    ];
    expect(serializeSegments(segments)).toBe(
      "Attention is 100\\% essential \\cite{vaswani2017}.",
    );
  });
});

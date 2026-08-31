import { describe, expect, it } from "vitest";

import {
  escapeParagraphText,
  findParagraphRange,
  segmentDisplayMath,
  segmentParagraph,
  serializeSegments,
  type ParagraphSegment,
} from "@/domain/source/paragraph-editing";

/** Leaving every visible value untouched must reproduce the source byte for byte. */
function expectRoundTrip(paragraph: string) {
  const segments = segmentParagraph(paragraph);
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
      kind: "text",
    });
  });

  it("opens display math as a formula instead of prose", () => {
    const range = findParagraphRange(lines, 10, 16);
    expect(range).toEqual({
      startLine: 16,
      endLine: 16,
      text: "y = f(x)",
      kind: "math",
    });
  });

  it("opens display math when SyncTeX points at its closing fence", () => {
    expect(findParagraphRange(lines, 10, 17)).toEqual({
      startLine: 16,
      endLine: 16,
      text: "y = f(x)",
      kind: "math",
    });
  });

  it("makes a heading's visible text editable", () => {
    expect(findParagraphRange(lines, 10, 10)).toEqual({
      startLine: 10,
      endLine: 10,
      text: "\\section{Attention}",
      kind: "text",
    });
  });

  it("resolves generated title paper text back to its editable value", () => {
    const preamble = [
      "\\title{Attention Mechanisms: A Brief Survey}",
      "\\author{幸川卓実}",
      "\\date{August 30, 2026}",
      "\\begin{document}",
      "\\maketitle",
    ];
    expect(
      findParagraphRange(
        preamble,
        40,
        44,
        "Attention Mechanisms: A Brief",
      ),
    ).toEqual({
      startLine: 40,
      endLine: 40,
      text: "\\title{Attention Mechanisms: A Brief Survey}",
      kind: "text",
    });
  });

  it("uses the clicked formula to reject a wrong fast SyncTeX line", () => {
    const source = [
      "\\begin{equation}",
      "\\operatorname{Attention}(Q,K,V)=\\operatorname{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V.",
      "\\end{equation}",
      "",
      "\\section{Self-Attention and Cross-Attention}",
    ];
    expect(
      findParagraphRange(
        source,
        90,
        94,
        "Attention(Q,K,V) = softmax(QKᵀ / √dₖ)V. (1)",
      ),
    ).toEqual({
      startLine: 91,
      endLine: 91,
      text: source[1],
      kind: "math",
    });
  });

  it("uses paper text when fast SyncTeX lands on a blank line", () => {
    expect(
      findParagraphRange(
        lines,
        10,
        11,
        "Attention lets a model weigh context. It is the core of the Transformer.",
      ),
    ).toEqual({
      startLine: 12,
      endLine: 13,
      text: "Attention lets a model weigh context.\nIt is the core of the Transformer.",
      kind: "text",
    });
  });

  it("uses paper text to reject a neighboring prose paragraph", () => {
    const source = [
      "First paragraph discusses convolution and local kernels.",
      "",
      "Second paragraph explains attention over every token.",
    ];
    expect(
      findParagraphRange(
        source,
        50,
        50,
        "Second paragraph explains attention over every token.",
      ),
    ).toEqual({
      startLine: 52,
      endLine: 52,
      text: source[2],
      kind: "text",
    });
  });

  it("does not open a wrong nearby paragraph when paper text has no source match", () => {
    expect(
      findParagraphRange(
        ["This source paragraph is unrelated."],
        80,
        80,
        "A page number or generated running header",
      ),
    ).toBeNull();
    expect(
      findParagraphRange(["Visible paragraph."], 80, 80, "2"),
    ).toBeNull();
  });

  it("offers nothing on blank or non-editable structure", () => {
    expect(findParagraphRange(lines, 10, 11)).toBeNull(); // blank
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

  it("exposes prose and math while keeping source structure invisible", () => {
    const source =
      "Attention \\emph{selects} inputs $q k^\\top$ as shown by \\cite{vaswani2017}.";
    const segments = expectRoundTrip(source);
    const text = segments
      .filter((segment) => segment.kind === "text")
      .map((segment) => segment.latex)
      .join("");
    expect(text).toBe("Attention selects inputs  as shown by .");
    expect(segments.filter((segment) => segment.kind === "math")).toEqual([
      { kind: "math", latex: "q k^\\top", prefix: "$", suffix: "$" },
    ]);
    expect(
      segments
        .filter((segment) => segment.kind === "syntax")
        .map((segment) => segment.latex)
        .join(""),
    ).toContain("\\cite{vaswani2017}");
  });

  it("recursively exposes prose inside formatting and footnotes", () => {
    const segments = expectRoundTrip("A \\footnote{see \\emph{here} too} B");
    expect(
      segments
        .filter((segment) => segment.kind === "text")
        .map((segment) => segment.latex)
        .join(""),
    ).toBe("A see here too B");
  });

  it("keeps non-editable commands entirely as hidden syntax", () => {
    const segments = expectRoundTrip("\\includegraphics[width=3cm]{fig.pdf} caption");
    expect(segments[0]).toEqual({
      kind: "syntax",
      latex: "\\includegraphics[width=3cm]{fig.pdf}",
    });
  });

  it("keeps every special character out of editable source syntax", () => {
    const source = "50\\% of $x$~always, \\LaTeX\\ and {\\bfseries bold} % note";
    const segments = expectRoundTrip(source);
    for (const segment of segments) {
      if (segment.kind !== "text") continue;
      expect(segment.latex).not.toMatch(/[\\$&#_^~{}]/);
    }
  });

  it("treats display math and \\( \\) spans as editable formulae", () => {
    expectRoundTrip("before \\(a+b\\) middle $$c$$ after");
    const segments = segmentParagraph("before \\(a+b\\) middle $$c$$ after");
    const math = segments.filter((segment) => segment.kind === "math");
    expect(math.map((segment) => segment.latex)).toEqual(["a+b", "c"]);
  });

  it("hides an \\item marker but leaves its prose editable", () => {
    const segments = expectRoundTrip("\\item First point about attention");
    expect(segments[0]).toEqual({ kind: "syntax", latex: "\\item" });
    expect(segments[1]).toEqual({ kind: "text", latex: " First point about attention" });
  });

  it("shows a title as text without exposing the command", () => {
    const segments = expectRoundTrip("\\title{Attention Mechanisms}");
    expect(segments.filter((segment) => segment.kind === "text")).toEqual([
      { kind: "text", latex: "Attention Mechanisms" },
    ]);
    expect(segments.filter((segment) => segment.kind === "syntax")).toEqual([
      { kind: "syntax", latex: "\\title{" },
      { kind: "syntax", latex: "}" },
    ]);
  });

  it("survives malformed input verbatim", () => {
    expectRoundTrip("an unmatched } brace and a lone \\");
    expectRoundTrip("unclosed $math to the end");
    expectRoundTrip("unclosed \\emph{group to the end");
  });

  it("keeps a \\verb span hidden to its closing delimiter", () => {
    const segments = expectRoundTrip("run \\verb|latexmk -pdf| here");
    expect(segments[1]).toEqual({ kind: "syntax", latex: "\\verb|latexmk -pdf|" });
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
      { kind: "syntax", latex: "\\cite{vaswani2017}" },
      { kind: "text", latex: "." },
    ];
    expect(serializeSegments(segments)).toBe(
      "Attention is 100\\% essential \\cite{vaswani2017}.",
    );
  });
});

describe("segmentDisplayMath", () => {
  it("keeps labels hidden and editable formula content separate", () => {
    const source = "  \\label{eq:sdpa}\n  QK^\\top / \\sqrt{d_k}";
    const segments = segmentDisplayMath(source);
    expect(segments.filter((segment) => segment.kind === "syntax")).toEqual([
      { kind: "syntax", latex: "  \\label{eq:sdpa}\n" },
    ]);
    expect(segments.filter((segment) => segment.kind === "math")).toEqual([
      { kind: "math", latex: "  QK^\\top / \\sqrt{d_k}", prefix: "", suffix: "" },
    ]);
    expect(serializeSegments(segments)).toBe(source);
  });
});

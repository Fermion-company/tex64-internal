import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DocumentSchema,
  SAMPLE_DOCUMENT,
  SAMPLE_DOCUMENT_IDS,
  SAMPLE_DOCUMENT_REVISION,
  applyDocumentPatch,
  escapeLatexText,
  renderDocumentToLatex,
  validateDocument,
  type DocumentModel,
  type DocumentNode,
  type MathExpression,
  type DocumentPatch,
} from "@/domain/document";
import { LocalLatexCompiler } from "@/server/compiler/local-compiler";

function extendedDocument(
  nodes: DocumentNode[],
  root: string[],
): DocumentModel {
  return {
    ...structuredClone(SAMPLE_DOCUMENT),
    schemaVersion: 2,
    root,
    nodes,
  };
}

function equationNode(id: string, expression: MathExpression): DocumentNode {
  return { id, type: "equation", expression, numbered: true };
}

function citationStyleDocument(
  style: "author-year" | "apa7" | "ieee" | "numeric",
): DocumentModel {
  const document = structuredClone(SAMPLE_DOCUMENT);
  document.schemaVersion = 2;
  document.metadata.citationStyle = { schemaVersion: 1, style };
  const first = document.nodes.find(
    (node) => node.id === SAMPLE_DOCUMENT_IDS.citation,
  );
  const bibliography = document.nodes.find(
    (node) => node.id === SAMPLE_DOCUMENT_IDS.bibliography,
  );
  const paragraph = document.nodes.find(
    (node) => node.id === SAMPLE_DOCUMENT_IDS.citedParagraph,
  );
  if (
    first?.type !== "citation" ||
    bibliography?.type !== "bibliography" ||
    paragraph?.type !== "paragraph"
  ) {
    throw new Error("Sample citation fixtures are missing");
  }
  Object.assign(first, {
    authors: ["Ada Lovelace"],
    title: "Alpha attention",
    year: "2025",
    publication: "Journal of Attention",
    publisher: "Research Press",
    volume: "12",
    issue: "3",
    pages: "44-58",
    sourceType: "journal_article" as const,
    sourceLanguage: "en",
    doi: "10.5555/alpha",
    url: "https://doi.org/10.5555/alpha",
  });
  const secondId = "10000000-0000-4000-8000-000000000099";
  document.nodes.push({
    id: secondId,
    type: "citation",
    authors: ["Ada Lovelace"],
    title: "Zeta attention",
    year: "2025",
    publication: "Journal of Attention",
    volume: "13",
    issue: "1",
    pages: "1-9",
    sourceType: "journal_article",
    sourceLanguage: "en",
    doi: "10.5555/zeta",
    url: "https://doi.org/10.5555/zeta",
  });
  bibliography.citationIds = [secondId, first.id];
  paragraph.content = [
    {
      type: "citationRef",
      citationId: first.id,
      locator: "p. 47",
    },
    { type: "text", text: " and ", marks: [] },
    { type: "citationRef", citationId: secondId },
  ];
  return validateDocument(document);
}

describe("deterministic LaTeX renderer", () => {
  it("preserves the established output for legacy documents byte for byte", () => {
    const rendered = renderDocumentToLatex(SAMPLE_DOCUMENT);
    // Region markers are the ONLY addition on top of the legacy output:
    // stripping the marker lines must reproduce the historical bytes exactly.
    const stripped = rendered
      .split("\n")
      .filter(
        (line) => !line.startsWith("%%T64B:") && !line.startsWith("%%T64E:"),
      )
      .join("\n");
    expect(createHash("sha256").update(stripped).digest("hex")).toBe(
      "09dd8c9241997fa8cb93985bd5409b280328ad1c5127bc4c01c0c6273f5beaba",
    );
    expect(createHash("sha256").update(rendered).digest("hex")).toBe(
      "9ce0885ea3f761aa6760bf34f8578a6beb423f6e9879d0b5314e8dcdb1e339b7",
    );
  });

  it("renders only allowlisted layout options from typed metadata", () => {
    const document = structuredClone(SAMPLE_DOCUMENT);
    document.schemaVersion = 2;
    document.metadata.layout = {
      preset: "academic",
      pageSize: "B5",
      columns: 2,
    };

    const latex = renderDocumentToLatex(document);
    expect(latex).toContain(
      "\\documentclass[b5paper,10pt,twocolumn]{ltjsarticle}",
    );
    expect(latex).toContain(
      "\\usepackage[top=20mm,bottom=22mm,left=20mm,right=20mm]{geometry}",
    );
    expect(latex).toContain("\\setlength{\\parskip}{0.2\\baselineskip}");
    expect(latex).not.toContain("document.metadata.layout");
  });

  it("renders deterministic author-year and APA 7 citations with disambiguation and locators", () => {
    const authorYear = renderDocumentToLatex(
      citationStyleDocument("author-year"),
    );
    expect(authorYear).toContain("(Lovelace, 2025a, p. 47)");
    expect(authorYear).toContain("(Lovelace, 2025b)");
    expect(authorYear).toContain("Ada Lovelace (2025a)");
    expect(authorYear.indexOf("Alpha attention")).toBeLessThan(
      authorYear.indexOf("Zeta attention"),
    );

    const apa = renderDocumentToLatex(citationStyleDocument("apa7"));
    expect(apa).toContain("Lovelace, A. (2025a)");
    expect(apa).toContain("\\emph{Journal of Attention}");
    expect(apa).toContain("\\emph{12}(3), 44-58");
    expect(apa).toContain("https://doi.org/10.5555/alpha");
  });

  it("renders deterministic IEEE and numeric references without arbitrary style input", () => {
    const ieee = renderDocumentToLatex(citationStyleDocument("ieee"));
    expect(ieee).toContain(
      `\\cite[p. 47]{cite${SAMPLE_DOCUMENT_IDS.citation.replaceAll("-", "")}}`,
    );
    expect(ieee).toContain("\\bibitem[2]");
    expect(ieee).toContain("A. Lovelace, “Alpha attention,”");
    expect(ieee).toContain("vol. 12, no. 3, pp. 44-58");

    const numeric = renderDocumentToLatex(citationStyleDocument("numeric"));
    expect(numeric).toContain("\\bibitem[1]");
    expect(numeric).toContain("Ada Lovelace. Zeta attention");
    expect(
      DocumentSchema.safeParse({
        ...citationStyleDocument("numeric"),
        metadata: {
          ...citationStyleDocument("numeric").metadata,
          citationStyle: { schemaVersion: 1, style: "custom.csl" },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps Japanese author names intact in author-year citations", () => {
    const document = citationStyleDocument("author-year");
    const citation = document.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.citation,
    );
    if (citation?.type !== "citation") throw new Error("Citation missing");
    citation.authors = ["山田 太郎", "佐藤 花子"];
    citation.sourceLanguage = "ja";
    const latex = renderDocumentToLatex(document);
    expect(latex).toContain("(山田 太郎・佐藤 花子, 2025");
  });

  it("escapes every user-controlled text field and does not pass shell commands through", () => {
    const document = structuredClone(SAMPLE_DOCUMENT);
    const hostile = String.raw`\input{/etc/passwd} & % # $ _ { } ^ ~ \immediate\write18{touch /tmp/pwn}`;
    document.metadata.title = hostile;
    const paragraph = document.nodes.find((node) => node.id === SAMPLE_DOCUMENT_IDS.paragraph);
    if (paragraph?.type !== "paragraph") throw new Error("Sample paragraph is missing");
    paragraph.content = [{ type: "text", text: hostile, marks: ["code", "bold"] }];

    const latex = renderDocumentToLatex(document);

    expect(latex).toContain("\\textbackslash{}input\\{/etc/passwd\\}");
    expect(latex).toContain("\\& \\% \\# \\$ \\_");
    expect(latex).toContain("\\textasciicircum{} \\textasciitilde{}");
    expect(latex).not.toContain("\\input{");
    expect(latex).not.toContain("\\write18");
    expect(latex).not.toContain("\\immediate");
    expect(latex).not.toContain("rawTeX");
  });

  it("escapes individual LaTeX metacharacters predictably", () => {
    expect(escapeLatexText("\\{}$&#%^_~\nnext")).toBe(
      "\\textbackslash{}\\{\\}\\$\\&\\#\\%\\textasciicircum{}\\_\\textasciitilde{} next",
    );
  });

  it("renders identical source for repeated renders and canonicalizes mark order", () => {
    const first = structuredClone(SAMPLE_DOCUMENT);
    const second = structuredClone(SAMPLE_DOCUMENT);
    const firstParagraph = first.nodes.find((node) => node.id === SAMPLE_DOCUMENT_IDS.paragraph);
    const secondParagraph = second.nodes.find((node) => node.id === SAMPLE_DOCUMENT_IDS.paragraph);
    if (firstParagraph?.type !== "paragraph" || secondParagraph?.type !== "paragraph") {
      throw new Error("Sample paragraph is missing");
    }
    firstParagraph.content = [{ type: "text", text: "同じ意味", marks: ["bold", "italic"] }];
    secondParagraph.content = [{ type: "text", text: "同じ意味", marks: ["italic", "bold"] }];

    const rendered = renderDocumentToLatex(first);
    expect(renderDocumentToLatex(first)).toBe(rendered);
    expect(renderDocumentToLatex(second)).toBe(rendered);
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it("derives figure paths only from validated IDs and allowlisted extensions", () => {
    const document = structuredClone(SAMPLE_DOCUMENT);
    const figure = document.nodes.find((node) => node.id === SAMPLE_DOCUMENT_IDS.figure);
    if (figure?.type !== "figure") throw new Error("Sample figure is missing");
    figure.assetId = "30000000-0000-4000-8000-000000000001";
    figure.assetKind = "png";

    const latex = renderDocumentToLatex(document);
    expect(latex).toContain(
      "{assets/30000000-0000-4000-8000-000000000001.png}",
    );
  });

  it("applies the same patch deterministically", () => {
    const patch: DocumentPatch = {
      id: "30000000-0000-4000-8000-000000000010",
      documentId: SAMPLE_DOCUMENT.id,
      baseRevision: 0,
      createdAt: "2026-08-07T03:00:00.000Z",
      operations: [
        {
          op: "move",
          nodeId: SAMPLE_DOCUMENT_IDS.bibliography,
          position: { kind: "root", index: 0 },
        },
      ],
    };

    const left = applyDocumentPatch(structuredClone(SAMPLE_DOCUMENT_REVISION), patch);
    const right = applyDocumentPatch(structuredClone(SAMPLE_DOCUMENT_REVISION), patch);
    expect(left).toEqual(right);
    expect(renderDocumentToLatex(left.document)).toBe(renderDocumentToLatex(right.document));
  });

  it("renders and compiles the complete typed mathematics vocabulary without raw TeX", async () => {
    const sectionId = "50000000-0000-4000-8000-000000000001";
    const inlineParagraphId = "50000000-0000-4000-8000-000000000100";
    const equationIds = Array.from(
      { length: 14 },
      (_, index) =>
        `50000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
    );
    const expressions: MathExpression[] = [
      {
        kind: "integral",
        integrand: { kind: "symbol", name: "f" },
        variable: { kind: "symbol", name: "x" },
        lowerBound: { kind: "literal", value: "0" },
        upperBound: { kind: "literal", value: "1" },
      },
      {
        kind: "sequence",
        items: [
          {
            kind: "largeOperator",
            operator: "sum",
            expression: { kind: "symbol", name: "x" },
            index: { kind: "symbol", name: "i" },
            lowerBound: { kind: "literal", value: "1" },
            upperBound: { kind: "symbol", name: "n" },
          },
          {
            kind: "largeOperator",
            operator: "product",
            expression: { kind: "symbol", name: "y" },
            index: { kind: "symbol", name: "j" },
            lowerBound: { kind: "literal", value: "1" },
            upperBound: { kind: "symbol", name: "m" },
          },
        ],
      },
      {
        kind: "limit",
        expression: { kind: "symbol", name: "a" },
        variable: { kind: "symbol", name: "x" },
        approaches: { kind: "literal", value: "0" },
        direction: "right",
      },
      {
        kind: "partialDerivative",
        expression: { kind: "symbol", name: "f" },
        variables: [
          { variable: { kind: "symbol", name: "x" }, order: 1 },
          { variable: { kind: "symbol", name: "y" }, order: 2 },
        ],
      },
      {
        kind: "vector",
        entries: [
          { kind: "symbol", name: "x" },
          { kind: "symbol", name: "y" },
        ],
        orientation: "column",
        delimiter: "parentheses",
      },
      {
        kind: "matrix",
        rows: [
          [
            { kind: "literal", value: "1" },
            { kind: "literal", value: "0" },
          ],
          [
            { kind: "literal", value: "0" },
            { kind: "literal", value: "1" },
          ],
        ],
        delimiter: "brackets",
      },
      {
        kind: "cases",
        cases: [
          {
            expression: { kind: "symbol", name: "x" },
            condition: { kind: "text", value: "x が非負" },
          },
          {
            expression: {
              kind: "unary",
              operator: "negate",
              operand: { kind: "symbol", name: "x" },
            },
            condition: { kind: "text", value: "x が負" },
          },
        ],
      },
      {
        kind: "aligned",
        lines: [
          {
            left: { kind: "symbol", name: "a" },
            relation: "equals",
            right: { kind: "symbol", name: "b" },
            annotation: "定義より",
          },
          {
            left: { kind: "symbol", name: "b" },
            relation: "approximatelyEquals",
            right: { kind: "symbol", name: "c" },
          },
        ],
      },
      {
        kind: "quantified",
        quantifier: "forAll",
        variable: { kind: "symbol", name: "x" },
        domain: { kind: "symbol", name: "realNumbers" },
        predicate: {
          kind: "binary",
          operator: "implies",
          left: {
            kind: "binary",
            operator: "greaterThanOrEqual",
            left: { kind: "symbol", name: "x" },
            right: { kind: "literal", value: "0" },
          },
          right: {
            kind: "binary",
            operator: "in",
            left: { kind: "accent", accent: "hat", expression: { kind: "symbol", name: "x" } },
            right: {
              kind: "set",
              elements: [
                { kind: "literal", value: "0" },
                { kind: "literal", value: "1" },
              ],
            },
          },
        },
      },
      {
        kind: "sequence",
        items: [
          {
            kind: "derivative",
            expression: { kind: "symbol", name: "f" },
            variable: { kind: "symbol", name: "x" },
            order: 2,
          },
          {
            kind: "unary",
            operator: "norm",
            operand: {
              kind: "accent",
              accent: "vector",
              expression: { kind: "symbol", name: "v" },
            },
          },
          {
            kind: "unary",
            operator: "floor",
            operand: { kind: "symbol", name: "x" },
          },
          {
            kind: "unary",
            operator: "ceiling",
            operand: { kind: "symbol", name: "y" },
          },
        ],
      },
      {
        kind: "binomial",
        upper: { kind: "symbol", name: "n" },
        lower: { kind: "symbol", name: "k" },
      },
      {
        kind: "sequence",
        items: [
          {
            kind: "statisticalOperator",
            operator: "probability",
            expression: { kind: "symbol", name: "A" },
            condition: { kind: "symbol", name: "B" },
          },
          {
            kind: "statisticalOperator",
            operator: "expectation",
            expression: { kind: "symbol", name: "X" },
            subscript: { kind: "symbol", name: "theta" },
          },
          {
            kind: "statisticalOperator",
            operator: "variance",
            expression: { kind: "symbol", name: "X" },
          },
          {
            kind: "statisticalOperator",
            operator: "covariance",
            expression: {
              kind: "sequence",
              items: [
                { kind: "symbol", name: "X" },
                { kind: "symbol", name: "Y" },
              ],
            },
          },
        ],
      },
      {
        kind: "setBuilder",
        variable: { kind: "symbol", name: "x" },
        condition: {
          kind: "binary",
          operator: "and",
          left: {
            kind: "binary",
            operator: "in",
            left: { kind: "symbol", name: "x" },
            right: { kind: "symbol", name: "integers" },
          },
          right: {
            kind: "binary",
            operator: "notEquals",
            left: { kind: "symbol", name: "x" },
            right: { kind: "literal", value: "0" },
          },
        },
      },
      {
        kind: "sequence",
        items: [
          {
            kind: "function",
            name: "realPart",
            arguments: [{ kind: "symbol", name: "z" }],
          },
          {
            kind: "binary",
            operator: "union",
            left: { kind: "symbol", name: "A" },
            right: {
              kind: "binary",
              operator: "intersection",
              left: { kind: "symbol", name: "B" },
              right: { kind: "symbol", name: "C" },
            },
          },
        ],
      },
    ];
    const document = extendedDocument(
      [
        {
          id: sectionId,
          type: "section",
          title: [{ type: "text", text: "数式", marks: [] }],
          children: [inlineParagraphId, ...equationIds],
        },
        {
          id: inlineParagraphId,
          type: "paragraph",
          content: [
            { type: "text", text: "成分", marks: [] },
            {
              type: "inlineMath",
              expression: {
                kind: "script",
                base: {
                  kind: "root",
                  radicand: { kind: "symbol", name: "x" },
                  index: { kind: "literal", value: "3" },
                },
                subscript: { kind: "symbol", name: "i" },
                superscript: { kind: "literal", value: "2" },
              },
            },
          ],
        },
        ...equationIds.map((id, index) =>
          equationNode(id, expressions[index] as MathExpression),
        ),
      ],
      [sectionId],
    );

    const latex = renderDocumentToLatex(document);
    expect(latex).toContain("\\int_{0}^{1} f\\, dx");
    expect(latex).toContain("\\sum_{i = 1}^{n} x");
    expect(latex).toContain("\\prod_{j = 1}^{m} y");
    expect(latex).toContain("\\lim_{x \\to 0^{+}} a");
    expect(latex).toContain("\\frac{\\partial^{3} f}{\\partial x \\partial y^{2}}");
    expect(latex).toContain("\\begin{pmatrix}x \\\\ y\\end{pmatrix}");
    expect(latex).toContain("\\begin{bmatrix}1 & 0 \\\\ 0 & 1\\end{bmatrix}");
    expect(latex).toContain("\\begin{cases}");
    expect(latex).toContain("\\begin{aligned}");
    expect(latex).toContain("\\text{定義より}");
    expect(latex).toContain("\\({\\sqrt[3]{x}}_{i}^{2}\\)");
    expect(latex).toContain("\\forall\\, x \\in \\mathbb{R}");
    expect(latex).toContain("\\frac{d^{2} f}{dx^{2}}");
    expect(latex).toContain("\\left\\lVert \\vec{v} \\right\\rVert");
    expect(latex).toContain("\\binom{n}{k}");
    expect(latex).toContain("\\mathbb{P}\\left[A \\mid B\\right]");
    expect(latex).toContain("\\mathbb{E}_{\\theta}\\left[X\\right]");
    expect(latex).toContain("\\left\\{x \\middle|");
    expect(latex).toContain("\\operatorname{Re}\\left(z\\right)");

    const compiled = await new LocalLatexCompiler().compile({
      userId: "math-test",
      documentId: document.id,
      revision: 1,
      latex,
    });
    expect(compiled.pageCount).toBeGreaterThan(0);
  }, 60_000);

  it("paginates long tables safely and spans a two-column layout", async () => {
    const sectionId = "52000000-0000-4000-8000-000000000001";
    const tableId = "52000000-0000-4000-8000-000000000002";
    const columnIds = [
      "52000000-0000-4000-8000-000000000003",
      "52000000-0000-4000-8000-000000000004",
      "52000000-0000-4000-8000-000000000005",
    ];
    const document = extendedDocument(
      [
        {
          id: sectionId,
          type: "section",
          title: [{ type: "text", text: "検証結果", marks: [] }],
          children: [tableId],
        },
        {
          id: tableId,
          type: "table",
          caption: [{ type: "text", text: "全試行の測定結果", marks: [] }],
          columns: columnIds.map((id, index) => ({
            id,
            header: [
              { type: "text" as const, text: `項目${index + 1}`, marks: [] },
            ],
            alignment: index === 0 ? ("left" as const) : ("right" as const),
          })),
          rows: Array.from({ length: 60 }, (_, rowIndex) => ({
            id: `52000000-0000-4000-8001-${String(rowIndex + 1).padStart(12, "0")}`,
            cells: columnIds.map((columnId, columnIndex) => ({
              columnId,
              content: [
                {
                  type: "text" as const,
                  text: `測定 ${rowIndex + 1}-${columnIndex + 1}`,
                  marks: [],
                },
              ],
            })),
          })),
        },
      ],
      [sectionId],
    );
    document.metadata.layout = {
      preset: "academic",
      pageSize: "A4",
      columns: 2,
    };

    const latex = renderDocumentToLatex(document);
    expect(latex).toContain("\\usepackage{longtable}");
    expect(latex).toContain("\\onecolumn");
    expect(latex).toContain("\\begin{longtable}");
    expect(latex).toContain("\\endfirsthead");
    expect(latex).toContain("\\twocolumn");

    const compiled = await new LocalLatexCompiler().compile({
      userId: "table-test",
      documentId: document.id,
      revision: 1,
      latex,
    });
    expect(compiled.pageCount).toBeGreaterThan(1);
  }, 60_000);

  it("renders and compiles theorem blocks, typed references, algorithms, safe code, and appendices", async () => {
    const ids = {
      section: "51000000-0000-4000-8000-000000000001",
      refs: "51000000-0000-4000-8000-000000000002",
      theorem: "51000000-0000-4000-8000-000000000003",
      statement: "51000000-0000-4000-8000-000000000004",
      proof: "51000000-0000-4000-8000-000000000005",
      proofText: "51000000-0000-4000-8000-000000000006",
      equation: "51000000-0000-4000-8000-000000000007",
      figure: "51000000-0000-4000-8000-000000000008",
      table: "51000000-0000-4000-8000-000000000009",
      column: "51000000-0000-4000-8000-000000000010",
      row: "51000000-0000-4000-8000-000000000011",
      algorithm: "51000000-0000-4000-8000-000000000012",
      step: "51000000-0000-4000-8000-000000000013",
      code: "51000000-0000-4000-8000-000000000014",
      appendixA: "51000000-0000-4000-8000-000000000015",
      appendixAText: "51000000-0000-4000-8000-000000000016",
      appendixB: "51000000-0000-4000-8000-000000000017",
      appendixBText: "51000000-0000-4000-8000-000000000018",
      definition: "51000000-0000-4000-8000-000000000019",
      definitionText: "51000000-0000-4000-8000-000000000020",
      theoremBlock: "51000000-0000-4000-8000-000000000021",
      theoremText: "51000000-0000-4000-8000-000000000022",
      corollary: "51000000-0000-4000-8000-000000000023",
      corollaryText: "51000000-0000-4000-8000-000000000024",
    } as const;
    const ref = (
      targetType: "section" | "equation" | "theorem" | "figure" | "table",
      targetId: string,
    ) => ({ type: "crossRef" as const, targetType, targetId, format: "number" as const });
    const document = extendedDocument(
      [
        {
          id: ids.section,
          type: "section",
          title: [{ type: "text", text: "本文", marks: [] }],
          children: [
            ids.refs,
            ids.theorem,
            ids.definition,
            ids.theoremBlock,
            ids.corollary,
            ids.equation,
            ids.figure,
            ids.table,
            ids.algorithm,
            ids.code,
          ],
        },
        {
          id: ids.refs,
          type: "paragraph",
          content: [
            ref("section", ids.section),
            {
              type: "crossRef",
              targetType: "section",
              targetId: ids.section,
              format: "page",
            },
            { type: "text", text: "・", marks: [] },
            ref("equation", ids.equation),
            { type: "text", text: "・", marks: [] },
            ref("theorem", ids.theorem),
            { type: "text", text: "・", marks: [] },
            ref("figure", ids.figure),
            { type: "text", text: "・", marks: [] },
            ref("table", ids.table),
          ],
        },
        {
          id: ids.theorem,
          type: "theorem",
          theoremKind: "lemma",
          title: [{ type: "text", text: "安全な補題", marks: [] }],
          children: [ids.statement, ids.proof],
        },
        {
          id: ids.statement,
          type: "paragraph",
          content: [{ type: "text", text: "主張です。", marks: [] }],
        },
        { id: ids.proof, type: "proof", children: [ids.proofText] },
        {
          id: ids.proofText,
          type: "paragraph",
          content: [{ type: "text", text: "証明です。", marks: [] }],
        },
        {
          id: ids.definition,
          type: "theorem",
          theoremKind: "definition",
          children: [ids.definitionText],
        },
        {
          id: ids.definitionText,
          type: "paragraph",
          content: [{ type: "text", text: "定義です。", marks: [] }],
        },
        {
          id: ids.theoremBlock,
          type: "theorem",
          theoremKind: "theorem",
          children: [ids.theoremText],
        },
        {
          id: ids.theoremText,
          type: "paragraph",
          content: [{ type: "text", text: "定理です。", marks: [] }],
        },
        {
          id: ids.corollary,
          type: "theorem",
          theoremKind: "corollary",
          children: [ids.corollaryText],
        },
        {
          id: ids.corollaryText,
          type: "paragraph",
          content: [{ type: "text", text: "系です。", marks: [] }],
        },
        equationNode(ids.equation, { kind: "symbol", name: "x" }),
        {
          id: ids.figure,
          type: "figure",
          altText: "図の代替説明",
          caption: [{ type: "text", text: "図の説明", marks: [] }],
          widthPercent: 80,
        },
        {
          id: ids.table,
          type: "table",
          caption: [{ type: "text", text: "表の説明", marks: [] }],
          columns: [
            {
              id: ids.column,
              header: [{ type: "text", text: "値", marks: [] }],
              alignment: "left",
            },
          ],
          rows: [
            {
              id: ids.row,
              cells: [
                {
                  columnId: ids.column,
                  content: [{ type: "text", text: "1", marks: [] }],
                },
              ],
            },
          ],
        },
        {
          id: ids.algorithm,
          type: "algorithm",
          title: [{ type: "text", text: "探索", marks: [] }],
          inputs: [{ type: "text", text: "候補", marks: [] }],
          outputs: [{ type: "text", text: "解", marks: [] }],
          steps: [
            {
              id: ids.step,
              content: [{ type: "text", text: "候補を評価する", marks: [] }],
              children: [],
            },
          ],
        },
        {
          id: ids.code,
          type: "codeBlock",
          language: "python",
          caption: [{ type: "text", text: "安全なコード", marks: [] }],
          code: String.raw`\end{quote}\input{/etc/passwd}% \write18{bad}`,
          showLineNumbers: true,
        },
        {
          id: ids.appendixA,
          type: "appendix",
          title: [{ type: "text", text: "追加結果", marks: [] }],
          children: [ids.appendixAText],
        },
        {
          id: ids.appendixAText,
          type: "paragraph",
          content: [{ type: "text", text: "結果A", marks: [] }],
        },
        {
          id: ids.appendixB,
          type: "appendix",
          title: [{ type: "text", text: "追加資料", marks: [] }],
          children: [ids.appendixBText],
        },
        {
          id: ids.appendixBText,
          type: "paragraph",
          content: [{ type: "text", text: "結果B", marks: [] }],
        },
      ],
      [ids.section, ids.appendixA, ids.appendixB],
    );
    expect(validateDocument(document)).toEqual(document);

    const latex = renderDocumentToLatex(document);
    expect(latex.match(/\\appendix/gu)).toHaveLength(1);
    expect(latex).toContain("\\usepackage{amsthm}");
    expect(latex).toContain("\\begin{lemma}[{安全な補題}]");
    expect(latex).toContain("\\begin{definition}");
    expect(latex).toContain("\\begin{theorem}");
    expect(latex).toContain("\\begin{corollary}");
    expect(latex).toContain("\\begin{proof}");
    expect(latex).toContain("\\refstepcounter{algorithm}");
    expect(latex).toContain("\\textbf{Input:}");
    expect(latex).toContain("\\textbackslash{}end\\{quote\\}");
    expect(latex).toContain("\\textbackslash{}input\\{/etc/passwd\\}");
    expect(latex).not.toContain("\\input{");
    expect(latex).not.toContain("\\write18");
    expect(latex).toContain(`\\ref{sec${ids.section.replaceAll("-", "")}}`);
    expect(latex).toContain(
      `\\pageref{sec${ids.section.replaceAll("-", "")}}`,
    );
    expect(latex).toContain(`\\eqref{eq${ids.equation.replaceAll("-", "")}}`);
    expect(latex).toContain(`\\label{thm${ids.theorem.replaceAll("-", "")}}`);
    expect(latex).toContain(`\\label{fig${ids.figure.replaceAll("-", "")}}`);
    expect(latex).toContain(`\\label{tab${ids.table.replaceAll("-", "")}}`);
    const compiled = await new LocalLatexCompiler().compile({
      userId: "document-domain-test",
      documentId: document.id,
      revision: 1,
      latex,
    });
    expect(Buffer.from(compiled.pdf.subarray(0, 5)).toString("ascii")).toBe(
      "%PDF-",
    );
  }, 60_000);
});

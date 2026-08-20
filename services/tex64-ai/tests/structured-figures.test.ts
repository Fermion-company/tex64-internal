import { describe, expect, it } from "vitest";
import {
  DocumentPatchSchema,
  DocumentSchema,
  DocumentValidationError,
  MAX_CHART_POINTS,
  MAX_FLOW_DIAGRAM_NODES,
  SAMPLE_DOCUMENT,
  SAMPLE_DOCUMENT_IDS,
  SAMPLE_DOCUMENT_REVISION,
  applyDocumentPatch,
  assertDocumentFiguresRenderable,
  renderDocumentToLatex,
  safeValidateDocument,
  validateDocument,
  type ChartPoint,
  type DocumentModel,
} from "@/domain/document";
import { LocalLatexCompiler } from "@/server/compiler/local-compiler";

const IDS = {
  flowStart: "60000000-0000-4000-8000-000000000101",
  flowDecision: "60000000-0000-4000-8000-000000000102",
  flowFinish: "60000000-0000-4000-8000-000000000103",
  lineChart: "60000000-0000-4000-8000-000000000201",
  barChart: "60000000-0000-4000-8000-000000000202",
} as const;

function structuredFigureDocument(): DocumentModel {
  const document = structuredClone(SAMPLE_DOCUMENT);
  document.schemaVersion = 2;
  const section = document.nodes.find(
    (node) => node.id === SAMPLE_DOCUMENT_IDS.section,
  );
  const figure = document.nodes.find(
    (node) => node.id === SAMPLE_DOCUMENT_IDS.figure,
  );
  if (section?.type !== "section" || figure?.type !== "figure") {
    throw new Error("Sample figure structure is missing");
  }
  figure.altText = "入力を検査し、条件に応じて文書を完成させる流れ";
  figure.content = {
    kind: "flowDiagram",
    direction: "left-to-right",
    nodes: [
      {
        id: IDS.flowStart,
        label: String.raw`入力 } \input{/etc/passwd} & 100%`,
        shape: "terminator",
      },
      {
        id: IDS.flowDecision,
        label: "条件を満たすか",
        shape: "decision",
      },
      {
        id: IDS.flowFinish,
        label: "完成文書",
        shape: "process",
      },
    ],
    edges: [
      { from: IDS.flowStart, to: IDS.flowDecision, label: "検査" },
      { from: IDS.flowDecision, to: IDS.flowFinish, label: "はい" },
    ],
  };

  document.nodes.push(
    {
      id: IDS.lineChart,
      type: "figure",
      altText: "反復回数に対する精度の推移",
      caption: [{ type: "text", text: "精度の推移", marks: [] }],
      widthPercent: 78,
      content: {
        kind: "chart",
        chartType: "line",
        xAxis: { label: "反復回数", range: { min: 0, max: 3 } },
        yAxis: { label: "精度 (%)", range: { min: 0, max: 100 } },
        series: [
          {
            label: String.raw`提案法 }],title={bad}\write18{bad}`,
            points: [
              { x: 0, y: 52 },
              { x: 1, y: 74 },
              { x: 2, y: 88 },
              { x: 3, y: 93 },
            ],
          },
          {
            label: "比較法",
            points: [
              { x: 0, y: 49 },
              { x: 1, y: 63 },
              { x: 2, y: 70 },
              { x: 3, y: 76 },
            ],
          },
        ],
      },
    },
    {
      id: IDS.barChart,
      type: "figure",
      altText: "条件ごとの処理時間の比較",
      caption: [{ type: "text", text: "処理時間の比較", marks: [] }],
      widthPercent: 72,
      content: {
        kind: "chart",
        chartType: "bar",
        xAxis: { label: "条件" },
        yAxis: { label: "時間 (秒)", range: { min: 0, max: 20 } },
        series: [
          {
            label: "提案法",
            points: [
              { x: 1, y: 7.5 },
              { x: 2, y: 9.25 },
            ],
          },
          {
            label: "比較法",
            points: [
              { x: 1, y: 12 },
              { x: 2, y: 15.5 },
            ],
          },
        ],
      },
    },
  );
  const figureIndex = section.children.indexOf(figure.id);
  section.children.splice(figureIndex + 1, 0, IDS.lineChart, IDS.barChart);
  return validateDocument(document);
}

describe("structured figures", () => {
  it("renders flow, line, and bar figures deterministically with conditional packages", () => {
    const document = structuredFigureDocument();
    const latex = renderDocumentToLatex(document);

    expect(renderDocumentToLatex(document)).toBe(latex);
    expect(() => assertDocumentFiguresRenderable(document)).not.toThrow();
    expect(latex.match(/\\usepackage\{tikz\}/gu)).toHaveLength(1);
    expect(latex.match(/\\usepackage\{pgfplots\}/gu)).toHaveLength(1);
    expect(latex.match(/\\begin\{figure\}/gu)).toHaveLength(3);
    expect(latex).toContain("\\node[flowterminator]");
    expect(latex).toContain("\\addplot+");
    expect(latex).toContain("ybar");
    expect(latex).not.toContain("\\fbox{");
    expect(latex).not.toContain("\\input{");
    expect(latex).not.toContain("\\write18");
    expect(latex).toContain("\\textbackslash{}input");
    expect(latex).toContain("\\textbackslash{}write\\allowbreak{}18");

    const legacy = renderDocumentToLatex(SAMPLE_DOCUMENT);
    expect(legacy).not.toContain("\\usepackage{tikz}");
    expect(legacy).not.toContain("\\usepackage{pgfplots}");
  });

  it("rejects injected styles or coordinates and invalid structured references", () => {
    const document = structuredFigureDocument();
    const flow = document.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.figure,
    );
    if (flow?.type !== "figure" || flow.content?.kind !== "flowDiagram") {
      throw new Error("Flow diagram is missing");
    }

    const styled = structuredClone(document) as unknown as Record<
      string,
      unknown
    >;
    const styledNodes = styled["nodes"] as Array<Record<string, unknown>>;
    const styledFigure = styledNodes.find(
      (node) => node["id"] === SAMPLE_DOCUMENT_IDS.figure,
    );
    const styledContent = styledFigure?.["content"] as Record<string, unknown>;
    const styledFlowNodes = styledContent["nodes"] as Array<
      Record<string, unknown>
    >;
    styledFlowNodes[0]!["style"] = String.raw`draw=none,execute at begin node=\input`;
    expect(DocumentSchema.safeParse(styled).success).toBe(false);

    const coordinated = structuredClone(document) as unknown as Record<
      string,
      unknown
    >;
    const coordinatedNodes = coordinated["nodes"] as Array<
      Record<string, unknown>
    >;
    const line = coordinatedNodes.find((node) => node["id"] === IDS.lineChart);
    const lineContent = line?.["content"] as Record<string, unknown>;
    const series = lineContent["series"] as Array<Record<string, unknown>>;
    const points = series[0]?.["points"] as Array<Record<string, unknown>>;
    points[0]!["coordinate"] = String.raw`(axis cs:0,0) node {\input}`;
    expect(DocumentSchema.safeParse(coordinated).success).toBe(false);

    flow.content.edges[0] = {
      from: "60000000-0000-4000-8000-000000009999",
      to: IDS.flowDecision,
    };
    const result = safeValidateDocument(document);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ code: "missing_reference" }),
      );
    }
  });

  it("does not allow new fake figures and exposes the strict completion gate", () => {
    expect(() => assertDocumentFiguresRenderable(SAMPLE_DOCUMENT)).toThrow(
      DocumentValidationError,
    );

    expect(
      DocumentPatchSchema.safeParse({
        id: "60000000-0000-4000-8000-000000000301",
        documentId: SAMPLE_DOCUMENT.id,
        baseRevision: 0,
        createdAt: "2026-08-08T00:00:00.000Z",
        operations: [
          {
            op: "insert",
            node: {
              id: "60000000-0000-4000-8000-000000000302",
              type: "figure",
              altText: "実体のない図",
              caption: [{ type: "text", text: "仮の図", marks: [] }],
              widthPercent: 80,
            },
            position: { kind: "root", index: 0 },
          },
        ],
      }).success,
    ).toBe(false);

    const both = structuredFigureDocument();
    const figure = both.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.figure,
    );
    if (figure?.type !== "figure") throw new Error("Figure is missing");
    figure.assetId = "60000000-0000-4000-8000-000000000303";
    figure.assetKind = "png";
    expect(() => validateDocument(both)).toThrow(DocumentValidationError);
  });

  it("upgrades a legacy document when a structured figure is applied", () => {
    const source = structuredFigureDocument();
    const structuredFigure = source.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.figure,
    );
    if (structuredFigure?.type !== "figure") {
      throw new Error("Structured figure is missing");
    }
    const result = applyDocumentPatch(SAMPLE_DOCUMENT_REVISION, {
      id: "60000000-0000-4000-8000-000000000304",
      documentId: SAMPLE_DOCUMENT.id,
      baseRevision: 0,
      createdAt: "2026-08-08T00:01:00.000Z",
      operations: [
        {
          op: "update",
          nodeId: structuredFigure.id,
          node: structuredFigure,
        },
      ],
    });

    expect(result.document.schemaVersion).toBe(2);
    expect(() => assertDocumentFiguresRenderable(result.document)).not.toThrow();
  });

  it("applies aggregate chart budgets before an oversized plot reaches TeX", () => {
    const document = structuredClone(SAMPLE_DOCUMENT);
    document.schemaVersion = 2;
    const figure = document.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.figure,
    );
    if (figure?.type !== "figure") throw new Error("Figure is missing");
    const points: ChartPoint[] = Array.from({ length: 5_000 }, (_, index) => ({
      x: index,
      y: index % 100,
    }));
    figure.content = {
      kind: "chart",
      chartType: "bar",
      xAxis: { label: "x" },
      yAxis: { label: "y" },
      series: Array.from({ length: 5 }, (_, index) => ({
        label: `series-${index}`,
        points,
      })),
    };

    const result = safeValidateDocument(document);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          code: "resource_limit",
          message: `Document exceeds ${MAX_CHART_POINTS} chart points`,
        }),
      );
    }
  });

  it("applies aggregate flow budgets and raw-input preflight limits", () => {
    const document = structuredClone(SAMPLE_DOCUMENT);
    document.schemaVersion = 2;
    const section = document.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.section,
    );
    if (section?.type !== "section") throw new Error("Section is missing");
    let sequence = 1;
    const nextId = () =>
      `${(0x61000000 + sequence++).toString(16)}-0000-4000-8000-000000000000`;
    for (let figureIndex = 0; figureIndex < 16; figureIndex += 1) {
      const figureId = nextId();
      const nodes = Array.from({ length: 32 }, (_, index) => ({
        id: nextId(),
        label: `node-${figureIndex}-${index}`,
        shape: "process" as const,
      }));
      document.nodes.push({
        id: figureId,
        type: "figure",
        altText: `flow-${figureIndex}`,
        caption: [],
        widthPercent: 80,
        content: {
          kind: "flowDiagram",
          direction: "top-to-bottom",
          nodes,
          edges: nodes.slice(1).map((node, index) => ({
            from: nodes[index]!.id,
            to: node.id,
          })),
        },
      });
      section.children.push(figureId);
    }

    const flowResult = safeValidateDocument(document);
    expect(flowResult.success).toBe(false);
    if (!flowResult.success) {
      expect(flowResult.error.issues).toContainEqual(
        expect.objectContaining({
          code: "resource_limit",
          message: `Document exceeds ${MAX_FLOW_DIAGRAM_NODES} flow diagram nodes`,
        }),
      );
    }

    const raw = structuredClone(SAMPLE_DOCUMENT) as unknown as Record<
      string,
      unknown
    >;
    raw["schemaVersion"] = 2;
    const rawNodes = raw["nodes"] as Array<Record<string, unknown>>;
    const rawFigure = rawNodes.find(
      (node) => node["id"] === SAMPLE_DOCUMENT_IDS.figure,
    );
    rawFigure!["content"] = {
      kind: "chart",
      chartType: "bar",
      xAxis: { label: "x" },
      yAxis: { label: "y" },
      series: [
        {
          label: "pathological",
          points: Array.from({ length: 90_000 }, (_, index) => ({
            x: index,
            y: index,
          })),
        },
      ],
    };
    const preflight = safeValidateDocument(raw);
    expect(preflight.success).toBe(false);
    if (!preflight.success) {
      expect(preflight.error.issues[0]).toMatchObject({
        code: "resource_limit",
      });
    }
  });

  it("compiles multiple real structured figures with LuaLaTeX", async () => {
    const document = structuredFigureDocument();
    const result = await new LocalLatexCompiler().compile({
      userId: "structured-figure-test",
      documentId: document.id,
      revision: 2,
      latex: renderDocumentToLatex(document),
    });

    expect(Buffer.from(result.pdf.subarray(0, 5)).toString("ascii")).toBe(
      "%PDF-",
    );
    expect(result.pdf.byteLength).toBeGreaterThan(1_000);
  }, 60_000);
});

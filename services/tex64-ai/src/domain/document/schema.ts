import { z } from "zod";

/**
 * The document domain deliberately contains no TeX source fields. TeX is a
 * derived artifact produced by the renderer from this typed model.
 */

export const StableIdSchema = z.string().uuid();
export type StableId = z.infer<typeof StableIdSchema>;

const NonEmptyTextSchema = z.string().min(1).max(100_000);
const ShortTextSchema = z.string().min(1).max(1_000);
const OptionalShortTextSchema = z.string().max(1_000).optional();
const TimestampSchema = z.string().datetime({ offset: true });

export const InlineMarkSchema = z.enum([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "code",
  "superscript",
  "subscript",
]);
export type InlineMark = z.infer<typeof InlineMarkSchema>;

const InlineMarksSchema = z
  .array(InlineMarkSchema)
  .max(InlineMarkSchema.options.length)
  .default([])
  .superRefine((marks, context) => {
    const seen = new Set<InlineMark>();
    for (const [index, mark] of marks.entries()) {
      if (seen.has(mark)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `Duplicate inline mark: ${mark}`,
        });
      }
      seen.add(mark);
    }
    if (seen.has("superscript") && seen.has("subscript")) {
      context.addIssue({
        code: "custom",
        message: "Text cannot be both superscript and subscript",
      });
    }
  });

export const TextInlineSchema = z.strictObject({
  type: z.literal("text"),
  text: NonEmptyTextSchema,
  marks: InlineMarksSchema,
});

export const CitationReferenceInlineSchema = z.strictObject({
  type: z.literal("citationRef"),
  citationId: StableIdSchema,
  locator: OptionalShortTextSchema,
});

export const FootnoteReferenceInlineSchema = z.strictObject({
  type: z.literal("footnoteRef"),
  footnoteId: StableIdSchema,
});

export const HardBreakInlineSchema = z.strictObject({
  type: z.literal("hardBreak"),
});

export const CrossReferenceTargetSchema = z.enum([
  "section",
  "equation",
  "theorem",
  "figure",
  "table",
]);
export type CrossReferenceTarget = z.infer<typeof CrossReferenceTargetSchema>;

export const CrossReferenceInlineSchema = z.strictObject({
  type: z.literal("crossRef"),
  targetType: CrossReferenceTargetSchema,
  targetId: StableIdSchema,
  format: z.enum(["number", "page"]),
});

export interface InlineMath {
  type: "inlineMath";
  expression: MathExpression;
}

export const InlineMathSchema: z.ZodType<InlineMath> = z.strictObject({
  type: z.literal("inlineMath"),
  expression: z.lazy(() => MathExpressionSchema),
});

export const InlineNodeSchema = z.union([
  TextInlineSchema,
  CitationReferenceInlineSchema,
  FootnoteReferenceInlineSchema,
  HardBreakInlineSchema,
  CrossReferenceInlineSchema,
  InlineMathSchema,
]);
export type InlineNode = z.infer<typeof InlineNodeSchema>;

export const InlineContentSchema = z.array(InlineNodeSchema).max(2_000);
export type InlineContent = z.infer<typeof InlineContentSchema>;

export interface MathLiteral {
  kind: "literal";
  value: string;
}

export interface MathSymbol {
  kind: "symbol";
  name: string;
}

export interface MathText {
  kind: "text";
  value: string;
}

export interface MathUnary {
  kind: "unary";
  operator:
    | "negate"
    | "sqrt"
    | "absolute"
    | "norm"
    | "floor"
    | "ceiling"
    | "not";
  operand: MathExpression;
}

export interface MathBinary {
  kind: "binary";
  operator:
    | "add"
    | "subtract"
    | "multiply"
    | "divide"
    | "power"
    | "equals"
    | "approximatelyEquals"
    | "lessThan"
    | "lessThanOrEqual"
    | "greaterThan"
    | "greaterThanOrEqual"
    | "notEquals"
    | "in"
    | "notIn"
    | "subset"
    | "subsetOrEqual"
    | "superset"
    | "supersetOrEqual"
    | "union"
    | "intersection"
    | "setDifference"
    | "and"
    | "or"
    | "implies"
    | "ifAndOnlyIf"
    | "proportionalTo";
  left: MathExpression;
  right: MathExpression;
}

export interface MathFunction {
  kind: "function";
  name:
    | "sin"
    | "cos"
    | "tan"
    | "arcsin"
    | "arccos"
    | "arctan"
    | "sinh"
    | "cosh"
    | "tanh"
    | "log"
    | "ln"
    | "exp"
    | "min"
    | "max"
    | "det"
    | "gcd"
    | "lcm"
    | "arg"
    | "realPart"
    | "imaginaryPart";
  arguments: MathExpression[];
}

export interface MathSequence {
  kind: "sequence";
  items: MathExpression[];
}

export interface MathScript {
  kind: "script";
  base: MathExpression;
  subscript?: MathExpression;
  superscript?: MathExpression;
}

export interface MathRoot {
  kind: "root";
  radicand: MathExpression;
  index?: MathExpression;
}

export interface MathIntegral {
  kind: "integral";
  integrand: MathExpression;
  variable: MathSymbol;
  lowerBound?: MathExpression;
  upperBound?: MathExpression;
}

export interface MathLargeOperator {
  kind: "largeOperator";
  operator: "sum" | "product";
  expression: MathExpression;
  index?: MathSymbol;
  lowerBound?: MathExpression;
  upperBound?: MathExpression;
}

export interface MathLimit {
  kind: "limit";
  expression: MathExpression;
  variable: MathSymbol;
  approaches: MathExpression;
  direction: "both" | "left" | "right";
}

export interface MathPartialDerivativeVariable {
  variable: MathSymbol;
  order: number;
}

export interface MathPartialDerivative {
  kind: "partialDerivative";
  expression: MathExpression;
  variables: MathPartialDerivativeVariable[];
}

export interface MathVector {
  kind: "vector";
  entries: MathExpression[];
  orientation: "row" | "column";
  delimiter: "parentheses" | "brackets";
}

export interface MathMatrix {
  kind: "matrix";
  rows: MathExpression[][];
  delimiter: "parentheses" | "brackets" | "bars" | "doubleBars" | "none";
}

export interface MathCase {
  expression: MathExpression;
  condition: MathExpression;
}

export interface MathCases {
  kind: "cases";
  cases: MathCase[];
}

export type MathAlignmentRelation =
  | "equals"
  | "approximatelyEquals"
  | "lessThan"
  | "lessThanOrEqual"
  | "greaterThan"
  | "greaterThanOrEqual";

export interface MathAlignedLine {
  left: MathExpression;
  relation: MathAlignmentRelation;
  right: MathExpression;
  annotation?: string;
}

export interface MathAligned {
  kind: "aligned";
  lines: MathAlignedLine[];
}

export interface MathAccent {
  kind: "accent";
  accent: "hat" | "bar" | "tilde" | "dot" | "doubleDot" | "vector";
  expression: MathExpression;
}

export interface MathDerivative {
  kind: "derivative";
  expression: MathExpression;
  variable: MathSymbol;
  order: number;
}

export interface MathSet {
  kind: "set";
  elements: MathExpression[];
}

export interface MathSetBuilder {
  kind: "setBuilder";
  variable: MathExpression;
  condition: MathExpression;
}

export interface MathQuantified {
  kind: "quantified";
  quantifier: "forAll" | "exists" | "existsUnique";
  variable: MathSymbol;
  domain?: MathExpression;
  predicate: MathExpression;
}

export interface MathBinomial {
  kind: "binomial";
  upper: MathExpression;
  lower: MathExpression;
}

export interface MathStatisticalOperator {
  kind: "statisticalOperator";
  operator: "probability" | "expectation" | "variance" | "covariance";
  expression: MathExpression;
  condition?: MathExpression;
  subscript?: MathExpression;
}

export type MathExpression =
  | MathLiteral
  | MathSymbol
  | MathText
  | MathUnary
  | MathBinary
  | MathFunction
  | MathSequence
  | MathScript
  | MathRoot
  | MathIntegral
  | MathLargeOperator
  | MathLimit
  | MathPartialDerivative
  | MathVector
  | MathMatrix
  | MathCases
  | MathAligned
  | MathAccent
  | MathDerivative
  | MathSet
  | MathSetBuilder
  | MathQuantified
  | MathBinomial
  | MathStatisticalOperator;

const MathLiteralSchema = z.strictObject({
  kind: z.literal("literal"),
  value: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/),
});

const MathSymbolSchema = z.strictObject({
  kind: z.literal("symbol"),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
});

const MathTextSchema = z.strictObject({
  kind: z.literal("text"),
  value: ShortTextSchema,
});

const MathAlignmentRelationSchema = z.enum([
  "equals",
  "approximatelyEquals",
  "lessThan",
  "lessThanOrEqual",
  "greaterThan",
  "greaterThanOrEqual",
]);

export const MathExpressionSchema: z.ZodType<MathExpression> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    MathLiteralSchema,
    MathSymbolSchema,
    MathTextSchema,
    z.strictObject({
      kind: z.literal("unary"),
      operator: z.enum([
        "negate",
        "sqrt",
        "absolute",
        "norm",
        "floor",
        "ceiling",
        "not",
      ]),
      operand: MathExpressionSchema,
    }),
    z.strictObject({
      kind: z.literal("binary"),
      operator: z.enum([
        "add",
        "subtract",
        "multiply",
        "divide",
        "power",
        "equals",
        "approximatelyEquals",
        "lessThan",
        "lessThanOrEqual",
        "greaterThan",
        "greaterThanOrEqual",
        "notEquals",
        "in",
        "notIn",
        "subset",
        "subsetOrEqual",
        "superset",
        "supersetOrEqual",
        "union",
        "intersection",
        "setDifference",
        "and",
        "or",
        "implies",
        "ifAndOnlyIf",
        "proportionalTo",
      ]),
      left: MathExpressionSchema,
      right: MathExpressionSchema,
    }),
    z.strictObject({
      kind: z.literal("function"),
      name: z.enum([
        "sin",
        "cos",
        "tan",
        "arcsin",
        "arccos",
        "arctan",
        "sinh",
        "cosh",
        "tanh",
        "log",
        "ln",
        "exp",
        "min",
        "max",
        "det",
        "gcd",
        "lcm",
        "arg",
        "realPart",
        "imaginaryPart",
      ]),
      arguments: z.array(MathExpressionSchema).min(1).max(16),
    }),
    z.strictObject({
      kind: z.literal("sequence"),
      items: z.array(MathExpressionSchema).min(1).max(64),
    }),
    z
      .strictObject({
        kind: z.literal("script"),
        base: MathExpressionSchema,
        subscript: MathExpressionSchema.optional(),
        superscript: MathExpressionSchema.optional(),
      })
      .superRefine((script, context) => {
        if (!script.subscript && !script.superscript) {
          context.addIssue({
            code: "custom",
            message: "A script requires a subscript or superscript",
          });
        }
      }),
    z.strictObject({
      kind: z.literal("root"),
      radicand: MathExpressionSchema,
      index: MathExpressionSchema.optional(),
    }),
    z
      .strictObject({
        kind: z.literal("integral"),
        integrand: MathExpressionSchema,
        variable: MathSymbolSchema,
        lowerBound: MathExpressionSchema.optional(),
        upperBound: MathExpressionSchema.optional(),
      })
      .superRefine((integral, context) => {
        if (Boolean(integral.lowerBound) !== Boolean(integral.upperBound)) {
          context.addIssue({
            code: "custom",
            message: "Definite integrals require both lower and upper bounds",
          });
        }
      }),
    z
      .strictObject({
        kind: z.literal("largeOperator"),
        operator: z.enum(["sum", "product"]),
        expression: MathExpressionSchema,
        index: MathSymbolSchema.optional(),
        lowerBound: MathExpressionSchema.optional(),
        upperBound: MathExpressionSchema.optional(),
      })
      .superRefine((operator, context) => {
        const bounded = [operator.index, operator.lowerBound, operator.upperBound];
        if (bounded.some(Boolean) && !bounded.every(Boolean)) {
          context.addIssue({
            code: "custom",
            message: "Bounded sums and products require an index and both bounds",
          });
        }
      }),
    z.strictObject({
      kind: z.literal("limit"),
      expression: MathExpressionSchema,
      variable: MathSymbolSchema,
      approaches: MathExpressionSchema,
      direction: z.enum(["both", "left", "right"]),
    }),
    z.strictObject({
      kind: z.literal("partialDerivative"),
      expression: MathExpressionSchema,
      variables: z
        .array(
          z.strictObject({
            variable: MathSymbolSchema,
            order: z.number().int().min(1).max(16),
          }),
        )
        .min(1)
        .max(16),
    }),
    z.strictObject({
      kind: z.literal("vector"),
      entries: z.array(MathExpressionSchema).min(1).max(512),
      orientation: z.enum(["row", "column"]),
      delimiter: z.enum(["parentheses", "brackets"]),
    }),
    z.strictObject({
      kind: z.literal("matrix"),
      rows: z
        .array(z.array(MathExpressionSchema).min(1).max(128))
        .min(1)
        .max(128),
      delimiter: z.enum([
        "parentheses",
        "brackets",
        "bars",
        "doubleBars",
        "none",
      ]),
    }),
    z.strictObject({
      kind: z.literal("cases"),
      cases: z
        .array(
          z.strictObject({
            expression: MathExpressionSchema,
            condition: MathExpressionSchema,
          }),
        )
        .min(1)
        .max(128),
    }),
    z.strictObject({
      kind: z.literal("aligned"),
      lines: z
        .array(
          z.strictObject({
            left: MathExpressionSchema,
            relation: MathAlignmentRelationSchema,
            right: MathExpressionSchema,
            annotation: ShortTextSchema.optional(),
          }),
        )
        .min(2)
        .max(512),
    }),
    z.strictObject({
      kind: z.literal("accent"),
      accent: z.enum(["hat", "bar", "tilde", "dot", "doubleDot", "vector"]),
      expression: MathExpressionSchema,
    }),
    z.strictObject({
      kind: z.literal("derivative"),
      expression: MathExpressionSchema,
      variable: MathSymbolSchema,
      order: z.number().int().min(1).max(16),
    }),
    z.strictObject({
      kind: z.literal("set"),
      elements: z.array(MathExpressionSchema).max(256),
    }),
    z.strictObject({
      kind: z.literal("setBuilder"),
      variable: MathExpressionSchema,
      condition: MathExpressionSchema,
    }),
    z.strictObject({
      kind: z.literal("quantified"),
      quantifier: z.enum(["forAll", "exists", "existsUnique"]),
      variable: MathSymbolSchema,
      domain: MathExpressionSchema.optional(),
      predicate: MathExpressionSchema,
    }),
    z.strictObject({
      kind: z.literal("binomial"),
      upper: MathExpressionSchema,
      lower: MathExpressionSchema,
    }),
    z.strictObject({
      kind: z.literal("statisticalOperator"),
      operator: z.enum(["probability", "expectation", "variance", "covariance"]),
      expression: MathExpressionSchema,
      condition: MathExpressionSchema.optional(),
      subscript: MathExpressionSchema.optional(),
    }),
  ]),
);

export interface ListItemModel {
  id: StableId;
  content: InlineContent;
  children: ListItemModel[];
}

export const ListItemSchema: z.ZodType<ListItemModel> = z.lazy(() =>
  z.strictObject({
    id: StableIdSchema,
    content: InlineContentSchema,
    children: z.array(ListItemSchema).max(100).default([]),
  }),
);

export const SectionNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("section"),
  title: InlineContentSchema,
  children: z.array(StableIdSchema).max(2_000),
});

export const ParagraphNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("paragraph"),
  content: InlineContentSchema,
});

export const HeadingNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("heading"),
  level: z.number().int().min(1).max(6),
  content: InlineContentSchema,
});

export const ListNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("list"),
  style: z.enum(["bullet", "ordered"]),
  items: z.array(ListItemSchema).min(1).max(1_000),
});

export const EquationNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("equation"),
  /** Immutable link to the validated plan item this equation realizes. */
  planItemId: StableIdSchema.optional(),
  expression: MathExpressionSchema,
  description: InlineContentSchema.optional(),
  numbered: z.boolean().default(true),
});

const FigureLabelSchema = z.string().min(1).max(240);

export const FlowDiagramShapeSchema = z.enum([
  "process",
  "decision",
  "terminator",
  "data",
]);
export type FlowDiagramShape = z.infer<typeof FlowDiagramShapeSchema>;

export const FlowDiagramDirectionSchema = z.enum([
  "left-to-right",
  "top-to-bottom",
]);
export type FlowDiagramDirection = z.infer<
  typeof FlowDiagramDirectionSchema
>;

export const FlowDiagramNodeSchema = z.strictObject({
  id: StableIdSchema,
  label: FigureLabelSchema,
  shape: FlowDiagramShapeSchema,
});
export type FlowDiagramNode = z.infer<typeof FlowDiagramNodeSchema>;

export const FlowDiagramEdgeSchema = z.strictObject({
  from: StableIdSchema,
  to: StableIdSchema,
  label: FigureLabelSchema.optional(),
});
export type FlowDiagramEdge = z.infer<typeof FlowDiagramEdgeSchema>;

export const FlowDiagramContentSchema = z.strictObject({
  kind: z.literal("flowDiagram"),
  direction: FlowDiagramDirectionSchema,
  nodes: z.array(FlowDiagramNodeSchema).min(2).max(32),
  edges: z.array(FlowDiagramEdgeSchema).min(1).max(96),
});
export type FlowDiagramContent = z.infer<typeof FlowDiagramContentSchema>;

/**
 * Numeric values are deliberately bounded before they reach pgfplots. The
 * renderer owns every visual style and coordinate mapping; callers can only
 * provide finite data values and plain-text labels.
 */
export const ChartNumberSchema = z
  .number()
  .finite()
  .min(-1_000_000_000_000)
  .max(1_000_000_000_000);

export const ChartAxisRangeSchema = z
  .strictObject({
    min: ChartNumberSchema,
    max: ChartNumberSchema,
  })
  .refine((range) => range.min < range.max, {
    message: "Chart axis minimum must be less than its maximum",
  });

export const ChartAxisSchema = z.strictObject({
  label: FigureLabelSchema,
  range: ChartAxisRangeSchema.optional(),
});
export type ChartAxis = z.infer<typeof ChartAxisSchema>;

export const ChartPointSchema = z.strictObject({
  x: ChartNumberSchema,
  y: ChartNumberSchema,
});
export type ChartPoint = z.infer<typeof ChartPointSchema>;

export const ChartSeriesSchema = z.strictObject({
  label: FigureLabelSchema,
  points: z.array(ChartPointSchema).min(1).max(5_000),
});
export type ChartSeries = z.infer<typeof ChartSeriesSchema>;

export const ChartContentSchema = z.strictObject({
  kind: z.literal("chart"),
  chartType: z.enum(["line", "bar"]),
  xAxis: ChartAxisSchema,
  yAxis: ChartAxisSchema,
  series: z.array(ChartSeriesSchema).min(1).max(12),
});
export type ChartContent = z.infer<typeof ChartContentSchema>;

export const FigureContentSchema = z.discriminatedUnion("kind", [
  FlowDiagramContentSchema,
  ChartContentSchema,
]);
export type FigureContent = z.infer<typeof FigureContentSchema>;

export const FigureNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("figure"),
  /** Immutable link to the validated plan item this figure realizes. */
  planItemId: StableIdSchema.optional(),
  assetId: StableIdSchema.optional(),
  assetKind: z.enum(["png", "jpeg", "pdf"]).optional(),
  content: FigureContentSchema.optional(),
  altText: ShortTextSchema,
  caption: InlineContentSchema,
  widthPercent: z.number().int().min(10).max(100).default(80),
});
export type FigureNode = z.infer<typeof FigureNodeSchema>;

export const TableColumnSchema = z.strictObject({
  id: StableIdSchema,
  header: InlineContentSchema,
  alignment: z.enum(["left", "center", "right"]).default("left"),
});
export type TableColumn = z.infer<typeof TableColumnSchema>;

export const TableCellSchema = z.strictObject({
  columnId: StableIdSchema,
  content: InlineContentSchema,
});
export type TableCell = z.infer<typeof TableCellSchema>;

export const TableRowSchema = z.strictObject({
  id: StableIdSchema,
  cells: z.array(TableCellSchema).max(100),
});
export type TableRow = z.infer<typeof TableRowSchema>;

export const TableNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("table"),
  /** Immutable link to the validated plan item this table realizes. */
  planItemId: StableIdSchema.optional(),
  caption: InlineContentSchema.optional(),
  columns: z.array(TableColumnSchema).min(1).max(30),
  rows: z.array(TableRowSchema).max(10_000),
});

export const CalloutNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("callout"),
  tone: z.enum(["note", "info", "warning", "success"]),
  title: InlineContentSchema.optional(),
  content: InlineContentSchema,
});

export const TheoremKindSchema = z.enum([
  "definition",
  "lemma",
  "theorem",
  "corollary",
]);
export type TheoremKind = z.infer<typeof TheoremKindSchema>;

export const TheoremNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("theorem"),
  theoremKind: TheoremKindSchema,
  title: InlineContentSchema.optional(),
  children: z.array(StableIdSchema).max(2_000),
});

export const ProofNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("proof"),
  title: InlineContentSchema.optional(),
  children: z.array(StableIdSchema).max(2_000),
});

export interface AlgorithmStepModel {
  id: StableId;
  content: InlineContent;
  children: AlgorithmStepModel[];
}

export const AlgorithmStepSchema: z.ZodType<AlgorithmStepModel> = z.lazy(() =>
  z.strictObject({
    id: StableIdSchema,
    content: InlineContentSchema,
    children: z.array(AlgorithmStepSchema).max(100).default([]),
  }),
);

export const AlgorithmNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("algorithm"),
  title: InlineContentSchema,
  description: InlineContentSchema.optional(),
  inputs: InlineContentSchema.optional(),
  outputs: InlineContentSchema.optional(),
  steps: z.array(AlgorithmStepSchema).min(1).max(1_000),
});

export const CodeBlockNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("codeBlock"),
  language: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_+.#-]{0,63}$/)
    .optional(),
  caption: InlineContentSchema.optional(),
  code: z.string().min(1).max(1_000_000),
  showLineNumbers: z.boolean(),
});

export const AppendixNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("appendix"),
  title: InlineContentSchema,
  children: z.array(StableIdSchema).max(2_000),
});

export const PageBreakNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("pageBreak"),
});

export const CitationNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("citation"),
  sourceId: StableIdSchema.optional(),
  authors: z.array(ShortTextSchema).min(1).max(100),
  title: ShortTextSchema,
  year: z.string().regex(/^\d{4}[a-z]?$/),
  publication: OptionalShortTextSchema,
  publisher: OptionalShortTextSchema,
  volume: OptionalShortTextSchema,
  issue: OptionalShortTextSchema,
  pages: OptionalShortTextSchema,
  sourceType: z
    .enum([
      "journal_article",
      "proceedings_article",
      "book",
      "book_chapter",
      "report",
      "thesis",
      "web",
      "other",
    ])
    .optional(),
  sourceLanguage: z
    .string()
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
    .optional(),
  doi: OptionalShortTextSchema,
  url: z.string().url().max(2_000).optional(),
});

export const BibliographyNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("bibliography"),
  title: InlineContentSchema.optional(),
  citationIds: z.array(StableIdSchema).min(1).max(10_000),
});

export const FootnoteNodeSchema = z.strictObject({
  id: StableIdSchema,
  type: z.literal("footnote"),
  content: InlineContentSchema,
});

export const DocumentNodeSchema = z.discriminatedUnion("type", [
  SectionNodeSchema,
  ParagraphNodeSchema,
  HeadingNodeSchema,
  ListNodeSchema,
  EquationNodeSchema,
  FigureNodeSchema,
  TableNodeSchema,
  CalloutNodeSchema,
  TheoremNodeSchema,
  ProofNodeSchema,
  AlgorithmNodeSchema,
  CodeBlockNodeSchema,
  AppendixNodeSchema,
  PageBreakNodeSchema,
  CitationNodeSchema,
  BibliographyNodeSchema,
  FootnoteNodeSchema,
]);
export type DocumentNode = z.infer<typeof DocumentNodeSchema>;
export type DocumentNodeType = DocumentNode["type"];

export type RenderableFigureNode = FigureNode & {
  assetId?: never;
  assetKind?: never;
  content: FigureContent;
};

/**
 * Completion/review code counts only structured content whose bytes the
 * renderer can produce itself. External asset IDs remain readable for legacy
 * documents, but cannot be completed until an asset-ingest/compiler contract
 * exists.
 */
export function isRenderableFigureNode(
  node: DocumentNode,
): node is RenderableFigureNode {
  if (node.type !== "figure") return false;
  return Boolean(node.content) && !node.assetId && !node.assetKind;
}

export const DocumentAuthorSchema = z.strictObject({
  id: StableIdSchema,
  name: ShortTextSchema,
  affiliation: OptionalShortTextSchema,
  email: z.string().email().max(320).optional(),
});
export type DocumentAuthor = z.infer<typeof DocumentAuthorSchema>;

/**
 * A deliberately small, renderer-owned layout vocabulary. User and model
 * input can select only these values; document classes, packages, dimensions,
 * and arbitrary TeX are never accepted through document metadata.
 */
export const DocumentLayoutPresetSchema = z.enum([
  "standard",
  "academic",
  "business",
  "compact",
]);
export const DocumentPageSizeSchema = z.enum([
  "A3",
  "A4",
  "A5",
  "B4",
  "B5",
  "letter",
]);
export const DocumentColumnCountSchema = z.union([
  z.literal(1),
  z.literal(2),
]);

export const DocumentCitationStyleNameSchema = z.enum([
  "author-year",
  "apa7",
  "ieee",
  "numeric",
]);
export const DocumentCitationStyleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  style: DocumentCitationStyleNameSchema,
});
export type DocumentCitationStyle = z.infer<
  typeof DocumentCitationStyleSchema
>;

export const DocumentLayoutSchema = z.strictObject({
  preset: DocumentLayoutPresetSchema,
  pageSize: DocumentPageSizeSchema,
  columns: DocumentColumnCountSchema,
});
export type DocumentLayout = z.infer<typeof DocumentLayoutSchema>;

export const DocumentWritingStyleSchema = z.strictObject({
  register: z.enum(["plain", "professional", "academic", "formal"]),
  voice: z.enum(["neutral", "assertive", "analytical", "persuasive"]),
  jargonLevel: z.enum(["low", "moderate", "high"]),
  sentenceStyle: z.enum(["concise", "balanced", "detailed"]),
});
export type DocumentWritingStyle = z.infer<
  typeof DocumentWritingStyleSchema
>;

/** Converts only explicit language names or BCP-47 tags; never guesses. */
export function normalizeDocumentLanguage(value: string): string | null {
  const normalized = value.normalize("NFKC").trim();
  const alias = normalized.toLocaleLowerCase().replaceAll(/\s+/gu, "");
  const aliases: Readonly<Record<string, string>> = Object.freeze({
    ja: "ja",
    japanese: "ja",
    日本語: "ja",
    en: "en",
    english: "en",
    英語: "en",
    zh: "zh",
    chinese: "zh",
    中国語: "zh",
    中文: "zh",
    ko: "ko",
    korean: "ko",
    韓国語: "ko",
    fr: "fr",
    french: "fr",
    フランス語: "fr",
    de: "de",
    german: "de",
    ドイツ語: "de",
    es: "es",
    spanish: "es",
    スペイン語: "es",
    it: "it",
    italian: "it",
    イタリア語: "it",
    pt: "pt",
    portuguese: "pt",
    ポルトガル語: "pt",
    ru: "ru",
    russian: "ru",
    ロシア語: "ru",
  });
  const known = aliases[alias];
  if (known) return known;
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(normalized)) return null;
  const [language, ...subtags] = normalized.split("-");
  return [
    language?.toLowerCase(),
    ...subtags.map((subtag) =>
      /^[A-Za-z]{2}$/u.test(subtag) ? subtag.toUpperCase() : subtag,
    ),
  ].join("-");
}

export const DocumentMetadataSchema = z.strictObject({
  title: ShortTextSchema,
  subtitle: OptionalShortTextSchema,
  language: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  documentType: z.enum([
    "article",
    "proposal",
    "report",
    "paper",
    "letter",
    "notes",
  ]),
  authors: z.array(DocumentAuthorSchema).max(100),
  keywords: z.array(ShortTextSchema).max(100).default([]),
  layout: DocumentLayoutSchema.optional(),
  citationStyle: DocumentCitationStyleSchema.optional(),
  writingStyle: DocumentWritingStyleSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;

export const DocumentSchema = z
  .strictObject({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    id: StableIdSchema,
    metadata: DocumentMetadataSchema,
    root: z.array(StableIdSchema).max(10_000),
    nodes: z.array(DocumentNodeSchema).max(20_000),
  })
  .superRefine((document, context) => {
    if (document.schemaVersion === 1 && requiresDocumentSchemaV2(document)) {
      context.addIssue({
        code: "custom",
        path: ["schemaVersion"],
        message: "Extended document features require schemaVersion 2",
      });
    }
  });
export type DocumentModel = z.infer<typeof DocumentSchema>;

const V2_NODE_TYPES = new Set([
  "theorem",
  "proof",
  "algorithm",
  "codeBlock",
  "appendix",
]);
const V2_MATH_KINDS = new Set([
  "integral",
  "largeOperator",
  "limit",
  "script",
  "root",
  "partialDerivative",
  "vector",
  "matrix",
  "cases",
  "aligned",
  "accent",
  "derivative",
  "set",
  "setBuilder",
  "quantified",
  "binomial",
  "statisticalOperator",
]);

export function requiresDocumentSchemaV2(
  document: Pick<DocumentModel, "metadata" | "nodes">,
): boolean {
  if (
    document.metadata.layout ||
    document.metadata.citationStyle ||
    document.metadata.writingStyle
  ) return true;
  const stack: unknown[] = [...document.nodes];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (
      (typeof record.type === "string" && V2_NODE_TYPES.has(record.type)) ||
      (record.type === "figure" && record.content !== undefined) ||
      ((record.type === "equation" ||
        record.type === "figure" ||
        record.type === "table") &&
        record.planItemId !== undefined) ||
      record.type === "crossRef" ||
      (typeof record.kind === "string" && V2_MATH_KINDS.has(record.kind))
    ) {
      return true;
    }
    stack.push(...Object.values(record));
  }
  return false;
}

export const DocumentPositionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("root"),
    index: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("section"),
    parentId: StableIdSchema,
    index: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("container"),
    parentId: StableIdSchema,
    index: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("definitions"),
  }),
]);
export type DocumentPosition = z.infer<typeof DocumentPositionSchema>;

export const InsertDocumentOperationSchema = z.strictObject({
  op: z.literal("insert"),
  node: DocumentNodeSchema,
  position: DocumentPositionSchema,
});

export const UpdateDocumentOperationSchema = z.strictObject({
  op: z.literal("update"),
  nodeId: StableIdSchema,
  node: DocumentNodeSchema,
});

export const MoveDocumentOperationSchema = z.strictObject({
  op: z.literal("move"),
  nodeId: StableIdSchema,
  position: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("root"),
      index: z.number().int().nonnegative(),
    }),
    z.strictObject({
      kind: z.literal("section"),
      parentId: StableIdSchema,
      index: z.number().int().nonnegative(),
    }),
    z.strictObject({
      kind: z.literal("container"),
      parentId: StableIdSchema,
      index: z.number().int().nonnegative(),
    }),
  ]),
});

export const DeleteDocumentOperationSchema = z.strictObject({
  op: z.literal("delete"),
  nodeId: StableIdSchema,
});

export const SetMetadataDocumentOperationSchema = z.strictObject({
  op: z.literal("setMetadata"),
  metadata: DocumentMetadataSchema,
});

export const DocumentOperationSchema = z.discriminatedUnion("op", [
  InsertDocumentOperationSchema,
  UpdateDocumentOperationSchema,
  MoveDocumentOperationSchema,
  DeleteDocumentOperationSchema,
  SetMetadataDocumentOperationSchema,
]);
export type DocumentOperation = z.infer<typeof DocumentOperationSchema>;

export const DocumentPatchSchema = z
  .strictObject({
    id: StableIdSchema,
    documentId: StableIdSchema,
    baseRevision: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    operations: z.array(DocumentOperationSchema).min(1).max(1_000),
  })
  .superRefine((patch, context) => {
    patch.operations.forEach((operation, index) => {
      if (
        (operation.op === "insert" || operation.op === "update") &&
        operation.node.type === "figure" &&
        !isRenderableFigureNode(operation.node)
      ) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "node"],
          message:
            "A new or updated figure requires structured figure content",
        });
      }
    });
  });
export type DocumentPatch = z.infer<typeof DocumentPatchSchema>;

export const DocumentRevisionSchema = z.strictObject({
  revisionId: StableIdSchema,
  revision: z.number().int().nonnegative(),
  parentRevisionId: StableIdSchema.nullable(),
  committedAt: TimestampSchema,
  document: DocumentSchema,
});
export type DocumentRevision = z.infer<typeof DocumentRevisionSchema>;

export const STRUCTURAL_NODE_TYPES = [
  "section",
  "paragraph",
  "heading",
  "list",
  "equation",
  "figure",
  "table",
  "callout",
  "theorem",
  "proof",
  "algorithm",
  "codeBlock",
  "appendix",
  "pageBreak",
  "bibliography",
] as const satisfies readonly DocumentNodeType[];

export type StructuralNode = Extract<
  DocumentNode,
  { type: (typeof STRUCTURAL_NODE_TYPES)[number] }
>;

export type DefinitionNode = Extract<DocumentNode, { type: "citation" | "footnote" }>;

export const CONTAINER_NODE_TYPES = [
  "section",
  "theorem",
  "proof",
  "appendix",
] as const satisfies readonly DocumentNodeType[];
export type ContainerNode = Extract<
  DocumentNode,
  { type: (typeof CONTAINER_NODE_TYPES)[number] }
>;

export function isStructuralNode(node: DocumentNode): node is StructuralNode {
  return (STRUCTURAL_NODE_TYPES as readonly string[]).includes(node.type);
}

export function isDefinitionNode(node: DocumentNode): node is DefinitionNode {
  return node.type === "citation" || node.type === "footnote";
}

export function isContainerNode(node: DocumentNode): node is ContainerNode {
  return (CONTAINER_NODE_TYPES as readonly string[]).includes(node.type);
}

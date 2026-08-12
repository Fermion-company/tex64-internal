import {
  type AlgorithmStepModel,
  type ChartContent,
  type CrossReferenceTarget,
  type DocumentCitationStyle,
  type DocumentLayout,
  type DocumentModel,
  type DocumentNode,
  type FigureContent,
  type FlowDiagramContent,
  type InlineContent,
  type InlineMark,
  type ListItemModel,
  type MathExpression,
  type StableId,
} from "./schema";
import { validateDocument } from "./validate";

type CitationNode = Extract<DocumentNode, { type: "citation" }>;
type MathBinaryOperator = Extract<MathExpression, { kind: "binary" }>["operator"];

const TEXT_ESCAPE: Readonly<Record<string, string>> = Object.freeze({
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "$": "\\$",
  "&": "\\&",
  "#": "\\#",
  "%": "\\%",
  "_": "\\_",
  "^": "\\textasciicircum{}",
  "~": "\\textasciitilde{}",
});

/** Escapes arbitrary plain text for a LaTeX text context. */
export function escapeLatexText(value: string): string {
  let output = "";
  for (const character of value.replace(/\r\n?/g, "\n")) {
    if (character === "\n" || character === "\t") {
      output += " ";
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) continue;
    output += TEXT_ESCAPE[character] ?? character;
  }
  return output;
}

const MARK_ORDER: readonly InlineMark[] = [
  "code",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "superscript",
  "subscript",
];

const MARK_COMMAND: Readonly<Record<InlineMark, string>> = Object.freeze({
  bold: "textbf",
  italic: "emph",
  underline: "underline",
  strikethrough: "sout",
  code: "texttt",
  superscript: "textsuperscript",
  subscript: "textsubscript",
});

function renderMarkedText(text: string, marks: readonly InlineMark[]): string {
  const markSet = new Set(marks);
  let rendered = escapeLatexText(text);
  for (const mark of MARK_ORDER) {
    if (markSet.has(mark)) rendered = `\\${MARK_COMMAND[mark]}{${rendered}}`;
  }
  return rendered;
}

function citationKey(id: StableId): string {
  return `cite${id.replaceAll("-", "")}`;
}

const REFERENCE_PREFIX: Readonly<Record<CrossReferenceTarget, string>> =
  Object.freeze({
    section: "sec",
    equation: "eq",
    theorem: "thm",
    figure: "fig",
    table: "tab",
  });

function referenceKey(targetType: CrossReferenceTarget, id: StableId): string {
  return `${REFERENCE_PREFIX[targetType]}${id.replaceAll("-", "")}`;
}

interface RenderContext {
  nodeById: ReadonlyMap<StableId, DocumentNode>;
  referencedTargetIds: ReadonlySet<StableId>;
  citationStyle: DocumentCitationStyle["style"] | undefined;
  citationYearById: ReadonlyMap<StableId, string>;
  citationNumberById: ReadonlyMap<StableId, number>;
  appendixStarted: boolean;
  layout: DocumentLayout | undefined;
}

const LONG_TABLE_ROW_THRESHOLD = 18;

function tableColumnAlignment(
  alignment: "left" | "center" | "right",
): string {
  return {
    left: ">{\\raggedright\\arraybackslash}X",
    center: ">{\\centering\\arraybackslash}X",
    right: ">{\\raggedleft\\arraybackslash}X",
  }[alignment];
}

function longTableColumnAlignment(
  alignment: "left" | "center" | "right",
  widthFraction: string,
): string {
  const directive = {
    left: "\\raggedright",
    center: "\\centering",
    right: "\\raggedleft",
  }[alignment];
  return `>{${directive}\\arraybackslash}p{${widthFraction}\\textwidth}`;
}

function renderTableNode(
  node: Extract<DocumentNode, { type: "table" }>,
  context: RenderContext,
): string {
  // Preserve the established byte output for legacy documents. Confirmed
  // production briefs always apply a renderer-owned layout before writing.
  if (!context.layout) {
    const alignment = node.columns
      .map((column) => ({ left: "l", center: "c", right: "r" })[column.alignment])
      .join("");
    const lines = ["\\begin{table}[htbp]", "\\centering", `\\begin{tabular}{${alignment}}`, "\\toprule"];
    lines.push(`${node.columns.map((column) => renderInline(column.header, context)).join(" & ")} \\\\`);
    lines.push("\\midrule");
    for (const row of node.rows) {
      const cellByColumn = new Map(row.cells.map((cell) => [cell.columnId, cell]));
      lines.push(
        `${node.columns
          .map((column) => renderInline(cellByColumn.get(column.id)?.content ?? [], context))
          .join(" & ")} \\\\`,
      );
    }
    lines.push("\\bottomrule", "\\end{tabular}");
    if (node.caption) lines.push(`\\caption{${renderInline(node.caption, context)}}`);
    const label = renderReferenceLabel(node, context);
    if (label) lines.push(label);
    lines.push("\\end{table}");
    return lines.join("\n");
  }

  const header = node.columns
    .map((column) => `\\textbf{${renderInline(column.header, context)}}`)
    .join(" & ");
  const rows = node.rows.map((row) => {
    const cellByColumn = new Map(row.cells.map((cell) => [cell.columnId, cell]));
    return `${node.columns
      .map((column) => renderInline(cellByColumn.get(column.id)?.content ?? [], context))
      .join(" & ")} \\\\`;
  });
  const label = renderReferenceLabel(node, context);
  const longTable = node.rows.length > LONG_TABLE_ROW_THRESHOLD;

  if (longTable) {
    const widthFraction = Math.max(0.04, 0.88 / node.columns.length).toFixed(4);
    const alignment = node.columns
      .map((column) => longTableColumnAlignment(column.alignment, widthFraction))
      .join("");
    const lines = [
      ...(context.layout.columns === 2 ? ["\\onecolumn"] : []),
      "\\begingroup",
      "\\small",
      "\\setlength{\\tabcolsep}{3pt}",
      `\\begin{longtable}{${alignment}}`,
    ];
    if (node.caption) {
      lines.push(
        `\\caption{${renderInline(node.caption, context)}}${label ?? ""} \\\\`,
      );
    }
    lines.push(
      "\\toprule",
      `${header} \\\\`,
      "\\midrule",
      "\\endfirsthead",
      "\\toprule",
      `${header} \\\\`,
      "\\midrule",
      "\\endhead",
      "\\midrule",
      `\\multicolumn{${node.columns.length}}{r}{\\small Continued on next page} \\\\`,
      "\\endfoot",
      "\\bottomrule",
      "\\endlastfoot",
      ...rows,
      "\\end{longtable}",
      "\\endgroup",
      ...(context.layout.columns === 2 ? ["\\twocolumn"] : []),
    );
    return lines.join("\n");
  }

  const environment = context.layout.columns === 2 ? "table*" : "table";
  const width = context.layout.columns === 2 ? "\\textwidth" : "\\linewidth";
  const alignment = node.columns
    .map((column) => tableColumnAlignment(column.alignment))
    .join("");
  const lines = [
    `\\begin{${environment}}[htbp]`,
    "\\centering",
    "\\small",
    "\\setlength{\\tabcolsep}{3pt}",
    `\\begin{tabularx}{${width}}{${alignment}}`,
    "\\toprule",
    `${header} \\\\`,
    "\\midrule",
    ...rows,
    "\\bottomrule",
    "\\end{tabularx}",
  ];
  if (node.caption) lines.push(`\\caption{${renderInline(node.caption, context)}}`);
  if (label) lines.push(label);
  lines.push(`\\end{${environment}}`);
  return lines.join("\n");
}

function renderInline(content: InlineContent, context: RenderContext): string {
  return content
    .map((inline) => {
      switch (inline.type) {
        case "text":
          return renderMarkedText(inline.text, inline.marks);
        case "hardBreak":
          return "\\\\ ";
        case "citationRef": {
          if (context.citationStyle) {
            return renderCitationReference(
              inline.citationId,
              inline.locator,
              context,
            );
          }
          const locator = inline.locator ? `[${escapeLatexText(inline.locator)}]` : "";
          return `\\cite${locator}{${citationKey(inline.citationId)}}`;
        }
        case "footnoteRef": {
          const footnote = context.nodeById.get(inline.footnoteId);
          if (footnote?.type !== "footnote") return "";
          return `\\footnote{${renderInline(footnote.content, context)}}`;
        }
        case "crossRef": {
          const key = referenceKey(inline.targetType, inline.targetId);
          if (inline.format === "page") return `\\pageref{${key}}`;
          return inline.targetType === "equation"
            ? `\\eqref{${key}}`
            : `\\ref{${key}}`;
        }
        case "inlineMath":
          return `\\(${renderMath(inline.expression)}\\)`;
      }
    })
    .join("");
}

const GREEK_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  alpha: "alpha",
  beta: "beta",
  gamma: "gamma",
  delta: "delta",
  epsilon: "epsilon",
  varepsilon: "varepsilon",
  zeta: "zeta",
  eta: "eta",
  theta: "theta",
  vartheta: "vartheta",
  iota: "iota",
  kappa: "kappa",
  lambda: "lambda",
  mu: "mu",
  nu: "nu",
  xi: "xi",
  omicron: "mathrm{o}",
  pi: "pi",
  varpi: "varpi",
  rho: "rho",
  varrho: "varrho",
  sigma: "sigma",
  tau: "tau",
  upsilon: "upsilon",
  phi: "phi",
  varphi: "varphi",
  chi: "chi",
  psi: "psi",
  omega: "omega",
  Gamma: "Gamma",
  Delta: "Delta",
  Theta: "Theta",
  Lambda: "Lambda",
  Pi: "Pi",
  Sigma: "Sigma",
  Phi: "Phi",
  Psi: "Psi",
  Omega: "Omega",
});

const NAMED_MATH_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  infinity: "\\infty",
  emptySet: "\\varnothing",
  realNumbers: "\\mathbb{R}",
  integers: "\\mathbb{Z}",
  naturalNumbers: "\\mathbb{N}",
  rationals: "\\mathbb{Q}",
  complexNumbers: "\\mathbb{C}",
});

const BINARY_OPERATOR: Readonly<Record<MathBinaryOperator, string>> = Object.freeze({
    add: "+",
    subtract: "-",
    multiply: "\\cdot",
    divide: "/",
    power: "^",
    equals: "=",
    approximatelyEquals: "\\approx",
    lessThan: "<",
    lessThanOrEqual: "\\leq",
    greaterThan: ">",
    greaterThanOrEqual: "\\geq",
    notEquals: "\\neq",
    in: "\\in",
    notIn: "\\notin",
    subset: "\\subset",
    subsetOrEqual: "\\subseteq",
    superset: "\\supset",
    supersetOrEqual: "\\supseteq",
    union: "\\cup",
    intersection: "\\cap",
    setDifference: "\\setminus",
    and: "\\land",
    or: "\\lor",
    implies: "\\implies",
    ifAndOnlyIf: "\\iff",
    proportionalTo: "\\propto",
});

const STANDARD_FUNCTIONS = new Set([
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
  "arg",
]);

const FUNCTION_OPERATOR_NAME: Readonly<Record<string, string>> = Object.freeze({
  lcm: "lcm",
  realPart: "Re",
  imaginaryPart: "Im",
});

function renderMath(expression: MathExpression): string {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "symbol": {
      const named = NAMED_MATH_SYMBOLS[expression.name];
      if (named) return named;
      const greek = GREEK_SYMBOLS[expression.name];
      if (greek) {
        return greek.startsWith("mathrm") ? `\\${greek}` : `\\${greek}`;
      }
      if (expression.name.length === 1) return expression.name;
      return `\\mathit{${expression.name}}`;
    }
    case "text":
      return `\\text{${escapeLatexText(expression.value)}}`;
    case "unary": {
      const operand = renderMath(expression.operand);
      if (expression.operator === "negate") return `-\\left(${operand}\\right)`;
      if (expression.operator === "sqrt") return `\\sqrt{${operand}}`;
      if (expression.operator === "absolute") return `\\left|${operand}\\right|`;
      if (expression.operator === "norm") return `\\left\\lVert ${operand} \\right\\rVert`;
      if (expression.operator === "floor") return `\\left\\lfloor ${operand} \\right\\rfloor`;
      if (expression.operator === "ceiling") return `\\left\\lceil ${operand} \\right\\rceil`;
      return `\\lnot\\left(${operand}\\right)`;
    }
    case "binary": {
      const left = renderMath(expression.left);
      const right = renderMath(expression.right);
      if (expression.operator === "divide") return `\\frac{${left}}{${right}}`;
      if (expression.operator === "power") return `{${left}}^{${right}}`;
      return `\\left(${left} ${BINARY_OPERATOR[expression.operator]} ${right}\\right)`;
    }
    case "function": {
      const args = expression.arguments.map(renderMath).join(", ");
      const command = STANDARD_FUNCTIONS.has(expression.name)
        ? `\\${expression.name}`
        : `\\operatorname{${FUNCTION_OPERATOR_NAME[expression.name] ?? expression.name}}`;
      return `${command}\\left(${args}\\right)`;
    }
    case "sequence":
      return expression.items.map(renderMath).join("\\, ");
    case "script": {
      const subscript = expression.subscript
        ? `_{${renderMath(expression.subscript)}}`
        : "";
      const superscript = expression.superscript
        ? `^{${renderMath(expression.superscript)}}`
        : "";
      return `{${renderMath(expression.base)}}${subscript}${superscript}`;
    }
    case "root": {
      const index = expression.index ? `[${renderMath(expression.index)}]` : "";
      return `\\sqrt${index}{${renderMath(expression.radicand)}}`;
    }
    case "integral": {
      const bounds =
        expression.lowerBound && expression.upperBound
          ? `_{${renderMath(expression.lowerBound)}}^{${renderMath(expression.upperBound)}}`
          : "";
      return `\\int${bounds} ${renderMath(expression.integrand)}\\, d${renderMath(expression.variable)}`;
    }
    case "largeOperator": {
      const command = expression.operator === "sum" ? "sum" : "prod";
      const bounds =
        expression.index && expression.lowerBound && expression.upperBound
          ? `_{${renderMath(expression.index)} = ${renderMath(expression.lowerBound)}}^{${renderMath(expression.upperBound)}}`
          : "";
      return `\\${command}${bounds} ${renderMath(expression.expression)}`;
    }
    case "limit": {
      const direction =
        expression.direction === "left"
          ? "^{-}"
          : expression.direction === "right"
            ? "^{+}"
            : "";
      return `\\lim_{${renderMath(expression.variable)} \\to ${renderMath(expression.approaches)}${direction}} ${renderMath(expression.expression)}`;
    }
    case "partialDerivative": {
      const totalOrder = expression.variables.reduce(
        (sum, variable) => sum + variable.order,
        0,
      );
      const numeratorOrder = totalOrder === 1 ? "" : `^{${totalOrder}}`;
      const denominator = expression.variables
        .map(({ variable, order }) => {
          const exponent = order === 1 ? "" : `^{${order}}`;
          return `\\partial ${renderMath(variable)}${exponent}`;
        })
        .join(" ");
      return `\\frac{\\partial${numeratorOrder} ${renderMath(expression.expression)}}{${denominator}}`;
    }
    case "vector": {
      const environment = expression.delimiter === "parentheses" ? "pmatrix" : "bmatrix";
      const separator = expression.orientation === "row" ? " & " : " \\\\ ";
      return `\\begin{${environment}}${expression.entries.map(renderMath).join(separator)}\\end{${environment}}`;
    }
    case "matrix": {
      const environment = {
        parentheses: "pmatrix",
        brackets: "bmatrix",
        bars: "vmatrix",
        doubleBars: "Vmatrix",
        none: "matrix",
      }[expression.delimiter];
      const rows = expression.rows
        .map((row) => row.map(renderMath).join(" & "))
        .join(" \\\\ ");
      return `\\begin{${environment}}${rows}\\end{${environment}}`;
    }
    case "cases": {
      const rows = expression.cases
        .map(
          (branch) =>
            `${renderMath(branch.expression)} & ${renderMath(branch.condition)}`,
        )
        .join(" \\\\ ");
      return `\\begin{cases}${rows}\\end{cases}`;
    }
    case "aligned": {
      const lines = expression.lines
        .map((line) => {
          const annotation = line.annotation
            ? ` && \\text{${escapeLatexText(line.annotation)}}`
            : "";
          return `${renderMath(line.left)} &${BINARY_OPERATOR[line.relation]} ${renderMath(line.right)}${annotation}`;
        })
        .join(" \\\\ ");
      return `\\begin{aligned}${lines}\\end{aligned}`;
    }
    case "accent": {
      const command = {
        hat: "hat",
        bar: "overline",
        tilde: "widetilde",
        dot: "dot",
        doubleDot: "ddot",
        vector: "vec",
      }[expression.accent];
      return `\\${command}{${renderMath(expression.expression)}}`;
    }
    case "derivative": {
      const order = expression.order === 1 ? "" : `^{${expression.order}}`;
      return `\\frac{d${order} ${renderMath(expression.expression)}}{d${renderMath(expression.variable)}${order}}`;
    }
    case "set":
      return expression.elements.length === 0
        ? "\\varnothing"
        : `\\left\\{${expression.elements.map(renderMath).join(", ")}\\right\\}`;
    case "setBuilder":
      return `\\left\\{${renderMath(expression.variable)} \\middle| ${renderMath(expression.condition)}\\right\\}`;
    case "quantified": {
      const quantifier = {
        forAll: "forall",
        exists: "exists",
        existsUnique: "exists!",
      }[expression.quantifier];
      const domain = expression.domain
        ? ` \\in ${renderMath(expression.domain)}`
        : "";
      return `\\${quantifier}\\, ${renderMath(expression.variable)}${domain}:\\, ${renderMath(expression.predicate)}`;
    }
    case "binomial":
      return `\\binom{${renderMath(expression.upper)}}{${renderMath(expression.lower)}}`;
    case "statisticalOperator": {
      const operator = {
        probability: "\\mathbb{P}",
        expectation: "\\mathbb{E}",
        variance: "\\operatorname{Var}",
        covariance: "\\operatorname{Cov}",
      }[expression.operator];
      const subscript = expression.subscript
        ? `_{${renderMath(expression.subscript)}}`
        : "";
      const condition = expression.condition
        ? ` \\mid ${renderMath(expression.condition)}`
        : "";
      return `${operator}${subscript}\\left[${renderMath(expression.expression)}${condition}\\right]`;
    }
  }
}

function renderListItems(
  items: readonly ListItemModel[],
  style: "bullet" | "ordered",
  context: RenderContext,
): string {
  const environment = style === "bullet" ? "itemize" : "enumerate";
  const lines = [`\\begin{${environment}}`];
  for (const item of items) {
    lines.push(`\\item ${renderInline(item.content, context)}`);
    if (item.children.length > 0) lines.push(renderListItems(item.children, style, context));
  }
  lines.push(`\\end{${environment}}`);
  return lines.join("\n");
}

function renderAlgorithmSteps(
  steps: readonly AlgorithmStepModel[],
  context: RenderContext,
): string {
  const lines = ["\\begin{enumerate}"];
  for (const step of steps) {
    lines.push(`\\item ${renderInline(step.content, context)}`);
    if (step.children.length > 0) {
      lines.push(renderAlgorithmSteps(step.children, context));
    }
  }
  lines.push("\\end{enumerate}");
  return lines.join("\n");
}

function renderCodeLine(line: string): string {
  if (line.length === 0) return "\\mbox{}";
  return Array.from(line)
    .map((character, index) => {
      const softBreak = index > 0 && index % 32 === 0 ? "\\allowbreak{}" : "";
      if (character === " ") return `${softBreak}\\hspace*{0.6em}`;
      if (character === "\t") return `${softBreak}\\hspace*{2.4em}`;
      return `${softBreak}${escapeLatexText(character)}`;
    })
    .join("");
}

const FLOW_SHAPE_STYLE: Readonly<
  Record<FlowDiagramContent["nodes"][number]["shape"], string>
> = Object.freeze({
  process: "flowprocess",
  decision: "flowdecision",
  terminator: "flowterminator",
  data: "flowdata",
});

const CHART_COLORS = [
  "blue",
  "red",
  "green!60!black",
  "orange",
  "violet",
  "cyan!70!black",
  "magenta",
  "black",
] as const;

const CHART_MARKS = [
  "*",
  "square*",
  "triangle*",
  "diamond*",
  "pentagon*",
  "x",
  "+",
  "asterisk",
] as const;

function renderChartNumber(value: number): string {
  return String(Object.is(value, -0) ? 0 : value);
}

function escapeLatexFigureText(value: string): string {
  const characters = Array.from(value);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += 12) {
    chunks.push(escapeLatexText(characters.slice(index, index + 12).join("")));
  }
  return chunks.join("\\allowbreak{}");
}

function renderFlowDiagram(
  diagram: FlowDiagramContent,
  width: string,
): string {
  const primarySpan = 6;
  const nodeNameById = new Map(
    diagram.nodes.map((node, index) => [node.id, `flow${index}`]),
  );
  const lines = [
    `\\resizebox{${width}\\linewidth}{!}{%`,
    "\\begin{tikzpicture}[",
    "node distance=10mm and 13mm,",
    "every node/.style={font=\\small,align=center},",
    "flowprocess/.style={draw,rectangle,rounded corners=1pt,minimum height=9mm,text width=27mm},",
    "flowdecision/.style={draw,diamond,aspect=2.1,inner sep=1.5pt,text width=22mm},",
    "flowterminator/.style={draw,ellipse,minimum height=9mm,text width=24mm},",
    "flowdata/.style={draw,trapezium,trapezium left angle=70,trapezium right angle=110,minimum height=9mm,text width=25mm},",
    "flowarrow/.style={-{Stealth[length=2.2mm]},semithick}",
    "]",
  ];

  diagram.nodes.forEach((node, index) => {
    let placement = "";
    if (index > 0) {
      if (diagram.direction === "left-to-right") {
        placement =
          index % primarySpan === 0
            ? `,below=of flow${index - primarySpan}`
            : `,right=of flow${index - 1}`;
      } else {
        placement =
          index % primarySpan === 0
            ? `,right=of flow${index - primarySpan}`
            : `,below=of flow${index - 1}`;
      }
    }
    lines.push(
      `\\node[${FLOW_SHAPE_STYLE[node.shape]}${placement}] (flow${index}) {${escapeLatexFigureText(node.label)}};`,
    );
  });

  const labelPosition =
    diagram.direction === "left-to-right" ? "above" : "right";
  for (const edge of diagram.edges) {
    const from = nodeNameById.get(edge.from);
    const to = nodeNameById.get(edge.to);
    if (!from || !to) continue;
    const edgeLabel = edge.label
      ? ` node[midway,${labelPosition},fill=white,inner sep=1pt,font=\\scriptsize]{${escapeLatexFigureText(edge.label)}}`
      : "";
    lines.push(`\\draw[flowarrow] (${from}) --${edgeLabel} (${to});`);
  }
  lines.push("\\end{tikzpicture}%", "}");
  return lines.join("\n");
}

function renderChart(chart: ChartContent, width: string): string {
  const options = [
    `width=${width}\\linewidth`,
    "height=0.58\\linewidth",
    "axis lines=left",
    "grid=major",
    "tick align=outside",
    `xlabel={${escapeLatexFigureText(chart.xAxis.label)}}`,
    `ylabel={${escapeLatexFigureText(chart.yAxis.label)}}`,
    "legend style={draw=none,font=\\small,at={(0.02,0.98)},anchor=north west}",
    "legend cell align={left}",
  ];
  if (chart.chartType === "bar") {
    options.push("ybar", "bar width=8pt", "enlarge x limits=0.1");
  }
  if (chart.xAxis.range) {
    options.push(
      `xmin=${renderChartNumber(chart.xAxis.range.min)}`,
      `xmax=${renderChartNumber(chart.xAxis.range.max)}`,
    );
  }
  if (chart.yAxis.range) {
    options.push(
      `ymin=${renderChartNumber(chart.yAxis.range.min)}`,
      `ymax=${renderChartNumber(chart.yAxis.range.max)}`,
    );
  }

  const lines = ["\\begin{tikzpicture}", "\\begin{axis}[", options.join(",\n"), "]"];
  chart.series.forEach((series, index) => {
    const color = CHART_COLORS[index % CHART_COLORS.length] ?? "black";
    const style =
      chart.chartType === "line"
        ? `color=${color},very thick,mark=${CHART_MARKS[index % CHART_MARKS.length] ?? "*"}`
        : `draw=${color},fill=${color}!35`;
    lines.push(`\\addplot+[${style}] coordinates {`);
    for (const point of [...series.points].sort(
      (left, right) => left.x - right.x || left.y - right.y,
    )) {
      lines.push(
        `(${renderChartNumber(point.x)},${renderChartNumber(point.y)})`,
      );
    }
    lines.push("};", `\\addlegendentry{${escapeLatexFigureText(series.label)}}`);
  });
  lines.push("\\end{axis}", "\\end{tikzpicture}");
  return lines.join("\n");
}

function renderStructuredFigure(
  content: FigureContent,
  width: string,
): string {
  return content.kind === "flowDiagram"
    ? renderFlowDiagram(content, width)
    : renderChart(content, width);
}

function renderReferenceLabel(
  node: DocumentNode,
  context: RenderContext,
): string | null {
  if (!context.referencedTargetIds.has(node.id)) return null;
  const targetType: CrossReferenceTarget | null =
    node.type === "section"
      ? "section"
      : node.type === "equation"
        ? "equation"
        : node.type === "theorem"
          ? "theorem"
          : node.type === "figure"
            ? "figure"
            : node.type === "table"
              ? "table"
              : null;
  return targetType ? `\\label{${referenceKey(targetType, node.id)}}` : null;
}

function renderChildren(
  childIds: readonly StableId[],
  context: RenderContext,
  sectionDepth: number,
): string[] {
  const rendered: string[] = [];
  for (const childId of childIds) {
    const child = context.nodeById.get(childId);
    if (child) rendered.push(renderNode(child, context, sectionDepth));
  }
  return rendered;
}

const SECTION_COMMANDS = ["section", "subsection", "subsubsection", "paragraph", "subparagraph"];
const HEADING_COMMANDS = [
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
  "subparagraph",
] as const;

function renderLegacyCitation(citation: CitationNode): string {
  const parts = [
    escapeLatexText(citation.authors.join(", ")),
    `\\emph{${escapeLatexText(citation.title)}}`,
    escapeLatexText(citation.publication ?? ""),
    escapeLatexText(citation.year),
    citation.doi ? `DOI: ${escapeLatexText(citation.doi)}` : "",
    citation.url ? escapeLatexText(citation.url) : "",
  ].filter(Boolean);
  return parts.join(". ");
}

function containsJapanese(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
}

function westernNameParts(name: string): { family: string; given: string[] } {
  const normalized = name.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const comma = normalized.indexOf(",");
  if (comma >= 0) {
    return {
      family: normalized.slice(0, comma).trim(),
      given: normalized.slice(comma + 1).trim().split(" ").filter(Boolean),
    };
  }
  const parts = normalized.split(" ").filter(Boolean);
  return {
    family: parts.at(-1) ?? normalized,
    given: parts.slice(0, -1),
  };
}

function familyName(name: string): string {
  return containsJapanese(name) ? name.trim() : westernNameParts(name).family;
}

function initials(words: readonly string[]): string {
  return words
    .flatMap((word) => {
      const first = Array.from(word.replace(/[^\p{L}\p{N}]/gu, ""))[0];
      return first ? [`${first.toLocaleUpperCase("en-US")}.`] : [];
    })
    .join(" ");
}

function apaAuthorName(name: string): string {
  if (containsJapanese(name)) return escapeLatexText(name.trim());
  const parts = westernNameParts(name);
  const given = initials(parts.given);
  return escapeLatexText(given ? `${parts.family}, ${given}` : parts.family);
}

function ieeeAuthorName(name: string): string {
  if (containsJapanese(name)) return escapeLatexText(name.trim());
  const parts = westernNameParts(name);
  const given = initials(parts.given);
  return escapeLatexText(given ? `${given} ${parts.family}` : parts.family);
}

function joinAuthors(
  authors: readonly string[],
  style: "apa7" | "ieee" | "plain",
  japanese: boolean,
): string {
  const formatted = authors.map((author) =>
    style === "apa7"
      ? apaAuthorName(author)
      : style === "ieee"
        ? ieeeAuthorName(author)
        : escapeLatexText(author),
  );
  if (japanese) return formatted.join("・");
  if (formatted.length <= 1) return formatted[0] ?? "";
  if (formatted.length === 2) {
    return `${formatted[0]}${style === "ieee" ? " and " : " \\& "}${formatted[1]}`;
  }
  const final = formatted.at(-1) ?? "";
  return `${formatted.slice(0, -1).join(", ")}${style === "ieee" ? ", and " : ", \\& "}${final}`;
}

function inlineAuthors(citation: CitationNode): string {
  const names = citation.authors.map(familyName);
  const japanese =
    citation.sourceLanguage?.toLowerCase().startsWith("ja") === true ||
    citation.authors.some(containsJapanese);
  if (names.length >= 3) {
    return japanese
      ? `${escapeLatexText(names[0] ?? "")}ほか`
      : `${escapeLatexText(names[0] ?? "")} et al.`;
  }
  return joinAuthors(names, "plain", japanese);
}

function renderCitationReference(
  citationId: StableId,
  locator: string | undefined,
  context: RenderContext,
): string {
  const style = context.citationStyle;
  const locatorOption = locator ? `[${escapeLatexText(locator)}]` : "";
  if (style === "numeric" || style === "ieee") {
    return `\\cite${locatorOption}{${citationKey(citationId)}}`;
  }
  const citation = context.nodeById.get(citationId);
  if (citation?.type !== "citation") return "";
  const year = context.citationYearById.get(citation.id) ?? citation.year;
  const located = locator ? `, ${escapeLatexText(locator)}` : "";
  return `(${inlineAuthors(citation)}, ${escapeLatexText(year)}${located})`;
}

function bibliographicDetails(citation: CitationNode): string[] {
  const volumeIssue = citation.volume
    ? `${escapeLatexText(citation.volume)}${citation.issue ? `(${escapeLatexText(citation.issue)})` : ""}`
    : citation.issue
      ? `(${escapeLatexText(citation.issue)})`
      : "";
  return [
    volumeIssue,
    citation.pages ? escapeLatexText(citation.pages) : "",
  ].filter(Boolean);
}

function citationLocator(citation: CitationNode): string {
  if (citation.doi) {
    return renderUrl(`https://doi.org/${citation.doi}`);
  }
  return citation.url ? renderUrl(citation.url) : "";
}

function renderUrl(value: string): string {
  const safe = value
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replaceAll("\\", "%5C")
    .replaceAll("{", "%7B")
    .replaceAll("}", "%7D");
  return `\\url{${safe}}`;
}

function renderAuthorYearCitation(
  citation: CitationNode,
  year: string,
  japanese: boolean,
): string {
  const details = bibliographicDetails(citation);
  return [
    `${joinAuthors(citation.authors, "plain", japanese)} (${escapeLatexText(year)})`,
    `\\emph{${escapeLatexText(citation.title)}}`,
    citation.publication ? escapeLatexText(citation.publication) : "",
    details.join(", "),
    citation.publisher ? escapeLatexText(citation.publisher) : "",
    citationLocator(citation),
  ]
    .filter(Boolean)
    .join(". ");
}

function renderApaCitation(
  citation: CitationNode,
  year: string,
  japanese: boolean,
): string {
  const periodical = citation.publication
    ? `\\emph{${escapeLatexText(citation.publication)}}`
    : "";
  const volume = citation.volume
    ? `\\emph{${escapeLatexText(citation.volume)}}`
    : "";
  const issue = citation.issue ? `(${escapeLatexText(citation.issue)})` : "";
  const publicationDetails = [
    `${periodical}${periodical && (volume || issue) ? ", " : ""}${volume}${issue}`,
    citation.pages ? escapeLatexText(citation.pages) : "",
  ]
    .filter(Boolean)
    .join(", ");
  return [
    `${joinAuthors(citation.authors, "apa7", japanese)} (${escapeLatexText(year)})`,
    escapeLatexText(citation.title),
    publicationDetails,
    citation.publisher ? escapeLatexText(citation.publisher) : "",
    citationLocator(citation),
  ]
    .filter(Boolean)
    .join(". ");
}

function renderIeeeCitation(citation: CitationNode, year: string, japanese: boolean): string {
  const details = [
    citation.volume ? `vol. ${escapeLatexText(citation.volume)}` : "",
    citation.issue ? `no. ${escapeLatexText(citation.issue)}` : "",
    citation.pages ? `pp. ${escapeLatexText(citation.pages)}` : "",
  ].filter(Boolean);
  return [
    joinAuthors(citation.authors, "ieee", japanese),
    `“${escapeLatexText(citation.title)},”`,
    citation.publication ? `\\emph{${escapeLatexText(citation.publication)}}` : "",
    details.join(", "),
    escapeLatexText(year),
    citation.doi ? `doi: ${renderUrl(`https://doi.org/${citation.doi}`)}` : "",
    !citation.doi && citation.url ? renderUrl(citation.url) : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function renderNumericCitation(citation: CitationNode, year: string, japanese: boolean): string {
  return [
    joinAuthors(citation.authors, "plain", japanese),
    escapeLatexText(citation.title),
    citation.publication ? escapeLatexText(citation.publication) : "",
    bibliographicDetails(citation).join(", "),
    escapeLatexText(year),
    citationLocator(citation),
  ]
    .filter(Boolean)
    .join(". ");
}

function renderStyledCitation(citation: CitationNode, context: RenderContext): string {
  const style = context.citationStyle;
  const year = context.citationYearById.get(citation.id) ?? citation.year;
  const japanese =
    citation.sourceLanguage?.toLowerCase().startsWith("ja") === true ||
    citation.authors.some(containsJapanese);
  switch (style) {
    case "author-year":
      return renderAuthorYearCitation(citation, year, japanese);
    case "apa7":
      return renderApaCitation(citation, year, japanese);
    case "ieee":
      return renderIeeeCitation(citation, year, japanese);
    case "numeric":
      return renderNumericCitation(citation, year, japanese);
    case undefined:
      return renderLegacyCitation(citation);
  }
}

function renderNode(node: DocumentNode, context: RenderContext, sectionDepth: number): string {
  switch (node.type) {
    case "section": {
      const command = SECTION_COMMANDS[Math.min(sectionDepth, SECTION_COMMANDS.length - 1)] ?? "subparagraph";
      const lines = [`\\${command}{${renderInline(node.title, context)}}`];
      const label = renderReferenceLabel(node, context);
      if (label) lines.push(label);
      lines.push(...renderChildren(node.children, context, sectionDepth + 1));
      return lines.join("\n\n");
    }
    case "paragraph":
      return renderInline(node.content, context);
    case "heading":
      return `\\${HEADING_COMMANDS[node.level - 1]}*{${renderInline(node.content, context)}}`;
    case "list":
      return renderListItems(node.items, node.style, context);
    case "equation": {
      const environment = node.numbered ? "equation" : "equation*";
      const lines = [
        `\\begin{${environment}}`,
        renderMath(node.expression),
      ];
      const label = renderReferenceLabel(node, context);
      if (label) lines.push(label);
      lines.push(`\\end{${environment}}`);
      if (node.description) {
        lines.push(`{\\small ${renderInline(node.description, context)}}`);
      }
      return lines.join("\n");
    }
    case "figure": {
      const width = (node.widthPercent / 100).toFixed(2);
      const lines = ["\\begin{figure}[htbp]", "\\centering"];
      if (node.assetId && node.assetKind) {
        const extension = node.assetKind === "jpeg" ? "jpg" : node.assetKind;
        lines.push(
          `\\includegraphics[width=${width}\\linewidth]{assets/${node.assetId}.${extension}}`,
        );
      } else if (node.content) {
        lines.push(renderStructuredFigure(node.content, width));
      } else {
        lines.push(
          `\\fbox{\\parbox[c][35mm][c]{${width}\\linewidth}{\\centering ${escapeLatexText(node.altText)}}}`,
        );
      }
      lines.push(`\\caption{${renderInline(node.caption, context)}}`);
      const label = renderReferenceLabel(node, context);
      if (label) lines.push(label);
      lines.push("\\end{figure}");
      return lines.join("\n");
    }
    case "table": {
      return renderTableNode(node, context);
    }
    case "callout": {
      const labels = { note: "Note", info: "Information", warning: "Warning", success: "Result" };
      const title = node.title ? renderInline(node.title, context) : labels[node.tone];
      return [
        "\\begin{quote}",
        `\\textbf{${title}}\\quad ${renderInline(node.content, context)}`,
        "\\end{quote}",
      ].join("\n");
    }
    case "theorem": {
      const title = node.title
        ? `[{${renderInline(node.title, context)}}]`
        : "";
      const lines = [`\\begin{${node.theoremKind}}${title}`];
      const label = renderReferenceLabel(node, context);
      if (label) lines.push(label);
      lines.push(
        ...renderChildren(node.children, context, sectionDepth),
        `\\end{${node.theoremKind}}`,
      );
      return lines.join("\n\n");
    }
    case "proof": {
      const title = node.title
        ? `[{${renderInline(node.title, context)}}]`
        : "";
      return [
        `\\begin{proof}${title}`,
        ...renderChildren(node.children, context, sectionDepth),
        "\\end{proof}",
      ].join("\n\n");
    }
    case "algorithm": {
      const lines = [
        "\\begin{quote}",
        "\\refstepcounter{algorithm}",
        `\\noindent\\textbf{Algorithm \\thealgorithm: ${renderInline(node.title, context)}}`,
      ];
      if (node.description) {
        lines.push(renderInline(node.description, context));
      }
      if (node.inputs) {
        lines.push(`\\noindent\\textbf{Input:} ${renderInline(node.inputs, context)}`);
      }
      if (node.outputs) {
        lines.push(`\\noindent\\textbf{Output:} ${renderInline(node.outputs, context)}`);
      }
      lines.push(renderAlgorithmSteps(node.steps, context), "\\end{quote}");
      return lines.join("\n");
    }
    case "codeBlock": {
      const lines = ["\\begin{quote}"];
      if (node.caption || node.language) {
        const caption = node.caption
          ? renderInline(node.caption, context)
          : escapeLatexText(node.language ?? "Code");
        const language = node.caption && node.language
          ? ` (${escapeLatexText(node.language)})`
          : "";
        lines.push(`\\noindent\\textbf{${caption}${language}}`);
      }
      lines.push("\\begingroup", "\\small\\ttfamily\\raggedright");
      const codeLines = node.code.replace(/\r\n?/gu, "\n").split("\n");
      const numberWidth = String(codeLines.length).length;
      codeLines.forEach((line, index) => {
        const number = node.showLineNumbers
          ? `\\makebox[${numberWidth}em][r]{${index + 1}}\\quad `
          : "";
        lines.push(`\\noindent ${number}${renderCodeLine(line)}\\par`);
      });
      lines.push("\\endgroup", "\\end{quote}");
      return lines.join("\n");
    }
    case "appendix": {
      const lines: string[] = [];
      if (!context.appendixStarted) {
        lines.push("\\appendix");
        context.appendixStarted = true;
      }
      lines.push(`\\section{${renderInline(node.title, context)}}`);
      lines.push(...renderChildren(node.children, context, 1));
      return lines.join("\n\n");
    }
    case "pageBreak":
      return "\\clearpage";
    case "bibliography": {
      const title = node.title ? renderInline(node.title, context) : "References";
      const citations = node.citationIds.flatMap((citationId) => {
        const citation = context.nodeById.get(citationId);
        return citation?.type === "citation" ? [citation] : [];
      });
      if (
        context.citationStyle === "author-year" ||
        context.citationStyle === "apa7"
      ) {
        citations.sort((left, right) => {
          const leftAuthor = left.authors.map(familyName).join("|");
          const rightAuthor = right.authors.map(familyName).join("|");
          return (
            leftAuthor.localeCompare(rightAuthor, "en") ||
            (context.citationYearById.get(left.id) ?? left.year).localeCompare(
              context.citationYearById.get(right.id) ?? right.year,
              "en",
            ) ||
            left.title.localeCompare(right.title, "en") ||
            left.id.localeCompare(right.id, "en")
          );
        });
        const lines = [
          "{",
          `\\section*{${title}}`,
          "\\begingroup",
          "\\setlength{\\parindent}{0pt}",
        ];
        for (const citation of citations) {
          lines.push(
            `\\noindent\\hangindent=1.5em\\hangafter=1 ${renderStyledCitation(citation, context)}\\par`,
          );
        }
        lines.push("\\endgroup", "}");
        return lines.join("\n");
      }
      const lines = [
        "{",
        `\\renewcommand{\\refname}{${title}}`,
        "\\begin{thebibliography}{99}",
      ];
      for (const citation of citations) {
        const number = context.citationNumberById.get(citation.id);
        const label = context.citationStyle && number ? `[${number}]` : "";
        lines.push(
          `\\bibitem${label}{${citationKey(citation.id)}} ${renderStyledCitation(citation, context)}`,
        );
      }
      lines.push("\\end{thebibliography}", "}");
      return lines.join("\n");
    }
    case "citation":
    case "footnote":
      return "";
  }
}

const PREAMBLE = String.raw`\documentclass[a4paper,11pt]{ltjsarticle}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs,array}
\usepackage[normalem]{ulem}
\usepackage[top=25mm,bottom=28mm,left=25mm,right=25mm]{geometry}
\setlength{\parskip}{0.35\baselineskip}
\setlength{\parindent}{1em}`;

const PAGE_CLASS_OPTION: Readonly<
  Record<DocumentLayout["pageSize"], string>
> = Object.freeze({
  A3: "a3paper",
  A4: "a4paper",
  A5: "a5paper",
  B4: "b4paper",
  B5: "b5paper",
  letter: "letterpaper",
});

const LAYOUT_PRESET: Readonly<
  Record<
    DocumentLayout["preset"],
    {
      fontSize: "10pt" | "11pt";
      geometry: string;
      paragraphSkip: string;
      paragraphIndent: string;
    }
  >
> = Object.freeze({
  standard: {
    fontSize: "11pt",
    geometry: "top=25mm,bottom=28mm,left=25mm,right=25mm",
    paragraphSkip: "0.35\\baselineskip",
    paragraphIndent: "1em",
  },
  academic: {
    fontSize: "10pt",
    geometry: "top=20mm,bottom=22mm,left=20mm,right=20mm",
    paragraphSkip: "0.2\\baselineskip",
    paragraphIndent: "1em",
  },
  business: {
    fontSize: "11pt",
    geometry: "top=22mm,bottom=24mm,left=24mm,right=24mm",
    paragraphSkip: "0.5\\baselineskip",
    paragraphIndent: "0pt",
  },
  compact: {
    fontSize: "10pt",
    geometry: "top=16mm,bottom=18mm,left=16mm,right=16mm",
    paragraphSkip: "0.15\\baselineskip",
    paragraphIndent: "1em",
  },
});

function renderBasePreamble(document: DocumentModel): string {
  const layout = document.metadata.layout;
  if (!layout) return PREAMBLE;

  const preset = LAYOUT_PRESET[layout.preset];
  const classOptions = [
    PAGE_CLASS_OPTION[layout.pageSize],
    preset.fontSize,
    ...(layout.columns === 2 ? ["twocolumn"] : []),
  ].join(",");
  return [
    `\\documentclass[${classOptions}]{ltjsarticle}`,
    "\\usepackage{amsmath,amssymb}",
    "\\usepackage{graphicx}",
    "\\usepackage{booktabs,array}",
    "\\usepackage[normalem]{ulem}",
    `\\usepackage[${preset.geometry}]{geometry}`,
    `\\setlength{\\parskip}{${preset.paragraphSkip}}`,
    `\\setlength{\\parindent}{${preset.paragraphIndent}}`,
  ].join("\n");
}

function collectReferencedTargetIds(document: DocumentModel): Set<StableId> {
  const targetIds = new Set<StableId>();
  const stack: unknown[] = [...document.nodes];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (record.type === "crossRef" && typeof record.targetId === "string") {
      targetIds.add(record.targetId);
    }
    stack.push(...Object.values(record));
  }
  return targetIds;
}

function orderedCitationIds(document: DocumentModel): StableId[] {
  const citationIds = new Set(
    document.nodes
      .filter((node): node is CitationNode => node.type === "citation")
      .map((citation) => citation.id),
  );
  const ordered: StableId[] = [];
  const seen = new Set<StableId>();
  for (const node of document.nodes) {
    if (node.type !== "bibliography") continue;
    for (const citationId of node.citationIds) {
      if (citationIds.has(citationId) && !seen.has(citationId)) {
        seen.add(citationId);
        ordered.push(citationId);
      }
    }
  }
  for (const citationId of citationIds) {
    if (!seen.has(citationId)) ordered.push(citationId);
  }
  return ordered;
}

function alphabeticSuffix(index: number): string {
  let value = index + 1;
  let suffix = "";
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return suffix;
}

function citationYearLabels(document: DocumentModel): Map<StableId, string> {
  const citations = document.nodes.filter(
    (node): node is CitationNode => node.type === "citation",
  );
  const groups = new Map<string, CitationNode[]>();
  for (const citation of citations) {
    const authorKey = citation.authors
      .map((author) => familyName(author).normalize("NFKC").toLowerCase())
      .join("|");
    const year = citation.year.slice(0, 4);
    const key = `${authorKey}:${year}`;
    const group = groups.get(key) ?? [];
    group.push(citation);
    groups.set(key, group);
  }

  const labels = new Map<StableId, string>();
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        left.title.localeCompare(right.title, "en") ||
        left.id.localeCompare(right.id, "en"),
    );
    ordered.forEach((citation, index) => {
      const year = citation.year.slice(0, 4);
      labels.set(
        citation.id,
        ordered.length > 1 ? `${year}${alphabeticSuffix(index)}` : citation.year,
      );
    });
  }
  return labels;
}

function citationNumberLabels(document: DocumentModel): Map<StableId, number> {
  return new Map(
    orderedCitationIds(document).map((citationId, index) => [
      citationId,
      index + 1,
    ]),
  );
}

function renderPreamble(document: DocumentModel): string {
  const extensions: string[] = [];
  if (document.metadata.citationStyle) {
    extensions.push("\\usepackage{xurl}");
  }
  if (document.metadata.layout && document.nodes.some((node) => node.type === "table")) {
    extensions.push("\\usepackage{tabularx}");
  }
  if (
    document.metadata.layout &&
    document.nodes.some(
      (node) => node.type === "table" && node.rows.length > LONG_TABLE_ROW_THRESHOLD,
    )
  ) {
    extensions.push("\\usepackage{longtable}");
  }
  if (
    document.nodes.some(
      (node) => node.type === "theorem" || node.type === "proof",
    )
  ) {
    const japanese = document.metadata.language.toLowerCase().startsWith("ja");
    const labels = japanese
      ? { definition: "定義", lemma: "補題", theorem: "定理", corollary: "系" }
      : {
          definition: "Definition",
          lemma: "Lemma",
          theorem: "Theorem",
          corollary: "Corollary",
        };
    extensions.push(
      "\\usepackage{amsthm}",
      "\\theoremstyle{plain}",
      `\\newtheorem{theorem}{${labels.theorem}}[section]`,
      `\\newtheorem{lemma}[theorem]{${labels.lemma}}`,
      `\\newtheorem{corollary}[theorem]{${labels.corollary}}`,
      "\\theoremstyle{definition}",
      `\\newtheorem{definition}[theorem]{${labels.definition}}`,
    );
  }
  if (document.nodes.some((node) => node.type === "algorithm")) {
    extensions.push(
      "\\newcounter{algorithm}",
      "\\renewcommand{\\thealgorithm}{\\arabic{algorithm}}",
    );
  }
  const hasFlowDiagram = document.nodes.some(
    (node) =>
      node.type === "figure" && node.content?.kind === "flowDiagram",
  );
  const hasChart = document.nodes.some(
    (node) => node.type === "figure" && node.content?.kind === "chart",
  );
  if (hasFlowDiagram || hasChart) {
    extensions.push("\\usepackage{tikz}");
  }
  if (hasFlowDiagram) {
    extensions.push(
      "\\usetikzlibrary{arrows.meta,positioning,shapes.geometric}",
    );
  }
  if (hasChart) {
    extensions.push(
      "\\usepackage{pgfplots}",
      "\\pgfplotsset{compat=1.18}",
    );
  }
  const base = renderBasePreamble(document);
  return extensions.length > 0
    ? [base, ...extensions].join("\n")
    : base;
}

/**
 * Produces byte-for-byte deterministic LuaLaTeX source from a valid document.
 * User-controlled strings are only emitted through escapeLatexText; asset paths
 * are generated exclusively from validated UUIDs and allowlisted extensions.
 */
export function renderDocumentToLatex(input: DocumentModel): string {
  const document = validateDocument(input);
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  const context: RenderContext = {
    nodeById,
    referencedTargetIds: collectReferencedTargetIds(document),
    citationStyle: document.metadata.citationStyle?.style,
    citationYearById: citationYearLabels(document),
    citationNumberById: citationNumberLabels(document),
    appendixStarted: false,
    layout: document.metadata.layout,
  };

  const title = document.metadata.subtitle
    ? `${escapeLatexText(document.metadata.title)}\\\\[0.4em]{\\large ${escapeLatexText(document.metadata.subtitle)}}`
    : escapeLatexText(document.metadata.title);
  const authors = document.metadata.authors.length
    ? document.metadata.authors
        .map((author) => {
          const affiliation = author.affiliation ? `\\\\{\\small ${escapeLatexText(author.affiliation)}}` : "";
          return `${escapeLatexText(author.name)}${affiliation}`;
        })
        .join(" \\and ")
    : "";
  const body = document.root
    .map((nodeId) => nodeById.get(nodeId))
    .filter((node): node is DocumentNode => Boolean(node))
    .map((node) => renderNode(node, context, 0))
    .filter(Boolean)
    .join("\n\n");

  return [
    renderPreamble(document),
    `\\title{${title}}`,
    `\\author{${authors}}`,
    `\\date{${escapeLatexText(document.metadata.updatedAt.slice(0, 10))}}`,
    "\\begin{document}",
    "\\maketitle",
    body,
    "\\end{document}",
    "",
  ].join("\n");
}

import type { z } from "zod";
import {
  DocumentSchema,
  isContainerNode,
  isRenderableFigureNode,
  isStructuralNode,
  type AlgorithmStepModel,
  type FigureNode,
  type CrossReferenceTarget,
  type DocumentModel,
  type DocumentNode,
  type InlineContent,
  type ListItemModel,
  type MathExpression,
  type StableId,
} from "./schema";
import { DocumentValidationError, type DocumentValidationIssue } from "./errors";

const MAX_STRUCTURE_DEPTH = 12;
const MAX_LIST_DEPTH = 12;
const MAX_MATH_DEPTH = 64;
export const MAX_DOCUMENT_SERIALIZED_BYTES = 2 * 1024 * 1024;
export const MAX_MATH_EXPRESSION_NODES = 25_000;
export const MAX_MATRIX_CELLS = 10_000;
export const MAX_ALGORITHM_STEPS = 5_000;
export const MAX_CODE_BYTES = 512 * 1024;
export const MAX_CODE_LINES = 20_000;
export const MAX_INLINE_NODES = 100_000;
export const MAX_CROSS_REFERENCES = 10_000;
export const MAX_STRUCTURAL_EDGES = 50_000;
export const MAX_STRUCTURED_FIGURES = 200;
export const MAX_FLOW_DIAGRAM_NODES = 500;
export const MAX_FLOW_DIAGRAM_EDGES = 1_000;
export const MAX_CHART_SERIES = 50;
export const MAX_CHART_POINTS = 20_000;
const MAX_RAW_STRUCTURE_DEPTH = 128;
const MAX_RAW_VALUES = 250_000;

type ZodIssue = z.core.$ZodIssue;

function zodIssueToDomainIssue(issue: ZodIssue): DocumentValidationIssue {
  return {
    code: "schema",
    path: issue.path.map(String).join("."),
    message: issue.message,
  };
}

function collectInlineGroups(node: DocumentNode): InlineContent[] {
  switch (node.type) {
    case "section":
    case "appendix":
      return [node.title];
    case "paragraph":
    case "heading":
      return [node.content];
    case "list": {
      const groups: InlineContent[] = [];
      const visit = (items: ListItemModel[]) => {
        for (const item of items) {
          groups.push(item.content);
          visit(item.children);
        }
      };
      visit(node.items);
      return groups;
    }
    case "equation":
      return node.description ? [node.description] : [];
    case "figure":
      return [node.caption];
    case "table":
      return [
        ...(node.caption ? [node.caption] : []),
        ...node.columns.map((column) => column.header),
        ...node.rows.flatMap((row) => row.cells.map((cell) => cell.content)),
      ];
    case "callout":
      return [...(node.title ? [node.title] : []), node.content];
    case "theorem":
    case "proof":
      return node.title ? [node.title] : [];
    case "algorithm": {
      const groups: InlineContent[] = [node.title];
      if (node.description) groups.push(node.description);
      if (node.inputs) groups.push(node.inputs);
      if (node.outputs) groups.push(node.outputs);
      const visit = (steps: AlgorithmStepModel[]) => {
        for (const step of steps) {
          groups.push(step.content);
          visit(step.children);
        }
      };
      visit(node.steps);
      return groups;
    }
    case "codeBlock":
      return node.caption ? [node.caption] : [];
    case "bibliography":
      return node.title ? [node.title] : [];
    case "footnote":
      return [node.content];
    case "pageBreak":
    case "citation":
      return [];
  }
}

function collectAlgorithmIds(
  steps: AlgorithmStepModel[],
  nodePath: string,
  registerId: (id: StableId, path: string) => void,
  issues: DocumentValidationIssue[],
  depth = 1,
): void {
  if (depth > MAX_LIST_DEPTH) {
    issues.push({
      code: "depth_limit",
      path: nodePath,
      message: `Algorithm step nesting exceeds ${MAX_LIST_DEPTH} levels`,
    });
    return;
  }
  for (const [index, step] of steps.entries()) {
    const stepPath = `${nodePath}.steps.${index}`;
    registerId(step.id, `${stepPath}.id`);
    collectAlgorithmIds(
      step.children,
      `${stepPath}.children`,
      registerId,
      issues,
      depth + 1,
    );
  }
}

function collectListIds(
  items: ListItemModel[],
  nodePath: string,
  registerId: (id: StableId, path: string) => void,
  issues: DocumentValidationIssue[],
  depth = 1,
): void {
  if (depth > MAX_LIST_DEPTH) {
    issues.push({
      code: "depth_limit",
      path: nodePath,
      message: `List nesting exceeds ${MAX_LIST_DEPTH} levels`,
    });
    return;
  }
  for (const [index, item] of items.entries()) {
    const itemPath = `${nodePath}.items.${index}`;
    registerId(item.id, `${itemPath}.id`);
    collectListIds(item.children, `${itemPath}.children`, registerId, issues, depth + 1);
  }
}

function validateMathDepth(
  expression: MathExpression,
  path: string,
  issues: DocumentValidationIssue[],
  depth = 1,
): void {
  if (depth > MAX_MATH_DEPTH) {
    issues.push({
      code: "depth_limit",
      path,
      message: `Math expression exceeds ${MAX_MATH_DEPTH} levels`,
    });
    return;
  }
  switch (expression.kind) {
    case "unary":
      validateMathDepth(expression.operand, `${path}.operand`, issues, depth + 1);
      break;
    case "binary":
      validateMathDepth(expression.left, `${path}.left`, issues, depth + 1);
      validateMathDepth(expression.right, `${path}.right`, issues, depth + 1);
      break;
    case "function":
      expression.arguments.forEach((argument, index) =>
        validateMathDepth(argument, `${path}.arguments.${index}`, issues, depth + 1),
      );
      break;
    case "sequence":
      expression.items.forEach((item, index) =>
        validateMathDepth(item, `${path}.items.${index}`, issues, depth + 1),
      );
      break;
    case "script":
      validateMathDepth(expression.base, `${path}.base`, issues, depth + 1);
      if (expression.subscript) {
        validateMathDepth(
          expression.subscript,
          `${path}.subscript`,
          issues,
          depth + 1,
        );
      }
      if (expression.superscript) {
        validateMathDepth(
          expression.superscript,
          `${path}.superscript`,
          issues,
          depth + 1,
        );
      }
      break;
    case "root":
      validateMathDepth(expression.radicand, `${path}.radicand`, issues, depth + 1);
      if (expression.index) {
        validateMathDepth(expression.index, `${path}.index`, issues, depth + 1);
      }
      break;
    case "integral":
      validateMathDepth(expression.integrand, `${path}.integrand`, issues, depth + 1);
      validateMathDepth(expression.variable, `${path}.variable`, issues, depth + 1);
      if (expression.lowerBound) {
        validateMathDepth(expression.lowerBound, `${path}.lowerBound`, issues, depth + 1);
      }
      if (expression.upperBound) {
        validateMathDepth(expression.upperBound, `${path}.upperBound`, issues, depth + 1);
      }
      break;
    case "largeOperator":
      validateMathDepth(expression.expression, `${path}.expression`, issues, depth + 1);
      if (expression.index) {
        validateMathDepth(expression.index, `${path}.index`, issues, depth + 1);
      }
      if (expression.lowerBound) {
        validateMathDepth(expression.lowerBound, `${path}.lowerBound`, issues, depth + 1);
      }
      if (expression.upperBound) {
        validateMathDepth(expression.upperBound, `${path}.upperBound`, issues, depth + 1);
      }
      break;
    case "limit":
      validateMathDepth(expression.expression, `${path}.expression`, issues, depth + 1);
      validateMathDepth(expression.variable, `${path}.variable`, issues, depth + 1);
      validateMathDepth(expression.approaches, `${path}.approaches`, issues, depth + 1);
      break;
    case "partialDerivative": {
      validateMathDepth(expression.expression, `${path}.expression`, issues, depth + 1);
      const totalOrder = expression.variables.reduce(
        (sum, variable) => sum + variable.order,
        0,
      );
      if (totalOrder > 64) {
        issues.push({
          code: "invalid_math",
          path: `${path}.variables`,
          message: "Total partial derivative order cannot exceed 64",
        });
      }
      expression.variables.forEach((variable, index) =>
        validateMathDepth(
          variable.variable,
          `${path}.variables.${index}.variable`,
          issues,
          depth + 1,
        ),
      );
      break;
    }
    case "vector":
      expression.entries.forEach((entry, index) =>
        validateMathDepth(entry, `${path}.entries.${index}`, issues, depth + 1),
      );
      break;
    case "matrix": {
      const expectedColumns = expression.rows[0]?.length ?? 0;
      expression.rows.forEach((row, rowIndex) => {
        if (row.length !== expectedColumns) {
          issues.push({
            code: "invalid_math",
            path: `${path}.rows.${rowIndex}`,
            message: `Matrix row has ${row.length} cells; expected ${expectedColumns}`,
          });
        }
        row.forEach((cell, columnIndex) =>
          validateMathDepth(
            cell,
            `${path}.rows.${rowIndex}.${columnIndex}`,
            issues,
            depth + 1,
          ),
        );
      });
      break;
    }
    case "cases":
      expression.cases.forEach((branch, index) => {
        validateMathDepth(
          branch.expression,
          `${path}.cases.${index}.expression`,
          issues,
          depth + 1,
        );
        validateMathDepth(
          branch.condition,
          `${path}.cases.${index}.condition`,
          issues,
          depth + 1,
        );
      });
      break;
    case "aligned":
      expression.lines.forEach((line, index) => {
        validateMathDepth(
          line.left,
          `${path}.lines.${index}.left`,
          issues,
          depth + 1,
        );
        validateMathDepth(
          line.right,
          `${path}.lines.${index}.right`,
          issues,
          depth + 1,
        );
      });
      break;
    case "literal":
    case "symbol":
    case "text":
      break;
  }
}

function matchesCrossReferenceTarget(
  targetType: CrossReferenceTarget,
  node: DocumentNode,
): boolean {
  if (targetType === "theorem") return node.type === "theorem";
  return node.type === targetType;
}

function chartValueKey(value: number): string {
  return String(Object.is(value, -0) ? 0 : value);
}

function validateFigureContent(
  figure: FigureNode,
  nodeIndex: number,
  issues: DocumentValidationIssue[],
): void {
  const path = `nodes.${nodeIndex}`;
  const hasAssetId = Boolean(figure.assetId);
  const hasAssetKind = Boolean(figure.assetKind);
  if (hasAssetId !== hasAssetKind) {
    issues.push({
      code: "invalid_asset",
      path,
      message:
        "Figure assetId and assetKind must either both be present or both be absent",
    });
  }
  if (figure.content && (hasAssetId || hasAssetKind)) {
    issues.push({
      code: "invalid_structure",
      path,
      message:
        "A figure must use either an asset or structured content, not both",
    });
  }
  if (!figure.content) return;

  if (figure.content.kind === "flowDiagram") {
    const nodeIds = new Set(
      figure.content.nodes.map((diagramNode) => diagramNode.id),
    );
    const connectedIds = new Set<StableId>();
    const edgeKeys = new Set<string>();
    figure.content.edges.forEach((edge, edgeIndex) => {
      const edgePath = `${path}.content.edges.${edgeIndex}`;
      if (!nodeIds.has(edge.from)) {
        issues.push({
          code: "missing_reference",
          path: `${edgePath}.from`,
          message: `Flow edge references unknown source node ${edge.from}`,
        });
      } else {
        connectedIds.add(edge.from);
      }
      if (!nodeIds.has(edge.to)) {
        issues.push({
          code: "missing_reference",
          path: `${edgePath}.to`,
          message: `Flow edge references unknown target node ${edge.to}`,
        });
      } else {
        connectedIds.add(edge.to);
      }
      if (edge.from === edge.to) {
        issues.push({
          code: "invalid_reference",
          path: edgePath,
          message: "Flow edges cannot point from a node to itself",
        });
      }
      const edgeKey = `${edge.from}:${edge.to}`;
      if (edgeKeys.has(edgeKey)) {
        issues.push({
          code: "invalid_reference",
          path: edgePath,
          message: "A flow diagram cannot repeat the same directed edge",
        });
      }
      edgeKeys.add(edgeKey);
    });
    figure.content.nodes.forEach((diagramNode, diagramNodeIndex) => {
      if (!connectedIds.has(diagramNode.id)) {
        issues.push({
          code: "invalid_structure",
          path: `${path}.content.nodes.${diagramNodeIndex}`,
          message: "Every flow node must be connected by at least one edge",
        });
      }
    });
    return;
  }

  const chart = figure.content;
  const normalizedLabels = new Set<string>();
  chart.series.forEach((series, seriesIndex) => {
    const seriesPath = `${path}.content.series.${seriesIndex}`;
    const labelKey = series.label.normalize("NFKC").toLocaleLowerCase("en-US");
    if (normalizedLabels.has(labelKey)) {
      issues.push({
        code: "invalid_structure",
        path: `${seriesPath}.label`,
        message: "Chart series labels must be unique",
      });
    }
    normalizedLabels.add(labelKey);
    if (chart.chartType === "line") {
      if (series.points.length < 2) {
        issues.push({
          code: "invalid_structure",
          path: `${seriesPath}.points`,
          message: "A line series requires at least two points",
        });
      }
    }
    const xValues = new Set<string>();
    series.points.forEach((point, pointIndex) => {
      const pointPath = `${seriesPath}.points.${pointIndex}`;
      const xKey = chartValueKey(point.x);
      if (xValues.has(xKey)) {
        issues.push({
          code: "invalid_structure",
          path: `${pointPath}.x`,
          message: "A chart series cannot contain duplicate x values",
        });
      }
      xValues.add(xKey);
      const xRange = chart.xAxis.range;
      if (xRange && (point.x < xRange.min || point.x > xRange.max)) {
        issues.push({
          code: "invalid_structure",
          path: `${pointPath}.x`,
          message: "Chart point falls outside the declared x-axis range",
        });
      }
      const yRange = chart.yAxis.range;
      if (yRange && (point.y < yRange.min || point.y > yRange.max)) {
        issues.push({
          code: "invalid_structure",
          path: `${pointPath}.y`,
          message: "Chart point falls outside the declared y-axis range",
        });
      }
    });
  });
}

function collectSemanticIssues(document: DocumentModel): DocumentValidationIssue[] {
  const issues: DocumentValidationIssue[] = [];
  const idOwners = new Map<StableId, string>();
  const nodeById = new Map<StableId, DocumentNode>();
  const nodeIndexById = new Map<StableId, number>();

  const registerId = (id: StableId, path: string) => {
    const previousPath = idOwners.get(id);
    if (previousPath) {
      issues.push({
        code: "duplicate_id",
        path,
        message: `ID ${id} is already used at ${previousPath}`,
      });
      return;
    }
    idOwners.set(id, path);
  };

  registerId(document.id, "id");
  document.metadata.authors.forEach((author, index) =>
    registerId(author.id, `metadata.authors.${index}.id`),
  );

  for (const [index, node] of document.nodes.entries()) {
    registerId(node.id, `nodes.${index}.id`);
    if (!nodeById.has(node.id)) {
      nodeById.set(node.id, node);
      nodeIndexById.set(node.id, index);
    }
    if (node.type === "list") {
      collectListIds(node.items, `nodes.${index}`, registerId, issues);
    }
    if (node.type === "algorithm") {
      collectAlgorithmIds(node.steps, `nodes.${index}`, registerId, issues);
    }
    if (node.type === "table") {
      node.columns.forEach((column, columnIndex) =>
        registerId(column.id, `nodes.${index}.columns.${columnIndex}.id`),
      );
      node.rows.forEach((row, rowIndex) =>
        registerId(row.id, `nodes.${index}.rows.${rowIndex}.id`),
      );
    }
    if (node.type === "figure") {
      if (node.content?.kind === "flowDiagram") {
        node.content.nodes.forEach((diagramNode, diagramNodeIndex) =>
          registerId(
            diagramNode.id,
            `nodes.${index}.content.nodes.${diagramNodeIndex}.id`,
          ),
        );
      }
      validateFigureContent(node, index, issues);
    }
    if (node.type === "equation") {
      validateMathDepth(node.expression, `nodes.${index}.expression`, issues);
    }
    collectInlineGroups(node).forEach((content, contentIndex) => {
      content.forEach((inline, inlineIndex) => {
        if (inline.type === "inlineMath") {
          validateMathDepth(
            inline.expression,
            `nodes.${index}.content.${contentIndex}.${inlineIndex}.expression`,
            issues,
          );
        }
      });
    });
    if (
      (node.type === "theorem" ||
        node.type === "proof" ||
        node.type === "appendix") &&
      node.children.length === 0
    ) {
      issues.push({
        code: "invalid_structure",
        path: `nodes.${index}.children`,
        message: `${node.type} nodes must contain at least one child`,
      });
    }
  }

  const parentPathByNode = new Map<StableId, string>();
  const structuralChildren = new Map<StableId, StableId[]>();

  const registerStructuralReference = (id: StableId, path: string): void => {
    const target = nodeById.get(id);
    if (!target) {
      issues.push({
        code: "missing_reference",
        path,
        message: `Referenced node ${id} does not exist`,
      });
      return;
    }
    if (!isStructuralNode(target)) {
      issues.push({
        code: "invalid_reference",
        path,
        message: `Definition node ${id} cannot be placed in document structure`,
      });
      return;
    }
    const previousParent = parentPathByNode.get(id);
    if (previousParent) {
      issues.push({
        code: "duplicate_parent",
        path,
        message: `Node ${id} is already placed at ${previousParent}`,
      });
      return;
    }
    parentPathByNode.set(id, path);
  };

  document.root.forEach((id, index) => registerStructuralReference(id, `root.${index}`));
  for (const [index, node] of document.nodes.entries()) {
    if (!isContainerNode(node)) continue;
    structuralChildren.set(node.id, node.children);
    node.children.forEach((id, childIndex) =>
      registerStructuralReference(id, `nodes.${index}.children.${childIndex}`),
    );
  }

  for (const node of document.nodes) {
    if (isStructuralNode(node) && !parentPathByNode.has(node.id)) {
      issues.push({
        code: "orphan_node",
        path: `nodes.${nodeIndexById.get(node.id) ?? 0}`,
        message: `Structural node ${node.id} is not reachable from the document root`,
      });
    }
  }

  const visitState = new Map<StableId, "visiting" | "visited">();
  const visitContainer = (id: StableId, ancestry: StableId[], depth: number): void => {
    if (visitState.get(id) === "visiting") {
      issues.push({
        code: "cycle",
        path: `nodes.${nodeIndexById.get(id) ?? 0}.children`,
        message: `Structural cycle detected: ${[...ancestry, id].join(" -> ")}`,
      });
      return;
    }
    if (visitState.get(id) === "visited") return;
    if (depth > MAX_STRUCTURE_DEPTH) {
      issues.push({
        code: "depth_limit",
        path: `nodes.${nodeIndexById.get(id) ?? 0}`,
        message: `Structural nesting exceeds ${MAX_STRUCTURE_DEPTH} levels`,
      });
      return;
    }
    visitState.set(id, "visiting");
    for (const childId of structuralChildren.get(id) ?? []) {
      const child = nodeById.get(childId);
      if (child && isContainerNode(child)) {
        visitContainer(childId, [...ancestry, id], depth + 1);
      }
    }
    visitState.set(id, "visited");
  };

  for (const node of document.nodes) {
    if (isContainerNode(node)) visitContainer(node.id, [], 1);
  }

  const firstAppendixIndex = document.root.findIndex(
    (id) => nodeById.get(id)?.type === "appendix",
  );
  for (const [index, node] of document.nodes.entries()) {
    if (node.type !== "appendix") continue;
    const rootIndex = document.root.indexOf(node.id);
    if (rootIndex < 0) {
      issues.push({
        code: "invalid_structure",
        path: `nodes.${index}`,
        message: "Appendix nodes must be placed directly in the document root",
      });
    }
  }
  if (firstAppendixIndex >= 0) {
    document.root.slice(firstAppendixIndex + 1).forEach((id, offset) => {
      const node = nodeById.get(id);
      if (
        node &&
        node.type !== "appendix" &&
        node.type !== "bibliography" &&
        node.type !== "pageBreak"
      ) {
        issues.push({
          code: "invalid_structure",
          path: `root.${firstAppendixIndex + offset + 1}`,
          message: "Body content cannot follow the first appendix",
        });
      }
    });
  }

  const bibliographyCitationIds = new Set<StableId>();
  for (const [index, node] of document.nodes.entries()) {
    if (node.type === "bibliography") {
      const localIds = new Set<StableId>();
      for (const [citationIndex, citationId] of node.citationIds.entries()) {
        const path = `nodes.${index}.citationIds.${citationIndex}`;
        if (localIds.has(citationId) || bibliographyCitationIds.has(citationId)) {
          issues.push({
            code: "invalid_reference",
            path,
            message: `Citation ${citationId} is listed more than once`,
          });
        }
        localIds.add(citationId);
        bibliographyCitationIds.add(citationId);
        if (nodeById.get(citationId)?.type !== "citation") {
          issues.push({
            code: nodeById.has(citationId) ? "invalid_reference" : "missing_reference",
            path,
            message: `Bibliography entry ${citationId} must reference a citation node`,
          });
        }
      }
    }
    if (node.type === "table") {
      const columnIds = new Set(node.columns.map((column) => column.id));
      for (const [rowIndex, row] of node.rows.entries()) {
        const cellIds = new Set<StableId>();
        for (const [cellIndex, cell] of row.cells.entries()) {
          const path = `nodes.${index}.rows.${rowIndex}.cells.${cellIndex}.columnId`;
          if (!columnIds.has(cell.columnId)) {
            issues.push({
              code: "invalid_table",
              path,
              message: `Cell references unknown column ${cell.columnId}`,
            });
          }
          if (cellIds.has(cell.columnId)) {
            issues.push({
              code: "invalid_table",
              path,
              message: `Row contains duplicate cell for column ${cell.columnId}`,
            });
          }
          cellIds.add(cell.columnId);
        }
        for (const columnId of columnIds) {
          if (!cellIds.has(columnId)) {
            issues.push({
              code: "invalid_table",
              path: `nodes.${index}.rows.${rowIndex}.cells`,
              message: `Row is missing a cell for column ${columnId}`,
            });
          }
        }
      }
    }
  }

  const citedIds = new Set<StableId>();
  for (const [nodeIndex, node] of document.nodes.entries()) {
    for (const [contentIndex, content] of collectInlineGroups(node).entries()) {
      for (const [inlineIndex, inline] of content.entries()) {
        const path = `nodes.${nodeIndex}.content.${contentIndex}.${inlineIndex}`;
        if (inline.type === "citationRef") {
          citedIds.add(inline.citationId);
          if (nodeById.get(inline.citationId)?.type !== "citation") {
            issues.push({
              code: nodeById.has(inline.citationId) ? "invalid_reference" : "missing_reference",
              path: `${path}.citationId`,
              message: `Citation reference ${inline.citationId} must target a citation node`,
            });
          }
        }
        if (inline.type === "footnoteRef") {
          if (node.type === "footnote") {
            issues.push({
              code: "invalid_reference",
              path: `${path}.footnoteId`,
              message: "Nested footnotes are not supported",
            });
          }
          if (nodeById.get(inline.footnoteId)?.type !== "footnote") {
            issues.push({
              code: nodeById.has(inline.footnoteId) ? "invalid_reference" : "missing_reference",
              path: `${path}.footnoteId`,
              message: `Footnote reference ${inline.footnoteId} must target a footnote node`,
            });
          }
        }
        if (inline.type === "crossRef") {
          const target = nodeById.get(inline.targetId);
          if (!target) {
            issues.push({
              code: "missing_reference",
              path: `${path}.targetId`,
              message: `Cross-reference target ${inline.targetId} does not exist`,
            });
          } else if (!matchesCrossReferenceTarget(inline.targetType, target)) {
            issues.push({
              code: "invalid_reference",
              path: `${path}.targetType`,
              message: `Cross-reference declares ${inline.targetType} but targets ${target.type}`,
            });
          } else if (target.type === "equation" && !target.numbered) {
            issues.push({
              code: "invalid_reference",
              path: `${path}.targetId`,
              message: "Unnumbered equations cannot be cross-referenced",
            });
          } else if (target.type === "table" && !target.caption) {
            issues.push({
              code: "invalid_reference",
              path: `${path}.targetId`,
              message: "A cross-referenced table must have a caption",
            });
          }
        }
      }
    }
  }

  for (const citationId of citedIds) {
    if (!bibliographyCitationIds.has(citationId)) {
      issues.push({
        code: "unlisted_citation",
        path: `nodes.${nodeIndexById.get(citationId) ?? 0}`,
        message: `Cited source ${citationId} is not included in a bibliography`,
      });
    }
  }

  return issues;
}

function mathChildren(expression: MathExpression): MathExpression[] {
  switch (expression.kind) {
    case "unary":
      return [expression.operand];
    case "binary":
      return [expression.left, expression.right];
    case "function":
      return expression.arguments;
    case "sequence":
      return expression.items;
    case "script":
      return [
        expression.base,
        ...(expression.subscript ? [expression.subscript] : []),
        ...(expression.superscript ? [expression.superscript] : []),
      ];
    case "root":
      return [
        expression.radicand,
        ...(expression.index ? [expression.index] : []),
      ];
    case "integral":
      return [
        expression.integrand,
        expression.variable,
        ...(expression.lowerBound ? [expression.lowerBound] : []),
        ...(expression.upperBound ? [expression.upperBound] : []),
      ];
    case "largeOperator":
      return [
        expression.expression,
        ...(expression.index ? [expression.index] : []),
        ...(expression.lowerBound ? [expression.lowerBound] : []),
        ...(expression.upperBound ? [expression.upperBound] : []),
      ];
    case "limit":
      return [expression.expression, expression.variable, expression.approaches];
    case "partialDerivative":
      return [
        expression.expression,
        ...expression.variables.map((variable) => variable.variable),
      ];
    case "vector":
      return expression.entries;
    case "matrix":
      return expression.rows.flat();
    case "cases":
      return expression.cases.flatMap((branch) => [
        branch.expression,
        branch.condition,
      ]);
    case "aligned":
      return expression.lines.flatMap((line) => [line.left, line.right]);
    case "accent":
    case "derivative":
      return [expression.expression, ...(expression.kind === "derivative" ? [expression.variable] : [])];
    case "set":
      return expression.elements;
    case "setBuilder":
      return [expression.variable, expression.condition];
    case "quantified":
      return [
        expression.variable,
        ...(expression.domain ? [expression.domain] : []),
        expression.predicate,
      ];
    case "binomial":
      return [expression.upper, expression.lower];
    case "statisticalOperator":
      return [
        expression.expression,
        ...(expression.condition ? [expression.condition] : []),
        ...(expression.subscript ? [expression.subscript] : []),
      ];
    case "literal":
    case "symbol":
    case "text":
      return [];
  }
}

function collectDocumentResourceIssues(
  document: DocumentModel,
): DocumentValidationIssue[] {
  const issues: DocumentValidationIssue[] = [];
  const serialized = JSON.stringify(document);
  const byteSize = new TextEncoder().encode(serialized).byteLength;
  if (byteSize > MAX_DOCUMENT_SERIALIZED_BYTES) {
    issues.push({
      code: "resource_limit",
      path: "",
      message: `Document exceeds ${MAX_DOCUMENT_SERIALIZED_BYTES} serialized bytes`,
    });
  }

  let mathNodeCount = 0;
  let matrixCellCount = 0;
  let algorithmStepCount = 0;
  let codeByteCount = 0;
  let codeLineCount = 0;
  let inlineNodeCount = 0;
  let crossReferenceCount = 0;
  let structuralEdgeCount = document.root.length;
  let structuredFigureCount = 0;
  let flowDiagramNodeCount = 0;
  let flowDiagramEdgeCount = 0;
  let chartSeriesCount = 0;
  let chartPointCount = 0;
  for (const node of document.nodes) {
    const mathRoots: MathExpression[] = [];
    if (node.type === "equation") mathRoots.push(node.expression);
    for (const content of collectInlineGroups(node)) {
      inlineNodeCount += content.length;
      for (const inline of content) {
        if (inline.type === "inlineMath") mathRoots.push(inline.expression);
        if (inline.type === "crossRef") crossReferenceCount += 1;
      }
    }
    if (isContainerNode(node)) structuralEdgeCount += node.children.length;
    for (const root of mathRoots) {
      const stack = [root];
      while (stack.length > 0) {
        const expression = stack.pop();
        if (!expression) continue;
        mathNodeCount += 1;
        if (expression.kind === "matrix") {
          matrixCellCount += expression.rows.reduce(
            (sum, row) => sum + row.length,
            0,
          );
        }
        if (mathNodeCount > MAX_MATH_EXPRESSION_NODES) break;
        stack.push(...mathChildren(expression));
      }
    }
    if (node.type === "algorithm") {
      const steps = [...node.steps];
      while (steps.length > 0) {
        const step = steps.pop();
        if (!step) continue;
        algorithmStepCount += 1;
        if (algorithmStepCount > MAX_ALGORITHM_STEPS) break;
        steps.push(...step.children);
      }
    }
    if (node.type === "codeBlock") {
      codeByteCount += new TextEncoder().encode(node.code).byteLength;
      codeLineCount += node.code.split(/\r\n?|\n/gu).length;
    }
    if (node.type === "figure" && node.content) {
      structuredFigureCount += 1;
      if (node.content.kind === "flowDiagram") {
        flowDiagramNodeCount += node.content.nodes.length;
        flowDiagramEdgeCount += node.content.edges.length;
      } else {
        chartSeriesCount += node.content.series.length;
        chartPointCount += node.content.series.reduce(
          (sum, series) => sum + series.points.length,
          0,
        );
      }
    }
  }
  if (mathNodeCount > MAX_MATH_EXPRESSION_NODES) {
    issues.push({
      code: "resource_limit",
      path: "nodes",
      message: `Document exceeds ${MAX_MATH_EXPRESSION_NODES} math expression nodes`,
    });
  }
  if (matrixCellCount > MAX_MATRIX_CELLS) {
    issues.push({
      code: "resource_limit",
      path: "nodes",
      message: `Document exceeds ${MAX_MATRIX_CELLS} matrix cells`,
    });
  }
  if (algorithmStepCount > MAX_ALGORITHM_STEPS) {
    issues.push({
      code: "resource_limit",
      path: "nodes",
      message: `Document exceeds ${MAX_ALGORITHM_STEPS} algorithm steps`,
    });
  }
  if (codeByteCount > MAX_CODE_BYTES) {
    issues.push({
      code: "resource_limit",
      path: "nodes",
      message: `Code content exceeds the aggregate ${MAX_CODE_BYTES} byte budget`,
    });
  }
  if (codeLineCount > MAX_CODE_LINES) {
    issues.push({
      code: "resource_limit",
      path: "nodes",
      message: `Code content exceeds the aggregate ${MAX_CODE_LINES} line budget`,
    });
  }
  if (inlineNodeCount > MAX_INLINE_NODES) {
    issues.push({
      code: "resource_limit",
      path: "nodes",
      message: `Document exceeds ${MAX_INLINE_NODES} inline nodes`,
    });
  }
  if (crossReferenceCount > MAX_CROSS_REFERENCES) {
    issues.push({
      code: "resource_limit",
      path: "nodes",
      message: `Document exceeds ${MAX_CROSS_REFERENCES} cross-references`,
    });
  }
  if (structuralEdgeCount > MAX_STRUCTURAL_EDGES) {
    issues.push({
      code: "resource_limit",
      path: "root",
      message: `Document exceeds ${MAX_STRUCTURAL_EDGES} structural edges`,
    });
  }
  if (structuredFigureCount > MAX_STRUCTURED_FIGURES) {
    issues.push({
      code: "resource_limit",
      path: "nodes",
      message: `Document exceeds ${MAX_STRUCTURED_FIGURES} structured figures`,
    });
  }
  if (flowDiagramNodeCount > MAX_FLOW_DIAGRAM_NODES) {
    issues.push({
      code: "resource_limit",
      path: "nodes",
      message: `Document exceeds ${MAX_FLOW_DIAGRAM_NODES} flow diagram nodes`,
    });
  }
  if (flowDiagramEdgeCount > MAX_FLOW_DIAGRAM_EDGES) {
    issues.push({
      code: "resource_limit",
      path: "nodes",
      message: `Document exceeds ${MAX_FLOW_DIAGRAM_EDGES} flow diagram edges`,
    });
  }
  if (chartSeriesCount > MAX_CHART_SERIES) {
    issues.push({
      code: "resource_limit",
      path: "nodes",
      message: `Document exceeds ${MAX_CHART_SERIES} chart series`,
    });
  }
  if (chartPointCount > MAX_CHART_POINTS) {
    issues.push({
      code: "resource_limit",
      path: "nodes",
      message: `Document exceeds ${MAX_CHART_POINTS} chart points`,
    });
  }
  return issues;
}

function collectRawInputResourceIssues(input: unknown): DocumentValidationIssue[] {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  const visited = new WeakSet<object>();
  let values = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) continue;
    values += 1;
    if (values > MAX_RAW_VALUES) {
      return [
        {
          code: "resource_limit",
          path: "",
          message: `Input exceeds ${MAX_RAW_VALUES} values`,
        },
      ];
    }
    if (entry.depth > MAX_RAW_STRUCTURE_DEPTH) {
      return [
        {
          code: "depth_limit",
          path: "",
          message: `Input nesting exceeds ${MAX_RAW_STRUCTURE_DEPTH} levels`,
        },
      ];
    }
    if (typeof entry.value !== "object" || entry.value === null) continue;
    if (visited.has(entry.value)) continue;
    visited.add(entry.value);
    for (const value of Object.values(entry.value)) {
      stack.push({ value, depth: entry.depth + 1 });
    }
  }

  try {
    const serialized = JSON.stringify(input) ?? "";
    if (new TextEncoder().encode(serialized).byteLength > MAX_DOCUMENT_SERIALIZED_BYTES) {
      return [
        {
          code: "resource_limit",
          path: "",
          message: `Document exceeds ${MAX_DOCUMENT_SERIALIZED_BYTES} serialized bytes`,
        },
      ];
    }
  } catch {
    return [
      {
        code: "resource_limit",
        path: "",
        message: "Input cannot be safely serialized",
      },
    ];
  }
  return [];
}

export function validateDocument(input: unknown): DocumentModel {
  const preflightIssues = collectRawInputResourceIssues(input);
  if (preflightIssues.length > 0) {
    throw new DocumentValidationError(preflightIssues);
  }
  const parsed = DocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new DocumentValidationError(parsed.error.issues.map(zodIssueToDomainIssue));
  }
  const issues = collectSemanticIssues(parsed.data);
  assertDocumentResourceBudget(parsed.data, issues);
  if (issues.length > 0) throw new DocumentValidationError(issues);
  return parsed.data;
}

/**
 * A stricter completion gate for publishing and independent review. Legacy
 * documents may still contain historical alt-text placeholders so their
 * derived TeX remains byte-for-byte stable, but such placeholders must never
 * satisfy a completed-figure requirement.
 */
export function assertDocumentFiguresRenderable(
  document: Pick<DocumentModel, "nodes">,
): void {
  const issues: DocumentValidationIssue[] = [];
  document.nodes.forEach((node, index) => {
    if (node.type === "figure" && !isRenderableFigureNode(node)) {
      issues.push({
        code: "invalid_structure",
        path: `nodes.${index}`,
        message:
          "Figure has no structured renderable content",
      });
    }
  });
  if (issues.length > 0) throw new DocumentValidationError(issues);
}

export function assertDocumentResourceBudget(
  document: DocumentModel,
  issues?: DocumentValidationIssue[],
): void {
  const resourceIssues = collectDocumentResourceIssues(document);
  if (resourceIssues.length === 0) return;
  if (issues) {
    issues.push(...resourceIssues);
    return;
  }
  throw new DocumentValidationError(resourceIssues);
}

export type SafeDocumentValidationResult =
  | { success: true; data: DocumentModel }
  | { success: false; error: DocumentValidationError };

export function safeValidateDocument(input: unknown): SafeDocumentValidationResult {
  try {
    return { success: true, data: validateDocument(input) };
  } catch (error) {
    if (error instanceof DocumentValidationError) return { success: false, error };
    throw error;
  }
}

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DocumentDomainError,
  DocumentPatchSchema,
  DocumentSchema,
  applyDocumentPatch,
  type DocumentModel,
  type DocumentNode,
  type DocumentOperation,
  type DocumentRevision,
  type InlineContent,
  type AlgorithmStepModel,
  type MathExpression,
} from "@/domain/document";
import type {
  AgentRun,
  DocumentBlock,
  DocumentDetail,
  DocumentElement,
  DocumentKind,
  DocumentSummary,
  DocumentVersion,
  RunProgressEvent,
} from "@/lib/client/types";
import {
  containsUnsafeUserFacingCopy,
  normalizeUserFacingQuestion,
} from "@/lib/user-facing-copy";
import type {
  DocumentRepository,
  StoredAgentRun,
  StoredArtifact,
  StoredDocument,
  StoredDocumentListItem,
  StoredRevisionListItem,
  StoredRunEvent,
} from "@/server/persistence";
import { runReleasesArtifact } from "@/server/artifacts/release";

const ClientBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: z.string().min(1).max(200),
    type: z.literal("heading"),
    level: z.union([z.literal(1), z.literal(2)]),
    text: z.string().max(100_000),
  }),
  z.strictObject({
    id: z.string().min(1).max(200),
    type: z.literal("paragraph"),
    text: z.string().max(100_000),
  }),
  z.strictObject({
    id: z.string().min(1).max(200),
    type: z.literal("quote"),
    text: z.string().max(100_000),
    attribution: z.string().max(1_000).optional(),
  }),
  z.strictObject({
    id: z.string().min(1).max(200),
    type: z.literal("list"),
    items: z.array(z.string().max(100_000)).max(1_000),
  }),
  z.strictObject({
    id: z.string().min(1).max(200),
    type: z.literal("equation"),
    expression: z.string().max(10_000),
    caption: z.string().max(1_000).optional(),
  }),
]);

export const ClientDocumentPatchSchema = z
  .object({
    baseRevision: z.number().int().positive(),
    title: z.string().max(1_000).optional(),
    eyebrow: z.string().max(1_000).optional(),
    author: z.string().max(1_000).optional(),
    blocks: z.array(ClientBlockSchema).max(10_000).optional(),
    status: z.enum(["draft", "working", "ready"]).optional(),
  })
  .strict();

type ClientDocumentPatchInput = z.infer<typeof ClientDocumentPatchSchema>;

type ApiDocumentDetail = DocumentDetail & {
  revision: number;
  artifactUrl?: string;
};

export function createEmptyDocument(input: {
  id: string;
  prompt: string;
  /** Omitted by the UI: the request text alone decides the kind. */
  kind?: DocumentKind;
  now?: string;
}): DocumentModel {
  const now = input.now ?? new Date().toISOString();
  const normalizedPrompt = input.prompt.normalize("NFKC").replace(/\s+/g, " ").trim();
  const kind = input.kind ?? inferDocumentKind(normalizedPrompt);
  const title = deriveTitle(normalizedPrompt, kind);
  return DocumentSchema.parse({
    schemaVersion: 1,
    id: input.id,
    metadata: {
      title,
      subtitle: kindLabel(kind),
      language: "ja",
      documentType: kindToDocumentType(kind),
      authors: [],
      keywords: [],
      createdAt: now,
      updatedAt: now,
    },
    root: [],
    nodes: [],
  });
}

export function toDocumentSummary(
  stored: StoredDocument | StoredDocumentListItem,
  hasCurrentArtifact = false,
): DocumentSummary {
  const documentType =
    "documentType" in stored
      ? stored.documentType
      : stored.document.metadata.documentType;
  const hasContent =
    "hasContent" in stored ? stored.hasContent : stored.document.root.length > 0;
  const preview =
    "preview" in stored ? stored.preview : documentPreview(stored.document);
  return {
    id: stored.id,
    title: stored.title,
    kind: documentTypeToKind(documentType),
    status: hasCurrentArtifact ? "ready" : hasContent ? "working" : "draft",
    updatedAt: stored.updatedAt,
    preview,
  };
}

export function toDocumentDetail(input: {
  stored: StoredDocument;
  revisions: StoredRevisionListItem[];
  runs: StoredAgentRun[];
  presentedRuns?: AgentRun[];
  artifact: StoredArtifact | null;
  completedRun?: StoredAgentRun | null;
}): ApiDocumentDetail {
  const { stored, revisions, runs, presentedRuns, artifact, completedRun = null } = input;
  const releasedArtifact = runReleasesArtifact(completedRun, artifact)
    ? artifact
    : null;
  // The inline preview also covers the owner's draft compiles (manual edits,
  // restores): any current-revision artifact is viewable by its owner.
  const currentArtifact =
    artifact && artifact.revision === stored.currentRevision ? artifact : null;
  const artifactBase = currentArtifact
    ? `/api/documents/${encodeURIComponent(stored.id)}/artifacts/${currentArtifact.revision}/${currentArtifact.sha256}`
    : null;
  return {
    ...toDocumentSummary(
      stored,
      releasedArtifact?.revision === stored.currentRevision,
    ),
    revision: stored.currentRevision,
    eyebrow: stored.document.metadata.subtitle,
    author: stored.document.metadata.authors[0]?.name,
    blocks: documentToBlocks(stored.document),
    elements: documentToElements(stored.document),
    versions: revisions.map(toVersion),
    runs: presentedRuns ?? runs.map(toAgentRun),
    ...(releasedArtifact?.revision === stored.currentRevision
      ? {
          artifactUrl: `/api/documents/${encodeURIComponent(stored.id)}/artifacts/${releasedArtifact.revision}/${releasedArtifact.sha256}`,
        }
      : {}),
    ...(artifactBase
      ? {
          previewUrl: `${artifactBase}/preview`,
          regionsUrl: `${artifactBase}/regions`,
        }
      : {}),
  };
}

export function createDomainPatchFromClient(input: {
  current: StoredDocument;
  patch: ClientDocumentPatchInput;
  now?: string;
}): { patch: ReturnType<typeof DocumentPatchSchema.parse>; next: DocumentRevision } | null {
  const currentDocument = input.current.document;
  const operations: DocumentOperation[] = [];
  const now = input.now ?? new Date().toISOString();

  const nextMetadata = structuredClone(currentDocument.metadata);
  let metadataChanged = false;
  if (input.patch.title !== undefined) {
    const title = input.patch.title.trim() || "無題の文書";
    if (title !== nextMetadata.title) {
      nextMetadata.title = title;
      metadataChanged = true;
    }
  }
  if (input.patch.eyebrow !== undefined) {
    const subtitle = input.patch.eyebrow.trim() || undefined;
    if (subtitle !== nextMetadata.subtitle) {
      nextMetadata.subtitle = subtitle;
      metadataChanged = true;
    }
  }
  if (input.patch.author !== undefined) {
    const name = input.patch.author.trim();
    const currentName = nextMetadata.authors[0]?.name ?? "";
    if (name !== currentName) {
      nextMetadata.authors = name
        ? [
            {
              id: nextMetadata.authors[0]?.id ?? randomUUID(),
              name,
            },
          ]
        : [];
      metadataChanged = true;
    }
  }
  if (metadataChanged) {
    nextMetadata.updatedAt = now;
    operations.push({ op: "setMetadata", metadata: nextMetadata });
  }

  if (input.patch.blocks) {
    operations.push(...blocksToOperations(currentDocument, input.patch.blocks));
  }
  if (operations.length === 0) return null;

  const patch = DocumentPatchSchema.parse({
    id: randomUUID(),
    documentId: currentDocument.id,
    baseRevision: input.patch.baseRevision,
    createdAt: now,
    operations,
  });
  const currentRevision: DocumentRevision = {
    revisionId: stableRevisionId(currentDocument.id, input.current.currentRevision),
    revision: input.current.currentRevision,
    parentRevisionId:
      input.current.currentRevision > 1
        ? stableRevisionId(currentDocument.id, input.current.currentRevision - 1)
        : null,
    committedAt: input.current.updatedAt,
    document: currentDocument,
  };
  return { patch, next: applyDocumentPatch(currentRevision, patch) };
}

function blocksToOperations(document: DocumentModel, blocks: DocumentBlock[]): DocumentOperation[] {
  const operations: DocumentOperation[] = [];
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  const projectedBlocks = documentToBlocks(document);
  const projectedById = new Map(projectedBlocks.map((block) => [block.id, block]));
  const visibleIds = projectedBlocks.map((block) => block.id);
  const incomingIds = new Set(blocks.map((block) => block.id));

  for (const nodeId of [...visibleIds].reverse()) {
    if (!incomingIds.has(nodeId) && nodeById.has(nodeId)) operations.push({ op: "delete", nodeId });
  }

  let appended = 0;
  for (const block of blocks) {
    const current = nodeById.get(block.id);
    if (current) {
      const projected = projectedById.get(block.id);
      if (projected && JSON.stringify(projected) === JSON.stringify(block)) continue;
      assertPlainTextEditable(current, block);
      const updated = updateNodeFromBlock(current, block);
      if (JSON.stringify(updated) !== JSON.stringify(current)) {
        operations.push({ op: "update", nodeId: current.id, node: updated });
      }
      continue;
    }

    const node = newNodeFromBlock(block);
    operations.push({
      op: "insert",
      node,
      position: { kind: "root", index: document.root.length + appended },
    });
    appended += 1;
  }
  return operations;
}

function assertPlainTextEditable(node: DocumentNode, block: DocumentBlock): void {
  const editable = (() => {
    switch (node.type) {
      case "section":
        return isPlainInline(node.title);
      case "heading":
        return node.level <= 2 && isPlainInline(node.content);
      case "paragraph":
        return isPlainInline(node.content);
      case "callout":
        return isPlainInline(node.content) && (!node.title || isPlainInline(node.title));
      case "list":
        return (
          (block.type === "list" && block.items.length === 0) ||
          node.items.every(
            (item) => item.children.length === 0 && isPlainInline(item.content),
          )
        );
      case "equation":
        return (
          node.expression.kind === "text" &&
          (!node.description || isPlainInline(node.description))
        );
      default:
        return false;
    }
  })();

  if (!editable) {
    throw new DocumentDomainError(
      "invalid_operation",
      "Structured content cannot be replaced through the plain-text editor.",
      { nodeId: node.id, nodeType: node.type },
    );
  }
}

function isPlainInline(content: InlineContent): boolean {
  return (
    content.length === 0 ||
    (content.length === 1 &&
      content[0]?.type === "text" &&
      content[0].marks.length === 0)
  );
}

function updateNodeFromBlock(current: DocumentNode, block: DocumentBlock): DocumentNode {
  if (current.type === "section" && block.type === "heading") {
    return { ...current, title: inline(block.text) };
  }
  if (current.type === "heading" && block.type === "heading") {
    return { ...current, level: block.level, content: inline(block.text) };
  }
  if (current.type === "paragraph" && block.type === "paragraph") {
    return { ...current, content: inline(block.text) };
  }
  if (current.type === "callout" && block.type === "quote") {
    return {
      ...current,
      content: inline(block.text),
      title: block.attribution?.trim() ? inline(block.attribution) : undefined,
    };
  }
  if (current.type === "list" && block.type === "list") {
    const items = nonEmptyListValues(block.items);
    return {
      ...current,
      items: items.map((item, index) => ({
        id: current.items[index]?.id ?? randomUUID(),
        content: inline(item),
        children: block.items.length > 0 ? current.items[index]?.children ?? [] : [],
      })),
    };
  }
  if (current.type === "equation" && block.type === "equation") {
    return {
      ...current,
      expression: textExpression(block.expression),
      description: block.caption?.trim() ? inline(block.caption) : undefined,
    };
  }
  throw new Error("Block type cannot replace the current semantic node.");
}

function newNodeFromBlock(block: DocumentBlock): DocumentNode {
  const id = z.string().uuid().safeParse(block.id).success ? block.id : randomUUID();
  switch (block.type) {
    case "heading":
      return block.level === 1
        ? { id, type: "section", title: inline(block.text), children: [] }
        : { id, type: "heading", level: block.level, content: inline(block.text) };
    case "paragraph":
      return { id, type: "paragraph", content: inline(block.text) };
    case "quote":
      return {
        id,
        type: "callout",
        tone: "note",
        content: inline(block.text),
        title: block.attribution?.trim() ? inline(block.attribution) : undefined,
      };
    case "list":
      return {
        id,
        type: "list",
        style: "bullet",
        items: nonEmptyListValues(block.items).map((item) => ({
          id: randomUUID(),
          content: inline(item),
          children: [],
        })),
      };
    case "equation":
      return {
        id,
        type: "equation",
        expression: textExpression(block.expression),
        description: block.caption?.trim() ? inline(block.caption) : undefined,
        numbered: true,
      };
  }
}

/**
 * Reading-order inventory of selectable elements for the PDF overlay and
 * outline. Numbering matches the block canvas: root sections and equations
 * count sequentially in traversal order; figures/tables get their own
 * counters. Nodes that never typeset standalone (citations, footnotes,
 * page breaks) are omitted.
 */
function documentToElements(document: DocumentModel): DocumentElement[] {
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  const elements: DocumentElement[] = [];
  let sectionNumber = 0;
  let equationNumber = 0;
  let figureNumber = 0;
  let tableNumber = 0;
  const visit = (node: DocumentNode): void => {
    switch (node.type) {
      case "section": {
        sectionNumber += 1;
        elements.push({
          id: node.id,
          kind: "section",
          label: `第${sectionNumber}節`,
          editable: true,
        });
        for (const childId of node.children) {
          const child = nodeById.get(childId);
          if (child) visit(child);
        }
        break;
      }
      case "heading":
        elements.push({ id: node.id, kind: "heading", label: "小見出し", editable: true });
        break;
      case "paragraph":
        elements.push({ id: node.id, kind: "paragraph", label: "段落", editable: true });
        break;
      case "list":
        elements.push({ id: node.id, kind: "list", label: "箇条書き", editable: true });
        break;
      case "equation": {
        equationNumber += 1;
        elements.push({
          id: node.id,
          kind: "equation",
          label: `数式 (${equationNumber})`,
          editable: true,
        });
        break;
      }
      case "callout":
        elements.push({ id: node.id, kind: "quote", label: "引用", editable: true });
        break;
      case "figure": {
        figureNumber += 1;
        elements.push({
          id: node.id,
          kind: "figure",
          label: `図${figureNumber}`,
          editable: false,
        });
        break;
      }
      case "table": {
        tableNumber += 1;
        elements.push({
          id: node.id,
          kind: "table",
          label: `表${tableNumber}`,
          editable: false,
        });
        break;
      }
      case "theorem": {
        const label = {
          definition: "定義",
          lemma: "補題",
          theorem: "定理",
          corollary: "系",
        }[node.theoremKind];
        elements.push({ id: node.id, kind: "theorem", label, editable: false });
        for (const childId of node.children) {
          const child = nodeById.get(childId);
          if (child) visit(child);
        }
        break;
      }
      case "proof":
        elements.push({ id: node.id, kind: "proof", label: "証明", editable: false });
        for (const childId of node.children) {
          const child = nodeById.get(childId);
          if (child) visit(child);
        }
        break;
      case "algorithm":
        elements.push({
          id: node.id,
          kind: "algorithm",
          label: "アルゴリズム",
          editable: false,
        });
        break;
      case "codeBlock":
        elements.push({ id: node.id, kind: "code", label: "コード", editable: false });
        break;
      case "appendix":
        elements.push({ id: node.id, kind: "appendix", label: "付録", editable: false });
        for (const childId of node.children) {
          const child = nodeById.get(childId);
          if (child) visit(child);
        }
        break;
      case "bibliography":
        elements.push({
          id: node.id,
          kind: "bibliography",
          label: "参考文献",
          editable: false,
        });
        break;
      case "citation":
      case "footnote":
      case "pageBreak":
        break;
    }
  };
  for (const nodeId of document.root) {
    const node = nodeById.get(nodeId);
    if (node) visit(node);
  }
  return elements;
}

function documentToBlocks(document: DocumentModel): DocumentBlock[] {
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  const blocks: DocumentBlock[] = [];
  const visit = (node: DocumentNode): void => {
    switch (node.type) {
      case "section":
        blocks.push({ id: node.id, type: "heading", level: 1, text: inlinePlainText(node.title) });
        for (const childId of node.children) {
          const child = nodeById.get(childId);
          if (child) visit(child);
        }
        break;
      case "heading":
        blocks.push({ id: node.id, type: "heading", level: node.level === 1 ? 1 : 2, text: inlinePlainText(node.content) });
        break;
      case "paragraph":
        blocks.push({ id: node.id, type: "paragraph", text: inlinePlainText(node.content) });
        break;
      case "list":
        blocks.push({ id: node.id, type: "list", items: node.items.map((item) => inlinePlainText(item.content)) });
        break;
      case "equation":
        blocks.push({
          id: node.id,
          type: "equation",
          expression: mathPlainText(node.expression),
          caption: node.description ? inlinePlainText(node.description) : undefined,
        });
        break;
      case "callout":
        blocks.push({
          id: node.id,
          type: "quote",
          text: inlinePlainText(node.content),
          attribution: node.title ? inlinePlainText(node.title) : undefined,
        });
        break;
      case "theorem": {
        const label = {
          definition: "定義",
          lemma: "補題",
          theorem: "定理",
          corollary: "系",
        }[node.theoremKind];
        const title = node.title ? inlinePlainText(node.title) : "";
        blocks.push({
          id: node.id,
          type: "quote",
          text: title || label,
          attribution: title ? label : undefined,
        });
        for (const childId of node.children) {
          const child = nodeById.get(childId);
          if (child) visit(child);
        }
        break;
      }
      case "proof": {
        const title = node.title ? inlinePlainText(node.title) : "証明";
        blocks.push({ id: node.id, type: "quote", text: title });
        for (const childId of node.children) {
          const child = nodeById.get(childId);
          if (child) visit(child);
        }
        break;
      }
      case "algorithm":
        blocks.push({
          id: node.id,
          type: "list",
          items: [
            inlinePlainText(node.title),
            ...(node.description ? [inlinePlainText(node.description)] : []),
            ...(node.inputs ? [`入力: ${inlinePlainText(node.inputs)}`] : []),
            ...(node.outputs ? [`出力: ${inlinePlainText(node.outputs)}`] : []),
            ...algorithmStepText(node.steps),
          ].filter(Boolean),
        });
        break;
      case "codeBlock":
        blocks.push({
          id: node.id,
          type: "paragraph",
          text: [
            ...(node.caption ? [inlinePlainText(node.caption)] : []),
            node.code,
          ]
            .filter(Boolean)
            .join("\n"),
        });
        break;
      case "appendix":
        blocks.push({
          id: node.id,
          type: "heading",
          level: 1,
          text: inlinePlainText(node.title),
        });
        for (const childId of node.children) {
          const child = nodeById.get(childId);
          if (child) visit(child);
        }
        break;
      case "bibliography":
      case "citation":
      case "footnote":
      case "pageBreak":
      case "figure":
      case "table":
        break;
    }
  };
  for (const nodeId of document.root) {
    const node = nodeById.get(nodeId);
    if (node) visit(node);
  }
  return blocks;
}

function algorithmStepText(steps: readonly AlgorithmStepModel[]): string[] {
  return steps.flatMap((step) => [
    inlinePlainText(step.content),
    ...algorithmStepText(step.children),
  ]);
}

function inline(value: string): InlineContent {
  return value.length > 0 ? [{ type: "text", text: value, marks: [] }] : [];
}

function nonEmptyListValues(items: readonly string[]): readonly string[] {
  return items.length > 0 ? items : [""];
}

function inlinePlainText(content: InlineContent): string {
  return content
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "hardBreak") return "\n";
      if (item.type === "inlineMath") return mathPlainText(item.expression);
      return "";
    })
    .join("");
}

function textExpression(value: string): MathExpression {
  return { kind: "text", value: value || " " };
}

function mathPlainText(expression: MathExpression): string {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "symbol":
      return expression.name;
    case "text":
      return expression.value;
    case "unary":
      return `${expression.operator}(${mathPlainText(expression.operand)})`;
    case "binary":
      return `${mathPlainText(expression.left)} ${mathOperator(expression.operator)} ${mathPlainText(expression.right)}`;
    case "function":
      return `${expression.name}(${expression.arguments.map(mathPlainText).join(", ")})`;
    case "sequence":
      return expression.items.map(mathPlainText).join(" ");
    case "script": {
      const subscript = expression.subscript
        ? `_${mathPlainText(expression.subscript)}`
        : "";
      const superscript = expression.superscript
        ? `^${mathPlainText(expression.superscript)}`
        : "";
      return `${mathPlainText(expression.base)}${subscript}${superscript}`;
    }
    case "root":
      return expression.index
        ? `${mathPlainText(expression.index)}√(${mathPlainText(expression.radicand)})`
        : `√(${mathPlainText(expression.radicand)})`;
    case "integral": {
      const bounds =
        expression.lowerBound && expression.upperBound
          ? `_${mathPlainText(expression.lowerBound)}^${mathPlainText(expression.upperBound)}`
          : "";
      return `∫${bounds} ${mathPlainText(expression.integrand)} d${mathPlainText(expression.variable)}`;
    }
    case "largeOperator": {
      const operator = expression.operator === "sum" ? "Σ" : "Π";
      const bounds =
        expression.index && expression.lowerBound && expression.upperBound
          ? `_${mathPlainText(expression.index)}=${mathPlainText(expression.lowerBound)}^${mathPlainText(expression.upperBound)}`
          : "";
      return `${operator}${bounds} ${mathPlainText(expression.expression)}`;
    }
    case "limit": {
      const direction =
        expression.direction === "left"
          ? "−"
          : expression.direction === "right"
            ? "+"
            : "";
      return `lim ${mathPlainText(expression.variable)}→${mathPlainText(expression.approaches)}${direction} ${mathPlainText(expression.expression)}`;
    }
    case "partialDerivative": {
      const variables = expression.variables
        .map(({ variable, order }) =>
          `${mathPlainText(variable)}${order === 1 ? "" : `^${order}`}`,
        )
        .join(" ");
      return `∂ ${mathPlainText(expression.expression)} / ∂ ${variables}`;
    }
    case "vector": {
      const separator = expression.orientation === "row" ? ", " : "; ";
      return `[${expression.entries.map(mathPlainText).join(separator)}]`;
    }
    case "matrix":
      return `[${expression.rows
        .map((row) => row.map(mathPlainText).join(", "))
        .join("; ")}]`;
    case "cases":
      return expression.cases
        .map(
          (item) =>
            `${mathPlainText(item.expression)} (${mathPlainText(item.condition)})`,
        )
        .join("; ");
    case "aligned":
      return expression.lines
        .map(
          (line) =>
            `${mathPlainText(line.left)} ${mathOperator(line.relation)} ${mathPlainText(line.right)}${line.annotation ? ` (${line.annotation})` : ""}`,
        )
        .join("; ");
    case "accent":
      return `${expression.accent}(${mathPlainText(expression.expression)})`;
    case "derivative":
      return `d${expression.order === 1 ? "" : `^${expression.order}`} ${mathPlainText(expression.expression)} / d${mathPlainText(expression.variable)}${expression.order === 1 ? "" : `^${expression.order}`}`;
    case "set":
      return expression.elements.length === 0
        ? "∅"
        : `{${expression.elements.map(mathPlainText).join(", ")}}`;
    case "setBuilder":
      return `{${mathPlainText(expression.variable)} | ${mathPlainText(expression.condition)}}`;
    case "quantified":
      return `${
        expression.quantifier === "forAll"
          ? "∀"
          : expression.quantifier === "exists"
            ? "∃"
            : "∃!"
      } ${mathPlainText(expression.variable)}${expression.domain ? ` ∈ ${mathPlainText(expression.domain)}` : ""}: ${mathPlainText(expression.predicate)}`;
    case "binomial":
      return `C(${mathPlainText(expression.upper)}, ${mathPlainText(expression.lower)})`;
    case "statisticalOperator": {
      const operator = {
        probability: "P",
        expectation: "E",
        variance: "Var",
        covariance: "Cov",
      }[expression.operator];
      return `${operator}${expression.subscript ? `_${mathPlainText(expression.subscript)}` : ""}[${mathPlainText(expression.expression)}${expression.condition ? ` | ${mathPlainText(expression.condition)}` : ""}]`;
    }
  }
}

function mathOperator(operator: Extract<MathExpression, { kind: "binary" }>["operator"]): string {
  return {
    add: "+",
    subtract: "−",
    multiply: "×",
    divide: "÷",
    power: "^",
    equals: "=",
    approximatelyEquals: "≈",
    lessThan: "<",
    lessThanOrEqual: "≤",
    greaterThan: ">",
    greaterThanOrEqual: "≥",
    notEquals: "≠",
    in: "∈",
    notIn: "∉",
    subset: "⊂",
    subsetOrEqual: "⊆",
    superset: "⊃",
    supersetOrEqual: "⊇",
    union: "∪",
    intersection: "∩",
    setDifference: "∖",
    and: "∧",
    or: "∨",
    implies: "⇒",
    ifAndOnlyIf: "⇔",
    proportionalTo: "∝",
  }[operator];
}

function documentPreview(document: DocumentModel): string {
  for (const node of document.nodes) {
    if (node.type === "paragraph" || node.type === "callout") {
      const text = inlinePlainText(node.content).trim();
      if (text) return text.slice(0, 120);
    }
  }
  return "文書の作成を始めます。";
}

function toVersion(revision: StoredRevisionListItem): DocumentVersion {
  // Revision summaries written by the agent are model-authored text; the
  // history panel renders them verbatim, so unsafe copy falls back.
  const summary = revision.summary.trim();
  const label =
    summary.length > 0 &&
    summary.length <= 200 &&
    !containsUnsafeUserFacingCopy(summary)
      ? summary
      : revision.actor === "agent"
        ? "AIによる更新"
        : "手動編集";
  return {
    id: `${revision.documentId}:${revision.revision}`,
    revision: revision.revision,
    label,
    createdAt: revision.createdAt,
    source: revision.actor === "agent" ? "agent" : "manual",
  };
}

function userFacingNeedsInputNote(run: StoredAgentRun): string {
  return normalizeUserFacingQuestion(
    run.errorMessage,
    "clarification_required",
  );
}

/**
 * Failed runs may carry a user-facing explanation (for example the
 * missing-model configuration message). Anything that trips the internal-copy
 * filter falls back to the client's fixed failure copy instead.
 */
function userFacingFailureNote(run: StoredAgentRun): string | undefined {
  const message = run.errorMessage?.trim();
  if (
    !message ||
    message.length > 500 ||
    containsUnsafeUserFacingCopy(message)
  ) {
    return undefined;
  }
  return message;
}

export function toAgentRun(run: StoredAgentRun): AgentRun {
  // Historical runs persisted by the removed approval flow also stored
  // status "waiting_approval"; both render as an awaiting-answer question.
  const needsInput = run.status === "waiting_approval" || run.stage === "needs_input";
  return {
    id: run.id,
    documentId: run.documentId,
    prompt: run.prompt,
    stage: run.stage,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    resultNote:
      run.status === "completed"
        ? (run.resultNote ??
          (run.resultRevision === run.baseRevision
            ? "文書を確認しました"
            : "文書を更新しました"))
        : needsInput
          ? userFacingNeedsInputNote(run)
        : run.status === "failed"
          ? userFacingFailureNote(run)
          : undefined,
  };
}

export function presentAgentRun(run: StoredAgentRun): AgentRun {
  const presented = toAgentRun(run);
  return {
    ...presented,
    inputKind:
      run.status === "waiting_approval" && run.stage === "needs_input"
        ? "clarification"
        : null,
  };
}

/**
 * Project stored run events onto the client contract. Only the semantic
 * stage, its fixed label, ordering, and the repair-attempt counter survive;
 * internal detail (event keys, failure codes, issue counts) stays server-side.
 */
export function presentRunEvents(
  events: readonly StoredRunEvent[],
): RunProgressEvent[] {
  return events.map((event) => {
    const attempt =
      typeof event.detail?.attempt === "number" &&
      Number.isInteger(event.detail.attempt) &&
      event.detail.attempt > 0
        ? event.detail.attempt
        : undefined;
    return {
      stage: event.stage,
      label: event.message,
      sequence: event.sequence,
      occurredAt: event.createdAt,
      ...(attempt === undefined ? {} : { attempt }),
    };
  });
}

export function presentAgentRuns(
  runs: readonly StoredAgentRun[],
): AgentRun[] {
  return runs.map(presentAgentRun);
}

function stableRevisionId(documentId: string, revision: number): string {
  const hex = createHash("sha256").update(`${documentId}:${revision}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function deriveTitle(prompt: string, kind: DocumentKind): string {
  const quoted = prompt.match(/[「『]([^」』]{1,80})[」』]/)?.[1];
  if (quoted) return quoted;
  const stripped = prompt
    .replace(
      /(?:について|に関する|の)?(?:企画書|提案書|報告書|論文|メモ|文書)(?:を|に)?(?:まとめて|作って|書いて|作成して|執筆して|生成して).*$/u,
      "",
    )
    .trim();
  return (stripped || `新しい${kindLabel(kind)}`).slice(0, 80);
}

function kindLabel(kind: DocumentKind): string {
  // `proposal` stays the wire/enum value; 企画書 is the Japanese label users see.
  return { proposal: "企画書", report: "報告書", paper: "論文", memo: "メモ" }[kind];
}

/**
 * Picks the document kind from the request text so the user never has to pick
 * one up front. Explicit document nouns ("企画書", "論文") outrank topical
 * hints ("研究", "提案"); nothing matching falls back to the previous default.
 */
const KIND_SIGNALS: ReadonlyArray<{
  kind: DocumentKind;
  strong: RegExp;
  weak: RegExp;
}> = [
  {
    kind: "proposal",
    strong: /企画書|提案書|proposal/iu,
    weak: /企画|提案|ピッチ|pitch|plan\b/iu,
  },
  {
    kind: "report",
    strong: /報告書|レポート|report/iu,
    weak: /報告|調査|analysis|分析結果|実験結果/iu,
  },
  {
    kind: "paper",
    strong: /論文|paper|thesis|dissertation/iu,
    weak: /研究|学会|査読|arxiv|preprint/iu,
  },
  {
    kind: "memo",
    strong: /メモ|議事録|覚書|memo\b|notes?\b/iu,
    weak: /要点|箇条書き|下書き|走り書き/iu,
  },
];

const DEFAULT_DOCUMENT_KIND: DocumentKind = "paper";

export function inferDocumentKind(prompt: string): DocumentKind {
  const text = prompt.normalize("NFKC");
  for (const signal of KIND_SIGNALS) {
    if (signal.strong.test(text)) return signal.kind;
  }
  for (const signal of KIND_SIGNALS) {
    if (signal.weak.test(text)) return signal.kind;
  }
  return DEFAULT_DOCUMENT_KIND;
}

function kindToDocumentType(kind: DocumentKind): DocumentModel["metadata"]["documentType"] {
  const documentTypes = {
    proposal: "proposal",
    report: "report",
    paper: "paper",
    memo: "notes",
  } as const satisfies Record<
    DocumentKind,
    DocumentModel["metadata"]["documentType"]
  >;
  return documentTypes[kind];
}

function documentTypeToKind(type: DocumentModel["metadata"]["documentType"]): DocumentKind {
  if (type === "paper") return "paper";
  if (type === "notes" || type === "letter") return "memo";
  if (type === "report") return "report";
  if (type === "proposal") return "proposal";
  return "proposal";
}

import {
  DocumentPatchSchema,
  DocumentRevisionSchema,
  isContainerNode,
  isDefinitionNode,
  isStructuralNode,
  requiresDocumentSchemaV2,
  type DocumentModel,
  type DocumentNode,
  type DocumentOperation,
  type DocumentPatch,
  type DocumentPosition,
  type DocumentRevision,
  type StableId,
} from "./schema";
import { DocumentConflictError, DocumentDomainError } from "./errors";
import { validateDocument } from "./validate";

function parseRevision(input: unknown): DocumentRevision {
  const parsed = DocumentRevisionSchema.safeParse(input);
  if (!parsed.success) {
    throw new DocumentDomainError("invalid_document", "Current document revision is invalid", {
      issues: parsed.error.issues,
    });
  }
  const document = validateDocument(parsed.data.document);
  return { ...parsed.data, document };
}

function parsePatch(input: unknown): DocumentPatch {
  const parsed = DocumentPatchSchema.safeParse(input);
  if (!parsed.success) {
    throw new DocumentDomainError("invalid_patch", "Document patch is invalid", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function findNode(document: DocumentModel, nodeId: StableId): DocumentNode | undefined {
  return document.nodes.find((node) => node.id === nodeId);
}

function requireNode(document: DocumentModel, nodeId: StableId): DocumentNode {
  const node = findNode(document, nodeId);
  if (!node) {
    throw new DocumentDomainError("missing_node", `Node ${nodeId} does not exist`, { nodeId });
  }
  return node;
}

function requireContainerChildren(
  document: DocumentModel,
  parentId: StableId,
  sectionOnly: boolean,
): StableId[] {
  const parent = requireNode(document, parentId);
  if (!isContainerNode(parent) || (sectionOnly && parent.type !== "section")) {
    throw new DocumentDomainError(
      "invalid_position",
      sectionOnly
        ? `Node ${parentId} is not a section and cannot contain children`
        : `Node ${parentId} cannot contain document children`,
      { parentId },
    );
  }
  return parent.children;
}

function structuralContainer(
  document: DocumentModel,
  position: Exclude<DocumentPosition, { kind: "definitions" }>,
): StableId[] {
  if (position.kind === "root") return document.root;
  return requireContainerChildren(
    document,
    position.parentId,
    position.kind === "section",
  );
}

function assertInsertIndex(container: StableId[], index: number): void {
  if (index > container.length) {
    throw new DocumentDomainError(
      "invalid_position",
      `Insertion index ${index} exceeds container length ${container.length}`,
      { index, containerLength: container.length },
    );
  }
}

function insertOperation(document: DocumentModel, operation: Extract<DocumentOperation, { op: "insert" }>) {
  if (findNode(document, operation.node.id)) {
    throw new DocumentDomainError("duplicate_id", `Node ${operation.node.id} already exists`, {
      nodeId: operation.node.id,
    });
  }

  if (operation.position.kind === "definitions") {
    if (!isDefinitionNode(operation.node)) {
      throw new DocumentDomainError(
        "invalid_position",
        `Structural node ${operation.node.id} cannot be inserted as a definition`,
        { nodeId: operation.node.id },
      );
    }
    document.nodes.push(structuredClone(operation.node));
    return;
  }

  if (!isStructuralNode(operation.node)) {
    throw new DocumentDomainError(
      "invalid_position",
      `Definition node ${operation.node.id} cannot be placed in document structure`,
      { nodeId: operation.node.id },
    );
  }
  const container = structuralContainer(document, operation.position);
  assertInsertIndex(container, operation.position.index);
  document.nodes.push(structuredClone(operation.node));
  container.splice(operation.position.index, 0, operation.node.id);
}

function updateOperation(document: DocumentModel, operation: Extract<DocumentOperation, { op: "update" }>) {
  const index = document.nodes.findIndex((node) => node.id === operation.nodeId);
  if (index < 0) {
    throw new DocumentDomainError("missing_node", `Node ${operation.nodeId} does not exist`, {
      nodeId: operation.nodeId,
    });
  }
  const current = document.nodes[index];
  if (!current) {
    throw new DocumentDomainError("missing_node", `Node ${operation.nodeId} does not exist`, {
      nodeId: operation.nodeId,
    });
  }
  if (operation.node.id !== operation.nodeId) {
    throw new DocumentDomainError("invalid_operation", "An update cannot change a stable node ID", {
      nodeId: operation.nodeId,
      replacementId: operation.node.id,
    });
  }
  if (operation.node.type !== current.type) {
    throw new DocumentDomainError("invalid_operation", "An update cannot change a node type", {
      nodeId: operation.nodeId,
      currentType: current.type,
      replacementType: operation.node.type,
    });
  }
  document.nodes[index] = structuredClone(operation.node);
}

function findCurrentContainer(document: DocumentModel, nodeId: StableId): StableId[] | undefined {
  if (document.root.includes(nodeId)) return document.root;
  for (const node of document.nodes) {
    if (isContainerNode(node) && node.children.includes(nodeId)) return node.children;
  }
  return undefined;
}

function moveOperation(document: DocumentModel, operation: Extract<DocumentOperation, { op: "move" }>) {
  const node = requireNode(document, operation.nodeId);
  if (!isStructuralNode(node)) {
    throw new DocumentDomainError("invalid_operation", "Definition nodes cannot be moved into structure", {
      nodeId: operation.nodeId,
    });
  }
  const source = findCurrentContainer(document, operation.nodeId);
  if (!source) {
    throw new DocumentDomainError("invalid_position", `Node ${operation.nodeId} has no structural parent`, {
      nodeId: operation.nodeId,
    });
  }
  const sourceIndex = source.indexOf(operation.nodeId);
  source.splice(sourceIndex, 1);

  const destination = structuralContainer(document, operation.position);
  assertInsertIndex(destination, operation.position.index);
  destination.splice(operation.position.index, 0, operation.nodeId);
}

function collectStructuralSubtree(
  document: DocumentModel,
  nodeId: StableId,
  collected: Set<StableId>,
): void {
  if (collected.has(nodeId)) return;
  collected.add(nodeId);
  const node = findNode(document, nodeId);
  if (node && isContainerNode(node)) {
    for (const childId of node.children) collectStructuralSubtree(document, childId, collected);
  }
}

function deleteOperation(document: DocumentModel, operation: Extract<DocumentOperation, { op: "delete" }>) {
  const node = requireNode(document, operation.nodeId);
  const deletedIds = new Set<StableId>();
  if (isStructuralNode(node)) collectStructuralSubtree(document, node.id, deletedIds);
  else deletedIds.add(node.id);

  document.root = document.root.filter((id) => !deletedIds.has(id));
  for (const candidate of document.nodes) {
    if (isContainerNode(candidate)) {
      candidate.children = candidate.children.filter((id) => !deletedIds.has(id));
    }
  }
  document.nodes = document.nodes.filter((candidate) => !deletedIds.has(candidate.id));
}

function applyOperation(document: DocumentModel, operation: DocumentOperation): void {
  switch (operation.op) {
    case "insert":
      insertOperation(document, operation);
      break;
    case "update":
      updateOperation(document, operation);
      break;
    case "move":
      moveOperation(document, operation);
      break;
    case "delete":
      deleteOperation(document, operation);
      break;
    case "setMetadata":
      document.metadata = structuredClone(operation.metadata);
      break;
  }
}

/**
 * Applies a patch to an immutable revision. Operations are evaluated in order
 * against a private draft and the result is validated only after every
 * operation has succeeded. The caller's revision is therefore never partially
 * modified. Move indexes are interpreted after removing the source node.
 */
export function applyDocumentPatch(
  currentInput: DocumentRevision,
  patchInput: DocumentPatch,
): DocumentRevision {
  const current = parseRevision(currentInput);
  const patch = parsePatch(patchInput);

  if (patch.documentId !== current.document.id) {
    throw new DocumentDomainError("document_mismatch", "Patch targets a different document", {
      expectedDocumentId: current.document.id,
      patchDocumentId: patch.documentId,
    });
  }
  if (patch.baseRevision !== current.revision) {
    throw new DocumentConflictError(patch.baseRevision, current.revision);
  }
  if (patch.id === current.revisionId) {
    throw new DocumentDomainError("duplicate_revision", "Patch ID is already the current revision ID", {
      patchId: patch.id,
    });
  }

  const draft = structuredClone(current.document);
  for (const operation of patch.operations) applyOperation(draft, operation);
  if (draft.schemaVersion === 1 && requiresDocumentSchemaV2(draft)) {
    draft.schemaVersion = 2;
  }
  draft.metadata.updatedAt = patch.createdAt;
  const validatedDocument = validateDocument(draft);

  return DocumentRevisionSchema.parse({
    revisionId: patch.id,
    revision: current.revision + 1,
    parentRevisionId: current.revisionId,
    committedAt: patch.createdAt,
    document: validatedDocument,
  });
}

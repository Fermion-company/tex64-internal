import {
  CitationNodeSchema,
  DocumentPatchSchema,
  StableIdSchema,
  type DocumentModel,
  type DocumentNode,
  type DocumentPatch,
} from "@/domain/document";
import { canonicalDoiLocator, normalizeDoi } from "./canonicalize";
import { SourceRecordSchema, canSourceSupportClaims, type SourceRecord } from "./schema";

type CitationNode = Extract<DocumentNode, { type: "citation" }>;

export type SourceProvenanceErrorCode =
  | "invalid_document_patch"
  | "citation_source_required"
  | "citation_source_not_found"
  | "citation_source_not_verified"
  | "citation_source_scope_mismatch"
  | "citation_metadata_incomplete"
  | "citation_type_change";

export class SourceProvenanceError extends Error {
  readonly code: SourceProvenanceErrorCode;
  readonly operationIndex?: number;
  readonly sourceId?: string;

  constructor(
    code: SourceProvenanceErrorCode,
    message: string,
    details: { operationIndex?: number; sourceId?: string } = {},
  ) {
    super(message);
    this.name = "SourceProvenanceError";
    this.code = code;
    this.operationIndex = details.operationIndex;
    this.sourceId = details.sourceId;
  }
}

export type CanonicalCitationMetadata = Omit<CitationNode, "id" | "type">;

interface CitationMutationPlan {
  operationIndex: number;
  sourceId: string;
}

const MAX_CITATION_SOURCES_PER_PATCH = 100;

function normalizedCitationText(value: string, maximum: number): string | undefined {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .normalize("NFC");
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function citationYear(publishedAt: string | undefined): string | undefined {
  const match = /^(\d{4})(?:$|-)/.exec(publishedAt ?? "");
  return match?.[1];
}

/**
 * Produces the only citation metadata accepted by the commit boundary. Model
 * supplied authors, titles, dates and locators are never retained.
 */
export function canonicalCitationMetadataFromSource(
  rawSource: SourceRecord,
): CanonicalCitationMetadata {
  const parsed = SourceRecordSchema.safeParse(rawSource);
  if (!parsed.success) {
    throw new SourceProvenanceError(
      "citation_source_not_verified",
      "The citation source record is invalid",
      { sourceId: rawSource.id },
    );
  }
  const source = parsed.data;
  if (!canSourceSupportClaims(source)) {
    throw new SourceProvenanceError(
      "citation_source_not_verified",
      "The citation source has no verified evidence content",
      { sourceId: source.id },
    );
  }

  if (source.metadata.authors.length === 0 || source.metadata.authors.length > 100) {
    throw new SourceProvenanceError(
      "citation_metadata_incomplete",
      "The verified source has no bounded author list",
      { sourceId: source.id },
    );
  }
  const authors = source.metadata.authors.map((author) =>
    normalizedCitationText(author.name, 1_000),
  );
  if (authors.some((author) => !author)) {
    throw new SourceProvenanceError(
      "citation_metadata_incomplete",
      "The verified source has an invalid author name",
      { sourceId: source.id },
    );
  }
  const title = normalizedCitationText(source.metadata.title ?? "", 1_000);
  const year = citationYear(source.metadata.publishedAt);
  if (!title || !year) {
    throw new SourceProvenanceError(
      "citation_metadata_incomplete",
      "The verified source requires a title and four-digit publication year",
      { sourceId: source.id },
    );
  }

  const publication = source.metadata.publication
    ? normalizedCitationText(source.metadata.publication, 1_000)
    : undefined;
  if (source.metadata.publication && !publication) {
    throw new SourceProvenanceError(
      "citation_metadata_incomplete",
      "The verified source publication is invalid",
      { sourceId: source.id },
    );
  }
  const optionalFields = {
    publisher: source.metadata.publisher,
    volume: source.metadata.volume,
    issue: source.metadata.issue,
    pages: source.metadata.pages,
  } as const;
  const normalizedOptional = Object.fromEntries(
    Object.entries(optionalFields).flatMap(([key, value]) => {
      if (!value) return [];
      const normalized = normalizedCitationText(value, 1_000);
      if (!normalized) {
        throw new SourceProvenanceError(
          "citation_metadata_incomplete",
          `The verified source ${key} is invalid`,
          { sourceId: source.id },
        );
      }
      return [[key, normalized]];
    }),
  ) as Partial<Record<keyof typeof optionalFields, string>>;
  const sourceLanguage = source.metadata.language?.normalize("NFKC").trim();
  const safeSourceLanguage =
    sourceLanguage &&
    /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(sourceLanguage)
      ? sourceLanguage
      : undefined;
  const doi = source.metadata.doi ? normalizeDoi(source.metadata.doi) : undefined;
  if (source.metadata.doi && !doi) {
    throw new SourceProvenanceError(
      "citation_metadata_incomplete",
      "The verified source DOI is invalid",
      { sourceId: source.id },
    );
  }
  if (source.kind === "doi") {
    if (!doi || canonicalDoiLocator(doi) !== source.canonicalLocator) {
      throw new SourceProvenanceError(
        "citation_metadata_incomplete",
        "The verified DOI metadata does not match its canonical locator",
        { sourceId: source.id },
      );
    }
  }
  if (source.canonicalLocator.length > 2_000) {
    throw new SourceProvenanceError(
      "citation_metadata_incomplete",
      "The verified source locator is too long for a citation",
      { sourceId: source.id },
    );
  }

  return {
    sourceId: source.id,
    authors: authors as string[],
    title,
    year,
    ...(publication ? { publication } : {}),
    ...normalizedOptional,
    ...(source.metadata.workType
      ? { sourceType: source.metadata.workType }
      : {}),
    ...(safeSourceLanguage ? { sourceLanguage: safeSourceLanguage } : {}),
    ...(doi ? { doi } : {}),
    url: source.canonicalLocator,
  };
}

function citationMutationPlan(
  document: DocumentModel,
  patch: DocumentPatch,
): CitationMutationPlan[] {
  if (patch.documentId !== document.id) {
    throw new SourceProvenanceError(
      "invalid_document_patch",
      "The citation patch belongs to a different document",
    );
  }
  const nodeState = new Map<string, DocumentNode>();
  for (const node of document.nodes) {
    if (nodeState.has(node.id)) {
      throw new SourceProvenanceError(
        "invalid_document_patch",
        "The document contains duplicate node identifiers",
      );
    }
    nodeState.set(node.id, node);
  }

  const plans: CitationMutationPlan[] = [];
  for (const [operationIndex, operation] of patch.operations.entries()) {
    switch (operation.op) {
      case "insert": {
        if (nodeState.has(operation.node.id)) {
          throw new SourceProvenanceError(
            "invalid_document_patch",
            "The patch inserts a duplicate node identifier",
            { operationIndex },
          );
        }
        if (operation.node.type === "citation") {
          if (!operation.node.sourceId) {
            throw new SourceProvenanceError(
              "citation_source_required",
              "A new citation requires a verified source identifier",
              { operationIndex },
            );
          }
          plans.push({ operationIndex, sourceId: operation.node.sourceId });
        }
        nodeState.set(operation.node.id, operation.node);
        break;
      }
      case "update": {
        const current = nodeState.get(operation.nodeId);
        if (!current || operation.node.id !== operation.nodeId) {
          throw new SourceProvenanceError(
            "invalid_document_patch",
            "The patch updates an unknown or mismatched node identifier",
            { operationIndex },
          );
        }
        if (current.type === "citation" && operation.node.type !== "citation") {
          throw new SourceProvenanceError(
            "citation_type_change",
            "A citation cannot be replaced with an unverified node type",
            { operationIndex, sourceId: current.sourceId },
          );
        }
        if (operation.node.type === "citation") {
          const sourceId = operation.node.sourceId ??
            (current.type === "citation" ? current.sourceId : undefined);
          if (!sourceId || !StableIdSchema.safeParse(sourceId).success) {
            throw new SourceProvenanceError(
              "citation_source_required",
              "A citation update requires a verified source identifier",
              { operationIndex },
            );
          }
          plans.push({ operationIndex, sourceId });
          nodeState.set(operation.nodeId, { ...operation.node, sourceId });
        } else {
          nodeState.set(operation.nodeId, operation.node);
        }
        break;
      }
      case "delete":
        nodeState.delete(operation.nodeId);
        break;
      case "move":
      case "setMetadata":
        break;
    }
  }
  return plans;
}

/** Returns unique source IDs in their first citation-mutation order. */
export function citationSourceIdsForPatch(
  document: DocumentModel,
  patch: DocumentPatch,
): string[] {
  const seen = new Set<string>();
  const sourceIds: string[] = [];
  for (const plan of citationMutationPlan(document, patch)) {
    if (seen.has(plan.sourceId)) continue;
    seen.add(plan.sourceId);
    sourceIds.push(plan.sourceId);
    if (sourceIds.length > MAX_CITATION_SOURCES_PER_PATCH) {
      throw new SourceProvenanceError(
        "invalid_document_patch",
        "A document patch references too many citation sources",
      );
    }
  }
  return sourceIds;
}

export function normalizeCitationPatchWithSources(input: {
  document: DocumentModel;
  patch: DocumentPatch;
  sources: readonly SourceRecord[];
}): DocumentPatch {
  const plans = citationMutationPlan(input.document, input.patch);
  if (plans.length === 0) return input.patch;
  if (input.sources.length > MAX_CITATION_SOURCES_PER_PATCH) {
    throw new SourceProvenanceError(
      "invalid_document_patch",
      "Too many source records were supplied for one patch",
    );
  }

  const sourceById = new Map<string, SourceRecord>();
  for (const source of input.sources) {
    if (sourceById.has(source.id)) {
      throw new SourceProvenanceError(
        "citation_source_not_found",
        "The citation source set contains a duplicate identifier",
        { sourceId: source.id },
      );
    }
    sourceById.set(source.id, source);
  }
  const canonicalByOperation = new Map<number, CanonicalCitationMetadata>();
  const canonicalBySourceId = new Map<string, CanonicalCitationMetadata>();
  for (const plan of plans) {
    const source = sourceById.get(plan.sourceId);
    if (!source) {
      throw new SourceProvenanceError(
        "citation_source_not_found",
        "The citation source record was not loaded",
        { operationIndex: plan.operationIndex, sourceId: plan.sourceId },
      );
    }
    if (source.documentId !== input.document.id) {
      throw new SourceProvenanceError(
        "citation_source_scope_mismatch",
        "The citation source belongs to a different document",
        { operationIndex: plan.operationIndex, sourceId: plan.sourceId },
      );
    }
    let canonical = canonicalBySourceId.get(source.id);
    if (!canonical) {
      canonical = canonicalCitationMetadataFromSource(source);
      canonicalBySourceId.set(source.id, canonical);
    }
    canonicalByOperation.set(plan.operationIndex, canonical);
  }

  const operations = input.patch.operations.map((operation, operationIndex) => {
    const canonical = canonicalByOperation.get(operationIndex);
    if (!canonical || (operation.op !== "insert" && operation.op !== "update")) {
      return operation;
    }
    if (operation.node.type !== "citation") {
      throw new SourceProvenanceError(
        "invalid_document_patch",
        "Citation normalization plan no longer matches the patch",
        { operationIndex },
      );
    }
    const node = CitationNodeSchema.parse({
      id: operation.node.id,
      type: "citation",
      ...canonical,
    });
    return { ...operation, node };
  });
  const normalized = DocumentPatchSchema.safeParse({ ...input.patch, operations });
  if (!normalized.success) {
    throw new SourceProvenanceError(
      "invalid_document_patch",
      "The normalized citation patch is not a valid document patch",
    );
  }
  return normalized.data;
}

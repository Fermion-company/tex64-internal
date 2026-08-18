import {
  DocumentPatchSchema,
  DocumentCitationStyleSchema,
  DocumentLayoutSchema,
  DocumentValidationError,
  applyDocumentPatch,
  safeValidateDocument,
  validateDocument,
  type DocumentCitationStyle,
  type DocumentLayout,
  type DocumentModel,
  type DocumentPatch,
  type DocumentRevision,
} from "@/domain/document";
import type { ModelMessage } from "ai";

import { compileDocumentRevision } from "@/server/compiler/compile-document-revision";
import {
  DocumentNotFoundError,
  RevisionConflictError,
  getDocumentRepository,
  type StoredDocument,
} from "@/server/persistence";
import {
  SourceAuthorizationError,
  SourceProvenanceError,
  SourceResolutionError,
  authorizedSourceLocator,
  canonicalizeSourceLocator,
  citationSourceIdsForPatch,
  normalizeCitationPatchWithSources,
  resolveSource,
  type CanonicalizedSourceLocator,
} from "@/server/sources";

import type {
  ApplyDocumentPatchInput,
  CompileDocumentResult,
  DocumentCheckResult,
  DocumentMutationResult,
  FormatDocumentInput,
  ResolveSourceInput,
  ResolveSourceResult,
} from "./document-tools";
import { usesDirectOpenAiTransport } from "./language-model";
import { normalizeModelDocumentPatch } from "./normalize-model-patch";
import { deterministicUuid } from "./run-identity";
import { resolvedSourceToolResult } from "./source-tool-result";

/**
 * A tool failure the model is expected to read and repair, exactly like a
 * failing command in a coding agent. The message is user-safe Japanese and
 * goes back into the thread as the tool result.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * Everything a tool call needs. One turn builds this once; each tool reloads
 * the document itself so it always observes the effects of earlier calls in
 * the same turn.
 */
export type ToolScope = {
  userId: string;
  documentId: string;
  turnId: string;
  /**
   * The user's own words in this conversation, used as the authorization
   * surface for source fetches. Model- and document-authored text is never
   * part of it.
   */
  trustedPrompt: string;
};

async function requireDocument(scope: ToolScope): Promise<StoredDocument> {
  const document = await getDocumentRepository().getDocument(
    scope.userId,
    scope.documentId,
  );
  if (!document) throw new DocumentNotFoundError();
  return document;
}

function storedDocumentRevision(document: StoredDocument): DocumentRevision {
  return {
    revisionId: deterministicUuid(
      `${document.id}:stored-revision:${document.currentRevision}`,
    ),
    revision: document.currentRevision,
    parentRevisionId:
      document.currentRevision > 0
        ? deterministicUuid(
            `${document.id}:stored-revision:${document.currentRevision - 1}`,
          )
        : null,
    committedAt: document.updatedAt,
    document: document.document,
  };
}

function safeValidationMessage(code: string): string {
  switch (code) {
    case "missing_reference":
    case "invalid_reference":
      return "参照先を確認してください。";
    case "unlisted_citation":
      return "引用と参考文献の対応を確認してください。";
    case "duplicate_id":
      return "同じIDが重複しています。";
    default:
      return "文書の構造を確認してください。";
  }
}

export async function readDocument(scope: ToolScope): Promise<DocumentModel> {
  const document = await requireDocument(scope);
  return validateDocument(document.document);
}

export async function checkDocument(
  scope: ToolScope,
): Promise<DocumentCheckResult> {
  const document = await requireDocument(scope);
  const revisionNumber = document.currentRevision;
  const validation = safeValidateDocument(document.document);
  if (validation.success) {
    return { ok: true, revision: revisionNumber, issues: [] };
  }
  return {
    ok: false,
    revision: revisionNumber,
    issues: validation.error.issues.slice(0, 100).map((issue) => ({
      code: issue.code,
      message: safeValidationMessage(issue.code),
    })),
  };
}

export async function applyDocumentPatchTool(
  input: ApplyDocumentPatchInput,
  scope: ToolScope,
): Promise<DocumentMutationResult> {
  const repository = getDocumentRepository();
  const document = await requireDocument(scope);

  // Tool inputs arrive unvalidated on the direct transport, and models invent
  // slug ids; normalize first, then let zod be the gate and hand its findings
  // back as a repairable tool error instead of a dead end.
  const parsedPatch = DocumentPatchSchema.safeParse(
    normalizeModelDocumentPatch(scope.documentId, input.patch),
  );
  if (!parsedPatch.success) {
    const details = parsedPatch.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(" / ");
    throw new ToolError(
      `文書パッチが契約に合いません。修正して再送してください: ${details}`,
    );
  }
  let patch: DocumentPatch = parsedPatch.data;
  if (patch.documentId !== scope.documentId) {
    throw new ToolError("この文書には変更を適用できません。");
  }

  let baseRevision: DocumentRevision;
  if (document.currentRevision === patch.baseRevision) {
    baseRevision = storedDocumentRevision(document);
  } else {
    const storedBase = await repository.getRevision(
      scope.userId,
      scope.documentId,
      patch.baseRevision,
    );
    if (!storedBase) {
      throw new ToolError(
        "文書の基準となる版が見つかりません。内容を読み直してください。",
      );
    }
    baseRevision = {
      revisionId: storedBase.commitId,
      revision: storedBase.revision,
      parentRevisionId: null,
      committedAt: storedBase.createdAt,
      document: storedBase.document,
    };
  }

  let citationSourceIds: string[];
  try {
    citationSourceIds = citationSourceIdsForPatch(baseRevision.document, patch);
  } catch (error) {
    if (!(error instanceof SourceProvenanceError)) throw error;
    throw new ToolError(
      "確認済みの出典に結び付かない引用は追加できません。resolve_sourceで出典を確認するか、引用なしで書いてください。",
    );
  }

  const citationSources = await repository.listSourceRecordsByIds(
    scope.userId,
    scope.documentId,
    citationSourceIds,
  );
  try {
    patch = normalizeCitationPatchWithSources({
      document: baseRevision.document,
      patch,
      sources: citationSources,
    });
  } catch (error) {
    if (!(error instanceof SourceProvenanceError)) throw error;
    throw new ToolError(
      "確認済みの出典に結び付かない引用は追加できません。resolve_sourceで出典を確認するか、引用なしで書いてください。",
    );
  }

  let next: DocumentRevision;
  try {
    next = applyDocumentPatch(baseRevision, patch);
  } catch (error) {
    // The bare "Document validation failed" is unrepairable for the model;
    // surface the concrete issues so the next attempt can fix them.
    if (error instanceof DocumentValidationError) {
      const details = error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join(" / ");
      throw new ToolError(
        `適用後の文書が検証に失敗しました。修正して再送してください: ${details}`,
      );
    }
    throw error;
  }

  try {
    await repository.commitDocument({
      userId: scope.userId,
      documentId: scope.documentId,
      commitId: patch.id,
      expectedRevision: patch.baseRevision,
      document: next.document,
      actor: "agent",
      summary: input.summary,
      operations: patch.operations,
    });
  } catch (error) {
    if (!(error instanceof RevisionConflictError)) throw error;
    throw new ToolError(
      "文書が別の操作で更新されました。read_documentで読み直してから、もう一度適用してください。",
    );
  }

  const persisted = await repository.getRevision(
    scope.userId,
    scope.documentId,
    patch.baseRevision + 1,
  );
  if (!persisted || persisted.commitId !== patch.id) {
    throw new Error("Committed document revision is unavailable.");
  }
  return { ok: true, revision: persisted.revision, summary: input.summary };
}

function layoutsEqual(
  left: DocumentLayout | undefined,
  right: DocumentLayout,
): boolean {
  return (
    left?.preset === right.preset &&
    left?.pageSize === right.pageSize &&
    left?.columns === right.columns
  );
}

export async function formatDocument(
  input: FormatDocumentInput,
  scope: ToolScope,
): Promise<DocumentMutationResult> {
  const document = await requireDocument(scope);
  const currentLayout = document.document.metadata.layout;
  const layout = DocumentLayoutSchema.parse({
    preset: input.preset,
    pageSize: input.pageSize ?? currentLayout?.pageSize ?? "A4",
    columns: input.columns ?? currentLayout?.columns ?? 1,
  });
  const citationStyle: DocumentCitationStyle | undefined = input.citationStyle
    ? DocumentCitationStyleSchema.parse({
        schemaVersion: 1,
        style: input.citationStyle,
      })
    : undefined;

  const currentCitationStyle = document.document.metadata.citationStyle;
  const targetCitationStyle = citationStyle ?? currentCitationStyle;
  const citationStylesEqual =
    currentCitationStyle?.schemaVersion === targetCitationStyle?.schemaVersion &&
    currentCitationStyle?.style === targetCitationStyle?.style;
  if (
    layoutsEqual(document.document.metadata.layout, layout) &&
    citationStylesEqual
  ) {
    return {
      ok: true,
      revision: document.currentRevision,
      summary: "文書の体裁は既にこの指定です",
    };
  }
  if (input.baseRevision !== document.currentRevision) {
    throw new ToolError(
      "文書が別の操作で更新されました。read_documentで読み直してから、もう一度適用してください。",
    );
  }

  const metadata: DocumentModel["metadata"] = {
    ...structuredClone(document.document.metadata),
    layout,
  };
  if (targetCitationStyle) metadata.citationStyle = targetCitationStyle;
  else delete metadata.citationStyle;

  const patch: DocumentPatch = {
    id: deterministicUuid(
      `${scope.userId}:${scope.documentId}:${scope.turnId}:layout:${input.baseRevision}:${layout.preset}:${layout.pageSize}:${layout.columns}:citation:${targetCitationStyle?.style ?? "none"}`,
    ),
    documentId: scope.documentId,
    baseRevision: input.baseRevision,
    createdAt: document.updatedAt,
    operations: [{ op: "setMetadata", metadata }],
  };
  return applyDocumentPatchTool(
    { patch, summary: "文書の体裁を整えました" },
    scope,
  );
}

const DIRECT_TRANSPORT_SCHOLARLY_HOSTS = new Set([
  "arxiv.org",
  "www.arxiv.org",
  "export.arxiv.org",
  "doi.org",
  "dx.doi.org",
  "www.doi.org",
]);

/**
 * Without the provider-executed search tool, the direct transport has no
 * authorization evidence for sources the model proposes from its own
 * knowledge. Instead of blocking autonomous sourcing entirely, the fetch
 * surface narrows to canonical DOI locators and arXiv HTTPS URLs: untrusted
 * content can steer fetches only within these public archives, arbitrary
 * hosts stay closed, and the resolver's IP policy still applies.
 */
function directTransportScholarlyLocator(
  locator: string,
): CanonicalizedSourceLocator | null {
  if (!usesDirectOpenAiTransport()) return null;
  let canonical: CanonicalizedSourceLocator;
  try {
    canonical = canonicalizeSourceLocator(locator);
  } catch {
    return null;
  }
  if (canonical.kind === "doi") return canonical;
  try {
    const host = new URL(canonical.canonicalLocator).hostname.toLowerCase();
    return DIRECT_TRANSPORT_SCHOLARLY_HOSTS.has(host) ? canonical : null;
  } catch {
    return null;
  }
}

export async function resolveSourceTool(
  input: ResolveSourceInput,
  scope: ToolScope,
  messages: readonly ModelMessage[],
): Promise<ResolveSourceResult> {
  const repository = getDocumentRepository();
  let authorized: CanonicalizedSourceLocator;
  try {
    authorized = authorizedSourceLocator({
      locator: input.locator,
      trustedPrompt: scope.trustedPrompt,
      messages,
      searchToolName: "search_sources",
    });
  } catch (error) {
    if (!(error instanceof SourceAuthorizationError)) throw error;
    const fallback = directTransportScholarlyLocator(input.locator);
    if (!fallback) {
      throw new ToolError("この資料は確認対象として指定されていません。");
    }
    authorized = fallback;
  }

  const existing = await repository.getSourceRecordByLocator(
    scope.userId,
    scope.documentId,
    authorized.canonicalLocator,
  );
  if (existing) return resolvedSourceToolResult(existing);

  let source;
  try {
    source = await resolveSource({
      id: deterministicUuid(
        `${scope.userId}:${scope.documentId}:source:${authorized.canonicalLocator}`,
      ),
      userId: scope.userId,
      documentId: scope.documentId,
      locator: authorized.canonicalLocator,
    });
  } catch (error) {
    if (error instanceof SourceResolutionError) {
      return {
        status: "unavailable",
        message: "資料を確認できませんでした。別の候補を選んでください。",
      };
    }
    throw error;
  }

  return resolvedSourceToolResult(await repository.saveSourceRecord(source));
}

/**
 * Typesets the current document and publishes the PDF the reader sees. This
 * is the agent's own build command: it decides when to run it and repairs
 * what the diagnostics report, instead of a pipeline compiling on its behalf.
 */
export async function compileDocument(
  scope: ToolScope,
): Promise<CompileDocumentResult> {
  const document = await requireDocument(scope);
  if (document.currentRevision < 1 || document.document.root.length === 0) {
    throw new ToolError("まだ本文がありません。先に内容を書いてください。");
  }
  const compiled = await compileDocumentRevision({
    userId: scope.userId,
    documentId: scope.documentId,
    revision: document.currentRevision,
  });
  if (compiled.ok) {
    return {
      ok: true,
      revision: compiled.revision,
      pageCount: compiled.pageCount,
      warningCount: compiled.warningCount,
    };
  }
  return {
    ok: false,
    revision: compiled.revision,
    code: compiled.code,
    issueCount: compiled.issueCount,
    ...(compiled.diagnostics ? { diagnostics: compiled.diagnostics } : {}),
  };
}

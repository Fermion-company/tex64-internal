import {
  DocumentValidationError,
  assertDocumentFiguresRenderable,
  extractNodeLineRanges,
  renderDocumentToLatex,
  validateDocument,
} from "@/domain/document";
import {
  CURRENT_ARTIFACT_QUALITY_VERSION,
  artifactReleaseBinding,
  getArtifactStore,
  storedPdfMatchesMetadata,
} from "@/server/artifacts";
import {
  DocumentNotFoundError,
  getDocumentRepository,
  type ArtifactReleaseBinding,
} from "@/server/persistence";

// Via the barrel so test doubles that mock "@/server/compiler" apply here too.
import { CompileFailure, getDocumentCompiler } from "./index";
import { buildRegionMap } from "./synctex-regions";

/**
 * Result of one typesetting attempt. Failures carry the diagnostics the agent
 * repairs from; nothing here judges the document's content.
 */
export type CompileDocumentRevisionResult =
  | {
      ok: true;
      revision: number;
      artifact: { revision: number; sha256: string; byteSize: number };
      release: ArtifactReleaseBinding;
      pageCount: number;
      warningCount: number;
      reused: boolean;
    }
  | {
      ok: false;
      revision: number;
      code: "document_validation_failed" | "typesetting_failed";
      issueCount: number;
      /** Path-sanitized typesetting diagnostics, bounded for prompt reuse. */
      diagnostics?: Array<{ code: string; message: string; line?: number }>;
    };

export interface CompileDocumentRevisionInput {
  userId: string;
  documentId: string;
  revision: number;
}

/**
 * Validate → render → compile → store, shared by the agent's compile tool and
 * the on-demand compile route. Callers own scoping (session, rate limits);
 * this function owns artifact correctness.
 */
export async function compileDocumentRevision(
  input: CompileDocumentRevisionInput,
): Promise<CompileDocumentRevisionResult> {
  const repository = getDocumentRepository();
  const artifactStore = getArtifactStore();
  const revisionNumber = input.revision;

  const existingArtifact = await repository.getArtifact(
    input.userId,
    input.documentId,
    revisionNumber,
  );
  const revision = await repository.getRevision(
    input.userId,
    input.documentId,
    revisionNumber,
  );
  if (!revision) throw new DocumentNotFoundError();

  try {
    const document = validateDocument(revision.document);
    assertDocumentFiguresRenderable(document);
    if (
      existingArtifact &&
      existingArtifact.pageCount !== null &&
      existingArtifact.qualityVersion === CURRENT_ARTIFACT_QUALITY_VERSION &&
      (await storedPdfMatchesMetadata(artifactStore, existingArtifact))
    ) {
      return {
        ok: true,
        revision: revisionNumber,
        artifact: {
          revision: revisionNumber,
          sha256: existingArtifact.sha256,
          byteSize: existingArtifact.byteSize,
        },
        release: artifactReleaseBinding(existingArtifact),
        pageCount: existingArtifact.pageCount,
        warningCount: 0,
        reused: true,
      };
    }
    const latex = renderDocumentToLatex(document);
    const compiled = await getDocumentCompiler().compile({
      userId: input.userId,
      documentId: input.documentId,
      revision: revisionNumber,
      latex,
    });
    const saved = await artifactStore.savePdf({
      userId: input.userId,
      documentId: input.documentId,
      revision: revisionNumber,
      pdf: compiled.pdf,
    });

    // Element-region map for the PDF preview. Best-effort: any failure here
    // (no synctex, parse failure, store without regions support) must never
    // fail the compile — the preview degrades to a plain PDF.
    try {
      if (compiled.synctex) {
        const ranges = extractNodeLineRanges(latex);
        const regionMap =
          ranges.length > 0
            ? buildRegionMap({
                synctex: compiled.synctex,
                ranges,
                sourceText: latex,
              })
            : null;
        if (regionMap && regionMap.nodes.length > 0) {
          await artifactStore.saveRegions({
            userId: input.userId,
            documentId: input.documentId,
            revision: revisionNumber,
            pdfSha256: saved.sha256,
            regionsJson: JSON.stringify(regionMap),
          });
        }
      }
    } catch {
      // Intentionally swallowed; see above.
    }

    const storedArtifact = {
      userId: input.userId,
      documentId: input.documentId,
      revision: revisionNumber,
      storageKey: saved.storageKey,
      sha256: saved.sha256,
      byteSize: saved.byteSize,
      compileDurationMs: compiled.durationMs,
      pageCount: compiled.pageCount,
      qualityVersion: CURRENT_ARTIFACT_QUALITY_VERSION,
      createdAt: new Date().toISOString(),
    };
    if (existingArtifact) {
      await repository.replaceArtifact(existingArtifact, storedArtifact);
    } else {
      await repository.saveArtifact(storedArtifact);
    }

    return {
      ok: true,
      revision: revisionNumber,
      artifact: {
        revision: revisionNumber,
        sha256: saved.sha256,
        byteSize: saved.byteSize,
      },
      release: artifactReleaseBinding(storedArtifact),
      pageCount: compiled.pageCount,
      warningCount: compiled.diagnostics.filter(
        (diagnostic) => diagnostic.severity === "warning",
      ).length,
      reused: false,
    };
  } catch (error) {
    if (error instanceof DocumentValidationError) {
      return {
        ok: false,
        revision: revisionNumber,
        code: "document_validation_failed",
        issueCount: error.issues.length,
      };
    }
    if (error instanceof CompileFailure) {
      return {
        ok: false,
        revision: revisionNumber,
        code: "typesetting_failed",
        issueCount: error.diagnostics.length,
        diagnostics: error.diagnostics.slice(0, 10).map((diagnostic) => ({
          code: diagnostic.code,
          message: diagnostic.message,
          ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
        })),
      };
    }
    throw error;
  }
}

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
import {
  CompileFailure,
  blockingPdfVisualFindings,
  evaluateRenderedPageTarget,
  getDocumentCompiler,
  reviewPdfVisualQuality,
} from "./index";
import { buildRegionMap } from "./synctex-regions";

/**
 * Structurally identical to the workflow's CompileAndStoreResult so the
 * durable step can return it unchanged; kept here so non-workflow callers
 * (the on-demand compile route) do not depend on workflow modules.
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
      code:
        | "document_validation_failed"
        | "typesetting_failed"
        | "visual_quality_failed"
        | "page_target_mismatch"
        | "page_target_unsupported";
      issueCount: number;
      visualFindings?: Array<{
        category:
          | "clipping"
          | "overlap"
          | "spacing_and_margins"
          | "typography"
          | "figures_and_tables"
          | "equations";
        page: number;
        detail: string;
      }>;
      pageTarget?: {
        observed: number;
        minimum: number;
        maximum?: number;
      };
    };

export interface CompileDocumentRevisionInput {
  userId: string;
  documentId: string;
  revision: number;
  /** Confirmed brief page target, when one applies to this compile. */
  targetLength: string | null;
  /** Model runtime for the PDF visual pass; null skips visual review. */
  visualReviewRuntime: { provider: "ai_gateway"; model: string } | null;
}

/**
 * Validate → render → compile → (visual review) → store, shared between the
 * durable workflow step and the on-demand compile route. Callers own scoping
 * (run ownership, rate limits); this function owns artifact correctness.
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
      const pageFailure = renderedPageTargetFailure({
        targetLength: input.targetLength,
        pageCount: existingArtifact.pageCount,
        revision: revisionNumber,
      });
      if (pageFailure) return pageFailure;
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
    const pageFailure = renderedPageTargetFailure({
      targetLength: input.targetLength,
      pageCount: compiled.pageCount,
      revision: revisionNumber,
    });
    if (pageFailure) return pageFailure;
    if (input.visualReviewRuntime) {
      const visualReview = await reviewPdfVisualQuality({
        pdf: compiled.pdf,
        pageCount: compiled.pageCount,
        runtime: input.visualReviewRuntime,
      });
      const blockingFindings = blockingPdfVisualFindings(visualReview);
      if (blockingFindings.length > 0) {
        return {
          ok: false,
          revision: revisionNumber,
          code: "visual_quality_failed",
          issueCount: blockingFindings.length,
          visualFindings: blockingFindings.map((finding) => ({
            category: finding.category,
            page: finding.page,
            detail: finding.detail,
          })),
        };
      }
    }
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
      };
    }
    throw error;
  }
}

function renderedPageTargetFailure(input: {
  targetLength: string | null;
  pageCount: number;
  revision: number;
}): Extract<CompileDocumentRevisionResult, { ok: false }> | null {
  const evaluation = evaluateRenderedPageTarget(
    input.targetLength,
    input.pageCount,
  );
  if (evaluation.status === "not_applicable" || evaluation.status === "passed") {
    return null;
  }
  if (evaluation.status === "unsupported") {
    return {
      ok: false,
      revision: input.revision,
      code: "page_target_unsupported",
      issueCount: 1,
    };
  }
  return {
    ok: false,
    revision: input.revision,
    code: "page_target_mismatch",
    issueCount: 1,
    pageTarget: {
      observed: evaluation.observed,
      minimum: evaluation.target.minimum,
      ...(evaluation.target.maximum === undefined
        ? {}
        : { maximum: evaluation.target.maximum }),
    },
  };
}

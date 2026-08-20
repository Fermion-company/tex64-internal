import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/server/auth";
import { assertProductionMutationReady } from "@/server/config/production";
import { compileDocumentRevision } from "@/server/compiler/compile-document-revision";
import { assertSameOrigin } from "@/server/http/origin";
import {
  documentMutationRateLimitInput,
  takeRateLimits,
} from "@/server/http/rate-limit";
import { readJsonBody } from "@/server/http/request";
import { handleRouteError, jsonError, rateLimitResponse } from "@/server/http/responses";
import { DocumentNotFoundError, getDocumentRepository } from "@/server/persistence";
import { loadDocumentDetail } from "@/server/presentation/load-document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CompileRequestSchema = z.object({}).strict();

/**
 * On-demand typesetting of the document's current revision so manual edits
 * and restores keep the PDF preview alive between agent runs. Skips the
 * model-based visual pass — the owner is looking at the result themselves.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    assertProductionMutationReady();
    const { userId } = await requireSession();
    const { documentId } = await context.params;
    z.string().uuid().parse(documentId);
    CompileRequestSchema.parse(await readJsonBody(request));

    const limit = await takeRateLimits(
      documentMutationRateLimitInput({
        request,
        userId,
        action: "compile",
      }),
    );
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const repository = getDocumentRepository();
    const document = await repository.getDocument(userId, documentId);
    if (!document) throw new DocumentNotFoundError();
    if (document.document.root.length === 0) {
      return jsonError("まだ本文がありません。", 409, "empty_document");
    }
    const recentRuns = await repository.listRuns(userId, documentId, {
      limit: 10,
    });
    if (
      recentRuns.some(
        (run) => run.status === "queued" || run.status === "running",
      )
    ) {
      return jsonError(
        "執筆の処理中です。完了してからもう一度お試しください。",
        409,
        "document_busy",
      );
    }

    const compiled = await compileDocumentRevision({
      userId,
      documentId,
      revision: document.currentRevision,
      targetLength: null,
      visualReviewRuntime: null,
    });
    if (!compiled.ok) {
      return jsonError(
        "紙面を組み立てられませんでした。内容を見直して、もう一度お試しください。",
        422,
        "compile_failed",
      );
    }

    return NextResponse.json({
      document: await loadDocumentDetail(userId, documentId),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
